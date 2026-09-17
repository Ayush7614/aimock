import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureFile,
  FixtureFileEntry,
  FixtureFileResponse,
  FixtureResponse,
  ResponseOverrides,
} from "./types.js";
import {
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  isEmbeddingResponse,
  isImageResponse,
  isAudioResponse,
  isTranscriptionResponse,
  isVideoResponse,
  isJSONResponse,
} from "./helpers.js";
import type { Logger } from "./logger.js";
import { CHAOS_FIELDS, CHAOS_FIELD_NAMES, parseChaosField } from "./chaos.js";

/**
 * Auto-stringify object-valued `content` and `toolCalls[].arguments` fields.
 * This lets fixture authors write plain JSON objects instead of escaped strings.
 * All other fields (including ResponseOverrides, and the ErrorResponse
 * `fallthrough` OpenRouter-failover flag) pass through unmodified via the
 * shallow clone below.
 */
export function normalizeResponse(raw: FixtureFileResponse): FixtureResponse {
  // Shallow-clone so we don't mutate the parsed JSON input.
  const response = { ...raw } as Record<string, unknown>;

  // Auto-stringify object content (e.g. structured output)
  if (typeof response.content === "object" && response.content !== null) {
    response.content = JSON.stringify(response.content);
  }

  // Auto-stringify object arguments in toolCalls
  if (Array.isArray(response.toolCalls)) {
    response.toolCalls = (response.toolCalls as Array<Record<string, unknown>>).map((tc) => {
      if (typeof tc.arguments === "object" && tc.arguments !== null) {
        return { ...tc, arguments: JSON.stringify(tc.arguments) };
      }
      return tc;
    });
  }

  // Carry the optional ordered `blocks` array through, mirroring the
  // toolCalls[].arguments idiom above: auto-stringify object `arguments` on
  // each `toolCall` block. Gated on Array.isArray so a malformed (non-array)
  // `blocks` value passes through untouched rather than crashing — downstream
  // validation/builders own shape rejection. Absent `blocks` → key absent.
  if (Array.isArray(response.blocks)) {
    response.blocks = (response.blocks as Array<Record<string, unknown>>).map((block) => {
      if (
        block != null &&
        block.type === "toolCall" &&
        typeof block.arguments === "object" &&
        block.arguments !== null
      ) {
        return { ...block, arguments: JSON.stringify(block.arguments) };
      }
      return block;
    });
  }

  return response as unknown as FixtureResponse;
}

export function entryToFixture(entry: FixtureFileEntry, logger?: Logger): Fixture {
  const fixture: Fixture = {
    match: {
      userMessage: entry.match.userMessage,
      systemMessage: entry.match.systemMessage,
      inputText: entry.match.inputText,
      toolCallId: entry.match.toolCallId,
      toolResultContains: entry.match.toolResultContains,
      toolName: entry.match.toolName,
      model: entry.match.model,
      responseFormat: entry.match.responseFormat,
      endpoint: entry.match.endpoint,
      ...(entry.match.sequenceIndex !== undefined && { sequenceIndex: entry.match.sequenceIndex }),
      ...(entry.match.turnIndex !== undefined && {
        turnIndex: entry.match.turnIndex,
      }),
      ...(entry.match.hasToolResult !== undefined && {
        hasToolResult: entry.match.hasToolResult,
      }),
      ...(entry.match.context !== undefined && { context: entry.match.context }),
    },
    response: normalizeResponse(entry.response),
    ...(entry.latency !== undefined && { latency: entry.latency }),
    ...(entry.chunkSize !== undefined && { chunkSize: entry.chunkSize }),
    ...(entry.truncateAfterChunks !== undefined && {
      truncateAfterChunks: entry.truncateAfterChunks,
    }),
    ...(entry.disconnectAfterMs !== undefined && { disconnectAfterMs: entry.disconnectAfterMs }),
    ...(entry.streamingProfile !== undefined && { streamingProfile: entry.streamingProfile }),
    ...(entry.recordedTimings !== undefined && { recordedTimings: entry.recordedTimings }),
    ...(entry.replaySpeed != null && { replaySpeed: entry.replaySpeed }),
    ...(entry.chaos !== undefined && { chaos: entry.chaos }),
    ...(entry.openRouterProcessing !== undefined && {
      openRouterProcessing: entry.openRouterProcessing,
    }),
    ...(entry.metadata !== undefined && { metadata: entry.metadata }),
  };

  // Sanitize recordedTimings to guard against NaN or negative values that
  // would silently degrade replay timing calculations.
  if (fixture.recordedTimings) {
    const rt = fixture.recordedTimings;
    if (!Number.isFinite(rt.ttftMs) || rt.ttftMs < 0) rt.ttftMs = 0;
    rt.interChunkDelaysMs = Array.isArray(rt.interChunkDelaysMs)
      ? rt.interChunkDelaysMs.filter((d) => Number.isFinite(d) && d >= 0)
      : [];
    if (!Number.isFinite(rt.totalDurationMs) || rt.totalDurationMs < 0) rt.totalDurationMs = 0;
  }

  if (fixture.replaySpeed != null && fixture.replaySpeed <= 0) {
    logger?.warn(`Fixture replaySpeed must be positive, got ${fixture.replaySpeed}. Ignoring.`);
    delete fixture.replaySpeed;
  }

  return fixture;
}

