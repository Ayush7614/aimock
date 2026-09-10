import { describe, test, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

// ─── Fake Ark upstream ──────────────────────────────────────────────────────
// A real http.createServer on 127.0.0.1:0 implementing the Ark data plane:
// the two task endpoints plus the OpenAI-compatible chat/images surfaces. It
// records every path it was asked for, which is what pins the URL-composition
// decision (an origin-only configured base + a handler-owned path prefix).

/** A parsed Ark body; loose on purpose (see the replay suite's note). */
type ArkBody = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One entry as persisted to disk by the recorder. */
interface RecordedFixture {
  match: Record<string, unknown>;
  response: { json: ArkBody };
}

const MODEL = "seedance-1-0-pro-fast-251015";
const SUBMIT = "/api/v3/contents/generations/tasks";
const UPSTREAM_TASK_ID = "cgt-upstream-1";

interface ArkUpstreamOptions {
  /** Widened past the vendor's four so an UNRECOGNIZED terminal state is testable. */
  finalStatus?: string;
  /**
   * Corrupt the terminal poll body's `status` the way only a MALFORMED upstream
   * could: drop it entirely, or send a number. Neither is a shape Ark is known
   * to emit — this exists solely to pin the handler's robustness to it.
   */
  malformedTerminalStatus?: "omit" | "numeric";
  pollsBeforeTerminal?: number;
  submitHttpStatus?: number;
  pollHttpStatus?: number;
  submitBody?: unknown;
  extraTaskFields?: Record<string, unknown>;
  chatSse?: boolean;
}

interface ArkUpstream {
  url: string;
  close: () => Promise<void>;
  paths: { submit: string[]; poll: string[]; chat: string[]; images: string[] };
  lastHeaders: { submit?: http.IncomingHttpHeaders; poll?: http.IncomingHttpHeaders };
  lastSubmitBody?: unknown;
}

function startArkUpstream(opts: ArkUpstreamOptions = {}): Promise<ArkUpstream> {
  const finalStatus = opts.finalStatus ?? "succeeded";
  const pollsBeforeTerminal = opts.pollsBeforeTerminal ?? 0;
  const paths: ArkUpstream["paths"] = { submit: [], poll: [], chat: [], images: [] };
  const lastHeaders: ArkUpstream["lastHeaders"] = {};
  let pollCount = 0;
  const state: { lastSubmitBody?: unknown } = {};

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const url = new URL(req.url ?? "/", "http://stub");
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };

        if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
          paths.chat.push(url.pathname);
          if (opts.chatSse) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(
              'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                MODEL +
                '","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
            );
            res.write(
              'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                MODEL +
                '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          send(200, {
            id: "chatcmpl-ark",
            object: "chat.completion",
            created: 1,
            model: MODEL,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi from ark" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
          return;
        }

        if (req.method === "POST" && url.pathname.endsWith("/images/generations")) {
          paths.images.push(url.pathname);
          send(200, { created: 1, data: [{ url: "https://ark/img.png" }] });
          return;
        }

        if (req.method === "POST" && url.pathname.endsWith("/contents/generations/tasks")) {
          paths.submit.push(url.pathname);
          lastHeaders.submit = req.headers;
          try {
            state.lastSubmitBody = JSON.parse(raw);
          } catch {
            state.lastSubmitBody = raw;
          }
          if (opts.submitHttpStatus && opts.submitHttpStatus !== 200) {
            send(opts.submitHttpStatus, { error: { message: "upstream refused" } });
            return;
          }
          send(200, opts.submitBody ?? { id: UPSTREAM_TASK_ID });
          return;
        }

        if (req.method === "GET" && url.pathname.includes("/contents/generations/tasks/")) {
          paths.poll.push(url.pathname);
          lastHeaders.poll = req.headers;
          if (opts.pollHttpStatus && opts.pollHttpStatus !== 200) {
            send(opts.pollHttpStatus, {
              error: { code: "InvalidEndpointOrModel.NotFound", message: "task not found" },
            });
            return;
          }
          pollCount++;
          if (pollCount <= pollsBeforeTerminal) {
            send(200, {
              id: UPSTREAM_TASK_ID,
              model: MODEL,
              status: "running",
              created_at: 1785000000,
              updated_at: 1785000010,
            });
            return;
          }
          const terminal: Record<string, unknown> = {
            id: UPSTREAM_TASK_ID,
            model: MODEL,
            status: finalStatus,
            created_at: 1785000000,
            updated_at: Math.floor(Date.now() / 1000),
            framespersecond: 24,
            ...(opts.extraTaskFields ?? {}),
          };
          if (finalStatus === "succeeded") {
            terminal.content = { video_url: "https://ark-content/out.mp4" };
            terminal.usage = { completion_tokens: 129600, total_tokens: 129600 };
          } else if (finalStatus === "failed") {
            terminal.error = { code: "QuotaExceeded", message: "no quota" };
          }
          if (opts.malformedTerminalStatus === "omit") delete terminal.status;
          else if (opts.malformedTerminalStatus === "numeric") terminal.status = 123;
          send(200, terminal);
          return;
        }

        send(404, { error: { message: "stub: unknown path " + url.pathname } });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        reject(new Error("no address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        paths,
        lastHeaders,
        get lastSubmitBody() {
          return state.lastSubmitBody;
        },
      } as ArkUpstream);
    });
  });
}

function tmpFixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-byteplus-"));
}

function readFixtures(dir: string): RecordedFixture[] {
  const out: RecordedFixture[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) {
        const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
        // Recorded files wrap their entries in { fixtures: [...] }.
        const entries = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.fixtures)
            ? parsed.fixtures
            : [parsed];
        out.push(...entries);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

async function submit(
  mock: LLMock,
  body: unknown,
  p = SUBMIT,
): Promise<{ status: number; json: ArkBody }> {
  const res = await fetch(`${mock.url}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const goBody = { model: MODEL, content: [{ type: "text", text: "a guitar" }] };

// ─── URL composition (D1) — the pin on the central decision ─────────────────

describe("BytePlus video record — URL composition", () => {
  let mock: LLMock | undefined;
  let upstream: ArkUpstream | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    await upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = undefined;
  });

  test("an ORIGIN-ONLY configured base yields the full /api/v3 path upstream", async () => {
    // record.providers.byteplus is an ORIGIN; the handler owns the whole path
    // including the /api/v3 prefix. This is the repo's uniform convention: the
    // async-video handlers pass a handler-owned constant to resolveUpstreamUrl.
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();

    const res = await submit(mock, goBody);
    expect(res.status).toBe(200);
    expect(upstream.paths.submit).toEqual([SUBMIT]);

    await fetch(`${mock.url}${SUBMIT}/${res.json.id}`);
    expect(upstream.paths.poll).toEqual([`${SUBMIT}/${UPSTREAM_TASK_ID}`]);
  });

  test("composition is identical whether the client sends the /api/v3 prefix or not", async () => {
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();

    const res = await submit(mock, goBody, "/contents/generations/tasks");
    expect(res.status).toBe(200);
    // The client's prefix is irrelevant to what aimock sends upstream.
    expect(upstream.paths.submit).toEqual([SUBMIT]);
  });

  test("the upstream task id never escapes to the client", async () => {
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();
    const res = await submit(mock, goBody);
    expect(res.json.id).not.toBe(UPSTREAM_TASK_ID);
    expect(res.json.id.startsWith("cgt-")).toBe(true);

    const poll = await (await fetch(`${mock.url}${SUBMIT}/${res.json.id}`)).json();
    expect(poll.id).toBe(res.json.id);
  });
});

// ─── Submit + poll proxy behavior ───────────────────────────────────────────

describe("BytePlus video record — proxy behavior", () => {
  let mock: LLMock | undefined;
  let upstream: ArkUpstream | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    await upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = undefined;
  });

  async function boot(opts: ArkUpstreamOptions = {}, extra: Record<string, unknown> = {}) {
    upstream = await startArkUpstream(opts);
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir, ...extra },
    });
    await mock.start();
  }

  test("the raw submit body is forwarded verbatim, model-specific options intact", async () => {
    // Ark rejects an inapplicable option outright rather than ignoring it, so
    // anything aimock drops or rewrites becomes a live 400.
    await boot();
    await submit(mock!, {
      ...goBody,
      draft: true,
      service_tier: "flex",
      priority: 7,
      execution_expires_after: 600,
    });
    expect(upstream!.lastSubmitBody).toMatchObject({
      model: MODEL,
      draft: true,
      service_tier: "flex",
      priority: 7,
      execution_expires_after: 600,
    });
  });

  test("the configured provider key is injected as a bearer", async () => {
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: {
        providers: { byteplus: upstream.url },
        providerKeys: { byteplus: "ark-secret" },
        fixturePath: dir,
      },
    });
    await mock.start();
    await submit(mock, goBody);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer ark-secret");
  });

  test("no configured upstream warns and falls through to 404", async () => {
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openai: "https://api.openai.com" }, fixturePath: dir },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await submit(mock, goBody);
    expect(res.status).toBe(404);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes('provider "byteplus"'))).toBe(true);
    warnSpy.mockRestore();
  });

  test("a 401 from the upstream submit is relayed verbatim", async () => {
    await boot({ submitHttpStatus: 401 });
    const res = await submit(mock!, goBody);
    expect(res.status).toBe(401);
  });

  test("a submit response with no id is a 502", async () => {
    await boot({ submitBody: { nope: true } });
    const res = await submit(mock!, goBody);
    expect(res.status).toBe(502);
  });

  test("an upstream 404 on POLL is relayed as 404, not converted to 502", async () => {
    // The client has a deliberate 404 branch that keeps Ark's own code/message;
    // converting it to 502 would make record mode diverge from live Ark for the
    // one case that branch exists to serve.
    await boot({ pollHttpStatus: 404 });
    const res = await submit(mock!, goBody);
    const pollRes = await fetch(`${mock!.url}${SUBMIT}/${res.json.id}`);
    expect(pollRes.status).toBe(404);
    const body = await pollRes.json();
    expect(body.error.code).toBe("InvalidEndpointOrModel.NotFound");
  });

  test("strict mode refuses the upstream poll without touching the network", async () => {
    await boot();
    const res = await submit(mock!, goBody);
    const before = upstream!.paths.poll.length;
    const pollRes = await fetch(`${mock!.url}${SUBMIT}/${res.json.id}`, {
      headers: { "x-aimock-strict": "true" },
    });
    expect(pollRes.status).toBe(503);
    expect(upstream!.paths.poll.length).toBe(before);
  });
});

// ─── Terminal capture ───────────────────────────────────────────────────────

describe("BytePlus video record — terminal capture", () => {
  let mock: LLMock | undefined;
  let upstream: ArkUpstream | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    await upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = undefined;
  });

  test.each(["succeeded", "failed", "cancelled", "expired"] as const)(
    "%s is captured as a fixture — all four terminal states, no warn-and-drop",
    async (finalStatus) => {
      // The payoff of storing the envelope rather than a VideoResponse: an
      // engineer who cancels a task mid-record gets an artifact, not a warning
      // and an empty fixture directory.
      upstream = await startArkUpstream({ finalStatus });
      dir = tmpFixtureDir();
      mock = new LLMock({
        port: 0,
        record: { providers: { byteplus: upstream.url }, fixturePath: dir },
      });
      await mock.start();

      const res = await submit(mock, goBody);
      await fetch(`${mock.url}${SUBMIT}/${res.json.id}`);
      await mock.stop();
      mock = undefined;

      const fixtures = readFixtures(dir);
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].response.json.status).toBe(finalStatus);
      // The upstream id is removed at capture — replay stamps its own, and a
      // real Ark task id has no business in a committed artifact.
      expect(fixtures[0].response.json.id).toBeUndefined();
      expect(fixtures[0].match.endpoint).toBe("video");
      expect(fixtures[0].response.json.framespersecond).toBe(24);
    },
  );

  test("proxyOnly persists nothing", async () => {
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir, proxyOnly: true },
    });
    await mock.start();
    const res = await submit(mock, goBody);
    await fetch(`${mock.url}${SUBMIT}/${res.json.id}`);
    expect(readFixtures(dir)).toHaveLength(0);
  });

  test("round trip: record, then replay the written fixture and get the same body", async () => {
    upstream = await startArkUpstream({ pollsBeforeTerminal: 1 });
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();
    const rec = await submit(mock, goBody);
    await fetch(`${mock.url}${SUBMIT}/${rec.json.id}`); // running
    const recordedTerminal = await (await fetch(`${mock.url}${SUBMIT}/${rec.json.id}`)).json();
    await mock.stop();
    mock = undefined;

    const written = readFixtures(dir);
    expect(written).toHaveLength(1);

    // Replay session against the written fixture.
    const replay = new LLMock({ port: 0 });
    replay.addFixture(written[0]);
    await replay.start();
    try {
      const res = await submit(replay, goBody);
      expect(res.status).toBe(200);
      const body = await (await fetch(`${replay.url}${SUBMIT}/${res.json.id}`)).json();
      // Identical to the recorded terminal body except for the mock-issued id.
      expect({ ...body, id: undefined }).toEqual({ ...recordedTerminal, id: undefined });
      expect(body.id).toBe(res.json.id);
    } finally {
      await replay.stop();
    }
  });
});

// ─── Chat + images attribution (§6.4) ───────────────────────────────────────

describe("BytePlus chat/images attribution", () => {
  let mock: LLMock | undefined;
  let upstream: ArkUpstream | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    await upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = undefined;
  });

  async function chat(body: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`${mock!.url}/api/v3/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello ark" }],
        ...body,
      }),
    });
  }

  test("with byteplus configured, chat composes /api/v3/chat/completions and records as byteplus", async () => {
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();
    expect((await chat()).status).toBe(200);
    // Not /v1/..., and not a doubled prefix.
    expect(upstream.paths.chat).toEqual(["/api/v3/chat/completions"]);
    await mock.stop();
    mock = undefined;
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else files.push(e.name);
      }
    };
    walk(dir);
    expect(files.some((f) => f.startsWith("byteplus-"))).toBe(true);
  });

  test("images compose /api/v3/images/generations under the byteplus key", async () => {
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();
    const res = await fetch(`${mock.url}/api/v3/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream-4-0-250828", prompt: "a cat" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.paths.images).toEqual(["/api/v3/images/generations"]);
  });

  test("REGRESSION: with byteplus UNSET, /api/v3 chat still attributes to openai", async () => {
    // The gate. A path prefix is not evidence of a vendor — an OpenAI-compatible
    // vendor served under /api/v3 must keep working exactly as it does today.
    // This test must fail against an ungated implementation.
    upstream = await startArkUpstream();
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { openai: upstream.url }, fixturePath: dir },
    });
    await mock.start();
    expect((await chat()).status).toBe(200);
    await mock.stop();
    mock = undefined;

    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else files.push(e.name);
      }
    };
    walk(dir);
    expect(files.some((f) => f.startsWith("openai-"))).toBe(true);
    expect(files.some((f) => f.startsWith("byteplus-"))).toBe(false);
  });

  test("a recorded byteplus SSE stream collapses with no 'unknown SSE provider' warn", async () => {
    upstream = await startArkUpstream({ chatSse: true });
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await chat({ stream: true });
    expect(res.status).toBe(200);
    await res.text();
    await mock.stop();
    mock = undefined;
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("unknown SSE provider"))).toBe(
      false,
    );
    warnSpy.mockRestore();
  });
});

// ─── Proxy failure paths ────────────────────────────────────────────────────

describe("BytePlus video record — upstream failure handling", () => {
  let mock: LLMock | undefined;
  let upstream: http.Server | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = undefined;
  });

  /** An upstream that answers submit normally but is configurable on poll. */
  async function bootWith(
    pollHandler: (res: http.ServerResponse) => void,
  ): Promise<{ id: string }> {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: UPSTREAM_TASK_ID }));
          return;
        }
        pollHandler(res);
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", () => r()));
    const port = (upstream!.address() as AddressInfo).port;
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { byteplus: `http://127.0.0.1:${port}` }, fixturePath: dir },
    });
    await mock.start();
    const res = await submit(mock, goBody);
    expect(res.status).toBe(200);
    return { id: res.json.id };
  }

  test("a non-JSON poll response is a 502, not a malformed relay", async () => {
    const { id } = await bootWith((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>gateway</html>");
    });
    const res = await fetch(`${mock!.url}${SUBMIT}/${id}`);
    expect(res.status).toBe(502);
  });

  test("a poll response that is a JSON scalar is a 502", async () => {
    const { id } = await bootWith((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('"just a string"');
    });
    expect((await fetch(`${mock!.url}${SUBMIT}/${id}`)).status).toBe(502);
  });

  test("an upstream 5xx on poll becomes a 502 (unlike a 4xx, which relays)", async () => {
    const { id } = await bootWith((res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream down" } }));
    });
    expect((await fetch(`${mock!.url}${SUBMIT}/${id}`)).status).toBe(502);
  });

  test("a fixtures reset mid-flight discards the capture and persists nothing", async () => {
    const { id } = await bootWith((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: UPSTREAM_TASK_ID,
          model: MODEL,
          status: "succeeded",
          created_at: 1,
          updated_at: 2,
          content: { video_url: "https://x/v.mp4" },
        }),
      );
    });
    // A full reset clears the job map and bumps its world generation, which
    // invalidates the in-flight job: its poll must 404 into the new world and
    // no capture may be persisted into a world the job no longer belongs to.
    // (clearFixtures() alone does NOT do this — only performFullReset does.)
    mock!.reset();
    const res = await fetch(`${mock!.url}${SUBMIT}/${id}`);
    // The job is gone with the old world, so the poll 404s and nothing lands.
    expect(res.status).toBe(404);
    expect(readFixtures(dir!)).toHaveLength(0);
  });
});

