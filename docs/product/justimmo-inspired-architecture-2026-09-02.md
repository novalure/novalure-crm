# Justimmo-inspired product architecture

Status: local implementation record; release acceptance open, 2026-09-02
Scope: isolated development worktree and isolated Preview QA only

## Evidence boundary

The code, migrations and local contract evidence described here are release
candidates, not proof of a deployed system. Migrations 080–084 and their
rollback companions have not been executed against a Preview database. No
two-tenant browser E2E, provider acceptance, Preview deployment or Production
smoke was performed as part of this implementation pass. Production was not
queried or changed.

The candidate has not been frozen to a final commit and the release evidence is
not signed. `docs/audit/2026-09-02/justimmo-inspired-migration-checksums.json`
records the frozen migration bytes using the repository's Git-clean LF byte
contract. The byte freeze precedes the implementation commit, so its
`candidateCommit` intentionally remains `null` until that candidate is staged
and committed.

## Product boundary

Novalure keeps its role-aware workspaces, explicit workspace and project scope,
lead prioritisation, configurable dashboards, funnels, sequences, AI workflows
and progressive user experience. The work in this release adds the operational
real-estate lifecycle that was missing; it does not reproduce Justimmo's dense
navigation or legacy table-first interface.

External portal delivery and customer communication remain fail-closed unless a
provider is configured and accepts the request. A preview QA sink may prove
serialization, queueing, retries and persistence, but it can never set an
external portal to `published` or claim that a customer message was delivered.

## Implemented release slices

| Slice | Implemented behavior | Acceptance boundary |
| --- | --- | --- |
| Property exports | Server-built immutable snapshots, SHA-256 integrity, durable leases, validated scheduling up to 90 days, retry/dead-letter state, audit events and a registered `/api/cron/property-exports` worker. Runtime rows are actor/tenant scoped and the worker resolves the initiating user inside the job workspace. Channel actions for pause, resume, withdraw and update-required are OCC-, idempotency- and audit-protected. The only adapter is an in-process Preview QA sink and records `networkRequestPerformed: false`. | The worker requires cron authentication and enables processing only when `VERCEL_ENV=preview` and `NOVALURE_PROPERTY_EXPORT_QA_SINK_ENABLED=1`; all external portals remain `LAUNCH-OFF` and unconfigured. QA completion returns the channel to `ready`, never `published`. No portal/XSD certification or deployed cron run is claimed. |
| Property mutation scope | Listing and fragment mutations lock the canonical tenant listing before authorisation. Payload project hints cannot replace the locked project; same-project owner/owned-lead/owned-contact access does not permit a project move or owner reassignment. Creation requires target-project edit scope and permits initial self-ownership. | Local guard tests cover these paths; real role/project combinations still require the two-tenant Preview matrix. |
| Broker operations | Versioned buyer search profiles, deterministic server matching, offers backed by approved/versioned central templates and released attachments, viewings, typed activities, closings and commission allocations with tenant-qualified persistence and optimistic concurrency. Template and attachment access is re-checked before QA delivery. Legacy mandate writes fail closed instead of bypassing the new policy. | Offer delivery and calendar invitations are state models only until real providers return accepted receipts. Reservation/unit/deal synchronisation remains outside this cutover. |
| Project scope | Broker creates and project moves require the target project's explicit edit grant; non-managers cannot reassign ownership. Profile matching, match decisions and QA delivery lock the authoritative record and re-run canonical owner/project access inside the tenant transaction. | Local contracts cover the lock, ownership and permission paths; real two-tenant and cross-project Preview E2E remains required. |
| Content and privacy | Central document catalogue over private media, immutable versions, tenant-qualified entity links (including broker closings), versioned allowlisted templates, permission-filtered global search, recents, retention reviews, legal holds and DSAR metadata. Link reads and writes enforce the target record's owner/project policy; a projectless document cannot expose a project-scoped target. Approved `internal`, `customer` and `public` visibility follows one canonical server policy with active membership and project grants; anonymous file access still requires a separate active share token. | There is no automatic hard deletion, external register lookup or customer communication. Legal review remains required. |
| List productivity | Server pagination, URL-backed filter/query/page state, saved views, recent records and actor-bound bulk execution evidence. | Large-volume Preview performance and browser E2E remain open. |
| Media deletion | Migration 084 adds a durable `active`/`pending` deletion marker. The database records intent before Blob deletion; failed finalisation stays observable and retryable. A pending retry is limited to the original requester or an explicitly authorised content manager and never silently resurrects a previously pending asset. | The real isolated Preview Blob lifecycle and legacy-object migration have not been run. |
| Closing exports | CSV and PDF are generated on the server behind the closing financial permission. CSV cells neutralise spreadsheet formulas; PDFs identify themselves as operational reports, not invoices or signed contracts. | The generated local sample is synthetic QA output. Accounting, invoicing and signed-document providers are not implemented or accepted. |
| Accessibility diagnostic | A localhost-only Axe harness covers mobile property cards, the desktop property table and the five broker editor forms under read-only intercepted fixtures. It blocks unexpected writes and non-local targets. | This is a local diagnostic harness, not Preview or Production accessibility acceptance. Manual keyboard, screenreader, zoom and mobile-device verification is still required. |

