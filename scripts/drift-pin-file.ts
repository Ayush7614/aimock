/// <reference types="node" />

/**
 * The `logic-pin.test.ts` DATA_FROZEN pin surface — locating, rewriting and
 * VERIFYING a membership re-pin, in one module both the WRITER
 * (`drift-sync.ts`) and the external CHECKER (`drift-sync-check.ts`) import.
 *
 * WHY THIS IS ITS OWN MODULE. `drift-sync-check.ts` gate-1 admits
 * `logic-pin.test.ts` to the sync's changed-file allowlist. Before this module
 * existed, the only thing narrowing that admission lived inside the writer —
 * i.e. the constraint on the pin file was enforced by the same trust domain
 * that edits it, and the external gate (which is the thing an "LLM told to make
 * the drift job pass" cannot talk its way past) had no opinion at all. Because
 * `model-registry.ts` is allowlisted too, that combination was sufficient to
 * silence a frozen surface: widen `isClassifiedFamily`, re-paste that surface's
 * `FROZEN` pin, and gate-1 and gate-2 both pass. `verifyPinFileEdit` is the
 * predicate that closes it, and the CHECKER evaluates it over the git diff.
 *
 * ONE PROPERTY, STATED HONESTLY. The PR this replaces claimed two independent
 * guards and had one and a half: `maskPins` collapses EVERY `pin:` literal to
 * the same token — the FROZEN logic checksums included — so it can tell neither
 * which key moved nor whether the pin it moved was one the sync may touch. It
 * agreed with the locator instead of checking it. `verifyPinFileEdit` replaces
 * the pair with a reconstruction: re-apply exactly the entitled pin rewrites to
 * the pre-edit file and require the result to be the post-edit file byte for
 * byte. Everything else is a refusal by construction.
 */

import ts from "typescript";

/** The exact test file P0 froze the classification logic in. Single source of truth. */
export const LOGIC_PIN_REL_PATH = "src/__tests__/drift/logic-pin.test.ts";

/** A pin literal is always a lowercase 64-char SHA-256 hex digest. */
const PIN_VALUE = /^[0-9a-f]{64}$/;

export interface DataFrozenPin {
  /** The current pin value. */
  pin: string;
  /** Source offset of the first character INSIDE the pin string literal. */
  start: number;
  /** Source offset one past the last character inside the pin string literal. */
  end: number;
}

/**
 * Every `DATA_FROZEN` entry's `pin:` literal, keyed by entry name, located via
 * the real TypeScript parser.
 *
 * AST, not a forward text scan, because a forward scan is how the wrong entry
 * gets rewritten: the previous implementation searched from the key for the next
 * `pin:` and refused only if a QUOTED key intervened — but three real
 * DATA_FROZEN keys are unquoted (`knownVoiceModelFamilies`, `gaRealtimeModels`,
 * `MIN_LISTING_SIZE`), and one of them sits directly after the last key the sync
 * writes. A target entry whose own pin was not recognisable therefore landed the
 * write on the NEXT entry's pin (reproduced against the real file: the realtime
 * canary's seed-set pin was overwritten with a chat-family membership hash).
 * An entry-scoped AST lookup cannot express that failure at all.
 *
 * Returns `null` when the file has no `DATA_FROZEN` object literal — the caller
 * must treat that as a refusal, never as "no keys moved".
 */
