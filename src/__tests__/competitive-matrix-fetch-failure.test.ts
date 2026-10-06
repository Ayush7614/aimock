import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseCurrentMatrix,
  computeChanges,
  applyChanges,
  extractFeatures,
  FEATURE_RULES,
} from "../../scripts/update-competitive-matrix.js";

// These tests run the REAL script (main()) in a child process, with global
// fetch replaced by a preload module. A scan that cannot reach GitHub must
// fail the run, not report "no changes": the workflow posts "no changes" to
// Slack whenever the script exits 0.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/update-competitive-matrix.ts");

// STUB_FETCH_MODE sets the outcome of every request:
//   reject      every fetch throws (network down)
//   status:<n>  every request returns HTTP <n> (403 rate limit, 500, ...)
//
// Otherwise every repo is healthy (README found, package.json 404) except
// STUB_TARGET, whose files take the outcomes in STUB_README and STUB_PKG:
//   ok         HTTP 200 with base64 content
//   empty      HTTP 200 with base64 content that decodes to ""
//   nocontent  HTTP 200 with no base64 content
//   large      a file over 1 MB: HTTP 200 with content "" and encoding "none"
//              (GitHub's object response for 1-100 MB files); a request with
//              Accept: application/vnd.github.raw gets the raw text
//   largefail  as large, but the raw request returns HTTP 500
//   404        HTTP 404 (file not in repo)
//   500        HTTP 500
// The target's README text is STUB_README_TEXT when set.
const STUB = `
const mode = process.env.STUB_FETCH_MODE ?? "";
const target = process.env.STUB_TARGET ?? "";
const b64 = (s) => Buffer.from(s).toString("base64");
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Stubbed",
    headers: { "content-type": "application/json" },
  });
const LARGE = 1_500_000;
const respond = (outcome, text, raw) => {
  switch (outcome) {
    case "large":
      return raw
        ? new Response(text, { status: 200, headers: { "content-type": "application/vnd.github.raw" } })
        : json(200, { content: "", encoding: "none", size: LARGE });
    case "largefail":
      return raw ? json(500, { message: "boom" }) : json(200, { content: "", encoding: "none", size: LARGE });
    case "ok": return json(200, { content: b64(text), encoding: "base64" });
    case "empty": return json(200, { content: "", encoding: "base64" });
    case "nocontent": return json(200, { name: "x", type: "file" });
    case "404": return json(404, { message: "Not Found" });
    case "500": return json(500, { message: "boom" });
    default: throw new Error("unknown stub outcome: " + outcome);
  }
};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const raw = (init?.headers?.Accept ?? "") === "application/vnd.github.raw";
  const isReadme = url.endsWith("/readme");
  if (mode === "reject") throw new TypeError("fetch failed");
  if (mode.startsWith("status:")) return json(Number(mode.slice(7)), { message: "stubbed" });
  const isTarget = target !== "" && url.includes("/repos/" + target + "/");
  if (isReadme) {
    if (!isTarget) return respond("ok", "A small mock server.", raw);
    return respond(
      process.env.STUB_README,
      process.env.STUB_README_TEXT ?? "A small mock server.",
      raw,
    );
  }
  return respond(isTarget ? process.env.STUB_PKG : "404", process.env.STUB_PKG_TEXT, raw);
};
`;

let dir: string;
let stubUrl: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cm-fetch-stub-"));
  const stubPath = join(dir, "stub-fetch.mjs");
  writeFileSync(stubPath, STUB, "utf-8");
  stubUrl = pathToFileURL(stubPath).href;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runScan(
  env: Record<string, string>,
  extraArgs: string[] = [],
): { status: number | null; out: string } {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", stubUrl, SCRIPT, "--dry-run", ...extraArgs],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        STUB_FETCH_MODE: "",
        GITHUB_TOKEN: "",
        STUB_PKG_TEXT,
        ...env,
      },
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
  // A spawn error (timeout, missing binary) leaves status null: never let it
  // pass as a failing run.
  expect(res.error).toBeUndefined();
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

// The "  - <repo> <source>: <reason>" lines listed under the
// "Competitor scan incomplete" header, in order, without the "  - " prefix.
// Exact lines, not substrings: one expected line can be a prefix of another.
function failureLines(out: string): string[] {
  const all = out.split("\n");
  const start = all.findIndex((l) => l.includes("Competitor scan incomplete"));
  expect(start).toBeGreaterThanOrEqual(0);
  const lines: string[] = [];
  for (const l of all.slice(start + 1)) {
    if (!l.startsWith("  - ")) break;
    lines.push(l.slice(4));
  }
  return lines;
}

// Every warning line ("  ⚠ ...") that names the repo.
function warningsFor(out: string, repo: string): string[] {
  return out.split("\n").filter((l) => l.startsWith("  ⚠ ") && l.includes(repo));
}

