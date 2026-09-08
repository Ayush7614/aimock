import { describe, it, expect } from "vitest";
import { resolveOpenRouterShaping } from "../openrouter-chat.js";
import type { ResponseOverrides } from "../types.js";

// ---------------------------------------------------------------------------
// Prototype-pollution guard for the forward-compat usage passthrough (#369 CR).
//
// The passthrough loop in resolveOpenRouterShaping copies every un-shaped usage
// key onto the emitted `usageExtras`. Recorded fixtures are attacker-adjacent —
// they come from upstream provider responses — and JSON.parse materializes a
// `"__proto__"` (or `"constructor"` / `"prototype"`) key as a REAL own,
// enumerable property. A plain `usageExtras[key] = value` assignment for such a
// key hits the prototype setter, corrupting the emitted object's prototype
// chain rather than emitting a data field. The passthrough must be
// prototype-safe: skip those keys while letting legitimate un-shaped keys
// (e.g. `native_tokens_prompt`) through verbatim.
// ---------------------------------------------------------------------------

/**
 * Build a usage override whose extras include a `__proto__`, `constructor`, and
 * `prototype` OWN key. A source-level object literal cannot express the first
 * of these — `{ __proto__: … }` sets the prototype instead of an own key — so
 * parse it from JSON, exactly as the recorder would load a captured upstream
 * usage frame. All three keys exercise a distinct leg of `UNSAFE_PROTO_KEYS`.
 */
function usageWithProtoKeys(): ResponseOverrides {
  const usage = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true},"native_tokens_prompt":1200}',
  ) as ResponseOverrides["usage"];
  return { usage };
}

describe("openrouter usage passthrough — prototype safety", () => {
  it("does not let a __proto__ usage key corrupt the emitted object's prototype", () => {
    const shaping = resolveOpenRouterShaping(usageWithProtoKeys(), "openai/gpt-4o");
    const extras = shaping.usageExtras;

    // The emitted object's prototype chain must be intact — no bogus inherited prop.
    expect(Object.getPrototypeOf(extras)).toBe(Object.prototype);
    expect("polluted" in extras).toBe(false);
    expect((extras as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not emit __proto__ / constructor / prototype as own keys", () => {
    const shaping = resolveOpenRouterShaping(usageWithProtoKeys(), "openai/gpt-4o");
    const extras = shaping.usageExtras;

    expect(Object.prototype.hasOwnProperty.call(extras, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(extras, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(extras, "prototype")).toBe(false);
  });

  it("still passes legitimate un-shaped usage keys through verbatim", () => {
    const shaping = resolveOpenRouterShaping(usageWithProtoKeys(), "openai/gpt-4o");
    const extras = shaping.usageExtras as Record<string, unknown>;
    expect(extras.native_tokens_prompt).toBe(1200);
    expect(Object.prototype.hasOwnProperty.call(extras, "native_tokens_prompt")).toBe(true);
  });
});
