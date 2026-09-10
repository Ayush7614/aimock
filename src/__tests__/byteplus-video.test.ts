import { describe, test, expect, afterEach, vi } from "vitest";
import { LLMock } from "../llmock.js";
import {
  BytePlusVideoJobMap,
  BYTEPLUS_VIDEO_MAX_ENTRIES,
  buildBytePlusMatchText,
} from "../byteplus-video.js";
import { BYTEPLUS_VIDEO_SUBMIT_RE, BYTEPLUS_VIDEO_STATUS_RE } from "../metrics.js";
import type { Fixture } from "../types.js";
import type { BytePlusVideoJob } from "../byteplus-video.js";

/**
 * A parsed Ark task/response body. Deliberately loose — this surface's whole
 * point is that arbitrary recorded fields survive, so the tests read it the way
 * a consumer would rather than through a type that would hide a dropped field.
 */
type ArkBody = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MODEL = "seedance-1-0-pro-fast-251015";
const SUBMIT = "/api/v3/contents/generations/tasks";

/** A terminal Ark task envelope, as `record` would have captured it (no `id`). */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    status: "succeeded",
    created_at: 1785000000,
    updated_at: Math.floor(Date.now() / 1000),
    content: { video_url: "https://ark-content.example.com/out.mp4" },
    usage: { completion_tokens: 129600, total_tokens: 129600 },
    ...over,
  };
}

function videoFixture(userMessage: string, json: Record<string, unknown>): Fixture {
  return { match: { userMessage, endpoint: "video", model: MODEL }, response: { json } };
}

