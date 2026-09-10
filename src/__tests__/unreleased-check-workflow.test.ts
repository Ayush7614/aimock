/**
 * Assertions on .github/workflows/unreleased-check.yml.
 *
 * The check answers one question — "are there commits on main since the last
 * release tag that changed what we publish?" — and its whole value is that a
 * warning means something. It used to ask `git log v<ver>..HEAD -- 'src/'`,
 * and `src/__tests__/` lives under `src/`, so test-only and drift-harness-only
 * work counted as unreleased source changes. On `main` @ 8b0485b it warned
 * about 2 "source commits" that touched only `src/__tests__/drift/*`,
 * `drift-proposals/*` and `scripts/drift-sync*.ts` — nothing in the tarball.
 *
 * These guards EXECUTE the step's own `run:` body under bash against synthetic
 * git repositories, because the only claim worth pinning is behavioural: which
 * commits does it count. In particular the positive controls matter more than
 * the false-positive fix — a check that stopped crying wolf by no longer
 * barking at all would be a strictly worse bug than the one being fixed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, describe, it, expect, vi } from "vitest";

// Each observation shells out to git a dozen times and then runs the body
// itself under bash. That is far slower than a substring test, and a guard
// whose RED cannot be told apart from a timeout proves nothing, so the budget
// for this file is stated rather than inherited from the 5000ms default.
vi.setConfig({ testTimeout: 30_000 });

const WORKFLOW_PATH = resolve(__dirname, "../../.github/workflows/unreleased-check.yml");
const wf = readFileSync(WORKFLOW_PATH, "utf-8");

/**
 * The single `run:` block scalar in the workflow, dedented.
 *
 * `runBodyIsVerbatim` below re-indents the result and requires it to be a
 * literal substring of the file, so an extractor that paraphrases — and
 * therefore an observation that tests something other than what CI runs —
 * cannot pass.
 */
function runBody(): { body: string; indent: number } {
  const lines = wf.split("\n");
  const at = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  if (at === -1) throw new Error("unreleased-check.yml: no `run: |` block found");
  const indent = lines[at].length - lines[at].trimStart().length + 2;
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      out.push("");
      continue;
    }
    if (l.length - l.trimStart().length < indent) break;
    out.push(l.slice(indent));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return { body: out.join("\n") + "\n", indent };
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

function write(cwd: string, rel: string, contents: string): void {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/** The repo's real published-file declarations, so the fixture cannot drift from it. */
const realPkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as {
  files: string[];
};
const realTsconfig = JSON.parse(
  readFileSync(resolve(__dirname, "../../tsconfig.json"), "utf-8"),
) as {
  compilerOptions: Record<string, unknown>;
  include: string[];
  exclude: string[];
};

interface Observation {
  stdout: string;
  exit: number;
  /** The commit-count the check reported, or 0 when it reported none. */
  count: number;
}

/**
 * Build a repo tagged `v1.0.0`, apply `after` on top of the tag, and run the
 * workflow's own step body in it.
 */
function observe(
  after: Array<{ message: string; files: Record<string, string> }>,
  pkgOverride: Partial<{ files: string[] }> = {},
): Observation {
  const dir = mkdtempSync(join(tmpdir(), "unreleased-check-"));
  tmpDirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");

  write(
    dir,
    "package.json",
    JSON.stringify({ name: "f", version: "1.0.0", files: realPkg.files, ...pkgOverride }, null, 2) +
      "\n",
  );
  write(dir, "tsconfig.json", JSON.stringify(realTsconfig, null, 2) + "\n");
  write(dir, "src/index.ts", "export const a = 1;\n");
  write(dir, "src/__tests__/a.test.ts", "// t\n");
  write(dir, "scripts/tool.ts", "// s\n");
  write(dir, "skills/x/SKILL.md", "# x\n");
  write(dir, "fixtures/x.json", "{}\n");
  write(dir, "CHANGELOG.md", "# changelog\n");
  write(dir, ".github/workflows/w.yml", "name: w\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "release 1.0.0");
  git(dir, "tag", "v1.0.0");

  for (const c of after) {
    for (const [rel, contents] of Object.entries(c.files)) write(dir, rel, contents);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", c.message);
  }

  const r = spawnSync("bash", ["-e", "-c", runBody().body], { cwd: dir, encoding: "utf-8" });
  const stdout = (r.stdout ?? "") + (r.stderr ?? "");
  const m = /::warning::(\d+) published-file commits/.exec(stdout);
  return { stdout, exit: r.status ?? -1, count: m ? Number(m[1]) : 0 };
}

describe("unreleased-check.yml — the run body under test is the committed one", () => {
  it("the extracted `run:` body is a LITERAL substring of the file when re-indented", () => {
    const { body, indent } = runBody();
    const pad = " ".repeat(indent);
    const reindented = body
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l === "" ? "" : pad + l))
      .join("\n");
    expect(wf).toContain(reindented);
  });

  it("still counts commits with a real git log, not a hard-coded 'src/' pathspec", () => {
    expect(runBody().body).toContain('git log "${TAG}..HEAD"');
    expect(runBody().body).not.toContain("-- 'src/'");
  });
});