/**
 * Serialise a match value (string | string[] | RegExp | undefined) into a
 * dedup-key fragment that is kind-aware, so a string, a RegExp with the same
 * source, and an array containing that string do not collide. A plain template
 * literal would coerce `/foo/` and `"foo"` to the same text and join `["foo"]`
 * to `"foo"`, wrongly deduping fixtures that the router would treat as distinct.
 * Used by the duplicate-userMessage dedup key in validateFixtures.
 */
function serializeMatcher(value: string | string[] | RegExp | undefined): string {
  if (value === undefined) return "";
  if (value instanceof RegExp) return `re:${value.source}\u0000${value.flags}`;
  if (Array.isArray(value)) return `arr:${JSON.stringify(value)}`;
  return `str:${value}`;
}

// Logging helper — uses logger if provided, falls back to console.warn.
function warn(logger: Logger | undefined, msg: string, ...rest: unknown[]): void {
  if (logger) {
    logger.warn(msg, ...rest);
  } else {
    console.warn(`[fixture-loader] ${msg}`, ...rest);
  }
}

export function loadFixtureFile(filePath: string, logger?: Logger): Fixture[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    warn(logger, `Could not read file ${filePath}:`, err);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(logger, `Invalid JSON in ${filePath}:`, err);
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as FixtureFile).fixtures)
  ) {
    warn(logger, `Missing or invalid "fixtures" array in ${filePath}`);
    return [];
  }

  return (parsed as FixtureFile).fixtures.map((e) => entryToFixture(e, logger));
}

