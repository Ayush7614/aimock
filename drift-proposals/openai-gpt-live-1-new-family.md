# New / unclassified model family: gpt-live-1

Provider: openai
Detected: 2026-09-10
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. To approve adding it to
     the registry, a HUMAN changes the line below to `Decision: include` or
     `Decision: exclude` — the NEXT drift-sync run then applies the mechanical
     registry edit (still zero-LLM: this is a human-authored decision, not
     generated code). -->

<!-- DELIBERATELY NOT USING THE `Decision:` MARKER. Read this before adding one.

     PR #423 mechanized the `exclude` verdict (before it, `exclude` fail-closed
     to `pending` and only `include` was automated). But that automated path is
     INCOMPLETE FOR VOICE/AUDIO FAMILIES, which is exactly what this one is:

       - It writes `excludeFamilies[provider]` and re-pins that set. It NEVER
         writes `knownVoiceModelFamilies` (voice-models.ts).
       - `isVoiceModelId("gpt-live-1")` is true, so `ws-realtime.drift.ts` — which
         is in drift-sync's gate-3 re-collect — would still report
         `UNKNOWN_REALTIME_MODELS=gpt-live-1` and emit a CRITICAL.
       - Gate-3 red REVERTS both edited files, so the run ends `gate-failed`. The
         automated path would therefore APPLY AND REVERT, every run, forever —
         and it looks like it worked.

     Verified empirically here: with `gpt-live-1` in `excludeFamilies.openai` but
     NOT in `knownVoiceModelFamilies`, `detectVoiceModelDrift(["gpt-realtime",
     "gpt-live-1"])` returns `unknown = ["gpt-live-1"]` — the exact value
     ws-realtime.drift.ts asserts is empty.

     So this decision is recorded in PROSE and applied BY HAND to both sets, the
     way commit 936b59c did for the gpt-transcribe / gpt-live-transcribe pair:
     "The two sets are deliberately disjoint surfaces, so both need the entry."

     A literal `Decision: exclude` line here would be a live hazard, not just
     inert bookkeeping: if the exclude entry were ever removed, the next
     drift-sync run would re-add it to `excludeFamilies` ONLY and wedge the job
     on gate-3. Until #423's apply half also writes `knownVoiceModelFamilies`
     for voice families, do not put one here. -->

DECISION: **EXCLUDE** — applied by hand on 2026-09-10 to BOTH disjoint surfaces:

- `excludeFamilies.openai` in `src/__tests__/drift/model-registry.ts`
  (silences the `/models` classification check in `models.drift.ts`)
- `knownVoiceModelFamilies` in `src/__tests__/drift/voice-models.ts`
  (silences the realtime/voice canary in `ws-realtime.drift.ts`)
- both `DATA_FROZEN` membership pins re-pinned in
  `src/__tests__/drift/logic-pin.test.ts`
- the id added to the static OpenAI `/models` wave in
  `src/__tests__/drift/models.drift.ts`, so the offline test grades it

Rationale: wrong modality AND wrong endpoint. `gpt-live-1` is OpenAI's
GPT-Live-1, a full-duplex voice model served on the NEW `/v1/live/sessions`
endpoint. It is a SIBLING of the Realtime API, not a successor — its model page
marks Realtime as "Not supported" — and it never answers on
`/v1/chat/completions`, so it can never be text-generation drift. This mirrors
the treatment every other voice/audio/realtime family already gets
(`gpt-realtime*`, `gpt-audio*`, `gpt-transcribe`, `gpt-live-transcribe`,
`tts-1`, `whisper-1`), recorded in
drift-proposals/openai-gpt-live-transcribe-new-family.md (PR #343, commit
936b59c).

Membership in these sets is a CLASSIFICATION for the two listing canaries and
nothing more: it says the family is accounted for, NOT which endpoints aimock
implements for it.

## Scope: aimock does NOT mock /v1/live, and this note does not propose that

Mocking `/v1/live/sessions` is explicitly out of scope. There is no demand for
it (no open issue; the only realtime ask closed in May), and a real mock would
need a new route, a sideband socket and full-duplex framing. This note records a
classification, not a roadmap item.

## `gpt-live-1-mini` is deliberately left UNCLASSIFIED

Only `gpt-live-1` was decided. `gpt-live-1-mini` has not been observed in a live
listing; it appears in this repo solely as the realtime canary's NEW-FAMILY
negative control (`ws-realtime-canary.test.ts`, `logic-pin.test.ts`). Leaving it
unclassified keeps that control live — it is what still proves the matcher
reaches a voice id carrying no "realtime" substring, and that the new
`gpt-live-1` key does not swallow families that merely EXTEND it. If OpenAI ships
a real `gpt-live-1-mini`, it flags, and that is its own decision with its own
note.

## Follow-up: #423's automated exclude path should write both sets

The gate-3 defect described above is a real gap in `scripts/drift-sync.ts`, not
a quirk of this family: any future voice/audio family a human marks
`Decision: exclude` will apply-then-revert the same way. The durable fix is for
the apply half to also add the family literal to `knownVoiceModelFamilies` (and
re-pin it) when `isVoiceModelId(family)` is true. That is out of scope here and
is not attempted by this change.