// ─── Capture correctness: signalling, serialization, terminal vocabulary ────

describe("BytePlus video record — capture correctness", () => {
  let mock: LLMock | undefined;
  let upstream: ArkUpstream | undefined;
  let dir: string | undefined;
  let blockerDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    await upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (blockerDir) fs.rmSync(blockerDir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = blockerDir = undefined;
  });

  test("a persist failure on the terminal poll sets X-AIMock-Record-Error", async () => {
    // A full disk, a bad fixturePath, or a permissions error must reach the
    // client on the wire the way every sibling video surface signals it — not
    // only as a log line behind a 200 indistinguishable from a clean record.
    upstream = await startArkUpstream();
    blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-byteplus-pin-"));
    const blockerFile = path.join(blockerDir, "not-a-dir");
    fs.writeFileSync(blockerFile, "in the way");
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { byteplus: upstream.url }, fixturePath: blockerFile },
    });
    await mock.start();

    const res = await submit(mock, goBody);
    expect(res.status).toBe(200);
    const poll = await fetch(`${mock.url}${SUBMIT}/${res.json.id}`);
    expect(poll.status).toBe(200);
    expect(((await poll.json()) as ArkBody).status).toBe("succeeded");
    expect(poll.headers.get("x-aimock-record-error")).toBeTruthy();
  });

  test("two CONCURRENT terminal polls persist exactly one fixture", async () => {
    // The single job-map identity gate is what serializes a double capture:
    // poll B resumes from its upstream await after poll A already swapped the
    // replay job into the map, so B relays and persists nothing. Without the
    // gate B captures a second, duplicate fixture. It must also do this
    // QUIETLY — a concurrent poll is ordinary, not an error worth a log line.
    let pollsSeen = 0;
    let releaseBoth: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const terminal = {
      id: UPSTREAM_TASK_ID,
      model: MODEL,
      status: "succeeded",
      created_at: 1785000000,
      updated_at: 1785000010,
      content: { video_url: "https://ark-content/out.mp4" },
    };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (body: unknown): void => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "POST") {
          send({ id: UPSTREAM_TASK_ID });
          return;
        }
        // Hold BOTH polls upstream until both have arrived, so they resume
        // into the capture path in the same tick window.
        pollsSeen++;
        if (pollsSeen >= 2) releaseBoth?.();
        void bothArrived.then(() => send(terminal));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    dir = tmpFixtureDir();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { byteplus: `http://127.0.0.1:${port}` }, fixturePath: dir },
    });
    await mock.start();

    const res = await submit(mock, goBody);
    expect(res.status).toBe(200);
    const [a, b] = await Promise.all([
      fetch(`${mock.url}${SUBMIT}/${res.json.id}`),
      fetch(`${mock.url}${SUBMIT}/${res.json.id}`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as ArkBody).status).toBe("succeeded");
    expect(((await b.json()) as ArkBody).status).toBe("succeeded");
    await new Promise<void>((r) => server.close(() => r()));

    expect(readFixtures(dir)).toHaveLength(1);
    expect(warnSpy.mock.calls.filter((c) => c.join(" ").includes("discarded"))).toHaveLength(0);
    warnSpy.mockRestore();
  });

  test("an UNRECOGNIZED terminal status is captured, not polled forever", async () => {
    // The terminal vocabulary is derived as "not queued and not running", so a
    // vendor-added terminal state records instead of silently proxying until
    // the client times out.
    upstream = await startArkUpstream({ finalStatus: "rejected" });
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();

    const res = await submit(mock, goBody);
    const poll = await (await fetch(`${mock.url}${SUBMIT}/${res.json.id}`)).json();
    expect((poll as ArkBody).status).toBe("rejected");

    const written = readFixtures(dir);
    expect(written).toHaveLength(1);
    expect(written[0].response.json.status).toBe("rejected");
    // The upstream id is still scrubbed on this branch.
    expect(written[0].response.json.id).toBeUndefined();
    // And a SECOND poll is served from the captured fixture, not proxied again.
    await fetch(`${mock.url}${SUBMIT}/${res.json.id}`);
    expect(upstream.paths.poll).toHaveLength(1);
  });

  test("queued and running are still proxied through, never captured", async () => {
    upstream = await startArkUpstream({ pollsBeforeTerminal: 2 });
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();

    const res = await submit(mock, goBody);
    for (let i = 0; i < 2; i++) {
      const body = (await (await fetch(`${mock.url}${SUBMIT}/${res.json.id}`)).json()) as ArkBody;
      expect(body.status).toBe("running");
    }
    expect(readFixtures(dir)).toHaveLength(0);
    const body = (await (await fetch(`${mock.url}${SUBMIT}/${res.json.id}`)).json()) as ArkBody;
    expect(body.status).toBe("succeeded");
    expect(readFixtures(dir)).toHaveLength(1);
  });
});

