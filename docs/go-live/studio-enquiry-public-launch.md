# ST1 Studio enquiry: exact Production release

This is the Production counterpart of the accepted protected Preview, not a
promotion of QA credentials or test data. The same `studio-enquiry-v1` body,
immutable confirmation, operation UUID, hash, receipt, private file roles and
reconciliation protocol are retained. Calendar, invitations, email, marketing,
tasks and other product activation remain outside this launch.

## Exact scope and operator bindings

The receiving project is `prj_R32Okl6AHijTohvuKmryuTLjWMsk`, public origin
`https://www.novalure-crm.app`. The sending Studio project is
`prj_ktiCTisS9QmWy4vkHLO8HG3BrhQp`, origin `https://novalurestudio.ie`.
Workspace `8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101`, CRM project
`f7d83c6b-d08d-4d73-b822-1f1c0b4733d2`, form
`0f98b9fd-d300-4a34-a14c-54a1a61b2415`, active operator
`6122a6da-e7f4-47fa-bc55-e296bb01af62` are server-owned constants.
No browser, source document or model text selects these identities.

Set these existing-project Production variables through the authorized host-side
mechanism, never by copying an entire QA environment:

- `STUDIO_PUBLIC_ENQUIRY_ENABLED=1`, `STUDIO_PUBLIC_ENQUIRY_APPROVAL_ID` identifying
  the explicit public-launch authorization, and `STUDIO_PUBLIC_ENQUIRY_RELEASE_SHA`
  equal to the exact deployed `VERCEL_GIT_COMMIT_SHA`.
- `STUDIO_PUBLIC_ENQUIRY_CRM_PROJECT_ID`, `STUDIO_PUBLIC_ENQUIRY_CRM_ORIGIN`,
  `STUDIO_PUBLIC_ENQUIRY_STUDIO_PROJECT_ID`, `STUDIO_PUBLIC_ENQUIRY_STUDIO_ORIGIN`
  equal to the constants above.
- `STUDIO_PUBLIC_ENQUIRY_DATABASE_HOST`, `STUDIO_PUBLIC_ENQUIRY_DATABASE_NAME`,
  `STUDIO_PUBLIC_ENQUIRY_DATABASE_ROLE`, `STUDIO_PUBLIC_ENQUIRY_NEON_PROJECT_ID`,
  `STUDIO_PUBLIC_ENQUIRY_NEON_BRANCH_ID` equal to the approved actual Production
  pooled database identity. `DATABASE_URL` must match these coordinates; the
  actual query confirms Neon project/branch/database/current role, fixed active
  operator and active form/project, migrated marker constraint and FORCE RLS.
  The ordinary tenant transaction still rejects owner, superuser, BYPASSRLS,
  CREATEDB, CREATEROLE, replication and unsafe ownership/membership roles.
- `STUDIO_PUBLIC_ENQUIRY_BLOB_STORE_ID` equal to
  `NOVALURE_PRIVATE_BLOB_STORE_ID`. The existing private read/write credential
  must belong to that exact private store. No public Blob grant is permitted.
- A dedicated Production `STUDIO_ENQUIRY_SIGNING_SECRET` shared only with the
  Studio Production server, distinct from the legacy ingestion key and Preview
  binding. No value is recorded here or delivered to the browser.

The route requires its canonical CRM origin plus the fixed `X-Studio-Origin`
and `X-Studio-Project-Id` claims. These headers grant no authority by themselves:
the dedicated signature over exact request bytes and the immutable hash remain
mandatory. Existing Preview project/branch/database/recipient guards stay active
on Preview. QA-only variables remain forbidden in Production; the dedicated
enquiry signing variable is now valid in each separately scoped environment.

For the one authorized pre-domain candidate acceptance, the receiver additionally
permits **only** its own exact platform-provided `https://${VERCEL_URL}` origin
with a separate at-least-32-byte `STUDIO_PUBLIC_CANARY_SECRET` matching
`X-Studio-Canary-Authorization` in constant time. Arbitrary candidate hosts,
caller-selected hosts, HTTP, missing/short secrets and wrong headers fail closed.
The canonical public origin needs no canary header. This private entry still
requires every Production release/project/database/tenant/store guard, complete
request HMAC, fixed Studio origin/project and test proof when applicable; it is
not a new unsigned receiver or a relaxation of deployment protection.

Ordinary requests contain `syntheticTest:false`, are persisted as live enquiries
and contribute to the existing business metrics. Production requires the current
explicit privacy agreement `studio-enquiry-2026-10-19`; the original Preview
continues to require `studio-enquiry-2026-10-18`. Stored projections accept both
without rewriting historical consent. For the separately authorized
owner acceptance only, `syntheticTest:true` additionally requires the existing
Studio synthetic-proof format in `X-Studio-Synthetic-Test-Proof`, bound to this
operation UUID, the configured `NOVALURE_STUDIO_SYNTHETIC_TEST_EMAIL`, the
dedicated signing secret and a timestamp within five minutes. A test flag,
email address or source text alone is insufficient. The signed complete body
still binds all confirmed content. Synthetic acceptance records remain excluded
from business KPIs and never become real customer records.

## Additive database release