describe("unreleased-check.yml — the false positive it was crying wolf over", () => {
  it("EXECUTED: a test-only commit under src/__tests__/ is NOT an unreleased change", () => {
    const o = observe([
      { message: "test: harness only", files: { "src/__tests__/a.test.ts": "// changed\n" } },
    ]);
    expect(o.exit).toBe(0);
    expect(o.count).toBe(0);
    expect(o.stdout).toContain("No unreleased published-file changes");
  });

  it("EXECUTED: scripts/ and .github/ commits are NOT unreleased changes", () => {
    const o = observe([
      { message: "chore: tooling", files: { "scripts/tool.ts": "// changed\n" } },
      { message: "ci: workflow", files: { ".github/workflows/w.yml": "name: w2\n" } },
    ]);
    expect(o.exit).toBe(0);
    expect(o.count).toBe(0);
  });
});

describe("unreleased-check.yml — POSITIVE CONTROLS: it still barks at a real one", () => {
  it("EXECUTED: a real src/*.ts change IS an unreleased change", () => {
    const o = observe([
      { message: "feat: real source", files: { "src/index.ts": "export const a = 2;\n" } },
    ]);
    expect(o.exit).toBe(0);
    expect(o.count).toBe(1);
    expect(o.stdout).toContain("version has not been bumped");
    expect(o.stdout).toContain("feat: real source");
  });

  it("EXECUTED: a test-only commit does not MASK a real source commit beside it", () => {
    const o = observe([
      { message: "test: harness only", files: { "src/__tests__/a.test.ts": "// changed\n" } },
      { message: "feat: real source", files: { "src/index.ts": "export const a = 3;\n" } },
    ]);
    expect(o.count).toBe(1);
    expect(o.stdout).toContain("feat: real source");
    expect(o.stdout).not.toContain("test: harness only");
  });

  it("EXECUTED: changes to published NON-src paths count too (the old pathspec missed them)", () => {
    for (const [label, rel] of [
      ["skills", "skills/x/SKILL.md"],
      ["fixtures", "fixtures/x.json"],
      ["changelog", "CHANGELOG.md"],
    ] as const) {
      const o = observe([{ message: `feat: ${label}`, files: { [rel]: "changed\n" } }]);
      expect(o.count, `${label} (${rel}) must count as an unreleased change`).toBe(1);
    }
  });
});

describe("unreleased-check.yml — the pathspec cannot silently become 'everything'", () => {
  it("EXECUTED: an underivable published-file set is a hard error, not a match-all", () => {
    // `git log -- ` with no paths matches EVERY path, which would turn this
    // check into pure noise. It must refuse instead of degrading into one.
    const o = observe([{ message: "chore: tooling", files: { "scripts/tool.ts": "// c\n" } }], {
      files: [],
    });
    expect(o.exit).toBe(1);
    expect(o.stdout).toContain("::error::");
    expect(o.stdout).not.toContain("published-file commits");
  });

  it("EXECUTED: the pathspec is DERIVED from package.json, so it follows a new entry", () => {
    const o = observe([{ message: "feat: docs page", files: { "docs/x.md": "x\n" } }], {
      files: [...realPkg.files, "docs"],
    });
    expect(o.count).toBe(1);
    expect(o.stdout).toContain("feat: docs page");
  });

  it("EXECUTED: with the real files list, docs/ is NOT published and does not count", () => {
    const o = observe([{ message: "docs: page", files: { "docs/x.md": "x\n" } }]);
    expect(o.count).toBe(0);
  });
});

describe("unreleased-check.yml — the release commit itself", () => {
  it("EXECUTED: a version whose tag does not exist yet is skipped, not warned about", () => {
    const o = observe([
      {
        message: "chore(release): 1.1.0",
        files: {
          "package.json":
            JSON.stringify({ name: "f", version: "1.1.0", files: realPkg.files }, null, 2) + "\n",
          "src/index.ts": "export const a = 4;\n",
        },
      },
    ]);
    expect(o.exit).toBe(0);
    expect(o.count).toBe(0);
    expect(o.stdout).toContain("Skipping");
  });
});
