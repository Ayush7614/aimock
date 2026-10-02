#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * update-competitive-matrix.ts
 *
 * Fetches competitor READMEs from GitHub, extracts feature signals via keyword
 * matching, and updates the comparison table in docs/index.html and
 * corresponding migration pages when evidence of new capabilities is found.
 *
 * Usage:
 *   npx tsx scripts/update-competitive-matrix.ts                        # update in place
 *   npx tsx scripts/update-competitive-matrix.ts --dry-run               # show changes only
 *   npx tsx scripts/update-competitive-matrix.ts --summary out.md        # write markdown summary
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeHTML } from "entities";

// ── Types ────────────────────────────────────────────────────────────────────

interface Competitor {
  /** Display name matching the <th> link text in the HTML table */
  name: string;
  /** GitHub owner/repo */
  repo: string;
}

interface FeatureRule {
  /**
   * Row label of the homepage matrix (the <th scope="row"> of each body <tr>),
   * written as plain text: "Search & rerank", not "Search &amp; rerank".
   * Rules with no homepage row must be listed in MATRIX_ROWLESS_RULES.
   */
  rowLabel: string;
  /** Patterns to search for (case-insensitive) */
  keywords: readonly string[];
}

export interface DetectedChange {
  competitor: string;
  capability: string;
  from: string;
  to: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

const COMPETITORS: Competitor[] = [
  { name: "VidaiMock", repo: "vidaiUK/VidaiMock" },
  { name: "mock-llm", repo: "dwmkerr/mock-llm" },
  { name: "piyook/llm-mock", repo: "piyook/llm-mock" },
  { name: "mokksy/ai-mocks", repo: "mokksy/ai-mocks" },
];

// `as const` keeps each rowLabel as a string literal, so RuleLabel below is the
// exact set of rule labels and MATRIX_ROWLESS_RULES cannot name a missing rule.
export const FEATURE_RULES = [
  {
    rowLabel: "Chat Completions SSE",
    keywords: ["chat/completions", "streaming", "SSE", "server-sent", "stream.*true"],
  },
  {
    rowLabel: "Responses API SSE",
    keywords: ["responses", "/v1/responses", "response.create"],
  },
  {
    rowLabel: "Claude Messages API",
    keywords: ["claude", "anthropic", "/v1/messages", "messages API"],
  },
  {
    rowLabel: "Gemini streaming",
    keywords: ["gemini", "generateContent", "google.*ai"],
  },
  {
    rowLabel: "OpenRouter router / fallback simulation",
    keywords: [
      "openrouter",
      "fallback.*model",
      "model.*fallback",
      "provider routing",
      "failover",
      "models.*array",
      "allow_fallbacks",
    ],
  },
  {
    rowLabel: "WebSocket APIs",
    keywords: ["websocket", "realtime", "ws://", "wss://"],
  },
  {
    rowLabel: "Realtime GA protocol",
    keywords: [
      "gpt-realtime-2",
      "realtime.*ga",
      "ga.*protocol",
      "output_text\\.delta",
      "conversation\\.item\\.added",
    ],
  },
  {
    rowLabel: "Realtime Beta compatibility",
    keywords: [
      "openai-beta.*realtime",
      "realtime=v1",
      "beta.*shim",
      "beta.*compat",
      "response\\.text\\.delta",
    ],
  },
  {
    rowLabel: "Realtime transcription/translation",
    keywords: [
      "gpt-4o-transcribe",
      "gpt-4o-mini-transcribe",
      "whisper-1",
      "realtime.*transcription",
      "realtime.*translation",
    ],
  },
  {
    rowLabel: "Realtime image input",
    keywords: ["input_image.*realtime", "realtime.*image", "realtime.*vision"],
  },
  {
    rowLabel: "Realtime commentary phase",
    keywords: ["commentary.*phase", "phase.*commentary", "final_answer.*commentary"],
  },
  {
    rowLabel: "Embeddings API",
    keywords: ["/v1/embeddings", "embeddings api", "embedding endpoint", "embedding model"],
  },
  {
    rowLabel: "Image generation",
    keywords: ["dall-e", "dalle", "/v1/images", "image generation", "imagen", "generate.*image"],
  },
  {
    rowLabel: "Image editing",
    keywords: ["/v1/images/edits", "image edit", "image editing", "inpainting", "edit.*image"],
  },
  {
    rowLabel: "Text-to-Speech",
    keywords: ["text-to-speech", "/v1/audio/speech", "audio generation", "tts endpoint", "tts api"],
  },
  {
    rowLabel: "Audio transcription",
    keywords: [
      "/v1/audio/transcriptions",
      "whisper",
      "speech-to-text",
      "audio transcription",
      "transcription api",
    ],
  },
  {
    rowLabel: "Audio translation",
    keywords: [
      "/v1/audio/translations",
      "audio translation",
      "translate.*audio",
      "audio.*translate",
    ],
  },
  {
    rowLabel: "Non-speech audio",
    keywords: [
      "sound-generation",
      "sound effect",
      "music generation",
      "elevenlabs",
      "fal.ai",
      "audio generation",
      "non-speech audio",
    ],
  },
  {
    rowLabel: "Video generation",
    keywords: ["sora", "/v1/videos", "video generation", "generate.*video"],
  },
  {
    rowLabel: "Structured output / JSON mode",
    keywords: ["json_object", "json_schema", "structured output", "response_format"],
  },
  {
    rowLabel: "Sequential / stateful responses",
    keywords: ["sequence", "stateful", "sequential", "multi-turn"],
  },
  {
    rowLabel: "Azure OpenAI",
    keywords: ["azure", "deployments", "azure openai"],
  },
  {
    rowLabel: "AWS Bedrock",
    keywords: ["bedrock", "invoke-model", "aws.*bedrock"],
  },
  {
    rowLabel: "Docker image",
    keywords: ["dockerfile", "docker image", "docker-compose", "docker compose", "docker run"],
  },
  {
    rowLabel: "Helm chart",
    keywords: ["helm chart", "helm install", "kubernetes.*deploy", "k8s.*deploy"],
  },
  {
    rowLabel: "Fixture files",
    keywords: ["fixture", "yaml config", "template", "json fixture"],
  },
  {
    rowLabel: "CLI server",
    keywords: ["cli", "command line", "npx", "command-line"],
  },
  {
    rowLabel: "GET /v1/models",
    keywords: ["/v1/models", "models endpoint", "list models"],
  },
  {
    rowLabel: "Drift detection",
    keywords: [
      "drift detection",
      "drift test",
      "api drift",
      "conformance test",
      "schema validation",
    ],
  },
  {
    rowLabel: "Request journal",
    keywords: ["journal", "request log", "audit log", "request history"],
  },
  {
    rowLabel: "Error injection",
    keywords: ["error injection", "fault injection", "error simulation", "inject.*error"],
  },
  {
    rowLabel: "AG-UI event mocking",
    keywords: ["ag-ui", "agui", "agent-ui", "copilotkit.*frontend", "event stream mock"],
  },
  {
    rowLabel: "GitHub Action",
    keywords: ["github.*action", "action.yml", "uses:.*mock", "ci.*action"],
  },
  {
    rowLabel: "Vitest / Jest plugins",
    keywords: [
      "vitest.*plugin",
      "jest.*plugin",
      "useAimock",
      "useMock.*test",
      "test.*framework.*integrat",
    ],
  },
  {
    rowLabel: "Streaming usage chunks",
    keywords: [
      "stream_options",
      "include_usage",
      "streaming.*usage",
      "usage.*chunk",
      "usage.*stream",
    ],
  },
  {
    rowLabel: "Rate limiting headers",
    keywords: ["x-ratelimit", "rate.limit.*header", "retry-after", "429.*retry", "rate.limiting"],
  },
] as const satisfies readonly FeatureRule[];

/** The label of a FEATURE_RULES rule. */
export type RuleLabel = (typeof FEATURE_RULES)[number]["rowLabel"];

/**
 * Rules that intentionally have no row in the docs/index.html matrix, with the
 * reason. A detection of one of these rules never causes a page update by
 * itself: runMatrixUpdate() lists every row-less detection in the summary and
 * the log for manual follow-up. A migration page is updated only for a
 * competitor that also has an applied homepage change; that update applies
 * all of the competitor's detections (runMatrixUpdate passes the competitor's
 * full feature map to updateMigrationPage). Every
 * other rule must name a real homepage row; the run fails if one does not, so
 * a renamed row cannot silently stop the scan.
 */
export const MATRIX_ROWLESS_RULES: Partial<Record<RuleLabel, string>> = {
  "Realtime GA protocol": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime Beta compatibility": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime transcription/translation": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime image input": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime commentary phase": "The homepage folds Realtime into the WebSocket APIs row.",
  "Azure OpenAI": "The homepage counts providers in the free-text Multi-provider support row.",
  "AWS Bedrock": "The homepage counts providers in the free-text Multi-provider support row.",
  "Docker image":
    'The homepage row is the combined "Docker + Helm"; one signal must not mark both as supported.',
  "Helm chart":
    'The homepage row is the combined "Docker + Helm"; one signal must not mark both as supported.',
  "CLI server": "The homepage matrix has no CLI row.",
  "GET /v1/models": "The homepage matrix has no models-endpoint row.",
};

/**
 * True when `label` is an own key of MATRIX_ROWLESS_RULES. An `in` check would
 * also match names inherited from Object.prototype, such as "constructor".
 */
export function isRowlessRule(label: string): boolean {
  return Object.hasOwn(MATRIX_ROWLESS_RULES, label);
}

/** Maps competitor display names to their migration page paths (relative to docs/) */
export const COMPETITOR_MIGRATION_PAGES: Record<string, string> = {
  VidaiMock: "docs/migrate-from-vidaimock/index.html",
  "mock-llm": "docs/migrate-from-mock-llm/index.html",
  "piyook/llm-mock": "docs/migrate-from-piyook/index.html",
  "mokksy/ai-mocks": "docs/migrate-from-mokksy/index.html",
  // MSW and Python don't have GitHub repos in COMPETITORS[] yet
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const DOCS_PATH = resolve(import.meta.dirname ?? __dirname, "../docs/index.html");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "aimock-competitive-matrix-updater",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

async function fetchReadme(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/readme`;
  console.log(`  Fetching README from ${repo}...`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    console.warn(`  ⚠ Failed to fetch README for ${repo}: ${res.status} ${res.statusText}`);
    return "";
  }
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.content && json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf-8");
  }
  return "";
}

async function fetchPackageJson(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/package.json`;
  console.log(`  Fetching package.json from ${repo}...`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return "";
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.content && json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf-8");
  }
  return "";
}

/**
 * Builds a case-insensitive regex for a keyword that will only match when the
 * pattern is bounded by non-alphanumeric characters (or string edges). This
 * prevents short tokens from matching as substrings of larger words — e.g.
 * "cli" must not match "client"/"click", "sse" must not match "assess". The
 * boundary lookarounds constrain the surrounding text only, so keywords that
 * are themselves regexes (`stream.*true`, `output_text\.delta`) or that begin
 * or end with non-word characters (`/v1/models`, `ws://`) keep working.
 */
function keywordRegex(kw: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${kw.toLowerCase()})(?![a-z0-9])`, "i");
}

export function extractFeatures(text: string): Record<string, boolean> {
  const lower = text.toLowerCase();
  const result: Record<string, boolean> = {};
  for (const rule of FEATURE_RULES) {
    const found = rule.keywords.some((kw) => keywordRegex(kw).test(lower));
    result[rule.rowLabel] = found;
  }
  return result;
}

/**
 * Counts how many distinct LLM providers a competitor supports based on their
 * README text. De-duplicates overlapping patterns (e.g. "anthropic" and "claude"
 * both map to the same provider).
 */
export function countProviders(text: string): number {
  const lower = text.toLowerCase();

  // Group patterns that refer to the same provider. Each provider appears in
  // exactly ONE group so it is counted at most once (e.g. "gemini interactions"
  // is still just Gemini, not a separate provider).
  const providerGroups: string[][] = [
    ["openai"],
    ["claude", "anthropic"],
    ["gemini", "google.*ai"],
    ["bedrock", "aws"],
    ["azure"],
    ["vertex"],
    ["ollama"],
    ["cohere"],
    ["mistral"],
    ["groq"],
    ["together"],
    ["llama"],
    ["elevenlabs"],
  ];

  // Word-boundary matching so "cohere" does not match "coherent", "aws" does
  // not match "flaws", etc.
  let count = 0;
  for (const group of providerGroups) {
    const found = group.some((kw) => keywordRegex(kw).test(lower));
    if (found) count++;
  }
  return count;
}

// ── Migration Page Updating ─────────────────────────────────────────────────

/**
 * Updates a migration page's comparison table cells from the "no" state
 * (&#10007;) to the "yes" state (&#10003;) when a feature is detected.
 *
 * Migration page tables use a different format than the index.html matrix:
 * - "Yes" cells: <td style="color: var(--accent)">&#10003;</td>
 * - "No" cells:  <td style="color: var(--error)">&#10007;</td>
 *
 * The function also updates numeric provider claims in both table cells and
 * prose text (e.g., "5 providers" -> "8 providers").
 */
/**
 * Finds the 0-based <td> index of a competitor's column in a migration-page
 * table by matching the <th> header text to the competitor name. The <th> list
 * includes the leading "Capability" header at index 0, which aligns with the
 * leading label <td> in each body row, so the returned index can be used
 * directly against a row's <td> list. Matching is case-insensitive and
 * bidirectional-substring so header text ("Mokksy") resolves against the
 * competitor key ("mokksy/ai-mocks", whose leading token "mokksy" matches the
 * "Mokksy" header). Returns -1 when no column matches.
 *
 * Matching is intentionally token-aware rather than loose-substring: a plain
 * bidirectional `includes` would wrongly match the "aimock" header against the
 * "VidaiMock" competitor (the string "vidaimock" contains "aimock").
 */
function findMigrationCompetitorColumn(tableHtml: string, competitorName: string): number {
  const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
  const thTexts: string[] = [];
  let thM: RegExpExecArray | null;
  while ((thM = thRegex.exec(tableHtml)) !== null) {
    thTexts.push(thM[1].trim());
  }
  const comp = competitorName.toLowerCase();
  const compToken = comp.split("/")[0]; // "mokksy/ai-mocks" -> "mokksy"
  return thTexts.findIndex((t) => {
    const h = t.toLowerCase();
    return h.length > 0 && (h === comp || h === compToken || h.includes(comp));
  });
}

export function updateMigrationPage(
  html: string,
  competitorName: string,
  features: Record<string, boolean>,
  providerCount: number,
): { html: string; changes: string[] } {
  let result = html;
  const changes: string[] = [];

  // Find the comparison table (class="comparison-table" or class="endpoint-table")
  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (!tableMatch) {
    return { html: result, changes };
  }

  // Locate the competitor's column by header name (NOT by assuming it is the
  // first data column) so the correct cell flips even when an intervening
  // column (e.g. aimock) precedes it.
  const compColIdx = findMigrationCompetitorColumn(tableMatch[0], competitorName);

  // Update feature cells: find rows where the competitor column shows &#10007;
  // and the feature was detected.
  if (compColIdx >= 0) {
    for (const rule of FEATURE_RULES) {
      if (!features[rule.rowLabel]) continue;

      // Migration tables have different row labels than the index matrix.
      // We look for rows that conceptually match the feature rule.
      const rowPatterns = buildMigrationRowPatterns(rule.rowLabel);
      for (const rowPat of rowPatterns) {
        const rowRegex = new RegExp(`<tr>\\s*<td>${escapeRegex(rowPat)}</td>[\\s\\S]*?</tr>`);
        const rowMatch = result.match(rowRegex);
        if (!rowMatch) continue;

        const fullRow = rowMatch[0];
        let tdIdx = 0;
        let flipped = false;
        const newRow = fullRow.replace(/<td[^>]*>[\s\S]*?<\/td>/g, (tdMatch) => {
          const currentIdx = tdIdx++;
          if (
            currentIdx === compColIdx &&
            /var\(--error\)/.test(tdMatch) &&
            tdMatch.includes("&#10007;")
          ) {
            flipped = true;
            return `<td style="color: var(--accent)">&#10003;</td>`;
          }
          return tdMatch;
        });

        if (flipped) {
          // Function-form replacement keeps newRow literal (a $ / $& / $1 in the
          // surrounding HTML must not be interpreted by String.replace).
          result = result.replace(fullRow, () => newRow);
          changes.push(`${competitorName}: ${rowPat} ✗ -> ✓`);
        }
      }
    }
  }

  // Update provider count claims in the competitor column of the table
  // Match patterns like: >N providers<, >N+ providers<
  if (providerCount > 0) {
    result = updateProviderCounts(result, competitorName, providerCount, changes);
  }

  return { html: result, changes };
}