export function loadFixturesFromDir(dirPath: string, logger?: Logger): Fixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    warn(logger, `Could not read directory ${dirPath}:`, err);
    return [];
  }

  const jsonFiles: string[] = [];
  const subdirs: string[] = [];
  for (const name of entries) {
    const fullPath = join(dirPath, name);
    try {
      if (statSync(fullPath).isDirectory()) {
        subdirs.push(name);
        continue;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn(logger, `Could not stat ${fullPath}:`, err);
      }
      continue;
    }
    if (name.endsWith(".json")) {
      jsonFiles.push(name);
    }
  }
  jsonFiles.sort();

  const fixtures: Fixture[] = [];
  for (const name of jsonFiles) {
    const filePath = join(dirPath, name);
    fixtures.push(...loadFixtureFile(filePath, logger));
  }

  // Recurse into all subdirectories (full depth) to support nested layouts
  // like showcase/aimock/d6/<integration>/<feature>.json.
  subdirs.sort();
  for (const sub of subdirs) {
    fixtures.push(...loadFixturesFromDir(join(dirPath, sub), logger));
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Fixture validation
// ---------------------------------------------------------------------------

/**
 * The fixture indices a finding's message NAMES, carried as data.
 *
 * Two rules (`duplicate userMessage` and the catch-all ordering check) name
 * OTHER fixtures in the array they were given, so their message text embeds an
 * index. A consumer that validates a different array than the one the reader
 * sees — `aimock validate` runs the rules per file and then over the union of
 * every file — has to renumber those indices, and the only safe way to do that
 * is to re-render from the numbers rather than to rewrite the rendered prose:
 * `duplicate userMessage` interpolates the fixture's OWN `userMessage`, so a
 * regex over the message corrupts user-authored text that happens to read
 * "fixture 3".
 */
export type ValidationRef =
  | { rule: "duplicate-user-message"; userMessage: string; shadows: number }
  | { rule: "catch-all-not-last"; shadowsFrom: number; shadowsThrough: number };

export interface ValidationResult {
  severity: "error" | "warning";
  fixtureIndex: number;
  message: string;
  /** Present only on the rules whose message names other fixtures. */
  ref?: ValidationRef;
}

/**
 * Render a ref-carrying finding's message with each named index passed through
 * `renderIndex`. With `String` it reproduces the message `validateFixtures`
 * itself emits; `aimock validate` passes a renderer that resolves a union
 * index to `<file> #<index-in-that-file>`.
 */
export function renderValidationRef(
  ref: ValidationRef,
  renderIndex: (fixtureIndex: number) => string,
): string {
  return ref.rule === "duplicate-user-message"
    ? `duplicate userMessage '${ref.userMessage}' — shadows fixture ${renderIndex(ref.shadows)}`
    : `empty match acts as catch-all but is not the last fixture — shadows fixtures ${renderIndex(
        ref.shadowsFrom,
      )}+`;
}

function validateReasoning(
  response: { reasoning?: unknown },
  fixtureIndex: number,
  results: ValidationResult[],
): void {
  if (response.reasoning !== undefined) {
    if (typeof response.reasoning !== "string") {
      results.push({
        severity: "error",
        fixtureIndex,
        message: "reasoning must be a string",
      });
    } else if (response.reasoning === "") {
      results.push({
        severity: "warning",
        fixtureIndex,
        message: "reasoning is empty string — no reasoning events will be emitted",
      });
    }
  }
}

function validateWebSearches(
  response: { webSearches?: unknown },
  fixtureIndex: number,
  results: ValidationResult[],
): void {
  if (response.webSearches !== undefined) {
    if (!Array.isArray(response.webSearches)) {
      results.push({
        severity: "error",
        fixtureIndex,
        message: "webSearches must be an array of strings",
      });
    } else if (response.webSearches.length === 0) {
      results.push({
        severity: "warning",
        fixtureIndex,
        message: "webSearches is empty array — no web search events will be emitted",
      });
    } else {
      for (let j = 0; j < response.webSearches.length; j++) {
        if (typeof response.webSearches[j] !== "string") {
          results.push({
            severity: "error",
            fixtureIndex,
            message: `webSearches[${j}] is not a string`,
          });
          break;
        }
        if (response.webSearches[j] === "") {
          results.push({
            severity: "warning",
            fixtureIndex,
            message: `webSearches[${j}] is empty string`,
          });
        }
      }
    }
  }
}

function validateBlocks(
  response: { blocks?: unknown; content?: unknown; toolCalls?: unknown },
  fixtureIndex: number,
  results: ValidationResult[],
): void {
  if (response.blocks === undefined) return;

  // Mirrors the toolCalls checks: reject malformed `blocks` at LOAD time so a
  // bad blocks array never reaches the dispatch/builder (where
  // resolveFixtureBlocks throws AFTER the journal has already recorded
  // status:200, yielding a journal-200/client-500 mismatch). #274 F3+F8.
  if (!Array.isArray(response.blocks)) {
    results.push({
      severity: "error",
      fixtureIndex,
      message: `blocks must be an array, got ${typeof response.blocks}`,
    });
    return;
  }

  for (let j = 0; j < response.blocks.length; j++) {
    const block = response.blocks[j] as Record<string, unknown> | null | undefined;
    if (typeof block !== "object" || block === null) {
      results.push({
        severity: "error",
        fixtureIndex,
        message: `blocks[${j}] must be an object`,
      });
      continue;
    }
    if (block.type !== "text" && block.type !== "toolCall") {
      results.push({
        severity: "error",
        fixtureIndex,
        message: `blocks[${j}].type must be "text" or "toolCall", got ${JSON.stringify(block.type)}`,
      });
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        results.push({
          severity: "error",
          fixtureIndex,
          message: `blocks[${j}].text must be a string, got ${typeof block.text}`,
        });
      } else if (block.text === "") {
        // Mirror the content/toolCalls "empty string" rejection: an empty-text
        // block produces a meaningless/spurious wire chunk on replay.
        results.push({
          severity: "error",
          fixtureIndex,
          message: `blocks[${j}].text is empty string`,
        });
      }
    } else {
      // toolCall block — mirror toolCalls[] name + arguments checks.
      if (typeof block.name !== "string" || block.name === "") {
        results.push({
          severity: "error",
          fixtureIndex,
          message: `blocks[${j}].name must be a non-empty string`,
        });
      }
      // `arguments` is JSON-string in runtime form (normalizeResponse already
      // stringified object/array args); accept a valid-JSON string or an object.
      if (typeof block.arguments === "string") {
        try {
          JSON.parse(block.arguments);
        } catch {
          results.push({
            severity: "error",
            fixtureIndex,
            message: `blocks[${j}].arguments is not valid JSON: ${block.arguments}`,
          });
        }
      } else if (typeof block.arguments !== "object" || block.arguments === null) {
        results.push({
          severity: "error",
          fixtureIndex,
          message: `blocks[${j}].arguments must be a JSON string or object, got ${typeof block.arguments}`,
        });
      }
      if (block.id !== undefined && typeof block.id !== "string") {
        results.push({
          severity: "error",
          fixtureIndex,
          message: `blocks[${j}].id must be a string, got ${typeof block.id}`,
        });
      }
    }
  }

  // blocks-vs-content/toolCalls divergence (#274 P2). When a fixture carries
  // BOTH `blocks` AND legacy `content`/`toolCalls` (allowed but unusual now
  // that blocks-only is first-class), builders stream `blocks` and IGNORE the
  // redundant `content`/`toolCalls`. If those disagree it is a silent footgun,
  // so WARN (not a hard error). Stay silent on the clean blocks-only path
  // (neither legacy field present) — that is the intended shape.
  const hasLegacyContent = typeof response.content === "string";
  const hasLegacyToolCalls = Array.isArray(response.toolCalls);
  if ((hasLegacyContent || hasLegacyToolCalls) && Array.isArray(response.blocks)) {
    const textBlocks = response.blocks.filter(
      (b): b is { type: "text"; text: string } =>
        b != null &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    );
    const toolCallBlockNames = response.blocks
      .filter(
        (b): b is { type: "toolCall"; name: string } =>
          b != null &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "toolCall" &&
          typeof (b as { name?: unknown }).name === "string",
      )
      .map((b) => b.name);

    // Text divergence: blocks' concatenated text vs legacy `content`.
    if (hasLegacyContent) {
      const blocksText = textBlocks.map((b) => b.text).join("");
      if (blocksText !== response.content) {
        results.push({
          severity: "warning",
          fixtureIndex,
          message:
            "blocks text diverges from content — builders stream blocks and ignore the redundant content field",
        });
      }
    }

    // ToolCall divergence: blocks' ordered toolCall names vs legacy `toolCalls`.
    if (hasLegacyToolCalls) {
      const legacyNames = (response.toolCalls as Array<{ name?: unknown }>).map((tc) =>
        typeof tc?.name === "string" ? tc.name : undefined,
      );
      const sameNames =
        legacyNames.length === toolCallBlockNames.length &&
        legacyNames.every((n, k) => n === toolCallBlockNames[k]);
      if (!sameNames) {
        results.push({
          severity: "warning",
          fixtureIndex,
          message:
            "blocks toolCalls diverge from toolCalls — builders stream blocks and ignore the redundant toolCalls field",
        });
      }
    }
  }
}

