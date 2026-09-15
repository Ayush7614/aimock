import { describe, it, expect } from "vitest";
import { evaluateChaos, resolveChaosLatencyMs, applyChaosAction } from "../chaos.js";
import { createServer } from "../server.js";
import { Journal } from "../journal.js";
import type { Fixture } from "../types.js";
import type * as http from "node:http";

function textFixture(message: string): Fixture {
  return { match: { userMessage: message }, response: { content: message } };
}

function fakeRes(onStatus: (s: number, h?: Record<string, string>) => void): http.ServerResponse {
  return {
    writeHead: (s: number, h?: Record<string, string>) => onStatus(s, h),
    end: () => {},
    destroy: () => {},
  } as unknown as http.ServerResponse;
}

describe("chaos latency + ratelimit", () => {
  it("evaluates rateLimit at 1.0 and latency resolves deterministically", () => {
    expect(evaluateChaos(null, { rateLimitRate: 1.0 }, undefined)).toBe("rateLimit");
    expect(evaluateChaos(null, { rateLimitRate: 0 }, undefined)).toBe(null);
    expect(resolveChaosLatencyMs(null, { latencyMs: 150 }, undefined)).toBe(150);
    expect(resolveChaosLatencyMs(null, { latencyMs: 50000 }, undefined)).toBe(30000);
    expect(resolveChaosLatencyMs(null, undefined, undefined)).toBe(0);
    expect(
      resolveChaosLatencyMs(null, { latencyMs: 10 }, { "x-aimock-chaos-latency": "250" }),
    ).toBe(250);
    expect(evaluateChaos(null, { rateLimitRate: 0 }, { "x-aimock-chaos-ratelimit": "1" })).toBe(
      "rateLimit",
    );
    expect(
      resolveChaosLatencyMs(
        { match: {}, response: { content: "x" }, chaos: { latencyMs: 77 } },
        { latencyMs: 5 },
        undefined,
      ),
    ).toBe(77);
  });

  it("rateLimit action writes 429 with Retry-After and journals", () => {
    const journal = new Journal();
    let status = 0;
    const headers: Record<string, string> = {};
    const res = fakeRes((s, h) => {
      status = s;
      Object.assign(headers, h ?? {});
    });
    applyChaosAction(
      "rateLimit",
      res,
      null,
      journal,
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
      "internal",
    );
    expect(status).toBe(429);
    expect(headers["Retry-After"]).toBe("1");
    expect(journal.getAll()[0].response.status).toBe(429);
  });

  it("server 429s via header and control API round-trips new fields", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {});
    try {
      const rl = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aimock-chaos-ratelimit": "1",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello-chaos" }],
        }),
      });
      expect(rl.status).toBe(429);
      expect(rl.headers.get("retry-after")).toBe("1");

      const set = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: 120, rateLimitRate: 0 }),
      });
      expect(set.status).toBe(200);
      expect(((await set.json()) as { chaos: { latencyMs: number } }).chaos.latencyMs).toBe(120);

      const ok = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello-chaos" }],
        }),
      });
      expect(ok.status).toBe(200);

      const bad = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: 99999 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("async helper delays then applies terminal chaos", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    let status = 0;
    const res = fakeRes((s) => {
      status = s;
    });
    const t0 = Date.now();
    const fired = await applyChaosAsync(
      res,
      null,
      { latencyMs: 60, rateLimitRate: 1.0 },
      {},
      "/v1/chat/completions",
      journal,
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
      "internal",
    );
    expect(fired).toBe(true);
    expect(status).toBe(429);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });
});

