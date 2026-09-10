/**
 * BytePlus Ark (Seedance) video-proxy drift tests (surface: `byteplus-video`).
 *
 * Cost-safety first: Seedance generation costs real money per job, so NOTHING
 * here submits a paid generation.
 *
 * WHAT CARRIES THIS SURFACE — the KEYLESS live canary. An unauthenticated (or
 * malformed-bearer) GET against the real Ark task endpoint is answered by Ark's
 * auth layer before any billing or resource lookup: HTTP 401, an `x-error-code`
 * response header, and the SAME `{ error: { code, message, param, type } }`
 * envelope this surface's 4xx handling is modelled on. It costs nothing, needs
 * no account and no repo secret, and it goes RED when Ark restructures that
 * envelope. That is a real failure mode against a real external source, and it
 * runs on every drift run.
 *
 * A SECOND, authenticated canary (`ARK_API_KEY`) probes the RESOURCE layer — an
 * unknown task id — and stays `skipIf`-gated until a key is mirrored to repo
 * secrets. It is an upgrade, not the coverage.
 *
 * WHAT WAS DELETED AND WHY. This file previously ran three
 * `triangulate(sdkShape, sdkShape, mockShape)` checks whose "vendor truth" side
 * was a hand-copy, in this same file, of the fixture driving the mock — it
 * could not go red for anything BytePlus does, and its stand-in values
 * (`QuotaExceeded`, a `completion_tokens` count, an `ark-content.example.com`
 * URL) were INVENTED, inside the check meant to catch invented values. The
 * mock-side pass-through property those checks nominally covered is already
 * pinned by `expect(body).toEqual({ ...stored, id })` in
 * `src/__tests__/byteplus-video.test.ts`, in the always-on unit lane.
 *
 * EVERY WIRE VALUE BELOW WAS OBSERVED LIVE (2026-09-10) — see OBSERVED_*.
 *
 * WHAT THIS LEG STILL CANNOT DO: detect a change Ark makes to the SUCCESS task
 * shape, or to the `succeeded`/`failed` poll envelopes. Reaching those needs
 * either a funded key (a paid generation) or a compile-time assignability check
 * against `@tanstack/ai-byteplus`'s exported status type. Both are deferred.
 * The success shape of this surface is UNCOVERED; nothing here pretends
 * otherwise.
 *
 * WHICH LANE RUNS THIS: `.drift.ts` files are outside the always-on unit lane
 * (`vitest.config.ts` includes only `*.test.ts`). They run in the daily `drift`
 * job (gated `github.event_name != 'pull_request'`) AND in the `drift-live-pr`
 * job, which does run on a pull request whose diff touches
 * `src/__tests__/drift/**` — i.e. on a PR that edits this file.
 *
 * NETWORK FAILURE IS NOT DRIFT. An unreachable vendor, a rate limit, or a 5xx
 * becomes an HONEST SKIP (see `isInfraSkip` / `InfraError`), never a critical
 * finding. A canary that reds on a flaky network trains people to ignore it.
 */

import { describe, it, expect } from "vitest";
import { formatDriftReport, type ShapeDiff } from "./schema.js";
import {
  InfraError,
  isInfraSkip,
  probeBytePlusArkAuthEnvelope,
  probeBytePlusArkUnknownTask,
  type BytePlusArkProbeResult,
} from "./providers.js";

const ARK_API_KEY = process.env.ARK_API_KEY;

const TASK_PATH = "contents/generations/tasks/{unknown}";

// ---------------------------------------------------------------------------
// OBSERVED vendor truth. Captured by hand against live Ark on 2026-09-10 with
// `curl -i` on both ark.ap-southeast.bytepluses.com and ark.cn-beijing.volces.com
// (identical envelopes). NOTHING here is authored; re-observe before editing.
//
//   $ curl -i https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/x
//   HTTP/2 401
//   x-error-code: AuthN_MissOrInvalidAuthorizationHeader
//   {"error":{"code":"AuthenticationError","message":"the API key or AK/SK in the
//    request is missing or invalid. request id: …","param":"","type":"Unauthorized"}}
//
//   $ curl -i -H 'Authorization: Bearer garbage' …
//   HTTP/2 401
//   x-error-code: AuthN_AuthenticationError
//   {"error":{"code":"AuthenticationError","message":"The API key format is
//    incorrect. Request id: …","param":"","type":"Unauthorized"}}
// ---------------------------------------------------------------------------

const OBSERVED_AUTH_STATUS = 401;
const OBSERVED_ERROR_CODE = "AuthenticationError";
const OBSERVED_ERROR_TYPE = "Unauthorized";
const OBSERVED_ERROR_PARAM = "";
const OBSERVED_HEADER_MISSING = "AuthN_MissOrInvalidAuthorizationHeader";
const OBSERVED_HEADER_MALFORMED = "AuthN_AuthenticationError";

