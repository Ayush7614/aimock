# New / unclassified model family: claude-fable-5-1

Provider: anthropic
Detected: 2026-09-05
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision
<!-- drift-sync never auto-classifies a new family. To approve adding it to
     the registry, change the line below to `Decision: include` — the NEXT
     drift-sync run will then apply the mechanical registry edit (still
     zero-LLM: this is a human-authored decision, not generated code). -->
<!-- NOTE: the automated `Decision: include` path CANNOT apply this one. It
     writes into the family sets in `model-registry.ts`, whose membership is
     checksum-pinned in `logic-pin.test.ts` (DATA_FROZEN), and drift-sync-check
     gate-2 re-runs that exact test after the edit. drift-sync cannot update the
     pin — the gate-1 changed-file allowlist admits only `model-registry.ts` and
     `drift-proposals/`, so `logic-pin.test.ts` is off-limits to it. Leaving
     `Decision: include` here would therefore produce `reason=gate-failed` and
     revert the edit, not `ok-applied`. So the decision is applied BY HAND
     together with its re-pin, in one reviewed commit — the same way every prior
     classification landed (72f85f8 claude-opus-5, aa51d0c
     gemini-3.5-flash-lite/3.6-flash, and the gemini-3.7-flash note here). -->

Decision: INCLUDE (applied — includeFamilies.anthropic in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.anthropic`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: GA text chat, measured. Anthropic's `/v1/models` carries no
capability field (`id` / `display_name` / `created_at` only), so the
`supportedGenerationMethods` evidence used for the Gemini entries has no
equivalent here — but `/v1/messages` does: a minimal call
(`max_tokens: 16`, one user turn) returns **HTTP 200** with
`stop_reason: "end_turn"`, `model: "claude-fable-5-1"` and a real assistant
turn. Its listing entry is `display_name: "Claude Fable 5.1"`,
`created_at: 2026-08-28`, i.e. the point release of the already-included
`claude-fable-5` ("Claude Fable 5", 2026-06-07) — the same relationship
`claude-opus-4-1` has to `claude-opus-4`.

Corroborating: all 11 ids on the live listing are text-chat Claude families
(`claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`,
`claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`,
`claude-opus-4-5`, `claude-haiku-4-5`, `claude-sonnet-4-5`), and the canary
reported exactly ONE unclassified anthropic family — so every other live id
already normalized into `includeFamilies`.