/**
 * Human-readable form of the status range an injected error may carry.
 * Measured on Node v26: `res.writeHead` throws outside 100-999 (the injected
 * error is then lost and the caller sees a generic 500), and a 1xx status is
 * accepted but cannot terminate a response, so it hangs the request until the
 * client times out. 600-999 is unassigned, NOT invalid — Node sends it and a
 * client sees it — so a mock server allows it.
 */
export const INJECTED_STATUS_RANGE =
  "an integer between 200 and 999 (1xx cannot terminate a response and would hang the client)";

/**
 * Shared by the three doors that queue an error whose `status` reaches
 * `res.writeHead`: a fixture's `response.status` (below), `POST
 * /__aimock/error`, and `LLMock.nextRequestError`.
 */
export function isInjectableStatus(status: unknown): status is number {
  // The typeof is for the COMPILER — it narrows `unknown` so the comparisons
  // below type-check. At runtime `Number.isInteger` already excludes every
  // non-number, so mutating it away fails nothing.
  if (typeof status !== "number") return false;
  return Number.isInteger(status) && status >= 200 && status <= 999;
}

/**
 * An injected error is only a valid response for endpoints that can carry an
 * error envelope. Mirrors the router's endpoint-compat table
 * (matchFixtureDiagnostic in router.ts): error responses are compatible with
 * chat / embedding / realtime* / fal / the four elevenlabs-voice* slots and
 * with requests that carry no endpoint type, but NOT with multimedia endpoints
 * (image, speech, video, transcription, …). Whether files / fine-tuning /
 * batches belong here is an open design question — not widened yet.
 */
function isErrorEndpointCompatible(req: ChatCompletionRequest): boolean {
  const reqEndpoint = req._endpointType as string | undefined;
  return (
    reqEndpoint === undefined ||
    reqEndpoint === "chat" ||
    reqEndpoint === "embedding" ||
    reqEndpoint.startsWith("realtime") ||
    reqEndpoint === "fal" ||
    reqEndpoint === "elevenlabs-voice-design" ||
    reqEndpoint === "elevenlabs-voice" ||
    reqEndpoint === "elevenlabs-voice-get" ||
    reqEndpoint === "elevenlabs-voice-delete"
  );
}

/**
 * Queue a one-shot injected error at the FRONT of `fixtures` — shared by
 * `LLMock.nextRequestError` and `POST /__aimock/error` so both doors gate and
 * consume identically. The caller validates `status` (`isInjectableStatus`).
 *
 * The fixture is consumed exactly when its error body is actually WRITTEN to a
 * client, not when its predicate is evaluated and not when its factory happens
 * to run. Handlers that await chaos claim it synchronously at selection
 * (`claimOneShotError`) so two concurrent requests cannot both pick it across
 * the chaos-latency await, and RELEASES the claim (`releaseOneShotError`) on
 * every exit that ends the request without writing that body — a terminal
 * chaos action, or a client that left during the chaos-latency delay — unless
 * the queue was cleared (`clearFixtureQueue`) in between, in which case the
 * stale claim is dropped rather than re-armed into the reset queue. The
 * claim cannot simply be deferred past the chaos gate instead: the chaos
 * config is resolved FROM the selected fixture, and a claim taken after the
 * latency await re-opens the concurrency race the claim-at-selection closes.
 * The OpenRouter `models[]` loop cannot burn it by resolving a candidate it
 * then fails past — the error is `fallthrough: false` (terminal) so the
 * candidate that selects it serves it. The factory still performs the same
 * idempotent claim for handlers that only reach the fixture via
 * `resolveResponse` without an intervening await (realtime and fal). Consuming at
 * predicate time burned the error unserved whenever a later fixture won
 * selection (e.g. a behind-the-count `turnIndex` fixture) and spliced the
 * array while the router was still iterating it, skipping the very fixture
 * that then won. The predicate gate keeps an incompatible request (an image
 * call) from selecting it at all, so the error stays pending for its intended
 * endpoint.
 */
const oneShotErrorFixtures = new WeakSet<Fixture>();

/** True for a fixture queued by `queueOneShotError` (still armed or not). */
export function isOneShotError(fixture: Fixture): boolean {
  return oneShotErrorFixtures.has(fixture);
}

/**
 * Claim (consume) a one-shot error fixture. Returns true when this call
 * removed it from `fixtures`; false when another request already claimed it,
 * in which case the caller must NOT serve it and must re-select.
 */
export function claimOneShotError(fixtures: Fixture[], fixture: Fixture): boolean {
  const idx = fixtures.indexOf(fixture);
  if (idx === -1) return false;
  fixtures.splice(idx, 1);
  oneShotClaimGeneration.set(fixture, queueGeneration(fixtures));
  return true;
}

/**
 * Generation of each fixture queue, bumped by `clearFixtureQueue`. A one-shot
 * claim records the generation it was taken under; a release under a LATER
 * generation means the queue was cleared or reset while the claim was parked
 * (in the chaos-latency await) and the claim is stale — re-arming it would
 * plant the previous test's injection in the next test's freshly reset queue.
 * Keyed by array identity: every clear path preserves the array reference
 * (`length = 0`), so the counter follows the live queue.
 */