/**
 * Grade one keyless probe result against the observed envelope.
 *
 * Pure and exported-for-test so the mutation pin below can drive it through the
 * REAL probe with a stubbed transport and watch it go red — a guard nobody has
 * watched fail is a claim.
 */
export function gradeArkAuthEnvelope(
  probe: BytePlusArkProbeResult,
  expectedHeader: string,
): string[] {
  const problems: string[] = [];

  if (probe.status !== OBSERVED_AUTH_STATUS) {
    problems.push(`expected HTTP ${OBSERVED_AUTH_STATUS}, got ${probe.status}`);
  }
  if (probe.errorCodeHeader !== expectedHeader) {
    problems.push(
      `expected \`x-error-code: ${expectedHeader}\`, got ${
        probe.errorCodeHeader === null ? "no such header" : `\`${probe.errorCodeHeader}\``
      }`,
    );
  }

  const err =
    probe.body !== null && typeof probe.body === "object"
      ? (probe.body as { error?: unknown }).error
      : undefined;

  if (err === undefined || err === null || typeof err !== "object") {
    problems.push("response carried no `error` object");
    return problems;
  }

  const e = err as Record<string, unknown>;
  if (e.code !== OBSERVED_ERROR_CODE) {
    problems.push(`\`error.code\` is ${JSON.stringify(e.code)}, expected "${OBSERVED_ERROR_CODE}"`);
  }
  if (e.type !== OBSERVED_ERROR_TYPE) {
    problems.push(`\`error.type\` is ${JSON.stringify(e.type)}, expected "${OBSERVED_ERROR_TYPE}"`);
  }
  if (e.param !== OBSERVED_ERROR_PARAM) {
    problems.push(`\`error.param\` is ${JSON.stringify(e.param)}, expected the empty string`);
  }
  if (typeof e.message !== "string" || e.message.length === 0) {
    problems.push("`error.message` is not a non-empty string");
  }

  return problems;
}

/** Render `problems` as this surface's drift report. */
function arkDriftReport(
  context: string,
  problems: string[],
  probe: BytePlusArkProbeResult,
): string {
  const diffs: ShapeDiff[] = problems.map((issue) => ({
    path: TASK_PATH,
    severity: "critical" as const,
    issue:
      `${issue} — aimock's byteplus surface models Ark's error envelope as ` +
      `{ error: { code, message, param, type } } with an \`x-error-code\` header. ` +
      `If Ark changed it, revisit the OBSERVED_* constants in ` +
      `src/__tests__/drift/byteplus-video.drift.ts and the 4xx handling in ` +
      `src/byteplus-video.ts. Re-observe with curl before editing either.`,
    expected: `HTTP ${OBSERVED_AUTH_STATUS} + { error: { code, message, param, type } }`,
    real: `HTTP ${probe.status} [x-error-code: ${probe.errorCodeHeader ?? "absent"}]: ${JSON.stringify(
      probe.body,
    ).slice(0, 200)}`,
    mock: "n/a (live probe)",
  }));
  return formatDriftReport(context, diffs, "byteplus-video");
}

/**
 * True when the probe outcome is an environmental condition rather than drift.
 * 401 is this probe's EXPECTED status, so it is excluded from the infra classes
 * even though `isInfraSkip(401)` is true for every other leg.
 */
function isEnvironmentalStatus(status: number): boolean {
  return status !== OBSERVED_AUTH_STATUS && isInfraSkip(status);
}

// ---------------------------------------------------------------------------
// ALWAYS-ON live canary — FREE, KEYLESS, error path only. No generation.
// ---------------------------------------------------------------------------

