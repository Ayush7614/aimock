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

/**
 * B4: `POST /v1/batches/{id}/cancel` reads (and discards) its body before the
 * handler runs, so `readBody`'s 10 MB ceiling applies to it exactly as it does
 * to the create route beside it. A route that never touches the stream lets
 * node dump whatever the client sends and answers 200 to a 12 MB upload.
 */
describe("Batches cancel bounds its request body like create", () => {
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

  async function createBatch(): Promise<string> {
    const created = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-b4",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      })
    ).json()) as { id: string };
    return created.id;
  }

  it("rejects an over-cap cancel body the same way create does and leaves the batch untouched", async () => {
    const id = await createBatch();
    // readBody's ceiling is 10 MB; over it the request is destroyed, which
    // surfaces to fetch as a transport failure rather than a status.
    const overCap = Buffer.alloc(12 * 1024 * 1024, 0x78);
    const overCapPost = (path: string): Promise<Response> =>
      fetch(`${mock.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: overCap,
      });

    await expect(overCapPost("/v1/batches")).rejects.toThrow();
    await expect(overCapPost(`/v1/batches/${id}/cancel`)).rejects.toThrow();

    const after = (await (await fetch(`${mock.url}/v1/batches/${id}`)).json()) as {
      status: string;
    };
    expect(after.status).not.toBe("cancelled");
  });

  it("still cancels with an empty body and with a small JSON body", async () => {
    const empty = await fetch(`${mock.url}/v1/batches/${await createBatch()}/cancel`, {
      method: "POST",
    });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { status: string }).status).toBe("cancelled");

    const small = await post(`${mock.url}/v1/batches/${await createBatch()}/cancel`, {
      reason: "changed my mind",
    });
    expect(small.status).toBe(200);
    expect(((await small.json()) as { status: string }).status).toBe("cancelled");
  });
});

/**
 * Create/list wire shape against the vendored `openai` SDK 4.104.0
 * `resources/batches.d.ts`: `BatchCreateParams.endpoint` is the union
 * `'/v1/responses' | '/v1/chat/completions' | '/v1/embeddings' | '/v1/completions'`,
 * `Batch` carries `metadata` and `request_counts`, and `list` is a `CursorPage`
 * (`after`/`limit`, `has_more`) whose response also names `first_id`/`last_id`.
 */
describe("Batches API mock: create/list wire shape", () => {
  let mock: LLMock;

  type Created = {
    id: string;
    endpoint: string;
    metadata?: Record<string, string>;
    request_counts?: { total: number; completed: number; failed: number };
  };
  type Page = {
    object: string;
    data: { id: string }[];
    has_more: boolean;
    first_id: string | null;
    last_id: string | null;
  };

  async function create(body: Record<string, unknown>): Promise<Response> {
    return post(`${mock.url}/v1/batches`, {
      input_file_id: "file-shape",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      ...body,
    });
  }

  async function list(query: string): Promise<Response> {
    return fetch(`${mock.url}/v1/batches${query}`);
  }

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  it("echoes metadata and starts request_counts at zero", async () => {
    const res = await create({ metadata: { a: "b" } });
    expect(res.status).toBe(200);
    const created = (await res.json()) as Created;
    expect(created.metadata).toEqual({ a: "b" });
    expect(created.request_counts).toEqual({ total: 0, completed: 0, failed: 0 });

    const bare = (await (await create({})).json()) as Created;
    expect(bare.request_counts).toEqual({ total: 0, completed: 0, failed: 0 });
    expect("metadata" in bare).toBe(false);
  });

  it("rejects metadata that is not an object of strings", async () => {
    expect((await create({ metadata: { a: 1 } })).status).toBe(400);
    expect((await create({ metadata: "nope" })).status).toBe(400);
  });

  it("accepts /v1/responses as an endpoint", async () => {
    const res = await create({ endpoint: "/v1/responses" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Created).endpoint).toBe("/v1/responses");
  });

  it("pages the list newest-first with limit/after and reports has_more, first_id, last_id", async () => {
    // Created in order A, B, C; listed C, B, A, mirroring the fine-tuning list
    // and the newest-first input `paginate()` documents.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(((await (await create({})).json()) as Created).id);
    }
    const [a, b, c] = ids;

    const whole = (await (await list("")).json()) as Page;
    expect(whole.data.map((x) => x.id)).toEqual([c, b, a]);
    expect(whole.has_more).toBe(false);
    expect(whole.first_id).toBe(c);
    expect(whole.last_id).toBe(a);

    const first = (await (await list("?limit=2")).json()) as Page;
    expect(first.data.map((x) => x.id)).toEqual([c, b]);
    expect(first.has_more).toBe(true);
    expect(first.first_id).toBe(c);
    expect(first.last_id).toBe(b);

    const next = (await (await list(`?after=${first.last_id}&limit=2`)).json()) as Page;
    expect(next.data.map((x) => x.id)).toEqual([a]);
    expect(next.has_more).toBe(false);
    expect(next.first_id).toBe(a);
    expect(next.last_id).toBe(a);

    const middle = (await (await list(`?after=${c}&limit=1`)).json()) as Page;
    expect(middle.data.map((x) => x.id)).toEqual([b]);
    expect(middle.has_more).toBe(true);
  });

  it("returns null first_id/last_id on an empty page", async () => {
    const empty = (await (await list("")).json()) as Page;
    expect(empty.data).toEqual([]);
    expect(empty.has_more).toBe(false);
    expect(empty.first_id).toBeNull();
    expect(empty.last_id).toBeNull();
  });

  it("returns 400 for a bad limit or an unknown after cursor", async () => {
    expect((await list("?limit=abc")).status).toBe(400);
    expect((await list("?limit=0")).status).toBe(400);
    expect((await list("?after=batch-nope")).status).toBe(400);
  });
});