## Sources of truth

| Concern | Source of truth | Invariant |
| --- | --- | --- |
| Property content | `seller_listings`, `property_units`, property content tables | Export snapshots are immutable derivatives and never overwrite inventory. |
| Unit availability | `property_units` plus the active reservation projection | A match or offer cannot mutate availability. |
| Temporary block | `property_reservations` | Expired or cancelled reservations cannot keep a unit reserved. |
| Commercial process | `deals` | A reservation conversion alone cannot prove a won deal or a signed closing. |
| Buyer criteria and consent | contact plus buyer search profile | Matching uses a versioned criteria snapshot and records its explanation. |
| Closing | broker closing record | Only an explicit, authorised closing transition can prove signed/invoiced/paid. |
| Commission | commission allocation records | Server-side minor units and basis points must reconcile exactly. |
| Files | `media_assets` | Documents and document versions reference the shared private media store. |
| Media deletion | `media_assets.deletion_state` plus deletion actor/time | External storage is removed only after durable intent; pending cleanup remains non-active and retryable. |
| Audit | tenant-qualified audit and domain history records | Every protected state transition records actor, time, before/after or reason. |

## State models

### Publication

Channel: `draft | preflight_failed -> ready -> queued -> exporting -> ready`
for a successful QA artifact. `queued | exporting -> queued` on retry and
`queued | exporting -> failed` on terminal failure/dead letter. Scheduling sets
the job's `available_at`; a future job is not kick-started before that time.

The job lifecycle is `queued -> running -> completed`, with `retry`, `failed`,
`dead_letter` and `cancelled` as explicit durable outcomes. Manual channel
actions support `paused`, `withdrawn` and `update_required`; resume maps back to
the truthful job-derived state. `published` and `partially_published` are
reserved for a future real provider receipt and are unreachable through the QA
sink.

### Search profile and match

Search profile: `draft -> active <-> paused`, `active | paused -> expired |
archived`, and `expired -> active` only through renewal. `archived` is terminal.

Match evaluation is derived and immutable. Engagement (`new`, `shortlisted`,
`declined`, `archived`) is separate from availability (`available`,
`reserved_same`, `reserved_other`, `blocked`, `sold`). Offered and viewed are
derived from real offer and viewing records.

### Offer, viewing and activity

Offer: `draft <-> ready`, and either mutable state may transition to terminal
`withdrawn`. Delivery is a separate immutable attempt with
`blocked_not_allowed`, `blocked_provider_unavailable`, `accepted` or `failed`.
Only a real provider receipt can produce `accepted`; the current QA path remains
blocked and cannot claim customer delivery.

