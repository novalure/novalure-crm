# New blank Free-project CRM candidate bootstrap

This additive operator prepares the current CRM schema for the existing manual
`isolated-candidate` job. It does not create a Neon project, copy Production,
publish a deployment, run a model, send mail or perform a customer action.
The historical Stage3/Package4 tools and all original SQL remain unchanged.

## Current evidence and limits

The nonsecret target template `crm-candidate-free-target.pending.json` is
deliberately non-executable. No new project, native source installation or
manual-QA acceptance is claimed by this implementation. The original source
registry `config/crm-candidate-fresh-migrations.json` pins the complete169
forward SQL files and two separate087 stage files from75bf459. The separate
`config/crm-candidate-fresh-execution-variant.json` pins the existing standalone100
product variant: original100 explicitly rejects Preview097/098/099. Those three
exact original hashes remain inventoried and are recorded as
`NOT_EXECUTED_INCOMPATIBLE_PREVIEW_VARIANT`. No SQL is altered and no ledger row
is invented for them. Future SQL
changes require a separately reviewed registry successor; directory counts
must not be widened automatically.

There are41 original files before041 (including both013 files),83 files through
085 and125 canonical ledger entries after all166 selected originals succeed.
The169-file inventory describes128 possible ledger identities, but those
variants cannot all be executed together. Both108 identities are
preserved. Source/root199 is included; rollback files, Studio Voice draft SQL
and other staged copies are not implicitly executed. The portable local
PostgreSQL binary lacks pgvector. Its real selected-migration and061 tests
therefore prove only their stated local scope, not complete001–201 or native
Neon compatibility. The unchanged original001 still requires the real vector
extension; this operator never substitutes an array or omits its index.

## Descriptor and private host input

After Root creates a genuinely new blank project in `org-cool-cloud-50864215`,
record the actual Free plan, project creation response, new root branch with
parent null, endpoint and direct/pooled hosts in a nonsecret descriptor. Bind
the actual composite creation metadata through `nativeCreationReceiptSha256`.
Set `status=NATIVE_NEW_FREE_PROJECT_AUTHORIZED` and `sourceRevision` to the
final reviewed clean operator commit. The exact descriptor schema is enforced
by `validateCrmCandidateDescriptor`; its canonical SHA-256 must be supplied as
an independently reviewed expected digest. The project must be at most24hours
old; known historical/prod projects, paid plan, foreign organization, non-root
branch, different endpoint/host/database/role, additional credential fields,
digest or revision drift are rejected. The descriptor does not itself replace
the following actual database identity/catalog/role checks.

Commands run from the clean repository root with Node24 and verified system
TLS roots. Only nonsecret paths/digests appear in arguments:

```
node --use-system-ca scripts/crm-candidate-fresh-bootstrap.mjs --inspect
node --use-system-ca scripts/crm-candidate-fresh-bootstrap.mjs --preflight DESCRIPTOR_JSON DESCRIPTOR_SHA PRIVATE_PLAN_JSON
node --use-system-ca scripts/crm-candidate-fresh-bootstrap.mjs --apply DESCRIPTOR_JSON DESCRIPTOR_SHA PRIVATE_PLAN_JSON NEW_PRIVATE_RUN_DIRECTORY
```

The preflight reads exactly `{migrationDatabaseUrl}` from private UTF-8 stdin.
The apply reads exactly `{migrationDatabaseUrl,runtimePassword}`. URL values
never belong in shell arguments, environment variables, source, receipts or
chat. The URL must name the exact direct host, `neondb_owner`, `neondb`, verified
TLS and only supported connection options. The host constructs native pg
configuration explicitly, with verified CA/servername and
`enableChannelBinding:true`; it does not rely on pg parsing the optional
`channel_binding=require` URL parameter. Runtime password is a host-generated
40-byte random value encoded as80hex characters. The host must retain it in
private memory until the actual outcome and GitHub credential binding are
resolved. The operator never writes that password or any URI to a file.

Private plan and new run directory must be outside the repository, under an
existing owner-only directory (Windows current user/SYSTEM, POSIX0700). Files
are created exclusively. A permanent intent and append-only metadata journal
precede mutation. Credentials are neither inherited by a child process nor
used to invoke a different unchecked migration runner.

## Actual schema protocol

