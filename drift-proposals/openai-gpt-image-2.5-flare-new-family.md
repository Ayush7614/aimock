# New / unclassified model family: gpt-image-2.5-flare

Provider: openai
Detected: 2026-09-10
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. To approve adding it to
     the registry, change the line below to `Decision: include` — the NEXT
     drift-sync run will then apply the mechanical registry edit (still
     zero-LLM: this is a human-authored decision, not generated code). -->

<!-- NOTE: the `Decision: include` marker documented above is drift-sync's
     AUTOMATED path, and it writes EXCLUSIVELY into `includeFamilies`
     (scripts/drift-sync.ts: addFamilyLiteralInSource(..., "includeFamilies", ...)).
     There is no automated exclude path, so an EXCLUDE decision is recorded here
     in prose and applied by hand — writing `include` would misclassify. -->

Decision: EXCLUDE (applied 2026-09-10 — excludeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, plus the static OpenAI /models wave in
`src/__tests__/drift/models.drift.ts`).

Rationale: wrong modality — `gpt-image-2.5-flare` is an image-generation
model on the same lineage as the already-excluded `gpt-image-2`. It serves
/v1/images/generations and never answers on /v1/chat/completions, so it is not
text-generation drift. Mirrors the existing dall-e-\* / gpt-image-\* /
chatgpt-image-latest entries.