// Wiring regression: the latency knob used to be resolved, validated and
// clamped on every entry point and then never awaited by any handler — a
// configured 3000ms delay measured ~0ms on the wire. These tests measure
// ELAPSED TIME through a real server, so deleting the `awaitChaosLatency`
// call (or reverting a handler to the sync `applyChaos`) turns them red.
// The delay is fixed, never jittered, so replay stays deterministic; the
// values here are kept small so the suite stays fast.
describe("chaos latency is actually applied on the wire", () => {
  const LATENCY_MS = 200;
  // Timer/socket scheduling can fire a hair under the requested delay.
  const DELAYED_MIN = 150;
  // Comfortably below LATENCY_MS: an undelayed response returns in ~1ms.
  const UNDELAYED_MAX = 120;

  const chatBody = JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello-chaos" }],
  });
  const streamBody = JSON.stringify({
    model: "gpt-4o",
    stream: true,
    messages: [{ role: "user", content: "hello-chaos" }],
  });
  const claudeBody = JSON.stringify({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello-chaos" }],
  });

  /** Drive one request to completion and return the elapsed milliseconds. */
  async function timeRequest(
    url: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ ms: number; status: number }> {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    await res.text();
    return { ms: Date.now() - t0, status: res.status };
  }

  it("delays the chat, streaming and Anthropic paths from server-level config", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {
      chaos: { latencyMs: LATENCY_MS },
    });
    try {
      const chat = await timeRequest(`${instance.url}/v1/chat/completions`, chatBody);
      expect(chat.status).toBe(200);
      expect(chat.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

      const stream = await timeRequest(`${instance.url}/v1/chat/completions`, streamBody);
      expect(stream.status).toBe(200);
      expect(stream.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

      const claude = await timeRequest(`${instance.url}/v1/messages`, claudeBody);
      expect(claude.status).toBe(200);
      expect(claude.ms).toBeGreaterThanOrEqual(DELAYED_MIN);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("delays from a per-request header and from fixture-level chaos, and not otherwise", async () => {
    const plain = textFixture("hello-chaos");
    const slowFixture: Fixture = {
      match: { userMessage: "slow-fixture" },
      chaos: { latencyMs: LATENCY_MS },
      response: { content: "slow-fixture" },
    };
    const instance = await createServer([plain, slowFixture], {});
    try {
      const withHeader = await timeRequest(`${instance.url}/v1/chat/completions`, chatBody, {
        "x-aimock-chaos-latency": String(LATENCY_MS),
      });
      expect(withHeader.status).toBe(200);
      expect(withHeader.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

      const fixtureLevel = await timeRequest(
        `${instance.url}/v1/chat/completions`,
        JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "slow-fixture" }],
        }),
      );
      expect(fixtureLevel.status).toBe(200);
      expect(fixtureLevel.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

      // Negative control on the SAME server: no header, no fixture chaos.
      const undelayed = await timeRequest(`${instance.url}/v1/chat/completions`, chatBody);
      expect(undelayed.status).toBe(200);
      expect(undelayed.ms).toBeLessThan(UNDELAYED_MAX);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("scopes control-API latency to the installing testId and does not leak", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {});
    try {
      const set = await fetch(`${instance.url}/__aimock/chaos?testId=slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: LATENCY_MS }),
      });
      expect(set.status).toBe(200);

      const slow = await timeRequest(`${instance.url}/v1/chat/completions?testId=slow`, chatBody);
      expect(slow.status).toBe(200);
      expect(slow.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

      // A concurrent test that never configured chaos must not inherit it.
      const fast = await timeRequest(`${instance.url}/v1/chat/completions?testId=fast`, chatBody);
      expect(fast.status).toBe(200);
      expect(fast.ms).toBeLessThan(UNDELAYED_MAX);

      // Anthropic path honours the same scope.
      const slowClaude = await timeRequest(`${instance.url}/v1/messages?testId=slow`, claudeBody);
      expect(slowClaude.status).toBe(200);
      expect(slowClaude.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

      const fastClaude = await timeRequest(`${instance.url}/v1/messages?testId=fast`, claudeBody);
      expect(fastClaude.status).toBe(200);
      expect(fastClaude.ms).toBeLessThan(UNDELAYED_MAX);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("still returns 429 unchanged when rate limiting is configured alongside latency", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {
      chaos: { rateLimitRate: 1 },
    });
    try {
      const res = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody,
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(res.headers.get("x-ratelimit-reset")).toBe("1");
      expect(await res.json()).toEqual({
        error: {
          message: "Chaos: rate limit exceeded",
          type: "rate_limit_error",
          code: "chaos_ratelimit",
        },
      });
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });
});
