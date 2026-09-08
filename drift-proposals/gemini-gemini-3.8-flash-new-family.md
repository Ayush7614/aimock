# New / unclassified model family: gemini-3.8-flash

Provider: gemini
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

Decision: INCLUDE (applied — includeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.gemini` re-pin
in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: stable GA text tier. Google's live `/models` entry declares
`supportedGenerationMethods: [generateContent, countTokens, createCachedContent,
batchGenerateContent]` — set-identical to the already-included
`gemini-3.7-flash` (verified against the same live listing in the same call, not
quoted from the earlier note), and to `gemini-3.6-flash` / `gemini-3.5-flash` —
with `displayName: "Gemini 3.8 Flash"` and no preview, experimental,
confidential or EAP marker. It declares no `bidiGenerateContent` (so it is not a
Live / native-audio surface), no `embedContent`, and no `predict`. It is the next
release in the flash line aimock already mocks at 3.5 through 3.7.
