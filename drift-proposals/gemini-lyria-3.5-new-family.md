# New / unclassified model family: lyria-3.5

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

Decision: EXCLUDE (applied — excludeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `excludeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: non-text generative media — the GA tier of Google's music-generation
line, same category as the `imagen-*` / `veo-*` / `gemini-omni-1.1-flash`
entries.

This is the sharpest case yet for classifying on the MODEL CARD rather than on
`supportedGenerationMethods` alone. Its live entry declares
`supportedGenerationMethods: [generateContent, countTokens]`, so a
methods-only rule would have called it text-capable and argued INCLUDE. The rest
of its own entry settles it: `displayName: "Lyria 3.5"`,
`description: "Music Generation model"`. It emits audio, not a text turn, so it
can never be text-generation drift. (Mirrors `gemini-omni-1.1-flash`, where the
"omni" substring argued the opposite of the truth and the card decided.)

Its `-preview` siblings `lyria-3-clip-preview` and `lyria-3-pro-preview` are
present on the same live listing and are already auto-excluded by
PREVIEW_FAMILY. This GA id carries no `-preview` token, so that rule cannot
reach it and it must be enumerated.
