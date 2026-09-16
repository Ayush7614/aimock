import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { clearBatchStore } from "../batches.js";
import { normalizePathLabel } from "../metrics.js";

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Batches API mock", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  it("creates a batch and progresses validating -> in_progress -> completed", async () => {
    const created = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-abc",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      })
    ).json()) as { id: string; status: string };
    expect(created.id.startsWith("batch-")).toBe(true);
    expect(created.status).toBe("validating");

    const first = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
    };
    expect(first.status).toBe("in_progress");

    const second = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
      output_file_id: string;
      request_counts: { total: number; completed: number };
    };
    expect(second.status).toBe("completed");
    expect(second.output_file_id).toContain("output");
    expect(second.request_counts.completed).toBe(1);

    const third = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
    };
    expect(third.status).toBe("completed");
  });

  it("lists batches, cancels pending ones, and rejects terminal cancel", async () => {
    const one = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-1",
        endpoint: "/v1/embeddings",
        completion_window: "24h",
      })
    ).json()) as { id: string };
    const two = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-2",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      })
    ).json()) as { id: string };

    const list = (await (await fetch(`${mock.url}/v1/batches`)).json()) as {
      object: string;
      data: { id: string }[];
    };
    expect(list.object).toBe("list");
    expect(list.data.map((d) => d.id)).toEqual(expect.arrayContaining([one.id, two.id]));

    const cancelled = (await (
      await post(`${mock.url}/v1/batches/${one.id}/cancel`, {})
    ).json()) as { status: string };
    expect(cancelled.status).toBe("cancelled");

    // Drive `two` to completed, then cancel must 400.
    await fetch(`${mock.url}/v1/batches/${two.id}`);
    await fetch(`${mock.url}/v1/batches/${two.id}`);
    const badCancel = await post(`${mock.url}/v1/batches/${two.id}/cancel`, {});
    expect(badCancel.status).toBe(400);
  });

  it("validates endpoint, window, file id, and unknown ids", async () => {
    expect(
      (
        await post(`${mock.url}/v1/batches`, {
          input_file_id: "file-x",
          endpoint: "/v1/nope",
          completion_window: "24h",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${mock.url}/v1/batches`, {
          input_file_id: "file-x",
          endpoint: "/v1/chat/completions",
          completion_window: "1h",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${mock.url}/v1/batches`, {
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${mock.url}/v1/batches/batch-nope`)).status).toBe(404);

    const malformed = await fetch(`${mock.url}/v1/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);
  });

  it("journals under service=batches, clears on reset, normalizes metrics", async () => {
    await post(`${mock.url}/v1/batches`, {
      input_file_id: "file-j",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });
    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=batches`)
    ).json()) as { path: string }[];
    expect(journal.length).toBeGreaterThan(0);

    await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    const list = (await (await fetch(`${mock.url}/v1/batches`)).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);

    expect(normalizePathLabel("/v1/batches")).toBe("/v1/batches");
    expect(normalizePathLabel("/v1/batches/batch-123")).toBe("/v1/batches/{id}");
    expect(normalizePathLabel("/v1/batches/batch-123/cancel")).toBe("/v1/batches/{id}/cancel");
  });
});

// The chaos gate is shared with every other job surface (files, fine-tuning),
// so it has to behave the same way here: async so `latencyMs` actually
// delays, CORS set before the roll so a faulted 429/500 is readable from a
// browser, and `service: "batches"` on the journal context so faulted
// requests show up under `?service=batches`.
describe("Batches API chaos gate", () => {
  let mock: LLMock;
  const create = {
    input_file_id: "file-chaos",
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  };

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  it("honours chaos latencyMs on create", async () => {
    const t0 = Date.now();
    const res = await fetch(`${mock.url}/v1/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aimock-chaos-latency": "400" },
      body: JSON.stringify(create),
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it("sets CORS on a chaos-faulted response and journals it under service=batches", async () => {
    const chaos = { "Content-Type": "application/json", "x-aimock-chaos-ratelimit": "1" };
    const routes: [string, RequestInit][] = [
      [`${mock.url}/v1/batches`, { method: "POST", headers: chaos, body: JSON.stringify(create) }],
      [`${mock.url}/v1/batches`, { headers: chaos }],
      [`${mock.url}/v1/batches/batch-x`, { headers: chaos }],
      [`${mock.url}/v1/batches/batch-x/cancel`, { method: "POST", headers: chaos, body: "{}" }],
    ];
    for (const [url, init] of routes) {
      const res = await fetch(url, init);
      await res.text();
      expect(res.status).toBe(429);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=batches`)
    ).json()) as { response: { chaosAction?: string } }[];
    expect(journal).toHaveLength(4);
    expect(journal.every((e) => e.response.chaosAction === "rateLimit")).toBe(true);
  });
});
