# Justimmo-inspired gap matrix

Status: implementation gap review, 2026-09-02. The implementation candidate is
frozen in Git and its exact protected Preview build is READY, but the evidence
is not externally signed and no remote acceptance is inferred from this matrix.

| Capability | Implemented in the local candidate | Local evidence boundary | Explicitly deferred / still open |
| --- | --- | --- | --- |
| Property command centre | Existing persisted content, media, price and unit controls are retained and connected to truthful export history. Listing and fragment writes now lock the canonical tenant record; payload project hints cannot broaden access, and owner-level access cannot move a listing or reassign its owner. | Contract coverage checks the central mutation guard, target-project creation scope, initial self-ownership, paginated mobile-card/desktop-table surfaces and export entry points. | Full role/project combinations, large-volume Preview and browser acceptance. |
| Portal publication | Server-built immutable snapshot, payload SHA-256, validated future scheduling, durable queue leases, retry/dead letter, event history, Preview QA artifact and scheduled cron route. Runtime rows are tenant/actor scoped and the worker binds a job to an initiating user in the same workspace. Channel state follows enqueue, claim, retry and terminal outcome; pause/resume/withdraw/update-required actions are server-validated and audited. | Worker contracts cover scheduling without early execution, claim, lease, identity fencing, truthful channel states, retry and deterministic in-process artifact output. The sink records `networkRequestPerformed: false` and returns to `ready`, never `published`. | Real portal adapters, credentials, XSD/certification and provider receipts. External publication remains `LAUNCH-OFF`. |
| Cron execution | `/api/cron/property-exports` is registered for minute 12 hourly and requires cron authentication. | Source contracts verify the route and the fail-closed Preview guard. | No deployed cron invocation was run. Outside `VERCEL_ENV=preview` plus the explicit QA flag, the worker returns unavailable before queue processing. |
| Search profiles | Versioned criteria, ranges, geography, owner, expiry, lifecycle and project-aware persistence. Core and legacy readers now require an actor and apply owner or explicit project-edit scope; legacy mandate writes fail closed. | Assigning/changing a project locks permission evidence, requires target-project edit scope and prevents non-manager owner reassignment. | Real cross-tenant/cross-project Preview E2E. |
| Matching | One deterministic server engine with positive/negative reasons, availability and persisted engagement decisions. | Match calculation and decisions lock the profile with `FOR SHARE` and re-check canonical owner/project access. | Preview database concurrency and representative production-scale performance. |
| Offers | Versioned draft/items, central approved-template reference, template preview, structured released document/media selection, validation preview, activity link and separately labelled provider state. | Domain and API contracts cover state, idempotency and access boundaries; save and QA delivery re-lock and re-check the offer, exact template version, visibility, release and owner/project permission. | Real email/provider delivery and accepted customer receipt. |
| Viewings | Linked and historised viewing records with optional internal calendar projection and separate invitation state. Existing projections remain transactionally synchronized and cannot be silently detached. | Domain/API contracts cover transitions, scheduling, projection updates and tenant/project scope. | Real provider calendar creation, invitation delivery and provider acceptance. |
| Activities | Typed activity plus optional follow-up task in one tenant transaction. | Atomicity and idempotency contracts are local only. | Preview database transaction E2E. |
| Reservation / unit / deal | No unsafe relationship cutover was enabled. | Launch-scope contracts keep the legacy relation path fail-closed. | Must remain signed `LAUNCH-OFF` or receive its own migration, concurrency proof and full E2E cutover. |
| Closing / commission | Operational closing lifecycle and server-validated minor-unit/basis-point allocations. CSV and PDF are produced on the server behind financial permission. | Local domain contracts cover exact reconciliation, CSV formula neutralisation and PDF generation; the rendered sample is synthetic QA output. | Accounting ledger, invoice provider, signed contract document, Preview data acceptance and legal/product approval. |
| Documents | Central catalogue, immutable versions and generic tenant-qualified entity links over `media_assets`, including broker closing links. Migration 082 therefore explicitly depends on 081. | Local content contracts cover active membership, the canonical `internal`/`customer`/`public` matrix, version immutability, closing-target validation, target owner/project scope and delete-restricting references. Projectless documents cannot expose project-scoped targets; anonymous access requires a separate share token. | Real Preview Blob lifecycle, legacy-object migration and high-volume document E2E. |
| Templates | Approved, versioned and multilingual templates with an allowlisted variable contract. | Local contracts reject unapproved variables and unsafe state transitions. | Real Resend/calendar rendering and delivery acceptance. |
| Global search | Permission-, owner- and project-filtered paginated server search with recents and deep links. | Contract evidence checks canonical access policy, bounded query handling and safe deep-link targets. | Preview relevance, latency and two-tenant browser acceptance. |
| Privacy lifecycle | Retention policy/review, legal hold and DSAR job metadata without automatic hard delete. | Local contracts cover legal-hold/delete blocking and review-only semantics. | Legal approval, provider/export fulfilment and any automated deletion workflow. |
| List productivity | Server pagination, URL-backed query/filter/page state, saved views, recents and actor-bound bulk item evidence. | Local query-state, list and bulk-runtime contracts cover validation and isolation. | Large-data Preview performance, keyboard/screenreader acceptance and product sign-off. |
| Media lifecycle | Durable `active`/`pending` deletion intent precedes Blob removal; metadata is removed only after storage success. Pending retries are limited to the original actor or an explicit content manager. Document-linked reuse inherits document/target ACL, and legacy assets without creator evidence are manager-only. | Local failure-injection contracts prove first-attempt restoration, durable retry after incomplete finalisation, no resurrection of an already-pending asset and fail-closed reuse. | Isolated Preview Blob execution, legacy object migration, reconciliation run and Production lifecycle. |
| Accessibility | New surfaces use labelled controls, live status, keyboard navigation and mobile targets. A localhost-only Axe diagnostic covers property cards/table and five broker forms using read-only fixtures. | Harness contracts enforce localhost/demo auth, block unexpected writes and reject serious/critical Axe findings when the diagnostic is run. | This is not Preview or Production acceptance; manual Axe, screenreader, keyboard, 200%/400% zoom and real-device testing remain open. |
| Release evidence | Git-clean SHA-256 inventory covers migrations 080–084 and all rollback companions. | Checksums identify exact LF-canonical bytes at implementation commit `daaa84838ecae9dbc22d6690914ef0bfebea6edf`; the inventory has its own SHA-256 sidecar and a contract test re-reads every blob from that commit. | Evidence remains unsigned, migrations are not executed, and no final Preview or Production release attestation exists. |

## Existing strengths retained

- Role- and business-model-specific workspace navigation.
- Visible workspace/project/data scope and browser-history restoration.
- Lead score, SLA, priority and data-hygiene workflows.
- Pipeline stage gates and configurable dashboards.
- Mobile daily work, forms, funnels, newsletters, sequences and governed AI.

## Deferred blockers

The following need separate controlled work and are not silently converted into
success states: external portal certification, real Resend/calendar acceptance,
the atomic reservation/unit/deal cutover, KYC/register providers, automated
retention deletion, isolated Preview migration/restore/rollback and two-tenant
E2E, real Blob migration, final legal/product/signature approvals, SHA-identical
promotion, Production smoke and the observation window.

Production was neither queried nor changed while implementing or documenting
this candidate.
