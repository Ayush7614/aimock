import { describe, test, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

// ─── The doubled-prefix guard ───────────────────────────────────────────────
// `record.providers.byteplus` is an ORIGIN: every BytePlus code path (video
// submit/poll via resolveUpstreamUrl, plus the chat and images proxies, which
// relay the client's raw `req.url`) appends the full `/api/v3/...` path itself.
// BytePlus's own published OpenAI-SDK `base_url` is
// `https://ark.<region>.bytepluses.com/api/v3`, so pasting that into
// `--provider-byteplus` composes `/api/v3/api/v3/...` — observed, before this
// guard existed, as
//   ["/api/v3/api/v3/contents/generations/tasks", "/api/v3/api/v3/chat/completions"]
// on a stub upstream. Every such request fails upstream, and the operator sees
// a relayed 404 rather than the cause. A doc note is not a guard, so the
// mis-shaped base is rejected at startup.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-byteplus-base-"));
}

async function startStubOrigin(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("BytePlus provider base — doubled /api/v3 prefix", () => {
  let mock: LLMock | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  for (const suffix of ["/api/v3", "/api/v3/"]) {
    test(`a base ending in "${suffix}" is rejected at startup with an actionable message`, async () => {
      dir = tmpDir();
      mock = new LLMock({
        port: 0,
        record: {
          providers: { byteplus: `https://ark.ap-southeast.bytepluses.com${suffix}` },
          fixturePath: dir,
        },
      });
      const started = mock;
      mock = undefined;
      try {
        await expect(started.start()).rejects.toThrow(
          /record\.providers\.byteplus .*\/api\/v3.*ORIGIN/s,
        );
      } finally {
        // Only reached if the guard regressed and the server really started.
        await started.stop().catch(() => undefined);
      }
    });
  }

  test("an ORIGIN-only base still starts and is left untouched", async () => {
    const upstream = await startStubOrigin();
    try {
      dir = tmpDir();
      mock = new LLMock({
        port: 0,
        record: { providers: { byteplus: upstream.url }, fixturePath: dir },
      });
      await mock.start();
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await upstream.close();
    }
  });

  test("a base whose path merely CONTAINS api/v3 mid-path is not rejected", async () => {
    const upstream = await startStubOrigin();
    try {
      dir = tmpDir();
      mock = new LLMock({
        port: 0,
        record: { providers: { byteplus: `${upstream.url}/api/v3-proxy/edge` }, fixturePath: dir },
      });
      await mock.start();
      expect(mock.url).toBeTruthy();
    } finally {
      await upstream.close();
    }
  });

  test("the guard is scoped to byteplus — another provider may end in /api/v3", async () => {
    const upstream = await startStubOrigin();
    try {
      dir = tmpDir();
      mock = new LLMock({
        port: 0,
        record: { providers: { openai: `${upstream.url}/api/v3` }, fixturePath: dir },
      });
      await mock.start();
      expect(mock.url).toBeTruthy();
    } finally {
      await upstream.close();
    }
  });
});
