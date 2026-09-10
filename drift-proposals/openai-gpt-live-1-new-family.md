# New / unclassified model family: gpt-live-1

Provider: openai
Detected: 2026-09-10
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides, by
     changing the line below to either:

       Decision: include   — aimock mocks this family on the chat surface
       Decision: exclude   — wrong modality / retired / preview; not ours

     The NEXT drift-sync run then applies the mechanical registry edit to
     includeFamilies or excludeFamilies respectively, and re-pins that
     set's membership checksum in the same commit (still zero-LLM: this
     is a human-authored decision, not generated code). -->

<!-- NOTE: the `Decision: exclude` marker below is drift-sync's AUTOMATED path,
     added in PR #423 (before that, only `Decision: include` was mechanized and
     `exclude` fail-closed to `pending`). It is recorded here for the record and
     for durability, but nothing in this change RELIES on it: the registry edit,
     the membership re-pin and the offline /models wave update were all applied
     by hand in the same commit. Because `gpt-live-1` is classified as of that
     commit, `unclassifiedFamiliesForSync` will never return it again, so the
     addition half of drift-sync never revisits this note — the marker is inert
     unless the exclude entry is ever removed, in which case re-applying it is
     the correct behavior. -->

Decision: exclude (applied 2026-09-10 — excludeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, plus the static OpenAI /models wave in
`src/__tests__/drift/models.drift.ts`, plus the `excludeFamilies.openai`
membership pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: wrong modality AND wrong endpoint. `gpt-live-1` is OpenAI's
GPT-Live-1, a full-duplex voice model served on the NEW `/v1/live/sessions`
endpoint. It is a SIBLING of the Realtime API, not a successor — its model page
marks Realtime as "Not supported" — and it never answers on
/v1/chat/completions, so it can never be text-generation drift. This mirrors the
treatment every other voice/audio/realtime family already gets here
(`gpt-realtime*`, `gpt-audio*`, `gpt-transcribe`, `gpt-live-transcribe`,
`tts-1`, `whisper-1`), recorded in
drift-proposals/openai-gpt-live-transcribe-new-family.md (PR #343).

Membership in `excludeFamilies` is a CLASSIFICATION for the `/models` listing
check in models.drift.ts and nothing more: it says the family is accounted for,
NOT which endpoints aimock implements for it.

## Scope: aimock does NOT mock /v1/live, and this note does not propose that

Mocking `/v1/live/sessions` is explicitly out of scope. There is no demand for
it (no open issue; the only realtime ask closed in May), and a real mock would
need a new route, a sideband socket and full-duplex framing. This note records a
classification, not a roadmap item.

## Deliberately NOT added to `knownVoiceModelFamilies`

`knownVoiceModelFamilies` (src/\_\_tests\_\_/drift/voice-models.ts) is a
DIFFERENT canary's inventory: the realtime/voice canary in ws-realtime.drift.ts,
which asks "does the account's listing carry a voice family this repo has not
seen before". Two reasons `gpt-live-1` stays out of it:

1. Different meaning. Membership there asserts the realtime canary RECOGNIZES
   the family as part of the surface it watches over `/v1/realtime`. `gpt-live-1`
   lives on `/v1/live/sessions`, which aimock does not implement and does not
   intend to — marking it "known" would assert coverage that does not exist. The
   `excludeFamilies` entry makes the accurate, narrower statement ("not
   chat-surface drift").
2. Blast radius. `gpt-live-1` is the canonical worked EXAMPLE of "a genuinely new
   voice family" throughout the voice canary and its frozen-logic pins —
   ws-realtime-canary.test.ts (the `knownVoiceModelFamilies.has(...) === false`
   negative control), logic-pin.test.ts, model-family.test.ts, and the docblocks
   in voice-models.ts and model-family.ts. Adding it would require rewriting the
   canary's own negative control, which is a larger and riskier edit than the
   classification this note is about.

Whether `gpt-live-1` actually appears in this account's live `GET /v1/models`
payload — and therefore whether the voice canary will emit an
`UNKNOWN_REALTIME_MODELS=` marker for it — has NOT been observed here. If and
when the nightly voice canary does flag it, that is a separate decision and gets
its own note.
