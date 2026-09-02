# Justimmo-inspired implementation verification

Status: local candidate verified; isolated Preview acceptance and Production release remain open

## Frozen candidate

- Branch: `codex/justimmo-inspired-improvements-20260902`
- Implementation commit: `daaa84838ecae9dbc22d6690914ef0bfebea6edf`
- Scope: isolated development worktree and future isolated Preview QA only
- Production queried or mutated: no
- Real portal, email, calendar or customer communication sent: no
- Evidence signature: not signed

The migration inventory binds migrations 080–084 and all five rollback
companions to the exact Git blobs in the implementation commit. Database
execution is deliberately recorded as `NOT_RUN`; the inventory proves source
identity, not successful Preview migration execution.

## Implemented and locally verified

- Canonical property mutation authorization with locked tenant/project scope.
- Durable Preview-only property export queue, future scheduling, leases,
  retries, dead letters, truthful channel lifecycle, cancellation and QA
  artifacts. External portal publication remains launch-off.
- Versioned buyer profiles, deterministic explainable matching, offers,
  viewings, activities, closings and exact commission allocations.
- Approved versioned templates and released attachment selection with
  authorization revalidation at save and QA-delivery time.
- Central documents, visibility-aware media access, permission-filtered global
  search, saved views, recents and actor-bound bulk-operation evidence.
- Review-only privacy lifecycle, legal holds and DSAR export metadata without
  automatic destructive deletion.
- Durable media deletion intent and retry behavior that fails closed.
- Server-side closing CSV/PDF generation, with spreadsheet-formula protection
  and a synthetic QA PDF sample.
- Funnel and legacy CRM authorization paths tightened so payload hints cannot
  widen workspace/project access.

Three focused final re-audits found and corrected the remaining P1 ACL
boundaries. Their final reports show zero remaining P0/P1 findings in the
reviewed recovery, PostgreSQL role-graph and grant-contract scope. This does
not substitute for the external acceptance gates below.

## Verification results

| Check | Result |
| --- | --- |
| `npm run test:justimmo-improvements` | PASS |
| `npm run test:integration` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, zero warnings |
| `npm run test:unit` | PASS; the intentional Windows-only symlink skip remains documented |
| `npm run security:production` | PASS, zero production dependency vulnerabilities |
| `npm run build` | PASS, Next.js 16.3, 104 application routes/pages generated |
| Local Axe diagnostic | PASS, 6/6 audited surfaces; zero violations, incomplete checks, blocked cross-origin requests or unexpected writes |
| Migration/rollback byte contract | PASS for 10 canonical SQL files at the implementation commit |
| `git diff --check` | PASS |
| Secret-file inventory | PASS; no `.env*`, private-key or credential artifact included |

The Axe run used localhost demo authentication and read-only intercepted QA
fixtures. It is diagnostic evidence, not a substitute for release-grade
testing on the protected Preview deployment.

The generated closing/commission PDF is synthetic QA output. It was rendered
and visually inspected as one A4 page with no clipping or overlap; it is not an
invoice, signed contract or provider receipt.

## Reproducibility exception

`npm run ci:toolchain` correctly failed because the repository pins Node.js
`24.14.0`, while the available host runtime is `24.18.0` and the bundled
runtime is `24.19.0`. `package.json` accepts Node 24, but the exact pin remains
an unresolved release-reproducibility gate. Run CI and final build with the
pinned runtime instead of weakening the pin.

The Vercel CLI is not installed and this checkout is not linked through a
local `.vercel/project.json`. Install it with `npm i -g vercel` to enable
controlled `vercel env pull`, deployment inspection and log collection for the
isolated Preview acceptance run.

## Remaining release blockers

1. Apply migrations 080–084 only to an isolated Preview database, validate the
   ledger/checksums, and execute restore plus guarded rollback rehearsal.
2. Run real persistence/reload/OCC/cleanup E2E with two isolated QA tenants and
   the complete role/project matrix.
3. Deploy the exact implementation SHA to a protected Preview environment and
   prove that Preview database and private Blob resources are isolated from
   Production, including legacy object migration and reconciliation.
4. Complete portal certification plus Resend/password-reset/invitation and
   calendar provider acceptance using approved QA recipients only. External
   delivery remains launch-off until accepted receipts exist.
5. Run public form/funnel E2E, long-session proof refresh and rotate the
   previously exposed funnel publication token in the authorized environment.
6. Complete release-grade Axe, keyboard, screenreader, 200%/400% zoom,
   real-device mobile and Lighthouse budget acceptance on that exact Preview
   SHA, plus monitoring and alarm tests.
7. Keep unit/reservation/deal synchronization signed `LAUNCH-OFF`, or implement
   it in a separate controlled cutover with concurrency and rollback evidence.
8. Obtain Legal, company-profile, Product and Launch ON/OFF/INTERNAL signatures;
   freeze the resulting acceptance evidence and release attestation.
9. Resolve the exact Node.js toolchain pin and obtain green CI for the frozen
   SHA.
10. Only after all prior gates pass: perform SHA-identical promotion, controlled
    Production migrations/backup validation, Production smoke, rollback
    readiness and the signed observation window.

## Verdict

The code candidate is **READY FOR ISOLATED PREVIEW VALIDATION**.

The overall release verdict is **NO-GO FOR PRODUCTION** until every blocker
above has objective evidence. No local result in this report should be
interpreted as provider acceptance, successful Preview migration or Production
approval.
