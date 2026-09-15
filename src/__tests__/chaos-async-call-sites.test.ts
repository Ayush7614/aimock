import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Integration guard: a route handler that calls the synchronous `applyChaos()`
// silently drops the configured latency (`--chaos-latency` is only awaited by
// `applyChaosAsync()`), so every module under src/ except chaos.ts itself must
// use the async form.
//
// This is the gate that a green-per-branch, broken-when-merged composition
// slips past: each PR that adds routes is correct in isolation, the suite
// passes on every branch, and nothing asserts the sync form is gone. The check
// is therefore structural — it reads the sources rather than exercising a
// server, so a new route is covered the moment it is written.
//
// The files are read with the TypeScript parser, not a regex: a mention of
// `applyChaos(` inside a comment or a string is not a call site, and a regex
// scan cannot tell the difference. Reading is done with `fs` rather than a
// shell `grep` because src/fixture-loader.ts contains a literal NUL byte, on
// which grep reports a binary file and silently contributes no matches.
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The one module allowed to call the sync form: `applyChaosAsync` delegates to it. */
const ALLOWED = "chaos.ts";

const SYNC_NAME = "applyChaos";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    if (path.relative(SRC_ROOT, full) === ALLOWED) continue;
    out.push(full);
  }
  return out;
}

/** `applyChaos(...)` call sites in one file, as "<relative path>:<line>" strings. */
function syncCallSites(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const hits: string[] = [];

  const callee = (node: ts.CallExpression): string | undefined => {
    if (ts.isIdentifier(node.expression)) return node.expression.text;
    if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callee(node) === SYNC_NAME) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push(`src/${path.relative(SRC_ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return hits;
}

describe("chaos call sites", () => {
  it("no module outside src/chaos.ts calls the synchronous applyChaos()", () => {
    const offenders = sourceFiles(SRC_ROOT).flatMap(syncCallSites).sort();

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Synchronous applyChaos() call sites found — configured chaos latency ` +
            `does not apply on these paths. Convert each to \`await applyChaosAsync(...)\` ` +
            `(see src/chaos.ts):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("finds the call sites it is looking for", () => {
    // Positive control: the scanner must actually see a call, or the guard above
    // passes vacuously for every file. chaos.ts is excluded from the guard, so
    // its own internal delegation is the fixture.
    expect(syncCallSites(path.join(SRC_ROOT, ALLOWED)).length).toBeGreaterThan(0);
  });
});