Viewing: `planned -> confirmed | completed | no_show | cancelled`, and
`confirmed -> completed | no_show | cancelled`. Rescheduling creates history.
Once an internal calendar projection exists it is updated in the same tenant
transaction and cannot be silently detached; provider invitation state remains
separate and launch-off.

Activity creation and an optional follow-up task are one tenant transaction.

### Closing and commission

Closing: `draft -> reviewed -> signed -> invoiced -> paid`; cancellation and
reversal are explicit privileged transitions with an audit reason.

Commission allocations do not claim an independent lifecycle in this slice;
their business lifecycle follows the closing. On every closing save, percentage
allocations total exactly 10,000 basis points per funding side and absolute
allocations total exactly the corresponding commission amount in minor units.
Buyer and seller allocations fund their own side. A referral allocation keeps
`side = referral` for attribution and must name either `buyer` or `seller` as
its `sourceSide`, so it is included in exactly one reconciled commission pot.

## Security and tenancy

- Every query is constrained by the authenticated workspace and, where supplied,
  project scope.
- Project-scoped broker mutations do not infer access from supplied metadata.
  They lock the authoritative record and require the canonical explicit
  project-edit grant inside the same tenant transaction.
- Cross-entity references are validated in the same tenant transaction. New
  schema relations use workspace-qualified constraints where the existing schema
  permits them.
- User-initiated mutations require an authenticated session, CSRF validation,
  capability checks and an idempotency key where retrying could duplicate work.
  The cron worker is separately authenticated and remains Preview-sink gated.
- Optimistic concurrency rejects stale mutable versions instead of silently
  overwriting them.
- Private payloads, provider errors and audit metadata are returned with
  `private, no-store` response headers and are bounded/redacted.
- Destructive lifecycle actions are reviewable. Legal holds and references block
  hard deletion; no automated process in this release permanently deletes data.
- Document-linked media reuse inherits document and target access. Legacy media
  without creator evidence is manager-only instead of being treated as public or
  implicitly reusable.
- Approved internal documents are never exposed through customer-project access;
  customer documents require an active project grant, and anonymous public-file
  access still requires a live share token. Global search and media reuse call
  the same canonical visibility policy.
- Media deletion is ordered as durable intent, external removal, then metadata
  removal. A first-attempt storage failure restores `active` only when that same
  attempt created the marker; a pre-existing `pending` retry is never restored to
  active on failure.

## Migration and rollback boundary

- Migrations 080–084 are additive manual-cutover candidates. The migration
  runner never includes them automatically and explicitly refuses their direct
  use with the `prod` target; Production promotion requires a separate reviewed
  release. They were not applied during this pass.
- Each migration has a Preview-only rollback companion. Rollbacks require
  explicit session flags, disable RLS only for complete safety inspection and
  refuse destructive rollback when runtime evidence or later dependencies
  remain.
- Migration 082 explicitly depends on 081 because a content document can link to
  a tenant-qualified broker closing; the migration plan cannot apply that target
  validation before the closing table exists.
- The current canonical Git-clean SHA-256 values and Git object IDs are recorded
  in the dated audit inventory. Those checksums identify files; they do not prove
  successful migration, restore, rollback or data preservation.
- Previously excluded cutovers, including migrations 061, 062 and 065, are not
  activated by this release slice.

## Deliberately excluded

- No real portal credentials or external portal calls.
- No real customer email, invitation or calendar delivery.
- No Preview database migration, Preview E2E or provider acceptance in this pass.
- No Production database query, migration, deployment or data change.
- No scraping of KYC, company-register, sanctions or land-register systems.
- No accounting ledger; closing and commission are operational CRM records only.
- No release signature, SHA-identical promotion, Production smoke or observation
  window. These remain release gates rather than inferred success.