/**
 * Builds possible row label strings that a migration page might use for a given
 * feature rule. Migration pages use more descriptive labels than the index matrix.
 */
export function buildMigrationRowPatterns(rowLabel: string): string[] {
  const patterns = [rowLabel];

  // Add common migration-page variants
  const variants: Record<string, string[]> = {
    "Chat Completions SSE": ["OpenAI Chat Completions", "Streaming SSE"],
    "Responses API SSE": ["OpenAI Responses API"],
    "Claude Messages API": ["Anthropic Claude"],
    "Gemini streaming": ["Google Gemini"],
    "OpenRouter router / fallback simulation": ["OpenRouter routing", "Model fallback/failover"],
    "WebSocket APIs": ["WebSocket protocols"],
    "Structured output / JSON mode": ["Structured output / JSON mode", "Structured output"],
    "Sequential / stateful responses": ["Sequential responses"],
    "Docker image": ["Docker"],
    "CLI server": ["CLI"],
    "Request journal": ["Request journal"],
    "Drift detection": ["Drift detection"],
    "AG-UI event mocking": ["AG-UI event mocking", "AG-UI mocking", "AG-UI"],
    "Realtime GA protocol": ["Realtime GA protocol", "GA Realtime"],
    "Realtime Beta compatibility": ["Realtime Beta compatibility", "Beta Realtime"],
    "Realtime transcription/translation": [
      "Realtime transcription/translation",
      "Realtime translate/whisper",
      "Translate/Whisper",
    ],
    "Realtime image input": ["Realtime image input"],
    "Realtime commentary phase": ["Realtime commentary phase", "Commentary phase"],
    "Image editing": ["Image editing", "Image edit"],
    "Audio translation": ["Audio translation", "Audio translations"],
    "Streaming usage chunks": ["Streaming usage chunks", "Streaming usage"],
    "Rate limiting headers": ["Rate limiting headers", "Rate limiting"],
  };

  if (variants[rowLabel]) {
    patterns.push(...variants[rowLabel]);
  }

  return patterns;
}