Preserve historical migrations and their checksums. The operator's actual
Production read found 094/095/096, with no 097/098/099 or handoff/booking tables.
The scoped Production release therefore uses only the standalone
`100_studio_enquiry_production`, requiring genuine checksummed 096. It creates
the enquiry/asset tables, needed submission identity index, required boolean
snapshot marker, immutable confirmation, private media markers/FKs and fixed
tenant/actor FORCE RLS. It creates no booking/calendar tables, executes no 097,
and inserts no fabricated 097/098/099 ledger rows. It refuses an already
initialized Preview handoff schema.

The original four-column `crm_media_reference_counts(uuid)` definition,
signature and grants remain untouched. The new additive five-column
`crm_studio_media_reference_counts(uuid)` supplies the guarded deletion protocol
used by this release, including in-use Studio references. The independent
Preview path retains original 097/098 and the additive 099 marker change; 099
adds only a compatible wrapper under this same Studio-specific counter name.
This is not a requirement to apply the Preview/calendar path to Production.

All Studio migrations 097–100 are explicit manual cutovers: ordinary migration
plans skip them. Select only `100_studio_enquiry_production` with the existing
`--only` / `--allow-manual-cutover` and committed-SHA,
target/ledger/checksum-bound dry-run/plan-token/apply mechanism. Rehearse against
the approved isolated target; only the designated operator applies the approved
Production plan. Existing rows and legacy SQL checksums remain unchanged.

## Retention, removal and recovery

CRM owns accepted originals and analyses; Studio session expiry does not delete
them. They follow the existing active-workspace retention arrangement and owner
handling of an authorized erasure request. Ordinary media deletion correctly
rejects an in-use confirmed asset. There is no new public detach endpoint,
automatic retention cron, blanket cleanup or promised automatic erasure period.

The existing protected owner/operator storage process can remove the **bytes**
of an exact attachment without rewriting its immutable accepted receipt:

1. Establish the requester's authority and record the explicit deletion scope,
   approval and reason in the existing private operator/audit record. Read the
   exact workspace, operation, both source-role links, distinct asset IDs, hashes
   and private object paths under authorized tenant access. Never infer a path
   from a supplied filename or customer document.
2. Stop new Studio handoff writes with the scoped enable switch, reconcile the
   selected operation and exclude uncertain commits. Establish completion of
   in-flight writes and expiry of every issued 120-second private PUT capability
   before deleting its exact objects. Elapsed time alone is not drain evidence.
3. Through the already authorized private-store administration, delete only the
   manifest's distinct objects in the pinned store. Check actual absence, record
   each confirmed/unknown result, and retain the operation/receipt/reference
   identities and protected audit evidence. Do not remove RLS, publication,
   immutable-row or in-use-FK protections to make ordinary deletion pass.
4. Verify authenticated reads no longer return the removed bytes and foreign or
   anonymous access remains denied. An accepted receipt records historical
   acceptance, not present file availability; the same operation must never be
   re-created or automatically recopied after erasure. Unknown results require
   inspection of these same objects, not a broad cleanup or new operation.

This manual attachment-byte procedure is not full contact/enquiry erasure or an
implemented customer self-service deletion flow. Full-record erasure must use a
separately scoped reviewed owner data-handling plan accounting for the retained
immutable evidence and existing authoritative CRM/audit obligations; it is not
performed by this release. Do not claim that unavailable bytes equal deletion
of every stored customer field.

## Release, abort and rollback

Integrate the narrow change with the actual current Production source; preserve
parallel work and record exact pre-release deployment, source, aliases, database
ledger/recovery point and private-store scope. The Owner's explicit exact-release
App exception, if applicable, is recorded separately with technical checks,
independent source review and real acceptance. It never changes historical App
FAILURE 117981149748 into SUCCESS or disables branch protection/the Reviewer hold.

Before public traffic, confirm the approved target and credential metadata, exact
source/version, schema plan/application, tenant/role/storage boundaries, normal
authentication, public English consultation, consent, private PDF/image transfer,
confirmed display, same-operation replay and synthetic test exclusion. Local
PostgreSQL/mocked Blob tests are not live Provider or browser evidence.

Observe existing Runtime logs/error rate/latency, accepted-vs-uncertain operations,
file/hash/store failures and storage usage. Stop the scoped handoff on identity,
role, tenant, origin, signature, receipt/hash, private-access, migration or schema
invariant failure; also stop on the release's operator-recorded error/latency
thresholds. No source text or model reply authorizes a retry or changed scope.

Rollback first disables new Studio handoff admission and preserves all accepted
and uncertain operations/files for reconciliation. Prepare and verify a recovery
artifact retaining this schema-compatible media lifecycle with
`STUDIO_PUBLIC_ENQUIRY_ENABLED=0`. The old pre-Studio release knows only four
incoming media FKs; after 100 it would safely block ordinary media deletion on
the new fifth FK and is **not** a fully compatible functional rollback target.
Do not conceal that limitation or remove the protection to recover deletion.
Keep 100 (or 099 on Preview) and the accepted records; never reverse the boolean
marker after live `false` snapshots or restore over accepted enquiries. Re-enable
only after the exact compatible recovery deployment/configuration is verified;
otherwise leave handoff stopped. No EF1/Teams/calendar changes are required.
