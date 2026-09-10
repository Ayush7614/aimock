/**
 * BytePlus Ark (Seedance) video-proxy drift tests (surface: `byteplus-video`).
 *
 * Cost-safety first: Seedance generation costs real money per job, so NOTHING
 * here submits a paid generation. Two checks, and the scope is deliberately
 * narrow — see the spec's D6 for why there is no third.
 *
 *   1. Envelope shapes (STATIC, no key) — drive the aimock server over HTTP and
 *      triangulate the three envelopes the handler is CONTRACTED to emit
 *      against hand-authored conformant exemplars, via the documented static
 *      `triangulate(sdkShape, sdkShape, mockShape)` form. This exercises the
 *      REAL handler + triangulate + collector routing path, not a unit fake.
 *
 *   2. LIVE canary (FREE) — authenticate with `ARK_API_KEY` and probe a
 *      known-bad task id, expecting Ark to answer 404 with an error envelope.
 *      Metadata only; no generation. Gated on the key. The 404 expectation is
 *      NOT a verified vendor fact: it is inferred from the error shape in
 *      `@tanstack/ai-byteplus@0.3.4` and has never been checked against live
 *      Ark (no ARK_API_KEY exists in this repo). If the canary reports 400 or
 *      200-with-an-error-body, the expectation is what is wrong.
 *
 * WHAT THIS LEG CANNOT DO: detect a change made on Ark's side to the SUCCESS
 * task shape. Check 1 compares the mock against an in-repo exemplar and check 2
 * only exercises the error path. Closing that gap needs a compile-time
 * assignability check against @tanstack/ai-byteplus's exported status type,
 * which is deferred. Stated here so nobody reads this leg as broader than it is.
 *
 * WHICH LANE OWNS WHAT: `.drift.ts` files do not run in the always-on unit lane
 * (`vitest.config.ts` includes only `*.test.ts`), and test-drift.yml gates the
 * `drift` job on `github.event_name != 'pull_request'`. So neither check here
 * runs on the PR that would break it. The field-emission pins live in
 * `src/__tests__/byteplus-video.test.ts` instead.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost } from "./helpers.js";
import { probeBytePlusArkUnknownTask } from "./providers.js";

const ARK_API_KEY = process.env.ARK_API_KEY;

const MODEL = "seedance-1-0-pro-fast-251015";
const TASKS = "/api/v3/contents/generations/tasks";

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Fixtures — the raw Ark task envelope, which IS this surface's fixture format.
// Default progression (0/0) seeds the job terminal at submit, so the first poll
// is already terminal and no paid generation ever happens.
// ---------------------------------------------------------------------------

const SUCCEEDED_FIXTURE: Fixture = {
  match: { userMessage: "a serene beach at sunset", endpoint: "video", model: MODEL },
  response: {
    json: {
      model: MODEL,
      status: "succeeded",
      created_at: 1785000000,
      updated_at: 1785000131,
      content: { video_url: "https://ark-content.example.com/out.mp4" },
      usage: { completion_tokens: 129600, total_tokens: 129600 },
    },
  },
};

const FAILED_FIXTURE: Fixture = {
  match: { userMessage: "a task that fails", endpoint: "video", model: MODEL },
  response: {
    json: {
      model: MODEL,
      status: "failed",
      created_at: 1785000000,
      updated_at: 1785000031,
      error: { code: "QuotaExceeded", message: "insufficient quota" },
    },
  },
};

/** POST /api/v3/contents/generations/tasks → `{ id }` and nothing else. */
function submitEnvelopeShape() {
  return extractShape({ id: "cgt-00000000-0000-0000-0000-000000000000" });
}

function succeededPollShape() {
  return extractShape({
    id: "cgt-00000000-0000-0000-0000-000000000000",
    model: MODEL,
    status: "succeeded",
    created_at: 1785000000,
    updated_at: 1785000131,
    content: { video_url: "https://ark-content.example.com/out.mp4" },
    usage: { completion_tokens: 129600, total_tokens: 129600 },
  });
}