/**
 * Scans the HTML for numeric provider claims and updates them if the detected
 * count is higher. Only replaces within content scoped to the specific competitor
 * to avoid corrupting aimock's own claims or other competitors' counts.
 *
 * Scoping strategy: only replace inside elements/paragraphs that mention the
 * competitor by name, or within the competitor's column in a table row whose
 * label matches "provider" (case-insensitive).
 */
export function updateProviderCounts(
  html: string,
  competitorName: string,
  detectedCount: number,
  changes: string[],
): string {
  let result = html;
  const escapedName = escapeRegex(competitorName);

  // Strategy 1: Replace provider counts in table rows about providers,
  // scoped to the competitor's column. Find rows with "provider" in the label,
  // then find the competitor's column cell by index.
  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (tableMatch) {
    const fullTable = tableMatch[0];

    // Find the competitor's column index by header name (shared with the
    // feature-cell updater so both locate the same column).
    const compColIdx = findMigrationCompetitorColumn(fullTable, competitorName);

    if (compColIdx >= 0) {
      // Find provider-related rows and update only the competitor's cell
      const updatedTable = fullTable.replace(
        /<tr>([\s\S]*?)<\/tr>/g,
        (trMatch, trContent: string) => {
          // Check if this row is about providers
          const firstTd = trContent.match(/<td[^>]*>([\s\S]*?)<\/td>/);
          if (!firstTd || !/provider/i.test(firstTd[1])) return trMatch;

          // Replace provider count only in the competitor's column cell
          let cellIdx = 0;
          return trMatch.replace(/<td[^>]*>([\s\S]*?)<\/td>/g, (tdMatch, tdContent: string) => {
            const currentIdx = cellIdx++;
            if (currentIdx !== compColIdx) return tdMatch;

            const updated = replaceProviderCount(tdContent, detectedCount);
            if (updated !== tdContent) {
              const oldCount = tdContent.match(/(\d+)/)?.[1] ?? "?";
              changes.push(
                `${competitorName}: provider count ${oldCount} -> ${detectedCount} (table)`,
              );
              // Function-form replacement keeps `updated` literal.
              return tdMatch.replace(tdContent, () => updated);
            }
            return tdMatch;
          });
        },
      );

      // Function-form replacement keeps `updatedTable` literal so any $-sequence
      // in the HTML is not interpreted by String.replace.
      result = result.replace(fullTable, () => updatedTable);
    }
  }

  // Strategy 2: Replace provider counts in prose paragraphs/sentences that
  // explicitly mention the competitor by name.
  const prosePattern = new RegExp(
    `(<[^>]*>[^<]*${escapedName}[^<]*)(\\d+)\\+?\\s*(?:LLM\\s*)?providers?`,
    "gi",
  );
  result = result.replace(prosePattern, (match, prefix, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      changes.push(`${competitorName}: provider count ${currentCount} -> ${detectedCount} (prose)`);
      return match.replace(/(\d+)\+?\s*(?:LLM\s*)?providers?/, `${detectedCount} providers`);
    }
    return match;
  });

  return result;
}