1. Preflight reads the new native project/branch/database/session-owner identity,
   database OIDs/inventory, provider roles/memberships, extensions, ACLs and empty
   catalogs. No application roles/user tables/functions/types/settings or
   unknown sessions may exist. Save a new read-only plan. Its exact source,
   target, SQL, catalog and roles are bound; it expires after one hour.
2. Apply obtains the management-database advisory lock, re-reads the complete
   actual plan and refuses any drift before the first mutation. Preserve the
   original provider-created `neondb` by renaming it to
   `crm_candidate_provider_baseline`; create a new `neondb` from template0,
   owned by `neondb_owner`. Verify the preserved original OID/catalog before
   and after. Never drop/restore a donor database or change provider roles.
3. Create only the new restricted `novalure_app` login. Execute all83 early
   original files. Only062 moves, to immediately before060 after051, guarded
   by empty media, absent060/061/audit guard and the exact original030 audit
   seed. It never removes additional audit records. Runtime must remain a
   non-owner without elevated flags or DDL.061 uses a distinct descriptor-bound
   entry with the existing creator-edge renderer, complete role reachability,
  15 validated FKs and five FORCE-RLS tables. Its new receipt records original
   and actual executed SQL hashes and the new descriptor/creation references;
   no historical receipt is copied. Early ledger rows and SQL commit together.
4.086–120 use in-process **official migration-library composition**, not a CLI
   subprocess. The existing `db-migrate.mjs` exposes its unchanged
   `readMigrations`, `readLedger` and `applyMigration` implementations through
   export keywords only. The wrapper calls the actual official planner,
   checksum/collision/predecessor checks, exact Git/commit checks,
   `createMigrationPlanToken`, native target check and
   `applyCommittedMigrationPlan`/`applyMigration`. Each step writes a new
   metadata-only private plan and immediately re-reads target, full ledger,
   Git source and token before apply. Manual cutovers remain explicit; both108
   sources retain their reviewed hashes. SQL and its genuine canonical ledger
   insert retain the original official transaction implementation.
5. After actual087 execute its unchanged bounded backfill and contract, recording
   their separate source/execution receipts.095/096 execute adjacently while
   public application traffic is absent; the old lookup login ends disabled
   with PASSWORD NULL. After all manual predecessors through120, the official
   standard planner installs the remaining pending121–201. Verify every one of
   the125 exact selected canonical versions/names/checksums and the two087 stages,
   with the three exact Preview exclusions preserved as exclusions, not passes.
6. Authenticate the real restricted runtime through the exact pooled host.
   Verify target identity, no privileged membership/ownership/DDL/ledger access,
   safe tenant membership, physical original gateway seeds and no-context RLS
   default deny, plus the retired lookup identity. Close and confirm all own
   connections before publishing a final schema receipt. Application QA and
   Production readiness remain pending.

Every SQL action has an intent before execution. An error/unknown commit keeps
all genuinely earlier commits and evidence and ends HELD; no blind retry,
automatic role reset, fake ledger insert, source repair or partial-run resume
is provided. A new invocation must pass the original empty-target checks and
therefore cannot silently repeat a partial initialization. The owner must
reconcile the exact recorded target first. The original provider baseline is
retained; the operator does not claim disaster-recovery proof.

## Manual QA and cleanup boundary

Only after native full-schema/runtime success bind the exact new target and
fresh QA-only authentication/Studio signing values to GitHub Environment
`novalure-qa-candidate`. Its existing manual workflow starts a local Next
production build at127.0.0.1; this is not a Vercel deployment. The corrected
fixed CandidateRef must match the approved PR132 release branch and actual
final run SHA. Keep actual customer mail/calendar/blob/model credentials absent.

The signed candidate path has files/websites/targets empty and one run-bound
`example.invalid` address. API tests use synthetic workspaces/users and local
HTTP. Existing always-cleanup stops the server, removes scoped probes/run data,
verifies canonical Growth seeds and verifies the retired lookup role. However,
the public candidate test intentionally retains immutable synthetic audit
history and refuses a second candidate run on the same branch with
`QA_CANDIDATE_BRANCH_ALREADY_USED`. Treat this as an isolated one-shot
acceptance. A30-minute job timeout is a bound, not proof cleanup completed.

The workflow does not delete the Neon project or revoke its owner URL.
Explicitly retain the narrowly bound QA target or close/revoke/delete only the
owned new target and GitHub bindings after preserving genuine evidence. Never
reuse the expired paid-production window, automatically upgrade Free, connect
to production, or label this synthetic application QA as a production rehearsal.
