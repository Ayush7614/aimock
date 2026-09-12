import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, ChatCompletionRequest } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { extractBoundary, extractFormField } from "../transcription.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  method: string,
  body?: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : undefined;
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
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function postMultipart(
  url: string,
  contentType: string,
  rawBody: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function chatRequest(content: string): ChatCompletionRequest {
  return { model: "gpt-4", stream: false, messages: [{ role: "user", content }] };
}

function multipartBody(boundary: string, fields: Record<string, string>): string {
  let out = "";
  for (const [name, value] of Object.entries(fields)) {
    out += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  out += `--${boundary}--\r\n`;
  return out;
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
// extractBoundary — quoted-string handling
// ---------------------------------------------------------------------------

describe("extractBoundary", () => {
  it("returns undefined for missing/empty content types", () => {
    expect(extractBoundary(undefined)).toBeUndefined();
    expect(extractBoundary("multipart/form-data")).toBeUndefined();
    expect(extractBoundary("")).toBeUndefined();
  });

  it("extracts bare boundaries", () => {
    expect(extractBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(extractBoundary("multipart/form-data; boundary=----WebKitFormBoundaryXYZ")).toBe(
      "----WebKitFormBoundaryXYZ",
    );
  });

  it("strips double quotes (RFC 2046 quoted-string)", () => {
    expect(extractBoundary('multipart/form-data; boundary="abc123"')).toBe("abc123");
    expect(extractBoundary('multipart/form-data; boundary="----WebKitFormBoundaryXYZ"')).toBe(
      "----WebKitFormBoundaryXYZ",
    );
  });

  it("strips single quotes", () => {
    expect(extractBoundary("multipart/form-data; boundary='abc123'")).toBe("abc123");
  });

  it("ignores trailing parameters after the boundary", () => {
    expect(extractBoundary("multipart/form-data; boundary=abc123; charset=utf-8")).toBe("abc123");
    expect(extractBoundary('multipart/form-data; boundary="abc123"; charset=utf-8')).toBe("abc123");
  });

  it("returns undefined for empty quoted boundaries", () => {
    expect(extractBoundary('multipart/form-data; boundary=""')).toBeUndefined();
  });

  it("round-trips through extractFormField", () => {
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe", stream: "true" });
    const quoted = extractBoundary('multipart/form-data; boundary="abc123"');
    expect(quoted).toBe("abc123");
    expect(extractFormField(raw, "model", quoted)).toBe("gpt-4o-transcribe");
    expect(extractFormField(raw, "stream", quoted)).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/audio/transcriptions with quoted boundaries (HTTP)
// ---------------------------------------------------------------------------

describe("transcription with quoted multipart boundary", () => {
  const fixtures: Fixture[] = [
    {
      match: { model: "gpt-4o-transcribe" },
      response: { transcription: { text: "quoted hello" } },
    },
  ];

  it("routes quoted-boundary requests to the right model fixture", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe" });
    const res = await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      'multipart/form-data; boundary="abc123"',
      raw,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("quoted hello");
  });

  it("keeps working with bare boundaries (no regression)", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe" });
    const res = await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      "multipart/form-data; boundary=abc123",
      raw,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("quoted hello");
  });

  it("journals the parsed model (not the whisper-1 fallback)", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe" });
    await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      'multipart/form-data; boundary="abc123"',
      raw,
    );
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect((entry!.body as ChatCompletionRequest).model).toBe("gpt-4o-transcribe");
  });
});

// ---------------------------------------------------------------------------
// POST /__aimock/error — status/body validation
// ---------------------------------------------------------------------------

describe("POST /__aimock/error validation", () => {
  // Fresh fixtures per test: queueing unshifts a one-shot entry into the
  // passed array, so sharing one array across tests would leak state.
  const makeFixtures = (): Fixture[] => [
    { match: { userMessage: "hello" }, response: { content: "Hi" } },
  ];

  async function chatHello(): Promise<{ status: number; body: string }> {
    return httpRequest(`${instance!.url}/v1/chat/completions`, "POST", chatRequest("hello"));
  }

  it("rejects out-of-range integer statuses", async () => {
    instance = await createServer(makeFixtures());
    for (const status of [99, 0, -1, 100, 101, 199, 1000, 600, 99.5]) {
      const res = await httpRequest(`${instance.url}/__aimock/error`, "POST", { status });
      expect(res.status).toBe(400);
      expect(res.body).toContain("status");
    }
    // Nothing was queued — normal traffic still works
    const ok = await chatHello();
    expect(ok.status).toBe(200);
  });

  it("rejects non-numeric statuses", async () => {
    instance = await createServer(makeFixtures());
    for (const status of ["500", null, true, {}, [500]]) {
      const res = await httpRequest(`${instance.url}/__aimock/error`, "POST", { status });
      expect(res.status).toBe(400);
    }
    const ok = await chatHello();
    expect(ok.status).toBe(200);
  });

  it("rejects non-object bodies and non-string body fields", async () => {
    instance = await createServer(makeFixtures());
    const badBodies: unknown[] = [
      "oops",
      42,
      [1],
      { message: 42 },
      { message: null },
      { type: 7 },
      { code: {} },
    ];
    for (const body of badBodies) {
      const res = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
        status: 500,
        body,
      });
      expect(res.status).toBe(400);
    }
    const ok = await chatHello();
    expect(ok.status).toBe(200);
  });

  it("rejects non-object top-level JSON (null/array)", async () => {
    instance = await createServer([]);
    for (const payload of [null, []]) {
      const res = await httpRequest(
        `${instance.url}/__aimock/error`,
        "POST",
        payload as unknown as object,
      );
      expect(res.status).toBe(400);
    }
  });

  it("still queues valid errors incl. boundary statuses 200 and 599", async () => {
    for (const status of [200, 418, 599]) {
      instance = await createServer(makeFixtures());
      const queueRes = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
        status,
        body: { message: "custom", type: "custom_type" },
      });
      expect(queueRes.status).toBe(200);
      const errRes = await chatHello();
      expect(errRes.status).toBe(status);
      await new Promise<void>((resolve) => {
        instance!.server.close(() => resolve());
      });
      instance = null;
    }
  });

  it("queues the default 500 error when status is omitted", async () => {
    instance = await createServer(makeFixtures());
    const queueRes = await httpRequest(`${instance.url}/__aimock/error`, "POST", {});
    expect(queueRes.status).toBe(200);
    const errRes = await chatHello();
    expect(errRes.status).toBe(500);
  });
});
