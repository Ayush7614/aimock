import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The script imports writeFileSync from node:fs. Wrap it so a test can make
// one target path fail while every other write goes through to disk.
const failOn = vi.hoisted(() => ({ suffix: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (failOn.suffix && typeof file === "string" && file.endsWith(failOn.suffix)) {
      const err = new Error(`EACCES: permission denied, open '${file}'`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return actual.writeFileSync(file, data, options);
  };
  return { ...actual, writeFileSync };
});

import {
  COMPETITOR_MIGRATION_PAGES,
  runMatrixUpdate,
} from "../../scripts/update-competitive-matrix.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE_REL = "docs/index.html";
const MOCK_LLM_PAGE = COMPETITOR_MIGRATION_PAGES["mock-llm"];
const MIGRATION_PAGES = Object.values(COMPETITOR_MIGRATION_PAGES);

// The real homepage's no-cell markup, and the real migration pages' cross cell.
const REAL_NO_CELL = '<td><span class="no" role="img" aria-label="No">&#10007;</span></td>';
const MIGRATION_CROSS = '<td style="color: var(--error)">&#10007;</td>';

/**
 * `html` with mock-llm's "Claude Messages API" cell set to a no-cell. The
 * column index is read from the header. The scan bot flips the live cells over
 * time, so the test sets the state it needs in its copy.
 */
function withMockLlmClaudeNo(html: string): string {
  const thead = html.match(
    /<table class="comparison-table">[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  )![1];
  const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  const col = headers.findIndex((h) => /<a\b[^>]*>\s*mock-llm\s*<\/a>/.test(h));
  expect(col).toBeGreaterThan(0);
  const tr = html.match(
    /<tr\b[^>]*>\s*<th scope="row">Claude Messages API<\/th>[\s\S]*?<\/tr>/,
  )![0];
  let idx = 0;
  const newTr = tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (c) =>
    idx++ === col ? REAL_NO_CELL : c,
  );
  expect(idx).toBeGreaterThan(col);
  return html.replace(tr, () => newTr);
}

/** `html` (the mock-llm migration page) with its Anthropic Claude cell set to a cross. */
function withAnthropicClaudeCross(html: string): string {
  const re = /(<td>Anthropic Claude<\/td>\s*)<td[^>]*>[\s\S]*?<\/td>/;
  expect(html).toMatch(re);
  return html.replace(re, (_m, pre: string) => pre + MIGRATION_CROSS);
}

// With mock-llm's homepage "Claude Messages API" cell set to no and its
// migration page's Anthropic Claude cell set to a cross (in the copies), this
// one detection changes both the homepage and one migration page.
const FEATURES = new Map<string, Record<string, boolean>>([
  ["mock-llm", { "Claude Messages API": true }],
]);

describe("competitive-matrix run when a docs write fails partway", () => {
  let root: string;
  let summaryPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "cm-write-fail-"));
    for (const rel of [HOMEPAGE_REL, ...MIGRATION_PAGES]) {
      fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
      fs.copyFileSync(resolve(REPO_ROOT, rel), join(root, rel));
    }
    fs.writeFileSync(join(root, HOMEPAGE_REL), withMockLlmClaudeNo(read(HOMEPAGE_REL)));
    fs.writeFileSync(join(root, MOCK_LLM_PAGE), withAnthropicClaudeCross(read(MOCK_LLM_PAGE)));
    summaryPath = join(root, "summary.md");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    failOn.suffix = null;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (rel: string) => fs.readFileSync(join(root, rel), "utf-8");
  const run = () =>
    runMatrixUpdate({
      repoRoot: root,
      competitorFeatures: FEATURES,
      competitorProviderCounts: new Map(),
      dryRun: false,
      summaryPath,
    });

  it("the fixture changes the homepage and the mock-llm migration page", () => {
    const homepageBefore = read(HOMEPAGE_REL);
    const pageBefore = read(MOCK_LLM_PAGE);
    run();
    expect(read(HOMEPAGE_REL)).not.toBe(homepageBefore);
    expect(read(MOCK_LLM_PAGE)).not.toBe(pageBefore);
    const summary = read("summary.md");
    expect(summary).toContain("| mock-llm | Claude Messages API | No -> Yes |");
    expect(summary).toContain(`\`${MOCK_LLM_PAGE}\`: mock-llm: Anthropic Claude`);
  });

  it("names the files already written and writes no summary when a migration page write fails", () => {
    const pageBefore = read(MOCK_LLM_PAGE);
    failOn.suffix = MOCK_LLM_PAGE;

    expect(run).toThrow(
      new RegExp(
        `Failed to write ${MOCK_LLM_PAGE}[\\s\\S]*Files already written: ${HOMEPAGE_REL}\\.`,
      ),
    );

    expect(read(MOCK_LLM_PAGE)).toBe(pageBefore);
    // No summary may claim the migration change that never reached the page.
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it("names every docs file already written when the summary write fails", () => {
    failOn.suffix = "summary.md";

    expect(run).toThrow(
      new RegExp(
        `Failed to write ${summaryPath}[\\s\\S]*` +
          `Files already written: ${HOMEPAGE_REL}, ${MOCK_LLM_PAGE}\\.`,
      ),
    );
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it("reports no files written and writes no summary when the homepage write fails", () => {
    const homepageBefore = read(HOMEPAGE_REL);
    const pageBefore = read(MOCK_LLM_PAGE);
    failOn.suffix = HOMEPAGE_REL;

    expect(run).toThrow(
      new RegExp(`Failed to write ${HOMEPAGE_REL}[\\s\\S]*Files already written: none\\.`),
    );

    expect(read(HOMEPAGE_REL)).toBe(homepageBefore);
    expect(read(MOCK_LLM_PAGE)).toBe(pageBefore);
    expect(fs.existsSync(summaryPath)).toBe(false);
  });
});