// Every competitor the script scans, in scan order: homepage column name and repo.
const TRACKED = [
  { name: "VidaiMock", repo: "vidaiUK/VidaiMock" },
  { name: "mock-llm", repo: "dwmkerr/mock-llm" },
  { name: "piyook/llm-mock", repo: "piyook/llm-mock" },
  { name: "mokksy/ai-mocks", repo: "mokksy/ai-mocks" },
];
const TRACKED_REPOS = TRACKED.map((t) => t.repo);

describe("competitive-matrix scan when GitHub fetches fail", () => {
  it.each([
    ["reject", "fetch failed"],
    ["status:403", "HTTP 403 Stubbed"],
    ["status:500", "HTTP 500 Stubbed"],
    ["status:429", "HTTP 429 Stubbed"],
  ])("exits 1 and names every competitor when every fetch fails (%s)", (mode, reason) => {
    const { status, out } = runScan({ STUB_FETCH_MODE: mode });
    expect(out).not.toContain("No changes detected");
    expect(status).toBe(1);
    expect(out).toContain(
      `Competitor scan incomplete: ${TRACKED_REPOS.length} of ${TRACKED_REPOS.length} competitor(s)`,
    );
    expect(failureLines(out)).toEqual(
      TRACKED_REPOS.flatMap((repo) => [
        `${repo} README: ${reason}`,
        `${repo} package.json: ${reason}`,
      ]),
    );
  });
});

// README x package.json fetch outcomes for one competitor. The README is the
// primary source: every competitor repo is expected to have a non-empty one,
// so any README outcome other than "found" fails the run. package.json is
// optional (non-JS competitors have none): a 404 is a real answer and the
// run proceeds; a failed fetch only warns, because the README was scanned.
//
// README 404 + package.json 404 fails, like any other README 404: the
// competitor has no source to scan, so it cannot contribute a detection, and
// the run fails whenever a competitor's scan came back with nothing.
type Outcome = "ok" | "empty" | "nocontent" | "large" | "largefail" | "404" | "500";
type Expect =
  | { result: "proceed" }
  | { result: "warn"; warning: string }
  | { result: "fail"; lines: string[] };

/** The package.json text the stub returns for the target with outcome "ok". */
const STUB_PKG_TEXT = JSON.stringify({ name: "stub-pkg" });
/** A keyword that is plain text, so the README can name it verbatim. */
const LITERAL_KEYWORD = /^[\w/ -]+$/;

/**
 * The detection that the "proceed" cells check reaches the homepage. The
 * script runs against the real docs/index.html, and the scan bot flips its
 * cells over time, so the target is read from the live page: the first
 * tracked competitor (mock-llm first) with a no-cell in a rule-driven row,
 * and a README naming one plain keyword that detects that row's rule and
 * nothing else. Null only when no tracked competitor has any such no-cell.
 */
function pickDetectionTarget(): {
  repo: string;
  readmeText: string;
  detectedLine: string;
  changeLine: string;
} | null {
  const html = readFileSync(resolve(REPO_ROOT, "docs/index.html"), "utf-8");
  const matrix = parseCurrentMatrix(html);
  const order = [...TRACKED].sort(
    (a, b) => Number(b.name === "mock-llm") - Number(a.name === "mock-llm"),
  );
  for (const { name, repo } of order) {
    for (const rule of FEATURE_RULES) {
      for (const kw of rule.keywords.filter((k) => LITERAL_KEYWORD.test(k))) {
        const readmeText = `Mocks the ${kw} endpoint.`;
        // Both the README alone and README + package.json must detect only this rule.
        const detectsOnly = [readmeText, `${readmeText}\n${STUB_PKG_TEXT}`].every((text) => {
          const found = Object.entries(extractFeatures(text)).filter(([, v]) => v);
          return found.length === 1 && found[0][0] === rule.rowLabel;
        });
        if (!detectsOnly) continue;
        const changes = computeChanges(html, matrix, new Map([[name, { [rule.rowLabel]: true }]]));
        if (changes.length !== 1 || applyChanges(html, changes).applied.length !== 1) continue;
        return {
          repo,
          readmeText,
          detectedLine: `  Detected features: ${rule.rowLabel}`,
          changeLine: `  ${name} / ${rule.rowLabel}: No -> Yes`,
        };
      }
    }
  }
  return null;
}

const TARGET = pickDetectionTarget();
const REPO = TARGET?.repo ?? "dwmkerr/mock-llm";
const PKG_500_LINE = `${REPO} package.json: HTTP 500 Stubbed`;
const README_404_LINE = `${REPO} README: not found (HTTP 404)`;
const README_500_LINE = `${REPO} README: HTTP 500 Stubbed`;

