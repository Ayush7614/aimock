# New / unclassified model family: gpt-6-astra

Provider: openai
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

Decision: INCLUDE (applied — includeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.openai`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: plain GA text chat. Classified on a DECLARED-CAPABILITY probe, not on
the name — "astra" carries no modality signal, and OpenAI's `/v1/models` exposes
none either (`id` / `owned_by` / `created` only; the entry is
`gpt-6-astra owned_by=system created=1787853604`, i.e. 2026-08-27T18:00:04Z), so
the name shape alone could not decide this. A minimal `/v1/chat/completions` call
(`max_completion_tokens: 16`, one user turn) returns **HTTP 200** with
`finish_reason: "stop"`, `model: "gpt-6-astra"` and a real assistant turn —
identical in shape to the already-included `gpt-5.6-luna` probed the same way in
the same run. Negative control: `whisper-1` on the same endpoint returns **404**
`"This is not a chat model and thus not supported in the v1/chat/completions
endpoint"`, so the probe does discriminate. It is the text-chat surface aimock
mocks.
