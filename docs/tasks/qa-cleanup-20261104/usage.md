# Registered QA object retirement

This route retires a bounded set of explicitly registered QA objects. It does not adopt old data, delete a tenant, mutate accounts/rights, execute provider cleanup, or delete immutable history. The current historical workspace `69f1202e-b506-4127-9f59-a68d44c4b6ce` was reported as `is_qa=false` with zero ledger rows; it remains ineligible.

The contract reuses migration `068_qa_batch_reset_safety.sql` and the existing CRM command receipts. Additive migration `194_qa_registered_batch_lock.sql` supplies only the necessary safe lock contract. It creates a dedicated NOLOGIN/NOINHERIT/NOBYPASSRLS function owner with SELECT and one-column `UPDATE(id)` on `qa_batches`, because PostgreSQL requires that privilege for row locking. The application/runtime receives no UPDATE, owner membership, table ownership or adoption privilege. Existing append-only triggers remain intact, including for attempted owner DML. No flag activation or registration endpoint is introduced. A separate authorized provisioning/registration operation must establish genuine QA identity and exact object provenance before this route can act. A `LIVE-QA` name, a supplied UUID, a model answer or caller metadata never establishes this boundary.

## Existing browser administration path

`POST /api/admin/qa-reset?workspaceId=<authorized-workspace>` accepts only an active persisted cookie/database session bound to an identity and a stored auth session, current Owner/Admin technical role, `crm:write`, product `settings:manage`, and the existing `crm_workspace_manager` predicate. The ordinary workspace resolver, cookie/CSRF checks and current membership/session locks stay in use. Service identities, demo/header identities and inactive/revoked membership are denied. Selecting a workspace does not grant it.

Use JSON, the existing `Idempotency-Key` and `X-Correlation-Id` conventions, and the normal CSRF token for this exact POST path. The body is bounded to 32 KiB. There is a 100-object batch limit, a 15-second timeout for each database statement and lock wait, and a 5-second pool checkout limit. These do not impose a total transaction deadline: several sequential statements can retain locks for longer than 15 seconds. The route's 30-second hosting limit is not a proven database cancellation fence. Plan validity is 15 minutes for a first execution; a committed historical execution receipt can still be recovered after that period if present authority remains valid.

Dry-run body:

```json
{"mode":"dry_run","batchId":"<registered-batch-uuid>"}
```

The response provides a stored `planId`, `plan.digest`, `plan.counts`, exact `plan.targets`, and any blockers. A blocked plan cannot execute. A dry run writes append-only QA/CRM evidence and an idempotent receipt; it does not change business objects.

Execution body:

```json
{
  "mode":"execute",
  "batchId":"<same-batch-uuid>",
  "planId":"<returned-plan-uuid>",
  "expectedPlanDigest":"<returned-digest>",
  "expectedCounts":{"crm_property_creation_drafts":1},
  "expectedTargets":[{"type":"crm_property_creation_drafts","id":"<exact-registered-id>"}],
  "confirmation":"RETIRE QA BATCH <authorized-workspace-uuid> <same-batch-uuid>"
}
```

Supply a fresh command identity for execution. An uncertain response is recovered with exactly the same request and command identity. A different key for an already executed plan returns its existing historical result without retiring objects twice. Every replay rechecks current administrative, tenant, session and relevant project authority; it is not a statement that the batch remains empty after later changes.

## Deliberately limited adapters

| Ledger resource type | Action | Additional limit |
|---|---|---|
| `projects` | Set normal `Archiviert` status and increment normal revision | Current project grant; every dependency must be proven tenant-bound and supported/empty |
| `bots` | Set `inactive`, preserving configuration | No unproven/unsupported active successor; no provider action |
| `crm_property_creation_drafts` | Existing `savePropertyCreationDraft` discard | Only the current actor's own active draft; existing draft rights, validation and revision guard remain |
| `knowledge_areas` | Existing archive helper | Only a proven empty area; no implicit adoption/archive of sources |

Ledger resource types are exact table identifiers above. External/blob entries, workspaces, memberships/accounts, settings, audit/history targets and unknown types block the entire plan. Existing generic bot editing would reset omitted configuration, so the retirement adapter changes only status and timestamp under the same forced RLS rather than submitting an incomplete editor object.

Plans bind actor, workspace, batch, all exact registration rows, full row digests, action/count/ID manifest and the database dependency contract. Row contents are hashed inside PostgreSQL and never returned as private draft or bot configuration data. A validated workspace-composite foreign key, FORCE RLS and SELECT privilege do not prove tenant-complete child visibility. No incoming relation currently has a reviewed completeness contract, so every such relation blocks its parent with `QA_DEPENDENCY_VISIBILITY_UNPROVEN` (or an earlier schema blocker), including an apparently empty relation. No private successor is read or disclosed and no runtime rights are broadened. Leaf objects remain eligible; parent adapters are implemented but not admitted until that separate completeness contract exists. New registrations are excluded during planning/execution by the batch row lock and its foreign-key lock conflict. Object locks prevent concurrent FK successor insertion during the transaction. Unknown schema, changed source rows, changed registration or expired plan stop execution. No cascade deletion is performed.

No live invocation is authorized by this local implementation handoff. The old `qa-two-tenant-e2e` reset payload and deletion counters are not claimed compatible: this route requires stored plan identity, exact IDs/counts and uses retirement counters with `deletedCounts: {}`. The existing `qa-livegang-reset.mjs` verification/no-op is not replaced or described as cleanup.

## Local verification

The dedicated synthetic tests use a disposable loopback database, its ordinary non-owner tenant runtime and two synthetic tenants. They do not prove a production upgrade, native CI, App attestation or live cleanup. Run only the targeted test file documented in the handoff; do not use production environment credentials.

Migration 194's owner depends explicitly on `USAGE public`, `SELECT(id,is_qa)` from `workspaces`, SELECT plus `UPDATE(id)` on `qa_batches`, and EXECUTE on the existing 080 `crm_lock_active_member(uuid,uuid)` helper. Its own SELECT/lock policies stay exactly tenant-bound under FORCE RLS. The static definer validates the active stored Owner/Admin and one of the existing settings-capable product roles before returning the exact batch lock. PUBLIC and legacy default function grants are revoked; only the existing tenant runtime group receives EXECUTE. No function performs DML or accepts caller SQL. A production-like Schema-Owner/runner rehearsal must still validate this exact migration and its ownership/ACLs.

For PG17 ownership transfer, the migration temporarily enables only the actual deployer's necessary SET option and the function owner's schema CREATE, within the migration transaction. It restores the deployer's original grantor-specific ADMIN/INHERIT/SET membership options and the original schema CREATE privilege/grant option. Function ACL/comment are completed before owner transfer; owner NOINHERIT and application memberships are never changed. The narrow non-superuser deployment probe covers missing SET, a pre-existing grant by the deployer, and pre-existing SET/CREATE WITH GRANT OPTION. This local probe does not replace the full restored PG17 upgrade rehearsal.