/** Replaces "N providers" or "N+ providers" in a string if detected > current */
function replaceProviderCount(text: string, detectedCount: number): string {
  return text.replace(/(\d+)\+?\s*(?:LLM\s*)?providers?/gi, (match, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      return `${detectedCount} providers`;
    }
    return match;
  });
}

// ── HTML Matrix Parsing & Updating ───────────────────────────────────────────

/** The page's markup for a "yes" mark in a competitor cell. */
const YES_MARK = '<span class="yes" role="img" aria-label="Yes">&#10003;</span>';

/** One cell (<th> or <td>) of a table row. */
interface RowCell {
  /** The cell's opening tag, e.g. `<td class="col-aimock">` */
  open: string;
  /** The cell's inner HTML, untrimmed */
  inner: string;
}

/**
 * Splits a <tr>'s inner HTML into its cells in order. The homepage labels
 * each row with a <th scope="row"> and uses <td> for the data cells, so both
 * tags count as cells.
 */
function splitRowCells(trInner: string): RowCell[] {
  const cells: RowCell[] = [];
  const cellRe = /(<(th|td)\b[^>]*>)([\s\S]*?)<\/\2>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(trInner)) !== null) {
    cells.push({ open: m[1], inner: m[3] });
  }
  return cells;
}

/** Matches a colspan attribute on a cell's opening tag. */
const COLSPAN_RE = /\scolspan\s*=/i;

interface HeaderLink {
  /**
   * The link text with character references decoded, like a row label. Markup
   * inside the link text is kept, so such a header matches no competitor and
   * the scan reports it instead of guessing.
   */
  name: string;
  /** The link's href attribute, raw, or undefined when it has none. */
  href: string | undefined;
}

/**
 * Returns the first <a> link in a header cell, or null when the cell has none.
 * `<a\b` with a following space or `>` matches only an <a> tag, never <abbr>
 * or another tag that starts with "a". The name is decoded with the same
 * decoder as row labels, so a header such as "Search &amp; Co" matches the
 * competitor name "Search & Co".
 */
function headerCellLink(cell: RowCell): HeaderLink | null {
  const link = cell.inner.match(/<a(?=[\s>])([^>]*)>([\s\S]*?)<\/a>/);
  if (!link) return null;
  return {
    name: decodeHTML(link[2]).trim(),
    href: link[1].match(/\bhref="([^"]*)"/)?.[1],
  };
}

/**
 * Returns the <thead> header cells' links in page order (null for a cell with
 * no link, such as the "Capability" column). The array index is the cell index
 * within every body row. Throws on a colspan header cell.
 */
function parseHeaderLinks(tableHtml: string): (HeaderLink | null)[] {
  const thead = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  const cells = splitRowCells(thead);
  if (cells.some((cell) => COLSPAN_RE.test(cell.open))) {
    throw new Error(
      "The homepage matrix header has a colspan cell. colspan is not supported: " +
        "give each column its own header cell.",
    );
  }
  return cells.map(headerCellLink);
}

/**
 * Reads the column names from the table's <thead>: the decoded link text of
 * each header cell, or null for a header with no link (the "Capability"
 * column). The array index is the cell index within every body row.
 */
function parseHeaderColumns(tableHtml: string): (string | null)[] {
  return parseHeaderLinks(tableHtml).map((link) => link?.name ?? null);
}