const CELLS: Array<[Outcome, Outcome, Expect]> = [
  // README found
  ["ok", "ok", { result: "proceed" }],
  ["ok", "404", { result: "proceed" }],
  [
    "ok",
    "500",
    { result: "warn", warning: `Failed to fetch package.json for ${REPO}: HTTP 500 Stubbed` },
  ],
  // README not found (404)
  ["404", "ok", { result: "fail", lines: [README_404_LINE] }],
  [
    "404",
    "404",
    {
      result: "fail",
      lines: [
        `${REPO} README: not found (HTTP 404), and package.json not found (HTTP 404): ` +
          "no source to scan",
      ],
    },
  ],
  ["404", "500", { result: "fail", lines: [README_404_LINE, PKG_500_LINE] }],
  // README fetch failed
  ["500", "ok", { result: "fail", lines: [README_500_LINE] }],
  ["500", "404", { result: "fail", lines: [README_500_LINE] }],
  ["500", "500", { result: "fail", lines: [README_500_LINE, PKG_500_LINE] }],
  // HTTP 200 without base64 content, and an empty README
  [
    "nocontent",
    "404",
    { result: "fail", lines: [`${REPO} README: response had no base64 content`] },
  ],
  ["empty", "404", { result: "fail", lines: [`${REPO} README: README is empty`] }],
  // A README over 1 MB: GitHub returns empty content with encoding "none", so
  // the scan refetches it with the raw media type. If that fails, the reason
  // names the size and the raw fetch error.
  ["large", "404", { result: "proceed" }],
  [
    "largefail",
    "404",
    {
      result: "fail",
      lines: [
        `${REPO} README: file too large for the JSON response (1500000 bytes); raw fetch failed: HTTP 500 Stubbed`,
      ],
    },
  ],
  ["empty", "ok", { result: "fail", lines: [`${REPO} README: README is empty`] }],
  [
    "ok",
    "nocontent",
    {
      result: "warn",
      warning: `Failed to fetch package.json for ${REPO}: response had no base64 content`,
    },
  ],
];

const FAIL_CELLS = CELLS.filter(([, , want]) => want.result === "fail");
const PROCEED_CELLS = CELLS.filter(([, , want]) => want.result !== "fail");

describe("competitive-matrix README x package.json fetch outcomes", () => {
  it.each(FAIL_CELLS)("README %s, package.json %s", (readme, pkg, want) => {
    const { status, out } = runScan({
      STUB_TARGET: REPO,
      STUB_README: readme,
      STUB_PKG: pkg,
      STUB_README_TEXT: TARGET?.readmeText ?? "Mocks the /v1/embeddings endpoint.",
    });
    if (want.result !== "fail") throw new Error("FAIL_CELLS holds only fail cells");
    expect(status).toBe(1);
    expect(out).toContain("Competitor scan incomplete: 1 of 4 competitor(s)");
    // Exactly these lines: only the target competitor, nothing extra.
    expect(failureLines(out)).toEqual(want.lines);
    expect(out).not.toMatch(/^ {2}Detected features:/m);
    expect(out).not.toContain("No changes detected");
  });
});

// Skipped only when no tracked competitor has a no-cell left in any
// rule-driven homepage row: then no README can produce a homepage change.
describe.skipIf(TARGET === null)(
  "competitive-matrix README x package.json fetch outcomes that proceed" +
    (TARGET === null ? " (skipped: the homepage has no no-cell a scan could flip)" : ""),
  () => {
    it.each(PROCEED_CELLS)("README %s, package.json %s", (readme, pkg, want) => {
      const target = TARGET!;
      const { status, out } = runScan({
        STUB_TARGET: REPO,
        STUB_README: readme,
        STUB_PKG: pkg,
        STUB_README_TEXT: target.readmeText,
      });
      const lines = out.split("\n");
      expect(status).toBe(0);
      expect(out).not.toContain("Competitor scan incomplete");
      // The README was scanned and its detection reached the homepage matrix.
      expect(lines).toContain(target.detectedLine);
      expect(lines).toContain(target.changeLine);
      expect(warningsFor(out, REPO)).toEqual(want.result === "warn" ? [`  ⚠ ${want.warning}`] : []);
    });
  },
);

// The run continues when package.json fails and the README is found, but the
// scan of that competitor is incomplete. The summary (the PR body) must say
// so: it must not claim "no changes", and it must name the repo, the source
// and the cause.
describe("competitive-matrix summary when a package.json fetch fails", () => {
  it("names the warning and does not claim no changes (README ok, package.json 500)", () => {
    const summaryPath = join(dir, "summary-pkg-500.md");
    const { status } = runScan({ STUB_TARGET: REPO, STUB_README: "ok", STUB_PKG: "500" }, [
      "--summary",
      summaryPath,
    ]);
    expect(status).toBe(0);
    const md = readFileSync(summaryPath, "utf-8");
    expect(md).not.toMatch(/^No .*changes/m);
    expect(md.split("\n")[0]).toBe(
      `Competitor scan results are incomplete for ${REPO}. See "Fetch Warnings" below.`,
    );
    expect(md).toContain("## Fetch Warnings");
    expect(md).toContain(`- ${PKG_500_LINE}`);
  });

  it("writes no warning section when every fetch succeeds", () => {
    const summaryPath = join(dir, "summary-clean.md");
    const { status } = runScan({ STUB_TARGET: REPO, STUB_README: "ok", STUB_PKG: "ok" }, [
      "--summary",
      summaryPath,
    ]);
    expect(status).toBe(0);
    const md = readFileSync(summaryPath, "utf-8");
    expect(md).toBe("No competitive matrix changes detected this week.\n");
  });
});