export function parseDataFrozenPins(source: string): Map<string, DataFrozenPin> | null {
  const sf = ts.createSourceFile("logic-pin.test.ts", source, ts.ScriptTarget.Latest, true);
  let obj: ts.ObjectLiteralExpression | undefined;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "DATA_FROZEN") continue;
      if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        obj = decl.initializer;
      }
    }
  }
  if (!obj) return null;

  const out = new Map<string, DataFrozenPin>();
  const duplicated = new Set<string>();
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isStringLiteral(prop.name)
      ? prop.name.text
      : ts.isIdentifier(prop.name)
        ? prop.name.text
        : null;
    if (name === null) continue;
    if (out.has(name)) {
      duplicated.add(name);
      continue;
    }
    if (!ts.isObjectLiteralExpression(prop.initializer)) continue;
    for (const entryProp of prop.initializer.properties) {
      if (!ts.isPropertyAssignment(entryProp)) continue;
      const entryName = ts.isIdentifier(entryProp.name)
        ? entryProp.name.text
        : ts.isStringLiteral(entryProp.name)
          ? entryProp.name.text
          : null;
      if (entryName !== "pin") continue;
      const init = entryProp.initializer;
      if (!ts.isStringLiteral(init)) continue;
      out.set(name, { pin: init.text, start: init.getStart(sf) + 1, end: init.getEnd() - 1 });
    }
  }
  // A duplicated key is a structural surprise, not a choice between two spans:
  // drop it entirely so every consumer refuses rather than picking one.
  for (const name of duplicated) out.delete(name);
  return out;
}

/**
 * Replace the `pin:` literal belonging to ONE DATA_FROZEN key. Returns
 * `locatorMiss` when the key is missing, duplicated, or carries no recognisable
 * pin — the caller routes that to a human rather than guessing, exactly as it
 * does for a registry structural mismatch.
 *
 * The rewrite is span-exact and entry-scoped: the bytes replaced are the ones
 * INSIDE the named entry's own pin string literal, so the write cannot land on
 * a neighbouring entry however the surrounding file is shaped.
 */
export function updateDataFrozenPin(
  source: string,
  key: string,
  newPin: string,
): { text: string; changed: boolean; locatorMiss: boolean } {
  const pins = parseDataFrozenPins(source);
  const target = pins?.get(key);
  // No DATA_FROZEN, no such entry, a duplicated entry, an entry with no `pin:`
  // string literal, or a pin that is not a recognisable digest: all refusals.
  if (!target || !PIN_VALUE.test(target.pin)) {
    return { text: source, changed: false, locatorMiss: true };
  }
  if (target.pin === newPin) return { text: source, changed: false, locatorMiss: false };
  return {
    text: source.slice(0, target.start) + newPin + source.slice(target.end),
    changed: true,
    locatorMiss: false,
  };
}

/** Every `pin: "<hex>"` literal, normalised away — used to prove a diff is pin-only. */
function maskPins(source: string): string {
  return source.replace(/pin:\s*"[0-9a-f]{64}"/g, 'pin: "<PIN>"');
}

/**
 * `after` differs from `before` only inside SOME `pin:` string literal.
 *
 * NOT A GUARD, and the PR this replaces mistook it for one. `maskPins` collapses
 * EVERY `pin:` literal in the file to one token — the `FROZEN` LOGIC checksums
 * included — so re-pasting the checksum of a widened `isClassifiedFamily` reads
 * as "pin-only" here and sails through; reproduced end to end, with gate-1 and
 * gate-2 both passing a tree whose classification rule had been silenced. It
 * decides nothing in {@link verifyPinFileEdit}: it only picks which of that
 * refusal's two messages is the true one.
 */
export function onlyPinsChanged(before: string, after: string): boolean {
  return maskPins(before) === maskPins(after);
}

export type PinKeyDiff =
  | { ok: true; changedKeys: string[] }
  | { ok: false; changedKeys: string[]; detail: string };

/**
 * Exactly which DATA_FROZEN entries' pins differ between two revisions of the
 * pin file, BY NAME.
 *
 * Not ok when either revision has no parseable `DATA_FROZEN`, or when the set of
 * entries itself changed — an entry appearing or disappearing is a structural
 * edit, not a re-pin, and must never be reported as "these keys moved".
 */
export function diffPinKeys(before: string, after: string): PinKeyDiff {
  const a = parseDataFrozenPins(before);
  const b = parseDataFrozenPins(after);
  if (a === null || b === null) {
    return {
      ok: false,
      changedKeys: [],
      detail: "could not parse a DATA_FROZEN pin table out of the pin file",
    };
  }
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  if (added.length > 0 || removed.length > 0) {
    return {
      ok: false,
      changedKeys: [],
      detail:
        `the DATA_FROZEN entry set itself changed (added: ${added.join(", ") || "none"}; ` +
        `removed: ${removed.join(", ") || "none"}) — that is a structural edit, not a re-pin`,
    };
  }
  const changedKeys = [...a.keys()].filter((k) => a.get(k)!.pin !== b.get(k)!.pin).sort();
  return { ok: true, changedKeys };
}