/**
 * Throws, naming the row, unless the body row has exactly one cell per header
 * column. A row with fewer cells leaves the competitors in the columns it does
 * not reach with no cell, so their detections would be dropped without a
 * report; a row with more cells has cells that belong to no column.
 *
 * colspan is rejected, not expanded: each homepage cell must belong to exactly
 * one column, so a flip changes the mark of one competitor only. parse and
 * apply both call this, so they agree on which rows they accept.
 */
function assertRowMatchesHeader(rowLabel: string, cells: RowCell[], columnCount: number): void {
  if (cells.some((cell) => COLSPAN_RE.test(cell.open))) {
    throw new Error(
      `Homepage matrix row "${rowLabel}" has a colspan cell. colspan is not supported: ` +
        "give each column its own cell.",
    );
  }
  if (cells.length !== columnCount) {
    throw new Error(
      `Homepage matrix row "${rowLabel}" has ${cells.length} cells but the header has ` +
        `${columnCount} columns. Give the row one cell per column.`,
    );
  }
}

/**
 * Throws when two <thead> columns share a link text or a link target. The
 * parsed row map would keep only the last such column while applyChanges flips
 * only the first, so a detection would land in one column and be read back
 * from the other.
 */
function assertUniqueHeaderColumns(tableHtml: string): void {
  const nameByHref = new Map<string, string>();
  const names = new Set<string>();
  for (const link of parseHeaderLinks(tableHtml)) {
    if (!link) continue;
    const { name, href } = link;
    const duplicateOf = names.has(name) ? name : href ? nameByHref.get(href) : undefined;
    if (duplicateOf !== undefined) {
      throw new Error(
        `Duplicate competitor column in the homepage matrix: "${duplicateOf}". ` +
          "Give each comparison-table column a unique name and link.",
      );
    }
    names.add(name);
    if (href) nameByHref.set(href, name);
  }
}

/**
 * Returns a row's label (its first cell) as plain text, with HTML character
 * references decoded, so rules and lookups use the text a reader sees.
 */
function rowLabelText(cell: RowCell): string {
  return decodeHTML(cell.inner).trim();
}

/**
 * Parses the comparison table from docs/index.html.
 * Returns the competitor headers and a map: plain-text rowLabel -> { header -> cell inner HTML }
 */
export function parseCurrentMatrix(html: string): {
  headers: string[];
  rows: Map<string, Map<string, string>>;
} {
  // Extract the table between <table class="comparison-table"> and </table>
  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    throw new Error("Could not find comparison-table in HTML");
  }
  const tableHtml = tableMatch[1];

  const columns = parseHeaderColumns(tableHtml);
  // headers = ["aimock", "MSW", ...competitors]
  const headers = columns.filter((c): c is string => c !== null);
  assertUniqueHeaderColumns(tableHtml);

  const rows = new Map<string, Map<string, string>>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const trIter = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let tr: RegExpExecArray | null;

  while ((tr = trIter.exec(tbody)) !== null) {
    const cells = splitRowCells(tr[1]);
    if (cells.length === 0) continue;

    // The first cell (<th scope="row"> on the homepage) is the row label.
    const rowLabel = rowLabelText(cells[0]);
    // A repeated label would silently overwrite the earlier row here, and
    // applyChanges would then flip the cell in every row with that label.
    if (rows.has(rowLabel)) {
      throw new Error(
        `Duplicate row label in the homepage matrix: "${rowLabel}". ` +
          "Give each comparison-table row a unique label.",
      );
    }
    assertRowMatchesHeader(rowLabel, cells, columns.length);
    const rowMap = new Map<string, string>();
    for (let i = 1; i < cells.length; i++) {
      const name = columns[i];
      if (name !== null) rowMap.set(name, cells[i].inner.trim());
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers, rows };
}

/**
 * Returns the labels of rules that name no row in the parsed matrix and are
 * not listed in MATRIX_ROWLESS_RULES. A non-empty result means the homepage
 * and FEATURE_RULES have drifted apart.
 */
export function findUnmatchedRules(matrix: { rows: Map<string, Map<string, string>> }): string[] {
  return FEATURE_RULES.map((r) => r.rowLabel).filter(
    (label) => !matrix.rows.has(label) && !isRowlessRule(label),
  );
}

/**
 * Throws when findUnmatchedRules reports any rule. main() calls this before it
 * computes changes, so homepage/rule drift stops the scan.
 */
export function assertRulesMatchMatrix(matrix: { rows: Map<string, Map<string, string>> }): void {
  const unmatched = findUnmatchedRules(matrix);
  if (unmatched.length > 0) {
    throw new Error(
      `FEATURE_RULES name rows missing from the homepage matrix: ${unmatched.join(", ")}. ` +
        "Rename the rule to the real row label or list it in MATRIX_ROWLESS_RULES.",
    );
  }
}

/**
 * Returns the names of tracked competitors that have no column in the parsed
 * matrix. A header that was renamed, or that lost its link, leaves its
 * competitor here. A non-empty result means the homepage and COMPETITORS have
 * drifted apart, and that competitor's detected changes would be dropped.
 */
export function findUnmatchedCompetitors(matrix: { headers: string[] }): string[] {
  return COMPETITORS.map((c) => c.name).filter((name) => !matrix.headers.includes(name));
}

// ── "No" cells: one definition for recognition and flipping ─────────────────
//
// A cell shows "no" when it has any no-marker: a `no` class token on the cell
// tag or on any element inside it, or a cross mark. computeChanges reports a
// change for every such cell. applyChanges flips only the supported shapes
// below and reports every other no-cell as unapplied, so a cell is never
// half-flipped and never dropped without a report.
//
// Supported shapes (cell inner HTML, after the cell's open tag):
//   1. Text, one `<span class="no" ...>` that holds only a cross mark, text.
//      The span's class must be exactly `no`; other attributes and either
//      quote style are allowed. The cell tag must not have a `no` class.
//      The span becomes YES_MARK. The real homepage uses only this shape:
//      `<td><span class="no" role="img" aria-label="No">&#10007;</span></td>`.
//   2. Text only, with exactly one cross mark. The cross becomes YES_MARK,
//      and a `no` class token on the cell tag becomes `yes`.
// In both shapes the surrounding text must have no tags and no other cross.
//
// After a flip, checkFlippedCell must find no no-marker and exactly one yes
// mark in the result, or the change is reported unapplied.

