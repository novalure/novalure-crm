# G27 disposable Neon bootstrap

This opt-in infrastructure profile builds a fresh synthetic QA database for PR #65. It does not enable Production migrations, change application code, or change the G27 live A–F runner.

## Exact target

- Project: `super-block-59791927` / `novalure-g27-disposable-qa-20260920`.
- Branch: `br-summer-breeze-awuzinct` / `g27-qa-crm-20260923`.
- Parent: `br-dry-thunder-awmimouk` / `main`, the root of the separate disposable QA project.
- Branch creation: `2026-09-20T19:57:16Z`.
- New source database: `qa_g27_20260923`.
- New restore database: `qa_g27_restore_20260923`.
- New runtime login: `g27_qa_20260923`.

On September 23, authenticated Neon SQL verified this branch's project/branch fingerprint, only `neondb` as a non-template application database, and zero non-system relations. The existing unused branch was renamed to meet the unchanged live runner's `g27-qa-…` cleanup requirement. Neon API metadata confirmed non-default, non-primary and unprotected state. No database writes were needed for these checks.

## Preserved guards

`scripts/qa-neon-g27.mjs` and its G27-specific helpers derive from the audited G24 fresh-build profile. G24 files and their pins remain unchanged. The separate files intentionally preserve an exact, reviewable allowlist rather than accepting arbitrary environment-selected migration targets.

The G27 runner requires a clean committed checkout, committed migration bytes, fresh database and role names, a fixed Neon project/branch, direct TLS with certificate verification, and fresh API attestation before provisioning. A project-scoped Neon key is supplied only in the process as `G27_CRM_NEON_API_KEY`; the direct admin connection is supplied only as `G27_QA_ADMIN_URL`. The ignored configuration file contains target metadata, not that admin connection. Never print or commit credentials.

The G24 migration order is preserved: 001–059, 062 before the 060 append-only audit trigger, 060, guarded 061 compatibility, then remaining forward migrations through 087. Original SQL source/checksums are unchanged. Only the two previously reviewed provider creator-edge predicates in executed 061 differ from historical SQL, with an append-only execution receipt under the distinct G27 profile ID. Every other role, tenant, FK, RLS and audit check remains active. New migrations beyond 087 are rejected.

The fresh project has no inherited `novalure_app` group, so the profile explicitly creates the same safe NOLOGIN group used by the existing local database bootstrap. Runtime has no owner, superuser, BYPASSRLS, CREATEROLE, CREATEDB or replication capability. No provider role is modified. Application grants come from the original migrations.

The builder generates new synthetic fixture UUIDs for database-boundary checks, verifies the original migration-030 seed first, and tests immutable finance tables and FORCE RLS through 087. These fixtures are not the A–F fixture or proof of live Preview behavior. A native dump/restore must preserve the full catalog, grants, RLS, policies, functions, triggers, ledger and data digests; security probes run before and after restore.

## Execution and evidence

Run the committed profile using Node with trusted system CAs, PostgreSQL 18 client tools via `CRM_QA_PG_BIN`, and the explicitly supplied process credentials:

```text
node --use-system-ca scripts/qa-neon-g27.mjs .npm-cache/g27/neon-bootstrap-private.json
```

The configuration must be Git-ignored. Evidence, native dump, catalog snapshots and private synthetic runtime credentials stay under ignored `.npm-cache/g27/neon-bootstrap-20260923/`. Failures must never be repaired by disabling guards or reusing a partially initialized database. Review failed evidence and use a newly reviewed disposable target if a fresh retry is necessary.

Local compatibility validation on September 23: original G24 11/11 and new G27 11/11 PASS. The initial G27 test attempt caught an unchanged G24 receipt-profile expectation; it was corrected to the distinct G27 ID before the successful run. No security assertion was relaxed.

Remote migration, final effective Vercel binding, live A–F, cleanup and G27 closure remain separate gates. A successful bootstrap must not be reported as `G27 CLOSED` or `LIVE_RUNNER_PRECONDITION_PASS`.

The [Neon branch metadata API](https://api-docs.neon.tech/reference/getprojectbranch) supplies the current branch identity checked before writes. Credentials are not included in evidence.