/** The DATA_FROZEN keys drift-sync is ever entitled to re-pin: membership of the sets it edits. */
export const SYNC_REPINNABLE_KEYS: ReadonlySet<string> = new Set(
  ["includeFamilies", "excludeFamilies"].flatMap((list) =>
    ["openai", "anthropic", "gemini"].map((provider) => `${list}.${provider}`),
  ),
);

/**
 * The single predicate that makes admitting `logic-pin.test.ts` to the sync's
 * changed-file allowlist safe: this diff is a membership re-pin of `allowedKeys`
 * AND NOTHING ELSE.
 *
 * It is stated as a RECONSTRUCTION, not as a pattern the diff must avoid: take
 * `before`, apply exactly the entitled pin rewrites `after` asks for, and demand
 * the result be `after` BYTE FOR BYTE. Any other edit anywhere in the file — a
 * re-pasted `FROZEN` logic checksum, a widened `members` thunk, a deleted entry,
 * a changed comment — makes the reconstruction differ, with no enumeration of
 * forbidden shapes to keep exhaustive.
 *
 * Evaluated in two places, deliberately, over different inputs:
 *   * the WRITER, over its own in-memory rewrite, with `allowedKeys` = the keys
 *     THIS run re-pinned — so a write that lands on any other entry is refused
 *     before it reaches the filesystem;
 *   * the CHECKER (gate-1b), over the git diff of the working tree against HEAD,
 *     with `allowedKeys` = {@link SYNC_REPINNABLE_KEYS} — so a pin-file diff that
 *     re-pastes a `FROZEN` LOGIC checksum is refused by the external gate, no
 *     matter which writer produced it. That one is the real boundary: it does not
 *     trust the writer at all.
 */
export function verifyPinFileEdit(
  before: string,
  after: string,
  allowedKeys: ReadonlySet<string>,
): { ok: boolean; detail: string } {
  const diff = diffPinKeys(before, after);
  if (!diff.ok) return { ok: false, detail: diff.detail };
  const offending = diff.changedKeys.filter((k) => !allowedKeys.has(k));
  if (offending.length > 0) {
    return {
      ok: false,
      detail:
        `the edit re-pinned DATA_FROZEN key(s) it is not entitled to move: ${offending.join(", ")} ` +
        `(allowed: ${[...allowedKeys].sort().join(", ")})`,
    };
  }
  const afterPins = parseDataFrozenPins(after)!;
  let reconstructed = before;
  for (const key of diff.changedKeys) {
    const edit = updateDataFrozenPin(reconstructed, key, afterPins.get(key)!.pin);
    if (edit.locatorMiss) {
      return { ok: false, detail: `could not re-locate the DATA_FROZEN pin for "${key}"` };
    }
    reconstructed = edit.text;
  }
  if (reconstructed !== after) {
    // ONE verdict, two messages. `onlyPinsChanged` cannot decide anything here —
    // it is blind to WHICH pin moved, which is why it was never a second guard —
    // but it does separate the two ways to fail this, and a refusal that says
    // which one it is saves the next reader the diff.
    return {
      ok: false,
      detail: onlyPinsChanged(before, after)
        ? "the edit moved a `pin:` literal that is not a re-pinnable membership pin — a " +
          "re-pasted FROZEN logic checksum looks pin-only and lands exactly here"
        : "the edit changed bytes outside a `pin:` string literal",
    };
  }
  return {
    ok: true,
    detail:
      diff.changedKeys.length === 0
        ? "no DATA_FROZEN pin moved"
        : `re-pinned ${diff.changedKeys.join(", ")} and nothing else`,
  };
}