function failedPollShape() {
  return extractShape({
    id: "cgt-00000000-0000-0000-0000-000000000000",
    model: MODEL,
    status: "failed",
    created_at: 1785000000,
    updated_at: 1785000031,
    error: { code: "QuotaExceeded", message: "insufficient quota" },
  });
}

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([SUCCEEDED_FIXTURE, FAILED_FIXTURE], { port: 0 });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

describe("BytePlus video-proxy envelope shapes", () => {
  it("submit returns { id }", async () => {
    const res = await httpPost(`${instance.url}${TASKS}`, {
      model: MODEL,
      content: [{ type: "text", text: "a serene beach at sunset" }],
    });
    expect(res.status, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.id).toBe("string");

    const sdkShape = submitEnvelopeShape();
    const diffs = triangulate(sdkShape, sdkShape, extractShape(body));
    const report = formatDriftReport("BytePlus video submit", diffs, "byteplus-video");
    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("a succeeded poll returns the recorded envelope with the mock id", async () => {
    const submit = await httpPost(`${instance.url}${TASKS}`, {
      model: MODEL,
      content: [{ type: "text", text: "a serene beach at sunset" }],
    });
    expect(submit.status, submit.body).toBe(200);
    const { id } = JSON.parse(submit.body);

    const poll = await httpGet(`${instance.url}${TASKS}/${encodeURIComponent(id)}`);
    expect(poll.status, poll.body).toBe(200);
    const body = JSON.parse(poll.body);
    expect(body.status).toBe("succeeded");

    const sdkShape = succeededPollShape();
    const diffs = triangulate(sdkShape, sdkShape, extractShape(body));
    const report = formatDriftReport("BytePlus video succeeded poll", diffs, "byteplus-video");
    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("a failed poll returns the recorded error object", async () => {
    const submit = await httpPost(`${instance.url}${TASKS}`, {
      model: MODEL,
      content: [{ type: "text", text: "a task that fails" }],
    });
    expect(submit.status, submit.body).toBe(200);
    const { id } = JSON.parse(submit.body);

    const poll = await httpGet(`${instance.url}${TASKS}/${encodeURIComponent(id)}`);
    expect(poll.status, poll.body).toBe(200);
    const body = JSON.parse(poll.body);
    expect(body.status).toBe("failed");

    const sdkShape = failedPollShape();
    const diffs = triangulate(sdkShape, sdkShape, extractShape(body));
    const report = formatDriftReport("BytePlus video failed poll", diffs, "byteplus-video");
    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LIVE canary (FREE — error path only, NO generation). Skips until ARK_API_KEY
// is mirrored to repo secrets.
// ---------------------------------------------------------------------------

describe.skipIf(!ARK_API_KEY)("BytePlus Ark error-envelope canary (live)", () => {
  it("an unknown task id still answers 404 with { error: { code, message } }", async () => {
    const { status, body } = await probeBytePlusArkUnknownTask(ARK_API_KEY!);

    const err =
      body !== null && typeof body === "object"
        ? ((body as { error?: { code?: unknown; message?: unknown } }).error ?? undefined)
        : undefined;

    const problems: string[] = [];
    if (status !== 404) problems.push(`expected HTTP 404, got ${status}`);
    if (!err) problems.push("response carried no `error` object");
    else {
      if (typeof err.code !== "string") problems.push("`error.code` is not a string");
      if (typeof err.message !== "string") problems.push("`error.message` is not a string");
    }

    const report =
      problems.length > 0
        ? formatDriftReport(
            "BytePlus Ark (live unknown-task 404 canary)",
            problems.map((issue) => ({
              path: "contents/generations/tasks/{unknown}",
              severity: "critical" as const,
              issue:
                `${issue} — aimock's byteplus surface assumes Ark answers an unknown task id ` +
                `with 404 and the OpenAI-shaped error envelope. If Ark changed, revisit the ` +
                `canary in src/__tests__/drift/byteplus-video.drift.ts and the 404 handling in ` +
                `src/byteplus-video.ts`,
              expected: "404 with { error: { code: string, message: string } }",
              real: `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`,
              mock: "n/a (live probe)",
            })),
            "byteplus-video",
          )
        : "No drift detected: BytePlus Ark error-envelope canary";

    expect(problems, report).toEqual([]);
  });
});
