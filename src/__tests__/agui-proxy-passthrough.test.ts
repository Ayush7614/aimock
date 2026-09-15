import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { AGUIMock } from "../agui-mock.js";

// ---------------------------------------------------------------------------
// AG-UI proxy/record passthrough fidelity.
//
// The recorder used to rebuild the upstream request from scratch: it copied a
// hand-picked allowlist of two auth headers and re-serialized the parsed body.
// Any runtime whose contract lives in headers (session affinity, per-request
// agent configuration) lost it on the hop, and any caller that signed the
// payload (AWS SigV4 hashes the body) had its signature invalidated by the
// re-serialization. These tests pin the fixed behavior: inbound headers reach
// the upstream, and the body arrives byte-for-byte.
// ---------------------------------------------------------------------------

let upstream: http.Server | undefined;
let agui: AGUIMock | undefined;

afterEach(async () => {
  if (agui) {
    try {
      await agui.stop();
    } catch {
      /* already stopped */
    }
    agui = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
});

interface Captured {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

/** An upstream that captures exactly what it received, then answers with SSE. */
function createEchoUpstream(captured: Captured[]): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString() });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "ok" })}\n\n`,
        );
        res.end();
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** POST a raw body with arbitrary headers and drain the response. */
function post(
  url: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: { "Content-Length": Buffer.byteLength(rawBody), ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

async function startProxy(upstreamUrl: string): Promise<AGUIMock> {
  const mock = new AGUIMock({ port: 0, logLevel: "error" });
  mock.enableRecording({ upstream: upstreamUrl, proxyOnly: true });
  await mock.start();
  return mock;
}

describe("AG-UI proxy passthrough", () => {
  it("forwards arbitrary inbound headers to the upstream agent", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "u1", role: "user", content: "hello" }],
    });

    const resp = await post(agui.url, body, {
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
      "x-api-key": "key-123",
      "x-runtime-session-id": "session-abc",
      "x-runtime-agent-config": "cfg-xyz",
      "x-custom-tenant": "acme",
    });

    expect(resp.status).toBe(200);
    expect(captured).toHaveLength(1);

    const received = captured[0].headers;
    expect(received["authorization"]).toBe("Bearer token-123");
    expect(received["x-api-key"]).toBe("key-123");
    expect(received["x-runtime-session-id"]).toBe("session-abc");
    expect(received["x-runtime-agent-config"]).toBe("cfg-xyz");
    expect(received["x-custom-tenant"]).toBe("acme");
  });

  it("forwards the request body byte-for-byte", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    // Deliberately non-canonical JSON: unusual key order, extra whitespace, and
    // an unrecognized top-level field. Re-serializing from the parsed object
    // would normalize all three and change the payload hash.
    const body =
      '{\n  "runId":   "r1",\n  "threadId": "t1",\n  "vendorExtension": {"nested": [1, 2, 3]},\n  "messages": [{"id": "u1", "role": "user", "content": "hello"}]\n}';

    const resp = await post(agui.url, body, { "Content-Type": "application/json" });

    expect(resp.status).toBe(200);
    expect(captured[0].rawBody).toBe(body);
    expect(captured[0].headers["content-length"]).toBe(String(Buffer.byteLength(body)));
  });

  it("does not override content negotiation headers the caller set", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    await post(agui.url, body, {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "text/event-stream, application/json",
    });

    expect(captured[0].headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(captured[0].headers["accept"]).toBe("text/event-stream, application/json");
  });

  it("supplies content negotiation defaults when the caller omits them", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    await post(agui.url, body, {});

    expect(captured[0].headers["content-type"]).toBe("application/json");
    expect(captured[0].headers["accept"]).toBe("text/event-stream");
  });

  it("strips hop-by-hop and proxy-owned headers", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    await post(agui.url, body, {
      "Content-Type": "application/json",
      "x-test-id": "internal-only",
      "accept-encoding": "gzip",
      cookie: "session=nope",
    });

    const received = captured[0].headers;
    expect(received["x-test-id"]).toBeUndefined();
    expect(received["accept-encoding"]).toBeUndefined();
    expect(received["cookie"]).toBeUndefined();
    // The upstream host is the proxy target's, never the inbound one.
    expect(received["host"]).toBe(new URL(upstreamUrl).host);
  });
});
