import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { clearFileStore } from "../files.js";
import { clearVectorStoreStore } from "../vector-stores.js";
import { normalizePathLabel } from "../metrics.js";

async function postJson(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function uploadFile(mockUrl: string, filename: string, content: string): Promise<string> {
  const res = await postJson(`${mockUrl}/v1/files`, {
    filename,
    purpose: "assistants",
    content,
  });
  expect(res.status).toBe(200);
  const obj = (await res.json()) as { id: string };
  return obj.id;
}

describe("Vector Stores API mock", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearFileStore();
    clearVectorStoreStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
    clearVectorStoreStore();
  });

  it("creates, retrieves, modifies and deletes a store", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/vector_stores`, { name: "rag-docs" })
    ).json()) as {
      id: string;
      object: string;
      name: string;
      status: string;
      usage_bytes: number;
      file_counts: { total: number; completed: number };
      metadata: null;
    };
    expect(created.id.startsWith("vs_")).toBe(true);
    expect(created.object).toBe("vector_store");
    expect(created.name).toBe("rag-docs");
    expect(created.status).toBe("completed");
    expect(created.usage_bytes).toBe(0);
    expect(created.file_counts.total).toBe(0);

    const got = (await (await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).json()) as {
      id: string;
      name: string;
    };
    expect(got.id).toBe(created.id);

    const modified = (await (
      await postJson(`${mock.url}/v1/vector_stores/${created.id}`, {
        name: "renamed",
        metadata: { team: "search" },
      })
    ).json()) as { name: string; metadata: Record<string, string> };
    expect(modified.name).toBe("renamed");
    expect(modified.metadata).toEqual({ team: "search" });

    const del = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}`, { method: "DELETE" })
    ).json()) as { object: string; deleted: boolean };
    expect(del.object).toBe("vector_store.deleted");
    expect(del.deleted).toBe(true);
    expect((await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).status).toBe(404);
  });

  it("creates a store with file_ids and completes file ingestion on poll", async () => {
    const fileId = await uploadFile(mock.url, "doc.txt", "hello world");
    const created = (await (
      await postJson(`${mock.url}/v1/vector_stores`, { name: "with-files", file_ids: [fileId] })
    ).json()) as {
      id: string;
      status: string;
      file_counts: { total: number; in_progress: number };
    };
    expect(created.file_counts.total).toBe(1);

    const first = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}/files/${fileId}`)
    ).json()) as { status: string };
    expect(first.status).toBe("in_progress");

    const second = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}/files/${fileId}`)
    ).json()) as { status: string; usage_bytes: number };
    expect(second.status).toBe("completed");
    expect(second.usage_bytes).toBeGreaterThan(0);

    // Terminal file reads are stable.
    const third = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}/files/${fileId}`)
    ).json()) as { status: string };
    expect(third.status).toBe("completed");

    const store = (await (await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).json()) as {
      status: string;
      usage_bytes: number;
    };
    expect(store.status).toBe("completed");
    expect(store.usage_bytes).toBeGreaterThan(0);
  });

  it("attaches, lists, filters and detaches files", async () => {
    const store = (await (
      await postJson(`${mock.url}/v1/vector_stores`, { name: "s" })
    ).json()) as { id: string };
    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");

    for (const fileId of [a, b]) {
      const res = await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, {
        file_id: fileId,
      });
      expect(res.status).toBe(200);
    }

    // Complete one file so the filter has something to split on.
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${a}`);
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${a}`);

    const all = (await (await fetch(`${mock.url}/v1/vector_stores/${store.id}/files`)).json()) as {
      object: string;
      data: { id: string }[];
      has_more: boolean;
    };
    expect(all.object).toBe("list");
    expect(all.data.map((d) => d.id)).toEqual(expect.arrayContaining([a, b]));

    const done = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files?filter=completed`)
    ).json()) as { data: { id: string }[] };
    expect(done.data.map((d) => d.id)).toContain(a);
    expect(done.data.map((d) => d.id)).not.toContain(b);

    const pending = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files?filter=in_progress`)
    ).json()) as { data: { id: string }[] };
    expect(pending.data.map((d) => d.id)).toContain(b);

    const detached = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${b}`, { method: "DELETE" })
    ).json()) as { object: string; deleted: boolean };
    expect(detached.object).toBe("vector_store.file.deleted");
    expect(detached.deleted).toBe(true);
    expect((await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${b}`)).status).toBe(404);
  });

  it("rejects duplicate attaches, unknown files and unknown stores", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const fileId = await uploadFile(mock.url, "d.txt", "ddd");
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: fileId }))
        .status,
    ).toBe(200);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: fileId }))
        .status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: "file-nope" }))
        .status,
    ).toBe(404);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/vs_nope/files`, { file_id: fileId })).status,
    ).toBe(404);
    expect((await fetch(`${mock.url}/v1/vector_stores/vs_nope`)).status).toBe(404);
    expect((await fetch(`${mock.url}/v1/vector_stores/vs_nope`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("drives file batches through poll progression and cancel", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");

    const batch = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/file_batches`, { file_ids: [a, b] })
    ).json()) as { id: string; status: string; file_counts: { total: number } };
    expect(batch.id.startsWith("vsfb_")).toBe(true);
    expect(batch.status).toBe("in_progress");
    expect(batch.file_counts.total).toBe(2);

    const first = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}`)
    ).json()) as { status: string };
    expect(first.status).toBe("in_progress");

    const second = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}`)
    ).json()) as { status: string; file_counts: { completed: number } };
    expect(second.status).toBe("completed");
    expect(second.file_counts.completed).toBe(2);

    const members = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}/files`)
    ).json()) as { data: { id: string }[] };
    expect(members.data.map((d) => d.id)).toEqual(expect.arrayContaining([a, b]));

    // Cancel a live batch, then watch it land on cancelled.
    const c = await uploadFile(mock.url, "c.txt", "ccc");
    const live = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/file_batches`, { file_ids: [c] })
    ).json()) as { id: string };
    const cancelling = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${live.id}/cancel`, {})
    ).json()) as { status: string };
    expect(cancelling.status).toBe("cancelling");
    const cancelled = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${live.id}`)
    ).json()) as { status: string };
    expect(cancelled.status).toBe("cancelled");

    // Cancelling a terminal batch is a 400.
    expect(
      (
        await postJson(
          `${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}/cancel`,
          {},
        )
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${mock.url}/v1/vector_stores/vs_nope/file_batches/${batch.id}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/vsfb_nope`)).status,
    ).toBe(404);
  });

  it("honors the outcome header and rejects unknown outcomes", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const bad = await postJson(
      `${mock.url}/v1/vector_stores/${store.id}/files`,
      { file_id: await uploadFile(mock.url, "x.txt", "xxx") },
      { "X-AIMock-Vector-Outcome": "bogus" },
    );
    expect(bad.status).toBe(400);

    const failedId = await uploadFile(mock.url, "f.txt", "fff");
    const failed = (await (
      await postJson(
        `${mock.url}/v1/vector_stores/${store.id}/files`,
        { file_id: failedId },
        { "X-AIMock-Vector-Outcome": "failed" },
      )
    ).json()) as { status: string };
    expect(failed.status).toBe("in_progress");
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${failedId}`);
    const landed = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${failedId}`)
    ).json()) as { status: string; last_error: { code: string } | null };
    expect(landed.status).toBe("failed");
    expect(landed.last_error?.code).toBe("mock_ingest_failed");

    const batchFailed = (await (
      await postJson(
        `${mock.url}/v1/vector_stores/${store.id}/file_batches`,
        { file_ids: [await uploadFile(mock.url, "g.txt", "ggg")] },
        { "X-AIMock-Vector-Outcome": "cancelled" },
      )
    ).json()) as { id: string; status: string };
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batchFailed.id}`);
    const batchLanded = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batchFailed.id}`)
    ).json()) as { status: string };
    expect(batchLanded.status).toBe("cancelled");
  });

  it("searches completed files deterministically with top-k and thresholds", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    // Empty store searches cleanly with no results.
    const empty = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query: "hello" })
    ).json()) as { object: string; data: unknown[] };
    expect(empty.object).toBe("vector_store.search_results_page");
    expect(empty.data).toEqual([]);

    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");
    await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: a });
    await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: b });
    for (const fileId of [a, b]) {
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${fileId}`);
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${fileId}`);
    }

    const first = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query: "pricing" })
    ).json()) as { data: { file_id: string; score: number; content: { text: string }[] }[] };
    expect(first.data).toHaveLength(2);
    const second = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query: "pricing" })
    ).json()) as { data: { file_id: string }[] };
    // Deterministic ranking: same query, same order.
    expect(second.data.map((d) => d.file_id)).toEqual(first.data.map((d) => d.file_id));
    expect(first.data[0].content[0].text).toContain("pricing");

    const topOne = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
        query: "pricing",
        max_num_results: 1,
      })
    ).json()) as { data: unknown[] };
    expect(topOne.data).toHaveLength(1);

    const strict = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
        query: "pricing",
        ranking_options: { score_threshold: 0.9999 },
      })
    ).json()) as { data: unknown[] };
    expect(strict.data.length).toBeLessThanOrEqual(2);

    expect((await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {})).status).toBe(
      400,
    );
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
          query: "x",
          max_num_results: 99,
        })
      ).status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/vs_nope/search`, { query: "x" })).status,
    ).toBe(404);
  });

  it("validates bodies, metadata, expires_after, chunking and pagination", async () => {
    expect((await postJson(`${mock.url}/v1/vector_stores`, "nope")).status).toBe(400);
    expect((await postJson(`${mock.url}/v1/vector_stores`, { name: 42 })).status).toBe(400);
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores`, {
          metadata: { ["k".repeat(65)]: "v" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores`, { expires_after: { anchor: "x", days: 7 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores`, {
          expires_after: { anchor: "last_active_at", days: 0 },
        })
      ).status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores`, { chunking_strategy: { type: "weird" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores`, {
          chunking_strategy: {
            type: "static",
            static: { max_chunk_size_tokens: 50, chunk_overlap_tokens: 10 },
          },
        })
      ).status,
    ).toBe(400);

    const ok = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    expect((await postJson(`${mock.url}/v1/vector_stores/${ok.id}`, { name: 42 })).status).toBe(
      400,
    );

    expect((await fetch(`${mock.url}/v1/vector_stores?limit=0`)).status).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores?limit=101`)).status).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores?order=sideways`)).status).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores?after=nope`)).status).toBe(400);
    expect(
      (await fetch(`${mock.url}/v1/vector_stores?after=${ok.id}&before=${ok.id}`)).status,
    ).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores/${ok.id}/files?filter=bogus`)).status).toBe(
      400,
    );

    // Pagination walks newest-first with cursors.
    const second = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const page = (await (await fetch(`${mock.url}/v1/vector_stores?limit=1`)).json()) as {
      data: { id: string }[];
      first_id: string;
      last_id: string;
      has_more: boolean;
    };
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(second.id);
    expect(page.has_more).toBe(true);
    const next = (await (
      await fetch(`${mock.url}/v1/vector_stores?limit=1&after=${page.last_id}`)
    ).json()) as { data: { id: string }[] };
    expect(next.data.map((d) => d.id)).toContain(ok.id);
    const asc = (await (await fetch(`${mock.url}/v1/vector_stores?order=asc`)).json()) as {
      data: { id: string }[];
    };
    expect(asc.data[0].id).toBe(ok.id);
  });

  it("supports expires_after stamping and clearing", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/vector_stores`, {
        expires_after: { anchor: "last_active_at", days: 7 },
      })
    ).json()) as { id: string; expires_at: number; created_at: number };
    expect(created.expires_at).toBeGreaterThan(created.created_at);
    const cleared = (await (
      await postJson(`${mock.url}/v1/vector_stores/${created.id}`, { expires_after: null })
    ).json()) as { expires_at: null };
    expect(cleared.expires_at).toBeNull();
  });

  it("journals vector-stores traffic and resets clean", async () => {
    const created = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=vector-stores`)
    ).json()) as { service: string; response: { status: number } }[];
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((e) => e.service === "vector-stores")).toBe(true);

    const reset = await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect((await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).status).toBe(404);
    const list = (await (await fetch(`${mock.url}/v1/vector_stores`)).json()) as {
      data: unknown[];
    };
    expect(list.data).toEqual([]);
  });

  it("labels vector-stores paths for metrics without cardinality leaks", () => {
    expect(normalizePathLabel("/v1/vector_stores")).toBe("/v1/vector_stores");
    expect(normalizePathLabel("/v1/vector_stores/vs_abc")).toBe("/v1/vector_stores/{id}");
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/files/vsf_xyz")).toBe(
      "/v1/vector_stores/{id}/files/{fileId}",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/file_batches/vsfb_xyz")).toBe(
      "/v1/vector_stores/{id}/file_batches/{batchId}",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/file_batches/vsfb_xyz/cancel")).toBe(
      "/v1/vector_stores/{id}/file_batches/{batchId}/cancel",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/file_batches/vsfb_xyz/files")).toBe(
      "/v1/vector_stores/{id}/file_batches/{batchId}/files",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/search")).toBe(
      "/v1/vector_stores/{id}/search",
    );
  });
});