// ─── Malformed upstream status ──────────────────────────────────────────────
// A 2xx JSON object poll body whose `status` is absent or non-string is NOT a
// shape BytePlus Ark is known to emit; these pin robustness to it, nothing
// more. The pre-fix handler coerced such a body with `String(status ?? "")`,
// and because terminal is the COMPLEMENT of queued/running, the coerced value
// read as terminal. That captured the malformed envelope as a fixture and
// swapped the job to replay — after which every later poll 502s on that same
// envelope and the corrected upstream response is never fetched for the job.
// The status a capture stores must satisfy what replay demands of it: a
// non-empty string. Anything else is not terminal, so it is relayed and the
// job stays upstream-backed.

describe("BytePlus video record — a malformed upstream status is never captured", () => {
  let mock: LLMock | undefined;
  let upstream: ArkUpstream | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    await upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mock = upstream = undefined;
    dir = undefined;
  });

  test.each([
    ["absent", "omit" as const],
    ["numeric", "numeric" as const],
  ])(
    "a %s status keeps the job upstream-backed instead of persisting an unusable fixture",
    async (_label, malformedTerminalStatus) => {
      upstream = await startArkUpstream({ malformedTerminalStatus });
      dir = tmpFixtureDir();
      mock = new LLMock({
        port: 0,
        record: { providers: { byteplus: upstream.url }, fixturePath: dir },
      });
      await mock.start();

      const submitted = await submit(mock, goBody);
      expect(submitted.status).toBe(200);

      // Poll 1 relays the malformed body verbatim, as every non-terminal poll does.
      const first = await fetch(`${mock.url}${SUBMIT}/${submitted.json.id}`);
      expect(first.status).toBe(200);

      // Poll 2 must reach UPSTREAM again. Pre-fix it 502'd off a captured
      // replay envelope, and upstream was never asked a second time.
      const second = await fetch(`${mock.url}${SUBMIT}/${submitted.json.id}`);
      expect(second.status).toBe(200);
      expect(upstream.paths.poll.length).toBe(2);

      // Nothing unusable reached disk.
      expect(readFixtures(dir)).toEqual([]);
    },
  );

  test("a corrected upstream status on a LATER poll still records normally", async () => {
    // The point of not capturing: the job is still upstream-backed, so when the
    // upstream starts answering properly the recording happens as it should.
    // The helper closes over this object, so clearing the flag mid-test is what
    // "the upstream started answering properly" looks like on the wire.
    const upstreamOpts: ArkUpstreamOptions = { malformedTerminalStatus: "omit" };
    upstream = await startArkUpstream(upstreamOpts);
    dir = tmpFixtureDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { byteplus: upstream.url }, fixturePath: dir },
    });
    await mock.start();

    const submitted = await submit(mock, goBody);
    await fetch(`${mock.url}${SUBMIT}/${submitted.json.id}`);
    expect(readFixtures(dir)).toEqual([]);

    // Upstream is fixed mid-flight.
    upstreamOpts.malformedTerminalStatus = undefined;

    const recovered = await fetch(`${mock.url}${SUBMIT}/${submitted.json.id}`);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).status).toBe("succeeded");

    const fixtures = readFixtures(dir);
    expect(fixtures.length).toBe(1);
    expect(fixtures[0].response.json.status).toBe("succeeded");
  });
});