const fixtureQueueGeneration = new WeakMap<Fixture[], number>();
const oneShotClaimGeneration = new WeakMap<Fixture, number>();

function queueGeneration(fixtures: Fixture[]): number {
  return fixtureQueueGeneration.get(fixtures) ?? 0;
}

/**
 * Empty a fixture queue in place (array identity preserved — the running
 * server reads this same array on every request) and invalidate every
 * outstanding one-shot claim against it, so a release that lands after the
 * clear is a no-op instead of re-arming into the emptied queue. The ONE door
 * for `POST /__aimock/reset`, `DELETE /__aimock/fixtures` and
 * `LLMock.clearFixtures`; a bare `fixtures.length = 0` misses the second half.
 */
export function clearFixtureQueue(fixtures: Fixture[]): void {
  fixtures.length = 0;
  fixtureQueueGeneration.set(fixtures, queueGeneration(fixtures) + 1);
}

/**
 * Re-arm a one-shot error that was claimed for a request which then ended
 * WITHOUT writing the error body — a terminal chaos action (drop / disconnect
 * / rateLimit / malformed) or a client that hung up during the chaos-latency
 * delay. Without this the injection is burned unserved and the NEXT request
 * gets a 200, which is exactly the outcome `nextRequestError` promises not to
 * produce. A no-op for a fixture that is not a one-shot, and for one still
 * present in `fixtures` (never claimed, or already re-armed) so a double
 * release cannot duplicate the injection — and for a claim taken before the
 * queue was last cleared, so a reset that raced the request stays a reset.
 */
export function releaseOneShotError(fixtures: Fixture[], fixture: Fixture | null): void {
  if (fixture === null || !oneShotErrorFixtures.has(fixture)) return;
  if (fixtures.includes(fixture)) return;
  // Claimed under an earlier generation: the queue was cleared/reset while
  // this request was parked. The clear disarmed the injection — stay cleared.
  if (oneShotClaimGeneration.get(fixture) !== queueGeneration(fixtures)) return;
  // Front, matching `queueOneShotError`: the one-shot wins registration-order
  // ties against everything else, exactly as it did before it was claimed.
  fixtures.unshift(fixture);
}

export function queueOneShotError(
  fixtures: Fixture[],
  status: number,
  errorBody?: { message?: string; type?: string; code?: string },
): Fixture {
  const errorResponse: FixtureResponse = {
    error: {
      message: errorBody?.message ?? "Injected error",
      type: errorBody?.type ?? "server_error",
      code: errorBody?.code,
    },
    status,
    // Terminal in the OpenRouter `models[]` loop: the candidate that selects
    // (and thereby claims) the one-shot serves it instead of failing past it.
    fallthrough: false,
  };
  const fixture: Fixture = {
    match: { predicate: isErrorEndpointCompatible },
    response: () => {
      // Idempotent: a no-op when the handler already claimed at selection.
      claimOneShotError(fixtures, fixture);
      return errorResponse;
    },
  };
  oneShotErrorFixtures.add(fixture);
  // Insert at front so it wins registration-order ties against everything else.
  fixtures.unshift(fixture);
  return fixture;
}

