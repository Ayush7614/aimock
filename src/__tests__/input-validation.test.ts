import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import {
  validateEmbeddingDimensions,
  normalizeStringArrayInput,
  normalizeTextInput,
  MAX_EMBEDDING_DIMENSIONS,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
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
    req.write(data);
    req.end();
  });
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

// ---------------------------------------------------------------------------
// Unit: validateEmbeddingDimensions
// ---------------------------------------------------------------------------

describe("validateEmbeddingDimensions", () => {
  it("defaults to 1536 when omitted", () => {
    expect(validateEmbeddingDimensions(undefined)).toBe(1536);
  });

  it("accepts boundary values 1 and MAX", () => {
    expect(validateEmbeddingDimensions(1)).toBe(1);
    expect(validateEmbeddingDimensions(MAX_EMBEDDING_DIMENSIONS)).toBe(MAX_EMBEDDING_DIMENSIONS);
  });

  it("rejects zero, negatives, floats, NaN, strings, null", () => {
    for (const bad of [0, -1, -1536, 1.5, Number.NaN, "1536", null, {}, []]) {
      expect(validateEmbeddingDimensions(bad)).toBeNull();
    }
  });

  it("rejects values above the cap", () => {
    expect(validateEmbeddingDimensions(MAX_EMBEDDING_DIMENSIONS + 1)).toBeNull();
    expect(validateEmbeddingDimensions(100000)).toBeNull();
    expect(validateEmbeddingDimensions(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("normalizeStringArrayInput", () => {
  it("wraps a single string", () => {
    expect(normalizeStringArrayInput("hi")).toEqual(["hi"]);
  });

  it("passes through string arrays", () => {
    expect(normalizeStringArrayInput(["a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects numbers, objects, mixed arrays, null", () => {
    expect(normalizeStringArrayInput(123)).toBeNull();
    expect(normalizeStringArrayInput({})).toBeNull();
    expect(normalizeStringArrayInput(null)).toBeNull();
    expect(normalizeStringArrayInput([123])).toBeNull();
    expect(normalizeStringArrayInput(["ok", 42])).toBeNull();
    expect(normalizeStringArrayInput(undefined)).toBeNull();
  });
});

describe("normalizeTextInput", () => {
  it("passes strings through and joins string arrays", () => {
    expect(normalizeTextInput("hi")).toBe("hi");
    expect(normalizeTextInput(["a", "b"])).toBe("a b");
  });

  it("rejects numbers, objects, mixed arrays", () => {
    expect(normalizeTextInput(123)).toBeNull();
    expect(normalizeTextInput({})).toBeNull();
    expect(normalizeTextInput([123])).toBeNull();
    expect(normalizeTextInput(["ok", null])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/embeddings — strict input validation
// ---------------------------------------------------------------------------

describe("POST /v1/embeddings strict validation", () => {
  it("returns 400 for numeric input (was 500 TypeError)", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: 123,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("invalid_request_error");
  });

  it("returns 400 for object input and mixed arrays", async () => {
    instance = await createServer([]);
    for (const bad of [{}, { text: "hi" }, [123], ["ok", 42], [null], true]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: bad,
      });
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 for empty input arrays", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: [],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing input", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid dimensions (was RangeError/OOM)", async () => {
    instance = await createServer([]);
    for (const dimensions of [0, -1, 1.5, "1536", 100000, Number.NaN, null]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: "hi",
        dimensions,
      });
      expect(res.status).toBe(400);
    }
  });

  it("accepts boundary dimensions 1 and 3072", async () => {
    instance = await createServer([]);
    const res1 = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
      dimensions: 1,
    });
    expect(res1.status).toBe(200);
    const resMax = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
      dimensions: MAX_EMBEDDING_DIMENSIONS,
    });
    expect(resMax.status).toBe(200);
  });

  it("still serves valid string and string-array inputs", async () => {
    instance = await createServer([]);
    const res1 = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hello world",
    });
    expect(res1.status).toBe(200);
    const res2 = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: ["hello", "world"],
    });
    expect(res2.status).toBe(200);
  });

  it("journals invalid inputs as 400 entries", async () => {
    instance = await createServer([]);
    await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: 123,
    });
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("/v1/embeddings");
    expect(entry!.response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/moderations — strict input validation
// ---------------------------------------------------------------------------

describe("POST /v1/moderations strict validation", () => {
  it("returns 400 for numeric/object input (was 500 TypeError)", async () => {
    instance = await createServer([]);
    for (const bad of [123, {}, { text: "hi" }, true]) {
      const res = await post(`${instance.url}/v1/moderations`, { input: bad });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("invalid_request_error");
    }
  });

  it("returns 400 for arrays containing non-strings", async () => {
    instance = await createServer([]);
    for (const bad of [[123], ["ok", 42], [null]]) {
      const res = await post(`${instance.url}/v1/moderations`, { input: bad });
      expect(res.status).toBe(400);
    }
  });

  it("still serves valid string, array, and missing inputs", async () => {
    instance = await createServer([]);
    for (const body of [{ input: "hello" }, { input: ["a", "b"] }, {}]) {
      const res = await post(`${instance.url}/v1/moderations`, body);
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /search — strict query validation
// ---------------------------------------------------------------------------

describe("POST /search strict validation", () => {
  it("returns 400 for numeric/object query (was 500 TypeError)", async () => {
    instance = await createServer([]);
    for (const bad of [123, {}, { q: 1 }, true]) {
      const res = await post(`${instance.url}/search`, { query: bad });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("invalid_request_error");
    }
  });

  it("returns 400 for arrays containing non-strings", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/search`, { query: [123] });
    expect(res.status).toBe(400);
  });

  it("still serves valid and missing queries", async () => {
    instance = await createServer([]);
    const res1 = await post(`${instance.url}/search`, { query: "capital of france" });
    expect(res1.status).toBe(200);
    const res2 = await post(`${instance.url}/search`, {});
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /v2/rerank — strict query validation
// ---------------------------------------------------------------------------

describe("POST /v2/rerank strict validation", () => {
  it("returns 400 for numeric/object query (was 500 TypeError)", async () => {
    instance = await createServer([]);
    for (const bad of [123, {}, true]) {
      const res = await post(`${instance.url}/v2/rerank`, { query: bad });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("invalid_request_error");
    }
  });

  it("still serves valid queries", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/rerank`, { query: "best pizza" });
    expect(res.status).toBe(200);
  });
});