/** A cross mark: the glyph, or its decimal or hex character reference. */
const CROSS_SRC = String.raw`(?:✗|&#10007;|&#x2717;)`;
const CROSS_RE = new RegExp(CROSS_SRC, "gi");
/** A check mark: the glyph, or its decimal or hex character reference. */
const CHECK_RE = /✓|&#10003;|&#x2713;/gi;
/**
 * A `no` token in any class attribute, quoted or not. It is deliberately
 * loose: it also finds the token in a tag the shape patterns cannot read, so
 * such a cell is still recognized (and then reported as unsupported).
 */
const NO_CLASS_RE = /\sclass\s*=\s*["']?(?:[^"'<>]*\s)?no(?![\w-])/i;
/** One start-tag attribute: name, then an optional double/single/un-quoted value. */
const ATTR_SRC = String.raw`\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const ATTR_RE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
/** Supported shape 1, anchored to the whole inner HTML. */
const NO_SPAN_CELL_RE = new RegExp(
  String.raw`^([^<]*)<span((?:${ATTR_SRC})*)\s*>\s*${CROSS_SRC}\s*</span>([^<]*)$`,
  "i",
);
/** The attribute part of a cell's open tag, e.g. ` class="no"` of `<td class="no">`. */
const OPEN_TAG_ATTRS_RE = /^<[a-z][\w-]*((?:\s+[^>]*)?)>$/i;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** The class tokens of a start tag's attribute string; empty when it has none. */
function classTokens(attrs: string): string[] {
  for (const m of attrs.matchAll(ATTR_RE)) {
    if (m[1].toLowerCase() === "class") {
      return (m[2] ?? m[3] ?? m[4] ?? "").split(/\s+/).filter(Boolean);
    }
  }
  return [];
}

/** True when the cell (its open tag or inner HTML) has any no-marker. */
function hasNoMarker(open: string, inner: string): boolean {
  return NO_CLASS_RE.test(open) || NO_CLASS_RE.test(inner) || countMatches(inner, CROSS_RE) > 0;
}

export type NoCellShape =
  /** The cell has no no-marker. */
  | { kind: "not-no" }
  /** The cell shows "no" in a shape the flip does not support. */
  | { kind: "unsupported" }
  /** The cell shows "no" in a supported shape; `open`/`inner` are the flip result. */
  | { kind: "flippable"; open: string; inner: string };

/**
 * Classifies a cell against the supported no-cell shapes (see above) and,
 * for a supported shape, returns the flipped cell. computeChanges and
 * applyChanges both use this, so they agree on which cells are "no".
 */
export function classifyNoCell(open: string, inner: string): NoCellShape {
  if (!hasNoMarker(open, inner)) return { kind: "not-no" };
  const cellAttrs = open.match(OPEN_TAG_ATTRS_RE)?.[1] ?? "";
  const cellIsNo = classTokens(cellAttrs).includes("no");
  const textOk = (text: string): boolean => countMatches(text, CROSS_RE) === 0;

  const span = inner.match(NO_SPAN_CELL_RE);
  if (span) {
    const [, before, spanAttrs, after] = span;
    const spanClasses = classTokens(spanAttrs);
    if (
      !cellIsNo &&
      spanClasses.length === 1 &&
      spanClasses[0] === "no" &&
      textOk(before) &&
      textOk(after)
    ) {
      return { kind: "flippable", open, inner: before + YES_MARK + after };
    }
    return { kind: "unsupported" };
  }

  if (!inner.includes("<") && countMatches(inner, CROSS_RE) === 1) {
    // Function-form replacement keeps YES_MARK literal for String.replace.
    const flipped = inner.replace(new RegExp(CROSS_SRC, "i"), () => YES_MARK);
    return { kind: "flippable", open: cellIsNo ? flipCellOpenTag(open) : open, inner: flipped };
  }
  return { kind: "unsupported" };
}

/** True when a flipped cell has no no-marker and exactly one yes mark. */
function checkFlippedCell(open: string, inner: string): boolean {
  return (
    !hasNoMarker(open, inner) &&
    inner.split(YES_MARK).length === 2 &&
    countMatches(inner, CHECK_RE) === 1
  );
}

/**
 * Reads every body row of the comparison table as its cells, keyed by the
 * row's plain-text label, with the header columns. Null when the page has no
 * comparison table.
 */
function readTableCells(
  html: string,
): { columns: (string | null)[]; rows: Map<string, RowCell[]> } | null {
  const tableHtml = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/)?.[1];
  if (tableHtml === undefined) return null;
  const columns = parseHeaderColumns(tableHtml);
  const rows = new Map<string, RowCell[]>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  for (const tr of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = splitRowCells(tr[1]);
    if (cells.length > 0) rows.set(rowLabelText(cells[0]), cells);
  }
  return { columns, rows };
}

/**
 * Computes the "No" -> "Yes" changes for the competitors in
 * competitorFeatures (not aimock or MSW): one change for each detected feature
 * whose matrix row exists and whose current cell shows "no". A cell shows
 * "no" when it has a no-marker (a `no` class token on the cell tag or on an
 * element inside it, or a cross mark). The cell's open tag is read from
 * `html`, so a `<td class="no">` with no inner marker counts.
 *
 * Every "no" cell is reported, whether or not its shape is one applyChanges
 * can flip; applyChanges reports an unsupported shape as unapplied.
 * It does not modify the HTML; applyChanges does that. Never downgrades.
 */
export function computeChanges(
  html: string,
  matrix: { headers: string[]; rows: Map<string, Map<string, string>> },
  competitorFeatures: Map<string, Record<string, boolean>>,
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const table = readTableCells(html);

  for (const [compName, features] of competitorFeatures) {
    for (const [rowLabel, detected] of Object.entries(features)) {
      if (!detected) continue;

      const row = matrix.rows.get(rowLabel);
      if (!row) continue;

      // An empty cell is stored as "", so test for a missing column only.
      const currentCell = row.get(compName);
      if (currentCell === undefined) continue;

      // Only upgrade "No" cells — leave "Yes", "Partial", "Manual", etc. alone.
      // The open tag comes from the page itself, since the matrix holds only
      // each cell's inner HTML.
      const colIdx = table?.columns.indexOf(compName) ?? -1;
      const open = (colIdx > 0 && table?.rows.get(rowLabel)?.[colIdx]?.open) || "";
      if (classifyNoCell(open, currentCell).kind !== "not-no") {
        changes.push({
          competitor: compName,
          capability: rowLabel,
          from: "No",
          to: "Yes",
        });
      }
    }
  }

  return changes;
}

/** Why applyChanges could not place a change in the homepage table. */
export type UnappliedReason =
  /** No <thead> column has the competitor's name. */
  | "unknown-competitor"
  /** No body row has the capability as its label. */
  | "row-not-found"
  /** The row exists but the competitor's cell is not in the "no" state. */
  | "cell-not-no"
  /** The cell shows "no", but not in a shape applyChanges can flip. */
  | "unsupported-no-cell"
  /** The flipped cell still had a no-marker or not exactly one yes mark. */
  | "flip-check-failed";

export interface UnappliedChange {
  change: DetectedChange;
  reason: UnappliedReason;
}

export interface ApplyChangesResult {
  html: string;
  /** Changes whose cell was flipped, in input order. */
  applied: DetectedChange[];
  /** Changes that could not be placed, in input order, with the reason. */
  unapplied: UnappliedChange[];
}

/**
 * Applies detected changes to the HTML string. Each target cell is located by
 * its row label (the row's first cell) and its column (the <thead> header
 * with the competitor's name). Only cells in a supported no-cell shape are
 * flipped (see classifyNoCell): the cell's one "no" mark becomes the page's
 * "yes" mark, and any other text in the cell is kept. A "no" cell in any
 * other shape is left unchanged and reported as "unsupported-no-cell". Each
 * flip is then checked (checkFlippedCell); a result that still shows "no", or
 * does not have exactly one yes mark, is discarded and reported as
 * "flip-check-failed".
 *
 * Returns the updated HTML together with the changes that were applied and
 * the changes that could not be placed, so the caller never reports a change
 * the page does not show. Throws, naming the row, when a body row's cell count
 * does not match the header or a cell has colspan (see assertRowMatchesHeader),
 * and when a header cell has colspan (see parseHeaderLinks).
 */
export function applyChanges(html: string, changes: DetectedChange[]): ApplyChangesResult {
  if (changes.length === 0) return { html, applied: [], unapplied: [] };

  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    return {
      html,
      applied: [],
      unapplied: changes.map((change) => ({ change, reason: "row-not-found" as const })),
    };
  }
  const fullTable = tableMatch[0];
  const columns = parseHeaderColumns(tableMatch[1]);

  // rowLabel -> cell indices to flip
  const targets = new Map<string, Set<number>>();
  const colIdxByChange = changes.map((change) => {
    const colIdx = columns.indexOf(change.competitor);
    if (colIdx <= 0) return -1; // unknown competitor, or the label column
    if (!targets.has(change.capability)) targets.set(change.capability, new Set());
    targets.get(change.capability)!.add(colIdx);
    return colIdx;
  });

  // What the table walk actually found and flipped.
  const rowsSeen = new Set<string>();
  const flipped = new Set<string>(); // `${rowLabel}\0${cellIdx}`
  const refused = new Map<string, UnappliedReason>(); // no-cells left unflipped
  const cellKey = (rowLabel: string, idx: number): string => `${rowLabel}\0${idx}`;

  const updatedTable =
    targets.size === 0
      ? fullTable
      : fullTable.replace(
          /(<tbody>)([\s\S]*?)(<\/tbody>)/,
          (_tbodyMatch, tbodyOpen: string, tbodyInner: string, tbodyClose: string) => {
            const newInner = tbodyInner.replace(
              /(<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/g,
              (trMatch, trOpen: string, trInner: string, trClose: string) => {
                const cells = splitRowCells(trInner);
                if (cells.length === 0) return trMatch;
                const rowLabel = rowLabelText(cells[0]);
                // Same check as parseCurrentMatrix, on every body row: a cell
                // index is only a column index when the row matches the header.
                assertRowMatchesHeader(rowLabel, cells, columns.length);
                const cols = targets.get(rowLabel);
                if (!cols) return trMatch;
                rowsSeen.add(rowLabel);

                let cellIdx = 0;
                const newTrInner = trInner.replace(
                  /(<(th|td)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
                  (cellMatch, open: string, _tag: string, content: string, close: string) => {
                    const idx = cellIdx++;
                    if (!cols.has(idx)) return cellMatch;
                    const shape = classifyNoCell(open, content);
                    if (shape.kind === "not-no") return cellMatch;
                    if (shape.kind === "unsupported") {
                      refused.set(cellKey(rowLabel, idx), "unsupported-no-cell");
                      return cellMatch;
                    }
                    if (!checkFlippedCell(shape.open, shape.inner)) {
                      refused.set(cellKey(rowLabel, idx), "flip-check-failed");
                      return cellMatch;
                    }
                    flipped.add(cellKey(rowLabel, idx));
                    return shape.open + shape.inner + close;
                  },
                );
                return trOpen + newTrInner + trClose;
              },
            );
            return tbodyOpen + newInner + tbodyClose;
          },
        );

  const applied: DetectedChange[] = [];
  const unapplied: UnappliedChange[] = [];
  changes.forEach((change, i) => {
    const colIdx = colIdxByChange[i];
    if (colIdx < 0) unapplied.push({ change, reason: "unknown-competitor" });
    else if (!rowsSeen.has(change.capability)) unapplied.push({ change, reason: "row-not-found" });
    else if (!flipped.has(cellKey(change.capability, colIdx))) {
      const reason = refused.get(cellKey(change.capability, colIdx)) ?? "cell-not-no";
      unapplied.push({ change, reason });
    } else applied.push(change);
  });

  // Function-form replacement keeps the HTML-derived text literal so any
  // $ / $& / $1 in the table is not interpreted by String.replace.
  return { html: html.replace(fullTable, () => updatedTable), applied, unapplied };
}

/** Changes a `no` token in the cell tag's class attribute to `yes`. */
function flipCellOpenTag(open: string): string {
  return open.replace(
    /(\sclass\s*=\s*)(["'])([^"']*)\2/i,
    (_m, pre: string, quote: string, classes: string) =>
      pre + quote + classes.replace(/(^|\s)no(?=\s|$)/, "$1yes") + quote,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ── Summary Writing ──────────────────────────────────────────────────────────

function parseSummaryArg(): string | null {
  const idx = process.argv.indexOf("--summary");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return resolve(process.argv[idx + 1]);
}

function writeSummary(summaryPath: string, changes: DetectedChange[]): void {
  let md: string;

  if (changes.length === 0) {
    md = "No competitive matrix changes detected this week.\n";
  } else {
    const lines: string[] = [];
    lines.push("## Competitive Matrix Changes");
    lines.push("");
    lines.push("| Competitor | Capability | Change |");
    lines.push("| --- | --- | --- |");
    for (const ch of changes) {
      lines.push(`| ${ch.competitor} | ${ch.capability} | ${ch.from} -> ${ch.to} |`);
    }
    lines.push("");

    // Build mermaid flowchart grouped by competitor
    const byCompetitor = new Map<string, string[]>();
    for (const ch of changes) {
      if (!byCompetitor.has(ch.competitor)) {
        byCompetitor.set(ch.competitor, []);
      }
      byCompetitor.get(ch.competitor)!.push(ch.capability);
    }

    lines.push("```mermaid");
    lines.push("flowchart LR");
    let nodeCounter = 0;
    for (const [competitor, capabilities] of byCompetitor) {
      const subId = competitor.replace(/[^a-zA-Z0-9_-]/g, "_");
      const subLabel = competitor.replace(/"/g, "&quot;");
      lines.push(`  subgraph ${subId}["${subLabel}"]`);
      for (const cap of capabilities) {
        const nodeId = `n${nodeCounter}`;
        const capLabel = cap.replace(/"/g, "&quot;");
        lines.push(`    ${nodeId}["${capLabel}"]`);
        nodeCounter++;
      }
      lines.push("  end");
    }
    lines.push("```");
    lines.push("");

    md = lines.join("\n");
  }

  writeFileSync(summaryPath, md, "utf-8");
  console.log(`\nSummary written to ${summaryPath}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Competitive Matrix Updater ===\n");

  if (DRY_RUN) {
    console.log("  [DRY RUN] No files will be modified.\n");
  }

  // 1. Fetch competitor data
  const competitorFeatures = new Map<string, Record<string, boolean>>();
  const competitorProviderCounts = new Map<string, number>();
  const competitorReadmes = new Map<string, string>();

  for (const comp of COMPETITORS) {
    console.log(`\n--- ${comp.name} (${comp.repo}) ---`);
    const [readme, pkg] = await Promise.all([fetchReadme(comp.repo), fetchPackageJson(comp.repo)]);

    if (!readme && !pkg) {
      console.log(`  No data fetched, skipping.`);
      continue;
    }

    const combined = `${readme}\n${pkg}`;
    competitorReadmes.set(comp.name, combined);
    const features = extractFeatures(combined);
    competitorFeatures.set(comp.name, features);

    // Count providers
    const provCount = countProviders(combined);
    competitorProviderCounts.set(comp.name, provCount);

    // Log detected features
    const detected = Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (detected.length > 0) {
      console.log(`  Detected features: ${detected.join(", ")}`);
    } else {
      console.log(`  No features detected from keywords.`);
    }
    if (provCount > 0) {
      console.log(`  Detected ${provCount} LLM provider(s).`);
    }
  }

  // 2. Read current HTML
  console.log(`\nReading ${DOCS_PATH}...`);
  const html = readFileSync(DOCS_PATH, "utf-8");

  // 3. Parse current matrix
  const matrix = parseCurrentMatrix(html);
  console.log(
    `Parsed ${matrix.rows.size} capability rows, ${matrix.headers.length} competitor columns.`,
  );

  // Fail loudly if a rule names a row the homepage does not have: otherwise
  // the scan reports "no changes" forever without anyone noticing.
  assertRulesMatchMatrix(matrix);

  // Fail loudly if a competitor has no column (header renamed or unlinked):
  // otherwise its detected changes are dropped and the scan reports "no changes".
  const unmatchedCompetitors = findUnmatchedCompetitors(matrix);
  if (unmatchedCompetitors.length > 0) {
    throw new Error(
      `COMPETITORS name columns missing from the homepage matrix: ${unmatchedCompetitors.join(", ")}. ` +
        "Rename the competitor to the real <thead> link text, or restore the header's link.",
    );
  }

  // 4. Compute changes
  const changes = computeChanges(html, matrix, competitorFeatures);

  const summaryPath = parseSummaryArg();

  if (changes.length === 0) {
    console.log("\nNo changes detected. Competitive matrix is up to date.");
    if (summaryPath) writeSummary(summaryPath, changes);
    return;
  }

  console.log(`\n${changes.length} change(s) detected:`);
  for (const ch of changes) {
    console.log(`  ${ch.competitor} / ${ch.capability}: ${ch.from} -> ${ch.to}`);
  }

  if (summaryPath) writeSummary(summaryPath, changes);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would update docs/index.html with the above changes.");
    console.log("[DRY RUN] Would also update migration pages for changed competitors.");
    return;
  }

  // 5. Apply changes to index.html
  const { html: updated } = applyChanges(html, changes);
  writeFileSync(DOCS_PATH, updated, "utf-8");
  console.log("\nUpdated docs/index.html successfully.");

  // 6. Update migration pages for competitors with changes
  const docsDir = resolve(import.meta.dirname ?? __dirname, "..");
  const updatedCompetitors = new Set(changes.map((ch) => ch.competitor));

  for (const compName of updatedCompetitors) {
    const migrationPageRelPath = COMPETITOR_MIGRATION_PAGES[compName];
    if (!migrationPageRelPath) {
      console.log(`  No migration page mapped for ${compName}, skipping.`);
      continue;
    }

    const migrationPagePath = resolve(docsDir, migrationPageRelPath);
    if (!existsSync(migrationPagePath)) {
      console.log(`  Migration page not found: ${migrationPagePath}, skipping.`);
      continue;
    }

    const migrationHtml = readFileSync(migrationPagePath, "utf-8");
    const features = competitorFeatures.get(compName) ?? {};
    const provCount = competitorProviderCounts.get(compName) ?? 0;

    const { html: updatedMigration, changes: migrationChanges } = updateMigrationPage(
      migrationHtml,
      compName,
      features,
      provCount,
    );

    if (migrationChanges.length > 0) {
      writeFileSync(migrationPagePath, updatedMigration, "utf-8");
      console.log(`\nUpdated ${migrationPageRelPath}:`);
      for (const ch of migrationChanges) {
        console.log(`  ${ch}`);
      }
    } else {
      console.log(`\n${migrationPageRelPath}: no migration page changes needed.`);
    }
  }
}

// Only run when executed directly as a script (not when imported by tests).
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