export function validateFixtures(fixtures: Fixture[]): ValidationResult[] {
  const results: ValidationResult[] = [];

  const seenUserMessages = new Map<string, number>();

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const response = f.response;

    // Skip response-shape validation for function responses — they are
    // evaluated at runtime so we cannot statically inspect them.
    if (typeof response === "function") {
      // Still validate match fields and numeric options below.
    } else {
      // --- Error checks ---

      // Response type recognition
      // Note: isContentWithToolCallsResponse must be checked before isTextResponse
      // and isToolCallResponse since it is a structural superset of both.
      if (
        !isContentWithToolCallsResponse(response) &&
        !isTextResponse(response) &&
        !isToolCallResponse(response) &&
        !isErrorResponse(response) &&
        !isEmbeddingResponse(response) &&
        !isImageResponse(response) &&
        !isAudioResponse(response) &&
        !isTranscriptionResponse(response) &&
        !isVideoResponse(response) &&
        !isJSONResponse(response)
      ) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message:
            "response is not a recognized type (must have content, toolCalls, error, embedding, image, audio, transcription, video, or json)",
        });
      }

      // When a non-empty ordered `blocks` array is present, the builders stream
      // `blocks` and IGNORE the legacy `content` mirror (see validateBlocks's
      // divergence note + isContentWithToolCallsResponse's BLOCKS-ONLY clause).
      // So an empty-string `content` is harmless in that case and must NOT raise
      // the "content is empty string" hard error. Fixtures WITHOUT blocks keep
      // the error (an empty content with no blocks produces no output).
      const hasNonEmptyBlocks =
        Array.isArray((response as { blocks?: unknown }).blocks) &&
        (response as { blocks: unknown[] }).blocks.length > 0;

      // Text response checks
      if (isTextResponse(response)) {
        if (response.content === "" && !hasNonEmptyBlocks) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "content is empty string",
          });
        }
        validateReasoning(response, i, results);
        validateWebSearches(response, i, results);
      }

      // ContentWithToolCalls response checks
      if (isContentWithToolCallsResponse(response)) {
        // The guard now also matches a BLOCKS-ONLY fixture (non-empty `blocks`,
        // no `content`/`toolCalls`). For that shape the content/toolCalls checks
        // below don't apply (and `content`/`toolCalls` are undefined) — the
        // ordered `blocks` array is validated separately by `validateBlocks`
        // immediately after this block. So gate the legacy field checks on the
        // fields actually being present, mirroring the builders' branch-on-blocks.
        if (typeof response.content === "string") {
          if (response.content === "" && !hasNonEmptyBlocks) {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: "content is empty string",
            });
          }
        }
        if (Array.isArray(response.toolCalls)) {
          if (response.toolCalls.length === 0) {
            results.push({
              severity: "warning",
              fixtureIndex: i,
              message: "toolCalls array is empty — fixture will never produce tool calls",
            });
          }
          for (let j = 0; j < response.toolCalls.length; j++) {
            const tc = response.toolCalls[j];
            if (!tc.name) {
              results.push({
                severity: "error",
                fixtureIndex: i,
                message: `toolCalls[${j}].name is empty`,
              });
            }
            try {
              JSON.parse(tc.arguments);
            } catch {
              results.push({
                severity: "error",
                fixtureIndex: i,
                message: `toolCalls[${j}].arguments is not valid JSON: ${tc.arguments}`,
              });
            }
          }
        }
        validateReasoning(response, i, results);
        validateWebSearches(response, i, results);
      }

      // Optional ordered `blocks` checks — validated whenever present on the
      // response, regardless of which content/toolCalls guard matched, so a
      // malformed blocks array is rejected at LOAD rather than at dispatch.
      validateBlocks(
        response as { blocks?: unknown; content?: unknown; toolCalls?: unknown },
        i,
        results,
      );

      // Tool call response checks
      if (isToolCallResponse(response)) {
        if (response.toolCalls.length === 0) {
          results.push({
            severity: "warning",
            fixtureIndex: i,
            message: "toolCalls array is empty — fixture will never produce tool calls",
          });
        }
        for (let j = 0; j < response.toolCalls.length; j++) {
          const tc = response.toolCalls[j];
          if (!tc.name) {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `toolCalls[${j}].name is empty`,
            });
          }
          try {
            JSON.parse(tc.arguments);
          } catch {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `toolCalls[${j}].arguments is not valid JSON: ${tc.arguments}`,
            });
          }
        }
        validateWebSearches(response, i, results);
      }

      // Error response checks
      if (isErrorResponse(response)) {
        if (!response.error.message) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "error.message is empty",
          });
        }
        // Shared with `POST /__aimock/error` and `LLMock.nextRequestError`
        // (see `isInjectableStatus` above): a fixture's status lands on the same
        // `res.writeHead`, so it is accepted or rejected identically.
        if (response.status !== undefined && !isInjectableStatus(response.status)) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `error status ${response.status} is not a valid HTTP status code — must be ${INJECTED_STATUS_RANGE}`,
          });
        }
        // `fallthrough` gates OpenRouter `models[]` failover and is read as
        // `!== false`, so a non-boolean (`"false"`, 0, null) would silently
        // fall through — the OPPOSITE of the intended terminal behavior. Reject
        // it at load so the fail-closed half cannot quietly fail open.
        if (response.fallthrough !== undefined && typeof response.fallthrough !== "boolean") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `error.fallthrough must be a boolean, got ${typeof response.fallthrough}`,
          });
        }
      }

      // Embedding response checks
      if (isEmbeddingResponse(response)) {
        if (response.embedding.length === 0) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "embedding array is empty",
          });
        }
        for (let j = 0; j < response.embedding.length; j++) {
          if (typeof response.embedding[j] !== "number") {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `embedding[${j}] is not a number`,
            });
            break; // one error is enough
          }
        }
      }

      // Audio response checks — validate object-form audio
      if (isAudioResponse(response) && typeof response.audio === "object") {
        const audioObj = response.audio;
        if (typeof audioObj.b64Json !== "string" || audioObj.b64Json === "") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: "audio.b64Json must be a non-empty string",
          });
        }
        if (audioObj.contentType !== undefined && typeof audioObj.contentType !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `audio.contentType must be a string, got ${typeof audioObj.contentType}`,
          });
        }
      }

      // Validate ResponseOverrides fields
      if (
        isTextResponse(response) ||
        isToolCallResponse(response) ||
        isContentWithToolCallsResponse(response)
      ) {
        const r = response as ResponseOverrides;
        if (r.id !== undefined && typeof r.id !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "id" must be a string, got ${typeof r.id}`,
          });
        }
        if (r.created !== undefined && (typeof r.created !== "number" || r.created < 0)) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "created" must be a non-negative number`,
          });
        }
        if (r.model !== undefined && typeof r.model !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "model" must be a string, got ${typeof r.model}`,
          });
        }
        if (r.finishReason !== undefined && typeof r.finishReason !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "finishReason" must be a string, got ${typeof r.finishReason}`,
          });
        }
        if (r.role !== undefined && typeof r.role !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "role" must be a string, got ${typeof r.role}`,
          });
        }
        if (r.systemFingerprint !== undefined && typeof r.systemFingerprint !== "string") {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `override "systemFingerprint" must be a string, got ${typeof r.systemFingerprint}`,
          });
        }
        if (r.usage !== undefined) {
          if (typeof r.usage !== "object" || r.usage === null || Array.isArray(r.usage)) {
            results.push({
              severity: "error",
              fixtureIndex: i,
              message: `override "usage" must be an object`,
            });
          } else {
            // Numeric token fields must be numbers, but the OpenRouter cost
            // sub-fields carry non-numeric shapes (see ResponseOverrides.usage
            // in types.ts): cost_details / prompt_tokens_details /
            // completion_tokens_details are objects and is_byok is a boolean.
            // Validate each per its documented type so cost-scripting fixtures
            // are not rejected with a misleading "must be a number" error.
            // Known numeric inner scalars per object field (see
            // OpenRouterUsageExtras in types.ts). Validating only these keeps
            // the index-signature ([key: string]: unknown) escape hatch open
            // for forward-compat fields while still catching malformed values
            // on the documented ones — otherwise a bad inner scalar (e.g.
            // cost_details.upstream_inference_cost: "abc") passes load-time
            // validation and only blows up at replay in the canonical SDK.
            const numericInnerFields: Record<string, readonly string[]> = {
              cost_details: [
                "upstream_inference_cost",
                "upstream_inference_prompt_cost",
                "upstream_inference_completions_cost",
              ],
              prompt_tokens_details: ["cached_tokens", "cache_write_tokens", "audio_tokens"],
              completion_tokens_details: ["reasoning_tokens"],
            };
            const objectUsageFields = new Set(Object.keys(numericInnerFields));
            for (const key of Object.keys(r.usage)) {
              const val = (r.usage as Record<string, unknown>)[key];
              if (val === undefined) continue;
              if (objectUsageFields.has(key)) {
                if (typeof val !== "object" || val === null || Array.isArray(val)) {
                  results.push({
                    severity: "error",
                    fixtureIndex: i,
                    message: `override "usage.${key}" must be an object, got ${
                      Array.isArray(val) ? "array" : typeof val
                    }`,
                  });
                } else {
                  // Type-check the documented inner scalars; each is optional
                  // (required-if-present), so only validate keys that are set.
                  const inner = val as Record<string, unknown>;
                  for (const innerKey of numericInnerFields[key]) {
                    const innerVal = inner[innerKey];
                    if (innerVal !== undefined && typeof innerVal !== "number") {
                      results.push({
                        severity: "error",
                        fixtureIndex: i,
                        message: `override "usage.${key}.${innerKey}" must be a number, got ${typeof innerVal}`,
                      });
                    }
                  }
                }
              } else if (key === "is_byok") {
                if (typeof val !== "boolean") {
                  results.push({
                    severity: "error",
                    fixtureIndex: i,
                    message: `override "usage.is_byok" must be a boolean, got ${typeof val}`,
                  });
                }
              } else if (typeof val !== "number") {
                results.push({
                  severity: "error",
                  fixtureIndex: i,
                  message: `override "usage.${key}" must be a number, got ${typeof val}`,
                });
              }
            }
          }
        }
      }
    } // end: skip response-shape validation for function responses

    // Numeric sanity checks
    if (f.latency !== undefined && f.latency < 0) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "latency must be >= 0",
      });
    }
    if (f.chunkSize !== undefined && f.chunkSize < 1) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "chunkSize must be >= 1",
      });
    }
    if (f.truncateAfterChunks !== undefined && f.truncateAfterChunks < 1) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "truncateAfterChunks must be >= 1",
      });
    }
    if (f.disconnectAfterMs !== undefined && f.disconnectAfterMs < 0) {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: "disconnectAfterMs must be >= 0",
      });
    }
    if (f.streamingProfile !== undefined) {
      const sp = f.streamingProfile;
      if (sp.ttft !== undefined && sp.ttft < 0) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "streamingProfile.ttft must be >= 0",
        });
      }
      if (sp.tps !== undefined && sp.tps <= 0) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "streamingProfile.tps must be > 0",
        });
      }
      if (sp.jitter !== undefined && (sp.jitter < 0 || sp.jitter > 1)) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "streamingProfile.jitter must be between 0 and 1",
        });
      }
    }
    if (f.chaos !== undefined) {
      // EVERY chaos field is routed through the ONE chaos table, so a fixture
      // cannot accept a value the CLI, the header and the runtime reject. The
      // hand-rolled `< 0 || > 1` checks this replaces let `NaN`, `-0` and a
      // numeric string (`dropRate: "0.5"`) validate clean, and `latencyMs: 1.5`
      // through; the runtime then rejected the fixture value on every request.
      // A fixture is typed data, like the control API's JSON body: the field
      // must be a number. A numeric STRING is a type error here, not a wire
      // spelling to be parsed — the header API is the surface that takes text.
      const ch = f.chaos as Record<string, unknown>;
      for (const field of CHAOS_FIELD_NAMES) {
        const value = ch[field];
        if (value === undefined) continue;
        const accepted = typeof value === "number" ? parseChaosField(field, value) : undefined;
        if (accepted === undefined) {
          const shape = CHAOS_FIELDS[field].integer ? "a whole number of ms" : "a number";
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `chaos.${field} must be ${shape} between 0 and ${CHAOS_FIELDS[field].max}`,
          });
        }
      }
    }

    // Match field type checks
    if (f.match.turnIndex !== undefined) {
      if (
        typeof f.match.turnIndex !== "number" ||
        f.match.turnIndex < 0 ||
        !Number.isInteger(f.match.turnIndex)
      ) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "match.turnIndex must be a non-negative integer",
        });
      }
    }
    if (f.match.sequenceIndex !== undefined) {
      if (
        typeof f.match.sequenceIndex !== "number" ||
        f.match.sequenceIndex < 0 ||
        !Number.isInteger(f.match.sequenceIndex)
      ) {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "match.sequenceIndex must be a non-negative integer",
        });
      }
    }
    if (f.match.hasToolResult !== undefined && typeof f.match.hasToolResult !== "boolean") {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: `match.hasToolResult must be a boolean, got ${typeof f.match.hasToolResult}`,
      });
    }
    if (f.match.toolResultContains !== undefined) {
      if (typeof f.match.toolResultContains !== "string") {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: `match.toolResultContains must be a string, got ${typeof f.match.toolResultContains}`,
        });
      } else if (f.match.toolResultContains.length === 0) {
        // An empty substring is always contained, so the gate would silently
        // act as "last message is any tool result" — reject it as an authoring
        // mistake rather than let it shadow later fixtures.
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: "match.toolResultContains must be a non-empty string",
        });
      }
    }
    if (f.match.systemMessage !== undefined) {
      const sm = f.match.systemMessage;
      if (typeof sm === "string") {
        // ok
      } else if (Array.isArray(sm)) {
        if (sm.length === 0) {
          results.push({
            severity: "error",
            fixtureIndex: i,
            message: `match.systemMessage array must contain at least one substring`,
          });
        } else {
          for (let j = 0; j < sm.length; j++) {
            if (typeof sm[j] !== "string") {
              results.push({
                severity: "error",
                fixtureIndex: i,
                message: `match.systemMessage[${j}] must be a string, got ${typeof sm[j]}`,
              });
            }
          }
        }
      } else {
        results.push({
          severity: "error",
          fixtureIndex: i,
          message: `match.systemMessage must be a string or string[], got ${typeof sm}`,
        });
      }
    }
    if (f.match.context !== undefined && typeof f.match.context !== "string") {
      results.push({
        severity: "error",
        fixtureIndex: i,
        message: `match.context must be a string, got ${typeof f.match.context}`,
      });
    }

    // --- Warning checks ---

    // Duplicate userMessage shadowing — two fixtures are only genuine
    // duplicates when they would match the SAME requests, so the dedup key must
    // include EVERY match discriminator the router (matchFixtureDiagnostic in
    // router.ts) actually gates on: userMessage, systemMessage, inputText,
    // toolCallId, toolResultContains, toolName, model, responseFormat, endpoint,
    // context, sequenceIndex, turnIndex, and hasToolResult. Omitting any of these
    // (the old key only carried turnIndex/hasToolResult/toolResultContains/
    // sequenceIndex/context) flags two legitimately-distinct fixtures — e.g. two
    // that differ ONLY in toolCallId or model — as false duplicates.
    //
    // `predicate` is a function and cannot be compared for equivalence, so it is
    // never folded into a shared key: a fixture carrying a predicate is treated
    // as unconditionally distinct (keyed by its own index) so it neither shadows
    // nor is shadowed by another fixture on the userMessage axis.
    //
    // Values are serialised kind-aware so RegExp / string[] matchers do not
    // collide (a template literal would coerce a RegExp to its source and an
    // array via join, losing the distinction) — mirroring describeMatch in
    // router.ts.
    const um = f.match.userMessage;
    if (typeof um === "string" && um) {
      const m = f.match;
      const dedupKey =
        m.predicate !== undefined
          ? `predicate:${i}`
          : [
              serializeMatcher(m.userMessage),
              serializeMatcher(m.systemMessage),
              serializeMatcher(m.inputText),
              m.toolCallId,
              m.toolResultContains,
              m.toolName,
              serializeMatcher(m.model),
              m.responseFormat,
              m.endpoint,
              m.context,
              m.sequenceIndex,
              m.turnIndex,
              m.hasToolResult,
            ]
              .map((v) => (v === undefined ? "" : String(v)))
              .join("|");
      const prev = seenUserMessages.get(dedupKey);
      if (prev !== undefined) {
        const ref: ValidationRef = {
          rule: "duplicate-user-message",
          userMessage: um,
          shadows: prev,
        };
        results.push({
          severity: "warning",
          fixtureIndex: i,
          message: renderValidationRef(ref, String),
          ref,
        });
      } else {
        seenUserMessages.set(dedupKey, i);
      }
    }

    // Catch-all not in last position
    const match = f.match;
    const hasDiscriminator =
      match.endpoint !== undefined ||
      match.context !== undefined ||
      match.userMessage !== undefined ||
      match.systemMessage !== undefined ||
      match.inputText !== undefined ||
      match.responseFormat !== undefined ||
      match.toolCallId !== undefined ||
      match.toolResultContains !== undefined ||
      match.toolName !== undefined ||
      match.model !== undefined ||
      match.predicate !== undefined ||
      match.turnIndex !== undefined ||
      match.sequenceIndex !== undefined ||
      match.hasToolResult !== undefined;

    if (!hasDiscriminator && i < fixtures.length - 1) {
      const ref: ValidationRef = {
        rule: "catch-all-not-last",
        shadowsFrom: i + 1,
        shadowsThrough: fixtures.length - 1,
      };
      results.push({
        severity: "warning",
        fixtureIndex: i,
        message: renderValidationRef(ref, String),
        ref,
      });
    }
  }

  return results;
}
