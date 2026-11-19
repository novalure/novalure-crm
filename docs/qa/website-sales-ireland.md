# Website Sales Ireland: internal research and draft workflow

Contract `website-sales-ireland-v1` at `/api/crm/website-sales` implements the
November masterplan's Irish website-prospect slice. It uses the existing
authenticated internal CRM session and command kernel. The existing Task-only
machine identity is unchanged and is explicitly rejected by this session adapter.

## Data and actions

Migration `202_website_sales_ireland.sql` adds:

- `crm_company_locations`: canonical locations under `organizations`, with
  an authorized session's address/source attestation. It is not a claim of an
  externally verified company address. Domains are not location identity.
- `crm_website_sales_observations`: immutable, scope-bound evidence and optional
  investment plan/decision. These are research records, not another CRM.
- `crm_website_sales_workflows`: versions and links to the canonical contact,
  lead, deal, next task and offer draft, with terminal stop metadata.

All three tables enforce RLS/FORCE RLS and internal workspace/project scope.
Location and observation history cannot be updated/deleted/truncated by the
application. The reply helper exposes only one scoped Boolean; generic
conversation reads remain denied.

POST operations are `register_location`, `observe`, `qualify`, `prepare_offer`
and `stop`. Every operation binds the exact project, company and location;
workspace/actor come from the authenticated session. Writes use the existing
idempotency digest, CAS, audit and transactional event contract. An authorized
read or replay returns current state and `blockedReason`, never historical
readiness from a cached receipt.

Qualification requires a canonical existing contact, a current READY observation
and matching evidence digest. It creates canonical CRM objects atomically.
The opportunity uses the project's actual default pipeline and an existing
configured qualification/entry stage; there is no invented stage label. Missing
pipeline configuration blocks the write. Diagnostic pipeline/stage references
are metadata, not a second pipeline model.
Lead score is 0 with `scoreBasis=NOT_COMPUTED`: research qualification is neither
a measured sales priority nor a conversion/financial forecast.

Offer preparation delegates to the existing offer repository. It requires the
canonical recipient, creates DRAFT only and leaves existing OFFER/CONTRACT
approval boundaries intact. It creates no outbound delivery, consent grant or
provider effect.

Replies, existing contact restrictions/suppression, stale evidence and earlier
applicable contact stops prevent advancement. Explicit stop closes the next
workflow task. An opt-out stop prevents other location workflows from advancing
for that contact without rewriting historical consent evidence. Observation
refresh is limited to a newer OBSERVED version; it never silently reopens a
qualified, drafted or stopped workflow.

## Verification

Standalone repository checks include the new actual PostgreSQL cases through
`npm run test:sales` or `npm run test:website-sales-ireland`.

The connected acceptance requires the real companion client source:

```powershell
$env:EVELYN_WEBSITE_SALES_SOURCE='C:/Projects/evelyn-website-sales-ireland-20261119/src/business-pipelines/website-sales-client.ts'
npm run test:website-sales-connected
```

It starts disposable loopback PostgreSQL and HTTP, persists a synthetic MFA
session, uses real CSRF verification and the actual route, and independently
reads business rows afterward. It covers scope, replay/conflict, draft-only
results, stops, revoked authority, stale evidence, lost post-commit response and
chunked multibyte request limits. Missing companion source fails the test.

`src/lib/website-prospect.ts` is a byte-for-byte mirror of Evelyn's domain source;
the companion `verify-website-sales-contract.mjs` checks the actual two files.
Zod is explicitly locked as a runtime dependency. The same domain rules are
executed again by the server before qualification or offer preparation.

These are local tests with synthetic business data and actual persistence,
not Production/provider acceptance. Migration application, deployment, a real
Sales transport and any communication retain their applicable release gates.
There is no grant, credential, approval or provider activation seed in this change.

## Candidate verification, 19 November 2026

The final scoped run passed 15 actual PostgreSQL tests and 8 connected HTTP tests
with the actual companion client. Typecheck, affected lint and the production
Next build passed. Production dependency audit reported zero vulnerabilities.
The broader unchanged suites were also executed: 266 unit, 114 Sales, 60 Sales
Final, 15 migration and 23 Website Sales Ingestion tests passed; final changes
specific to this workflow were then exercised by the 15/8 scoped runs. Independent
exact-revision review and repository CI remain release conditions, not claims
made by this local record.
