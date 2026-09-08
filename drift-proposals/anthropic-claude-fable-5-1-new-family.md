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

Rationale: point release of the already-included `claude-fable-5`, exactly as
`claude-opus-4-1` is of `claude-opus-4`.

EVIDENCE LIMIT, stated plainly: no live capability probe was run for this one.
Anthropic's `/v1/models` carries no capability field at all (`id` /
`display_name` / `created_at` only), so the `supportedGenerationMethods` /
chat-probe evidence used for the Gemini and OpenAI entries in this wave has no
Anthropic equivalent — and separately, the only Anthropic key indexed for this
repo is invalid (`/v1/models` → HTTP 401 `authentication_error`, so it needs
rotating; tracked outside this note). The argument is therefore the same one
commit 72f85f8 used to classify `claude-opus-5`: the family is present on the
live listing (drift run 34193766572, 2026-09-08), its sibling `claude-fable-5` is
already included, and the canary reported exactly ONE unclassified anthropic
family that run — so every other live id normalized into `includeFamilies`,
i.e. the whole live Anthropic listing is text-chat Claude families plus this one.
If that inference is ever wrong the canary is the thing that catches it, which is
why this is recorded rather than assumed.
