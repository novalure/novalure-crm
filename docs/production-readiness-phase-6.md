# Production Readiness Phase 6 - Grounded Bot And Knowledge Base

Date: 2026-05-26

## Scope

Phase 6 closes the pilot gap around the AI bot area: a customer-facing bot must answer only from approved workspace or project knowledge, show source context, and hand off when no approved source exists.

## Inventory Result

- Bot chat runtime: `src/lib/bots/chat-runtime.ts`
- Bot policy: `src/lib/bots/policy.ts`
- Persistent knowledge API: `src/app/api/bots/knowledge/route.ts`
- Persistent runtime repositories: `src/lib/db/runtime-repositories.ts`
- Bot cockpit UI: `src/components/bot-command-center.tsx`
- QA seed: `scripts/qa-livegang-seed.mjs`

The runtime already searched `knowledge_sources` / `knowledge_chunks` and blocked model replies when strict knowledge was active and no source existed. The missing production pieces were a deterministic grounded offline answer, visible live knowledge state in the bot cockpit, explicit handoff status for missing knowledge, and a seeded active test bot with a matching approved knowledge source.

## Changes

- Offline model fallback now returns only approved knowledge excerpts when sources exist.
- Missing approved knowledge now produces a safe handoff response and marks the bot conversation as `handoff`.
- Bot run summaries include `humanHandoffRequired`.
- Bot cockpit reads `/api/bots/knowledge?limit=50` and uses persisted knowledge for readiness and counts when available.
- QA seed creates `QA Seeblick Sales Bot` with strict knowledge, handoff rules, and approved source `Projektinfo Seeblick`.
- Phase test `test:phase6` protects the grounding, handoff, cockpit live-source, seed, and no-internet policy paths.

## Acceptance Evidence

- Question with approved source, for example `Welche Wohnungen gibt es im Projekt Seeblick?`, can be answered from the seeded `Projektinfo Seeblick` chunk and includes citation handling through `appendRequiredCitations`.
- Question without a matching source is blocked from a model answer and sets the conversation to `handoff`.
- The bot cockpit no longer depends only on static knowledge props when the live API is available.

## Dimensions

- KI-Bot: expected +25, because the answer path is grounded, source-backed and has a no-source handoff.
- Technik gesamt: expected +5, because bot runtime state and audit status are persisted.
- Vertrauen/Professionalitaet: expected +5, because no-source answers stop making unsupported project claims.

## Open Risks

- A real provider-backed LLM can still be configured, but the system prompt and sanitizer remain the enforcement layer around it. Runtime tests should be expanded to hit a live seeded database during final acceptance.
- The Knowledge area still keeps prepared/import planner rows for UX continuity; the bot readiness path now prefers persistent sources.