describe("BytePlus Ark auth-layer error-envelope canary (live, keyless)", () => {
  const cases: { name: string; auth: "missing" | "malformed"; header: string }[] = [
    { name: "no Authorization header", auth: "missing", header: OBSERVED_HEADER_MISSING },
    { name: "a malformed bearer", auth: "malformed", header: OBSERVED_HEADER_MALFORMED },
  ];

  for (const { name, auth, header } of cases) {
    it(`${name} still yields Ark's documented 401 error envelope`, async (ctx) => {
      let probe: BytePlusArkProbeResult;
      try {
        probe = await probeBytePlusArkAuthEnvelope({ auth });
      } catch (err) {
        // Unreachable vendor / DNS / TLS — HONEST SKIP, never a drift finding.
        if (err instanceof InfraError) {
          ctx.skip(`BytePlus Ark unreachable (${err.message}) — skipping, not drift`);
          return;
        }
        throw err;
      }

      if (isEnvironmentalStatus(probe.status)) {
        ctx.skip(`Ark answered HTTP ${probe.status} (rate limit / outage) — skipping, not drift`);
        return;
      }

      const problems = gradeArkAuthEnvelope(probe, header);
      expect(
        problems,
        arkDriftReport(`BytePlus Ark auth envelope (${name})`, problems, probe),
      ).toEqual([]);
    });
  }

  // The guard's own red-green pin: drive the REAL probe through a stubbed
  // transport that returns a CHANGED envelope, and assert the grader reports it.
  // Offline, deterministic, always-on — so a future refactor that quietly makes
  // `gradeArkAuthEnvelope` unable to fail is itself caught.
  it("reports drift when the wire envelope changes (stubbed transport)", async () => {
    const stub = (body: unknown, status = 401, header: string | null = OBSERVED_HEADER_MISSING) =>
      probeBytePlusArkAuthEnvelope({
        fetchImpl: async () =>
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: header === null ? {} : { "x-error-code": header },
          }),
      });

    const conformant = {
      error: {
        code: OBSERVED_ERROR_CODE,
        message: "the API key or AK/SK in the request is missing or invalid. request id: x",
        param: OBSERVED_ERROR_PARAM,
        type: OBSERVED_ERROR_TYPE,
      },
    };

    // Positive control: the observed envelope grades clean.
    expect(gradeArkAuthEnvelope(await stub(conformant), OBSERVED_HEADER_MISSING)).toEqual([]);

    // Each mutation is a change Ark could plausibly make. All must be caught.
    const mutations: { what: string; probe: Promise<BytePlusArkProbeResult> }[] = [
      { what: "error object dropped", probe: stub({ message: "nope" }) },
      {
        what: "envelope flattened",
        probe: stub({ code: OBSERVED_ERROR_CODE, message: "nope", type: OBSERVED_ERROR_TYPE }),
      },
      {
        what: "error.code renamed",
        probe: stub({ error: { ...conformant.error, code: "invalid_api_key" } }),
      },
      {
        what: "error.type renamed",
        probe: stub({ error: { ...conformant.error, type: "authentication_error" } }),
      },
      {
        what: "error.param dropped",
        probe: stub({
          error: { code: OBSERVED_ERROR_CODE, message: "m", type: OBSERVED_ERROR_TYPE },
        }),
      },
      {
        what: "error.message dropped",
        probe: stub({ error: { ...conformant.error, message: "" } }),
      },
      { what: "x-error-code header dropped", probe: stub(conformant, 401, null) },
      { what: "x-error-code header renamed", probe: stub(conformant, 401, "Auth_Missing") },
      { what: "status moved off 401", probe: stub(conformant, 403) },
      { what: "body is not JSON", probe: stub("Unauthorized", 401) },
    ];

    for (const { what, probe } of mutations) {
      const problems = gradeArkAuthEnvelope(await probe, OBSERVED_HEADER_MISSING);
      expect(problems, `mutation "${what}" was NOT detected`).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// RESOURCE-layer canary (FREE — error path only, NO generation). An UPGRADE to
// the keyless canary above, not this surface's coverage. Skips until
// ARK_API_KEY is mirrored to repo secrets; the 404 assumption below has
// therefore NEVER been executed against live Ark. Set ARK_BASE_URL alongside
// the key if it was minted outside the default region — a regional mismatch is
// configuration, not drift.
// ---------------------------------------------------------------------------

describe.skipIf(!ARK_API_KEY)("BytePlus Ark unknown-task canary (live, authenticated)", () => {
  it("an unknown task id still answers 404 with { error: { code, message } }", async (ctx) => {
    let probe: BytePlusArkProbeResult;
    try {
      probe = await probeBytePlusArkUnknownTask(ARK_API_KEY!);
    } catch (err) {
      if (err instanceof InfraError) {
        ctx.skip(`BytePlus Ark unreachable (${err.message}) — skipping, not drift`);
        return;
      }
      throw err;
    }

    // 401/403 here means the KEY is stale or minted in another region — a
    // configuration problem. Report it as such rather than as vendor drift.
    if (probe.status === 401 || probe.status === 403) {
      ctx.skip(
        `ARK_API_KEY rejected (HTTP ${probe.status}) — rotate it or set ARK_BASE_URL to its region`,
      );
      return;
    }
    if (isInfraSkip(probe.status)) {
      ctx.skip(`Ark answered HTTP ${probe.status} (rate limit / outage) — skipping, not drift`);
      return;
    }

    const err =
      probe.body !== null && typeof probe.body === "object"
        ? ((probe.body as { error?: { code?: unknown; message?: unknown } }).error ?? undefined)
        : undefined;

    const problems: string[] = [];
    if (probe.status !== 404) problems.push(`expected HTTP 404, got ${probe.status}`);
    if (!err) problems.push("response carried no `error` object");
    else {
      if (typeof err.code !== "string") problems.push("`error.code` is not a string");
      if (typeof err.message !== "string") problems.push("`error.message` is not a string");
    }

    expect(
      problems,
      arkDriftReport("BytePlus Ark (live unknown-task 404 canary)", problems, probe),
    ).toEqual([]);
  });
});
