import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, ChatCompletionRequest } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(
  url: string,
  method: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = opts?.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
          ...opts?.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, body: text, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function chatRequest(content: string): ChatCompletionRequest {
  return { model: "gpt-4", stream: false, messages: [{ role: "user", content }] };
}

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

async function seedTraffic(): Promise<void> {
  const fixtures: Fixture[] = [{ match: { userMessage: "hello" }, response: { content: "Hi" } }];
  instance = await createServer(fixtures);
  await request(`${instance.url}/v1/chat/completions`, "POST", { body: chatRequest("hello") });
  await request(`${instance.url}/v1/chat/completions`, "POST", {
    body: chatRequest("unmatched prompt"),
    headers: { "X-Test-Id": "t1" },
  });
  await request(`${instance.url}/search`, "POST", { body: { query: "cats" } });
}

// ---------------------------------------------------------------------------
// GET /__aimock/journal filtering & pagination
// ---------------------------------------------------------------------------

describe("GET /__aimock/journal filters", () => {
  it("returns the full array when no params are given (back-compat)", async () => {
    await seedTraffic();
    const res = await request(`${instance!.url}/__aimock/journal`, "GET");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect((res.json as unknown[]).length).toBe(3);
  });

  it("paginates with limit and offset", async () => {
    await seedTraffic();
    const limited = await request(`${instance!.url}/__aimock/journal?limit=2`, "GET");
    expect(limited.status).toBe(200);
    expect((limited.json as unknown[]).length).toBe(2);

    const offset = await request(`${instance!.url}/__aimock/journal?offset=2`, "GET");
    expect(offset.status).toBe(200);
    expect((offset.json as unknown[]).length).toBe(1);

    const page = await request(`${instance!.url}/__aimock/journal?offset=1&limit=1`, "GET");
    expect(page.status).toBe(200);
    const entries = page.json as { path: string }[];
    expect(entries.length).toBe(1);

    const zero = await request(`${instance!.url}/__aimock/journal?limit=0`, "GET");
    expect(zero.status).toBe(200);
    expect(zero.json).toEqual([]);
  });

  it("filters by path substring, method, status, and service", async () => {
    await seedTraffic();
    const byPath = await request(`${instance!.url}/__aimock/journal?path=/search`, "GET");
    expect(byPath.status).toBe(200);
    const pathEntries = byPath.json as { path: string }[];
    expect(pathEntries.length).toBe(1);
    expect(pathEntries[0].path).toBe("/search");

    const byMethod = await request(`${instance!.url}/__aimock/journal?method=post`, "GET");
    expect(byMethod.status).toBe(200);
    // Filter is case-insensitive: all three seeded entries are POSTs
    expect((byMethod.json as unknown[]).length).toBe(3);
    const byMethodGet = await request(`${instance!.url}/__aimock/journal?method=GET`, "GET");
    expect(byMethodGet.status).toBe(200);
    expect(byMethodGet.json).toEqual([]);

    const byService = await request(`${instance!.url}/__aimock/journal?service=search`, "GET");
    expect(byService.status).toBe(200);
    expect((byService.json as unknown[]).length).toBe(1);

    const byStatus = await request(`${instance!.url}/__aimock/journal?status=200`, "GET");
    expect(byStatus.status).toBe(200);
    // Matched chat + search are 200; the unmatched chat records 404
    expect((byStatus.json as unknown[]).length).toBe(2);

    const by404 = await request(`${instance!.url}/__aimock/journal?status=404`, "GET");
    expect(by404.status).toBe(200);
    expect((by404.json as unknown[]).length).toBe(1);

    const missing = await request(`${instance!.url}/__aimock/journal?status=429`, "GET");
    expect(missing.status).toBe(200);
    expect(missing.json).toEqual([]);
  });

  it("filters by testId via the X-Test-Id header", async () => {
    await seedTraffic();
    const res = await request(`${instance!.url}/__aimock/journal?testId=t1`, "GET");
    expect(res.status).toBe(200);
    const entries = res.json as { headers: Record<string, string> }[];
    expect(entries.length).toBe(1);
    expect(entries[0].headers["x-test-id"]).toBe("t1");
  });

  it("rejects invalid limit/offset/status with 400", async () => {
    await seedTraffic();
    for (const qs of [
      "limit=-1",
      "limit=abc",
      "limit=1.5",
      "offset=-2",
      "offset=nope",
      "status=ok",
    ]) {
      const res = await request(`${instance!.url}/__aimock/journal?${qs}`, "GET");
      expect(res.status).toBe(400);
    }
    // Journal itself is untouched by the rejected reads
    const full = await request(`${instance!.url}/__aimock/journal`, "GET");
    expect((full.json as unknown[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// GET /__aimock/fixtures dump
// ---------------------------------------------------------------------------

describe("GET /__aimock/fixtures dump", () => {
  it("returns only the count by default (back-compat)", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const res = await request(`${instance.url}/__aimock/fixtures`, "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ count: 1 });
  });

  it("dumps redacted fixtures with ?include=fixtures", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
      {
        match: { userMessage: /bye.*/i, predicate: () => true },
        response: { error: { message: "nope" }, status: 400 },
      },
    ]);
    const res = await request(`${instance.url}/__aimock/fixtures?include=fixtures`, "GET");
    expect(res.status).toBe(200);
    const body = res.json as {
      count: number;
      fixtures: { index: number; match: Record<string, unknown>; response: string }[];
    };
    expect(body.count).toBe(2);
    expect(body.fixtures.length).toBe(2);
    expect(body.fixtures[0]).toMatchObject({ index: 0, response: "content" });
    expect(body.fixtures[0].match).toEqual({ userMessage: "hello" });
    // RegExp stringified, predicate redacted — both JSON-safe
    expect(body.fixtures[1].match).toEqual({ userMessage: "/bye.*/i", predicate: "[function]" });
    expect(body.fixtures[1].response).toBe("error");
    // Round-trips through JSON (no functions survive)
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it("rejects unknown include values with 400", async () => {
    instance = await createServer([]);
    const res = await request(`${instance.url}/__aimock/fixtures?include=bogus`, "GET");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET/PUT /__aimock/chaos runtime control
// ---------------------------------------------------------------------------

describe("GET/PUT /__aimock/chaos", () => {
  it("reads the construction chaos config", async () => {
    instance = await createServer([], { chaos: { dropRate: 0 } });
    const res = await request(`${instance.url}/__aimock/chaos`, "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ chaos: { dropRate: 0 } });
  });

  it("reads empty chaos by default", async () => {
    instance = await createServer([]);
    const res = await request(`${instance.url}/__aimock/chaos`, "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ chaos: {} });
  });

  it("applies dropRate at runtime without a restart", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const put = await request(`${instance.url}/__aimock/chaos`, "PUT", {
      body: { dropRate: 1 },
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ chaos: { dropRate: 1 } });

    const dropped = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(dropped.status).toBe(500);

    // Clearing restores normal traffic
    const cleared = await request(`${instance.url}/__aimock/chaos`, "PUT", { body: {} });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ chaos: {} });
    const ok = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(ok.status).toBe(200);
  });

  it("rejects out-of-range, non-numeric, and unknown fields with 400", async () => {
    instance = await createServer([]);
    const badBodies: unknown[] = [
      { dropRate: 2 },
      { dropRate: -0.5 },
      { malformedRate: "1" },
      { disconnectRate: Number.NaN },
      { drop_rate: 1 },
      { dropRate: 1, bogus: true },
      [1],
      "chaos",
    ];
    for (const body of badBodies) {
      const res = await request(`${instance.url}/__aimock/chaos`, "PUT", { body });
      expect(res.status).toBe(400);
    }
    // Nothing was applied
    const current = await request(`${instance.url}/__aimock/chaos`, "GET");
    expect(current.json).toEqual({ chaos: {} });
  });
});
