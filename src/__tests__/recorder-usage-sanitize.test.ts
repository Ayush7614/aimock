import { describe, it, expect } from "vitest";
import { sanitizeRecordedUsage } from "../recorder.js";
import { validateFixtures } from "../fixture-loader.js";
import type { Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// sanitizeRecordedUsage (#369): field classification must be OWN-KEY, and the
// object-field data structure must not imply a dead inner-field allowlist.
//
// The sanitizer's output must always be a SUBSET of what validateFixtures
// accepts, so "a recorded fixture always validates" holds. We assert that
// parity directly by feeding sanitized usage through validateFixtures.
// ---------------------------------------------------------------------------

/** Build a minimal fixture whose response.usage is the sanitized override. */
function fixtureWithUsage(usage: unknown): Fixture[] {
  return [
    {
      match: {},
      response: { content: "ok", usage: usage as never },
    },
  ] as unknown as Fixture[];
}

function usageErrors(usage: unknown): string[] {
  return validateFixtures(fixtureWithUsage(usage))
    .filter((r) => r.severity === "error")
    .map((r) => r.message);
}

describe("sanitizeRecordedUsage — own-key classification (F1)", () => {
  it("keeps a numeric prototype-named scalar and real fields alongside it", () => {
    // `toString` collides with Object.prototype: a `key in USAGE_OBJECT_FIELDS`
    // check misclassifies it as an object-field and drops the numeric value.
    const out = sanitizeRecordedUsage({ toString: 5, prompt_tokens: 10 });
    expect(out).toEqual({ toString: 5, prompt_tokens: 10 });
    // And the validator accepts what the sanitizer produced (parity).
    expect(usageErrors(out)).toEqual([]);
  });

  it("drops an object under a prototype-named key instead of emitting it (validator would reject it)", () => {
    // `valueOf` collides with Object.prototype: `key in USAGE_OBJECT_FIELDS` is
    // true, so an object value is emitted under `valueOf` — which the validator
    // rejects ("usage.valueOf must be a number"), breaking recorder→loader parity.
    const out = sanitizeRecordedUsage({
      valueOf: { reasoning_tokens: 3 },
      completion_tokens: 7,
    });
    // `toEqual` compares OWN enumerable keys, so this proves no `valueOf` key
    // was emitted (a `not.toHaveProperty` check would wrongly match the
    // inherited Object.prototype.valueOf).
    expect(out).toEqual({ completion_tokens: 7 });
    expect(usageErrors(out)).toEqual([]);
  });

  it("classifies the real object fields as objects, not scalars", () => {
    const out = sanitizeRecordedUsage({
      prompt_tokens: 4,
      prompt_tokens_details: { cached_tokens: 2 },
    });
    expect(out).toEqual({
      prompt_tokens: 4,
      prompt_tokens_details: { cached_tokens: 2 },
    });
    expect(usageErrors(out)).toEqual([]);
  });
});

describe("sanitizeRecordedUsage — object-field passthrough (F3 characterization)", () => {
  it("keeps numeric inner fields (documented and undocumented) — the design's forward-compat passthrough", () => {
    // The object-field structure carries only the three field NAMES; the inner
    // arrays were dead. All finite-numeric inner fields survive, matching the
    // validator's index-signature escape hatch for forward-compat inner keys.
    const out = sanitizeRecordedUsage({
      cost_details: {
        upstream_inference_cost: 1.5, // documented
        some_future_inner_cost: 0.25, // undocumented but numeric
      },
    });
    expect(out).toEqual({
      cost_details: {
        upstream_inference_cost: 1.5,
        some_future_inner_cost: 0.25,
      },
    });
    expect(usageErrors(out)).toEqual([]);
  });

  it("drops non-numeric inner fields", () => {
    const out = sanitizeRecordedUsage({
      completion_tokens_details: { reasoning_tokens: 9, label: "nope" },
    });
    expect(out).toEqual({ completion_tokens_details: { reasoning_tokens: 9 } });
    expect(usageErrors(out)).toEqual([]);
  });
});