async function submit(
  mock: LLMock,
  body: unknown,
  path = SUBMIT,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: ArkBody }> {
  const res = await fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function poll(
  mock: LLMock,
  id: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: ArkBody; text: string }> {
  const res = await fetch(`${mock.url}${SUBMIT}/${encodeURIComponent(id)}`, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
}

// ─── Job map ────────────────────────────────────────────────────────────────

describe("BytePlusVideoJobMap", () => {
  const stubJob = (id: string): BytePlusVideoJob => ({
    kind: "replay",
    id,
    phase: "terminal",
    pollCount: 0,
    pollsBeforeRunning: 0,
    pollsBeforeTerminal: 0,
    envelope: { status: "succeeded" },
    warned: {},
  });

  test("is exported with the bounded-entries constant and a world generation", () => {
    expect(BYTEPLUS_VIDEO_MAX_ENTRIES).toBe(10_000);
    const map = new BytePlusVideoJobMap();
    expect(map.size).toBe(0);
    expect(map.generation).toBe(0);
    map.clear();
    expect(map.generation).toBe(1);
  });

  test("evicts lazily on get once an entry is past its 1h TTL", () => {
    vi.useFakeTimers();
    try {
      const map = new BytePlusVideoJobMap();
      map.set("t:a", stubJob("a"));
      expect(map.get("t:a")).toBeDefined();
      vi.advanceTimersByTime(3_600_001);
      expect(map.get("t:a")).toBeUndefined();
      // The lazy eviction actually removed it rather than just hiding it.
      expect(map.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a set refreshes the TTL (delete-before-set), so a polled job survives", () => {
    vi.useFakeTimers();
    try {
      const map = new BytePlusVideoJobMap();
      map.set("t:a", stubJob("a"));
      vi.advanceTimersByTime(3_000_000);
      map.set("t:a", stubJob("a")); // a poll refreshes
      vi.advanceTimersByTime(3_000_000);
      expect(map.get("t:a")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("FIFO-evicts the oldest entries when over capacity", () => {
    const map = new BytePlusVideoJobMap();
    for (let i = 0; i < BYTEPLUS_VIDEO_MAX_ENTRIES + 5; i++) map.set(`t:${i}`, stubJob(String(i)));
    expect(map.size).toBe(BYTEPLUS_VIDEO_MAX_ENTRIES);
    expect(map.get("t:0")).toBeUndefined();
    expect(map.get("t:4")).toBeUndefined();
    expect(map.get(`t:${BYTEPLUS_VIDEO_MAX_ENTRIES + 4}`)).toBeDefined();
  });

  test("delete removes an entry and reports whether it was there", () => {
    const map = new BytePlusVideoJobMap();
    map.set("t:a", stubJob("a"));
    expect(map.delete("t:a")).toBe(true);
    expect(map.delete("t:a")).toBe(false);
  });
});

// ─── Route anchoring (§6.2) — the G5 pin ────────────────────────────────────

describe("route regexes are anchored, not wildcarded", () => {
  test("both supported client baseURL forms route", () => {
    expect(BYTEPLUS_VIDEO_SUBMIT_RE.test("/contents/generations/tasks")).toBe(true);
    expect(BYTEPLUS_VIDEO_SUBMIT_RE.test("/api/v3/contents/generations/tasks")).toBe(true);
    expect(BYTEPLUS_VIDEO_STATUS_RE.test("/contents/generations/tasks/cgt-1")).toBe(true);
    expect(BYTEPLUS_VIDEO_STATUS_RE.test("/api/v3/contents/generations/tasks/cgt-1")).toBe(true);
  });

  test("a /fal-prefixed path is NOT claimed — these routes run ahead of every fal branch", () => {
    // A tolerant prefix would take this path away from the fal proxy, which
    // dispatches ~1,100 lines later. That would be a live behavior change for a
    // shipped provider.
    expect(BYTEPLUS_VIDEO_SUBMIT_RE.test("/fal/contents/generations/tasks")).toBe(false);
    expect(BYTEPLUS_VIDEO_STATUS_RE.test("/fal/contents/generations/tasks/x")).toBe(false);
  });

  test("a doubled suffix cannot match the status RE", () => {
    expect(
      BYTEPLUS_VIDEO_STATUS_RE.test("/x/contents/generations/tasks/contents/generations/tasks"),
    ).toBe(false);
  });
});

// ─── Match key (§7.1) ───────────────────────────────────────────────────────

describe("buildBytePlusMatchText", () => {
  test("text-only content is the concatenated prompt plus an EMPTY media marker", () => {
    // The marker is unconditional so that no key can be a substring of another —
    // router.ts substring-matches userMessage, so a bare "a guitar" would have
    // shadowed the image-to-video key "a guitar\n[media: first_frame:…]".
    expect(buildBytePlusMatchText([{ type: "text", text: "a guitar" }])).toBe(
      "a guitar\n[media: ]",
    );
  });

  test("a text-less image-to-video job still yields a non-empty key", () => {
    // This is the collision the digest exists to prevent: without it the match
    // would be {endpoint, model} — a wildcard over every i2v job for the model.
    const key = buildBytePlusMatchText([
      { type: "image_url", image_url: { url: "https://x/first.png" } },
    ]);
    expect(key).not.toBe("");
    expect(key).toMatch(/^\[media: first_frame:[0-9a-f]{12}\]$/);
  });

  test("different media urls under the same prompt produce different keys", () => {
    const a = buildBytePlusMatchText([
      { type: "text", text: "same prompt" },
      { type: "image_url", image_url: { url: "https://x/a.png" } },
    ]);
    const b = buildBytePlusMatchText([
      { type: "text", text: "same prompt" },
      { type: "image_url", image_url: { url: "https://x/b.png" } },
    ]);
    expect(a).not.toBe(b);
    // Neither is a substring of the other, so router.ts's substring matching
    // cannot cross-match two RECORDED fixtures.
    expect(a.includes(b)).toBe(false);
    expect(b.includes(a)).toBe(false);
  });

  test("audio parts are digested, and a part with no resolvable url still contributes", () => {
    // A dropped part is how the key degraded back to a model-wide wildcard: a
    // content array of ONLY unresolvable parts returned "", buildFixtureMatch
    // then omitted userMessage, and isEmptyMatch cannot catch it because
    // `endpoint` is set. Unresolvable parts are digested over their own JSON.
    const key = buildBytePlusMatchText([
      { type: "audio_url", audio_url: { url: "https://x/a.mp3" }, role: "reference_audio" },
      { type: "image_url" }, // no url — digested over the part itself
      { type: "unknown_kind", whatever: 1 },
    ]);
    expect(key).toMatch(
      /^\[media: reference_audio:[0-9a-f]{12}, image_url:[0-9a-f]{12}, unknown_kind:[0-9a-f]{12}\]$/,
    );
  });

  test("an explicit role is used verbatim and a data: URI never reaches the key", () => {
    const key = buildBytePlusMatchText([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" }, role: "last_frame" },
      { type: "video_url", video_url: { url: "https://x/ref.mp4" }, role: "reference_video" },
    ]);
    expect(key).toMatch(/^\[media: last_frame:[0-9a-f]{12}, reference_video:[0-9a-f]{12}\]$/);
    expect(key).not.toContain("base64");
  });
});

// ─── Submit ─────────────────────────────────────────────────────────────────

describe("POST /api/v3/contents/generations/tasks (submit)", () => {
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("fixture match returns { id } with a live-Ark-shaped cgt- prefix, HTTP 200", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture(videoFixture("a guitar being played", envelope()));
    await mock.start();

    const res = await submit(mock, {
      model: MODEL,
      content: [{ type: "text", text: "a guitar being played" }],
    });
    expect(res.status).toBe(200);
    expect(typeof res.json.id).toBe("string");
    expect(res.json.id.startsWith("cgt-")).toBe(true);
    // The submit body is `{ id }` and nothing else, per the live-verified shape.
    expect(Object.keys(res.json)).toEqual(["id"]);
  });

  test("both client baseURL forms reach the handler", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture(videoFixture("prefixless", envelope()));
    await mock.start();
    const res = await submit(
      mock,
      { model: MODEL, content: [{ type: "text", text: "prefixless" }] },
      "/contents/generations/tasks",
    );
    expect(res.status).toBe(200);
    expect(res.json.id.startsWith("cgt-")).toBe(true);
  });

  test("validation: malformed JSON, non-object body, and bad model/content are 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    expect((await submit(mock, "{not json")).status).toBe(400);
    expect((await submit(mock, [1, 2, 3])).status).toBe(400);

    // `model` is REQUIRED and never defaulted — a defaulted id would be a value
    // aimock never observed AND a silent mis-key of the fixture match.
    const noModel = await submit(mock, { content: [{ type: "text", text: "x" }] });
    expect(noModel.status).toBe(400);
    expect(noModel.json.error.message).toContain("'model'");
    expect(noModel.json.error.code).toBeUndefined();

    expect((await submit(mock, { model: 42, content: [{ type: "text", text: "x" }] })).status).toBe(
      400,
    );
    expect((await submit(mock, { model: MODEL })).status).toBe(400);
    expect((await submit(mock, { model: MODEL, content: [] })).status).toBe(400);
  });

  test("no fixture and no record mode is a 404 whose message names the endpoint requirement", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await submit(mock, { model: MODEL, content: [{ type: "text", text: "nope" }] });
    expect(res.status).toBe(404);
    expect(res.json.error.message).toContain('match.endpoint: "video"');
  });

  test("strict mode with no fixture is 503", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const res = await submit(mock, { model: MODEL, content: [{ type: "text", text: "nope" }] });
    expect(res.status).toBe(503);
  });

  test("a fixture omitting match.endpoint is skipped by the router; adding it matches", async () => {
    // §7.7: router.ts's endpoint/response gate asserts video ⇒ VideoResponse, so
    // an endpoint-less { json } fixture never reaches this handler at all.
    mock = new LLMock({ port: 0 });
    mock.addFixture({ match: { userMessage: "endpointless" }, response: { json: envelope() } });
    await mock.start();
    const miss = await submit(mock, {
      model: MODEL,
      content: [{ type: "text", text: "endpointless" }],
    });
    expect(miss.status).toBe(404);
    await mock.stop();

    mock = new LLMock({ port: 0 });
    mock.addFixture(videoFixture("endpointless", envelope()));
    await mock.start();
    const hit = await submit(mock, {
      model: MODEL,
      content: [{ type: "text", text: "endpointless" }],
    });
    expect(hit.status).toBe(200);
  });

  test("a VideoResponse fixture warns and 404s rather than half-building a body", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "wrong shape", endpoint: "video", model: MODEL },
      response: { video: { id: "v1", status: "completed", url: "https://x/v.mp4" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await submit(mock, {
      model: MODEL,
      content: [{ type: "text", text: "wrong shape" }],
    });
    expect(res.status).toBe(404);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("NOT a VideoResponse"))).toBe(true);
    warnSpy.mockRestore();
  });

  test("two same-prompt fixtures with different first frames do not cross-match", async () => {
    const urlA = "https://x/a.png";
    const urlB = "https://x/b.png";
    const keyA = buildBytePlusMatchText([
      { type: "text", text: "same prompt" },
      { type: "image_url", image_url: { url: urlA } },
    ]);
    const keyB = buildBytePlusMatchText([
      { type: "text", text: "same prompt" },
      { type: "image_url", image_url: { url: urlB } },
    ]);

    mock = new LLMock({ port: 0 });
    mock.addFixture(videoFixture(keyA, envelope({ seed: 1 })));
    mock.addFixture(videoFixture(keyB, envelope({ seed: 2 })));
    await mock.start();

    const a = await submit(mock, {
      model: MODEL,
      content: [
        { type: "text", text: "same prompt" },
        { type: "image_url", image_url: { url: urlA } },
      ],
    });
    const b = await submit(mock, {
      model: MODEL,
      content: [
        { type: "text", text: "same prompt" },
        { type: "image_url", image_url: { url: urlB } },
      ],
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await poll(mock, a.json.id)).json.seed).toBe(1);
    expect((await poll(mock, b.json.id)).json.seed).toBe(2);
  });
});

// ─── Poll ───────────────────────────────────────────────────────────────────

describe("GET /api/v3/contents/generations/tasks/{id} (poll)", () => {
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  async function start(
    json: Record<string, unknown>,
    opts: Record<string, unknown> = {},
  ): Promise<string> {
    mock = new LLMock({ port: 0, ...opts });
    mock.addFixture(videoFixture("go", json));
    await mock.start();
    const res = await submit(mock!, { model: MODEL, content: [{ type: "text", text: "go" }] });
    expect(res.status).toBe(200);
    return res.json.id;
  }

  test("progresses queued → running → the RECORDED terminal status", async () => {
    const id = await start(envelope(), {
      bytePlusVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    const first = await poll(mock!, id);
    expect(first.json.status).toBe("running");
    // Non-terminal bodies withhold content/error/usage and carry the envelope's
    // own timestamps — the status token is the only synthesized value.
    expect(first.json.content).toBeUndefined();
    expect(first.json.usage).toBeUndefined();
    expect(first.json.created_at).toBe(1785000000);
    expect(first.json.model).toBe(MODEL);
    expect(first.json.id).toBe(id);

    const second = await poll(mock!, id);
    expect(second.json.status).toBe("succeeded");
    expect(second.json.content.video_url).toBe("https://ark-content.example.com/out.mp4");
  });

  test("a 0/0 progression is terminal on the very first poll", async () => {
    const id = await start(envelope());
    expect((await poll(mock!, id)).json.status).toBe("succeeded");
  });

  test("post-terminal polls are byte-identical (the client always polls once more)", async () => {
    // getVideoStatus then getVideoUrl hit the same endpoint, so the two
    // responses must agree. Timestamps come from the envelope, never the clock,
    // so this cannot flake across a second boundary.
    const id = await start(envelope());
    const first = await poll(mock!, id);
    for (let i = 0; i < 3; i++) {
      expect((await poll(mock!, id)).text).toBe(first.text);
    }
  });

  test("replays every recorded field verbatim; only `id` differs from the envelope", async () => {
    const stored = envelope({
      framespersecond: 24,
      draft_task_id: "cgt-draft-1",
      duration: "5",
      priority: 3,
      output_format: "mp4",
      usage: { completion_tokens: "129600", total_tokens: "129600", tool_usage: { web_search: 2 } },
    });
    const id = await start(stored);
    const body = (await poll(mock!, id)).json;
    expect(body).toEqual({ ...stored, id });
    // The number|string union is stored and replayed as recorded, not coerced.
    expect(body.usage.completion_tokens).toBe("129600");
    expect(body.usage.tool_usage.web_search).toBe(2);
    expect(body.framespersecond).toBe(24);
  });

  test.each(["succeeded", "failed", "cancelled", "expired"])(
    "terminal status %s replays as itself",
    async (status) => {
      const id = await start(envelope({ status }));
      expect((await poll(mock!, id)).json.status).toBe(status);
    },
  );

  test("a failed envelope with no error.code emits no code key", async () => {
    const id = await start(
      envelope({ status: "failed", content: undefined, error: { message: "it broke" } }),
    );
    const body = (await poll(mock!, id)).json;
    expect(body.error).toEqual({ message: "it broke" });
    expect("code" in body.error).toBe(false);
  });

  test("succeeded with no content.video_url warns exactly once and still serves", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await start(envelope({ content: undefined }), { logLevel: "warn" });
    for (let i = 0; i < 3; i++) expect((await poll(mock!, id)).status).toBe(200);
    const hits = warnSpy.mock.calls.filter((c) =>
      c.join(" ").includes("Video is not ready for download"),
    );
    expect(hits).toHaveLength(1);
    warnSpy.mockRestore();
  });

  test("an updated_at older than 24h warns exactly once and still serves the url", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    const id = await start(envelope({ updated_at: stale }), { logLevel: "warn" });
    const body = (await poll(mock!, id)).json;
    expect(body.content.video_url).toBe("https://ark-content.example.com/out.mp4");
    await poll(mock!, id);
    const hits = warnSpy.mock.calls.filter((c) => c.join(" ").includes("expired at"));
    expect(hits).toHaveLength(1);
    warnSpy.mockRestore();
  });

  test("a status outside the vendor's six warns once, naming the client's throw, and serves", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await start(envelope({ status: "rejected" }), { logLevel: "warn" });
    expect((await poll(mock!, id)).json.status).toBe("rejected");
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("mapStatus"))).toBe(true);
    warnSpy.mockRestore();
  });

  test("an unknown job id 404s with the Ark envelope SHAPE and no invented code", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await poll(mock, "cgt-does-not-exist");
    expect(res.status).toBe(404);
    expect(typeof res.json.error.message).toBe("string");
    expect(res.json.error.message).toContain("cgt-does-not-exist");
    expect("code" in res.json.error).toBe(false);
  });

  test("jobs are testId-scoped and the id alone does not cross the boundary", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture(videoFixture("scoped", envelope()));
    await mock.start();
    const res = await submit(
      mock,
      { model: MODEL, content: [{ type: "text", text: "scoped" }] },
      SUBMIT,
      { "x-test-id": "alpha" },
    );
    expect(res.status).toBe(200);
    // No ?testId= suffix: the client percent-encodes the id into the path, so
    // the testId must ride the x-test-id header instead.
    expect(res.json.id).not.toContain("testId");
    expect((await poll(mock, res.json.id, { "x-test-id": "alpha" })).status).toBe(200);
    expect((await poll(mock, res.json.id)).status).toBe(404);
  });

  test("DELETE on a task id is not routed (E6)", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(`${mock.url}${SUBMIT}/cgt-1`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ─── Authoring-error paths ──────────────────────────────────────────────────

describe("fixture authoring errors are named, never half-served", () => {
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("an error-response fixture is served as that error", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "boom", endpoint: "video", model: MODEL },
      response: { error: { message: "rate limited", type: "rate_limit" }, status: 429 },
    });
    await mock.start();
    const res = await submit(mock, { model: MODEL, content: [{ type: "text", text: "boom" }] });
    expect(res.status).toBe(429);
  });

  test("a json payload that is not an object warns and 404s", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "scalar", endpoint: "video", model: MODEL },
      response: { json: "not an envelope" },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await submit(mock, { model: MODEL, content: [{ type: "text", text: "scalar" }] });
    expect(res.status).toBe(404);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("not a JSON object"))).toBe(true);
    warnSpy.mockRestore();
  });

  test("an envelope with no status is a 502 on poll, not a malformed body", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture(videoFixture("statusless", { model: MODEL, created_at: 1 }));
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await submit(mock, {
      model: MODEL,
      content: [{ type: "text", text: "statusless" }],
    });
    expect(res.status).toBe(200);
    const pollRes = await poll(mock, res.json.id);
    expect(pollRes.status).toBe(502);
    expect(pollRes.json.error.message).toContain("status");
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("authoring error"))).toBe(true);
    warnSpy.mockRestore();
  });
});
