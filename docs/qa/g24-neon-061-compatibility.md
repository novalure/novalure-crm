# G24 — Neon 061 compatibility and fresh QA rebuild

Scope: PR #63, `codex/crm-sales-readiness-high-gaps`. This work addresses G24 only. G08 remains open. No Production migration, deployment, application connection, provider integration or PR merge is authorized by this change.

## Root cause and preserved history

`061_validate_and_activate_tenant_rls_pilot.sql` contains no membership GRANT. Its own first preflight raises SQLSTATE `42501` for the direct member `neondb_owner` of `novalure_tenant_app`: that member is privileged and has no effective USAGE of the tenant group. Its second preflight also mistakes the same administrative membership for an application LOGIN owning pilot tables.

The actual Neon catalog identifies grantor `cloud_admin` and options ADMIN=true, INHERIT=false, SET=false. PostgreSQL automatically creates this edge when a non-superuser with CREATEROLE creates a role. The creator cannot revoke that bootstrap-superuser grant. ADMIN-only is **not** a security boundary: its holder can later grant additional membership options. The permitted exception is therefore solely the already trusted database/migration/pilot-table owner, never an arbitrary ADMIN member.

Primary documentation: [PostgreSQL 17 role attributes](https://www.postgresql.org/docs/17/role-attributes.html), [role membership options](https://www.postgresql.org/docs/17/sql-grant.html), [Neon role documentation](https://neon.com/docs/manage/roles).

The historical 060 and 061 files are unchanged. Normalized UTF-8/LF SHA-256:

| Migration | Source checksum |
| --- | --- |
| 060 | `b037f00c56daf6af4a12b7641bd60fe6e3b981240859800d3f62a21b68a31baf` |
| 061 | `0fdd95faee430de5b6e1ea0d22d477099ff151c5583476bdb542b6e00dcb5d23` |

061 has that same checksum in this branch's historical commits `566a43b`, `bc6e677`, `c370592` and pre-G24 `f64337e`. A separate development branch changed it; that variant is not imported. Prior August reports and the failed September QA ledger show 060 but no successful remote 061 application. Existing local tests have applied the original 061. Production history was deliberately not queried and remains NOT VERIFIED. No historical ledger row or checksum is overwritten.

## Narrow compatibility profile

`scripts/lib/neon-061-compat.mjs` is an opt-in QA utility, not a production migration-runner bypass. The real profile is pinned to the newly created isolated branch and explicitly checks connected project, branch, database, session user and PostgreSQL version. Source 061 and predecessor 060 checksums must match exactly; an existing 061 ledger entry is rejected.

The module changes only two membership-classification predicates in the SQL executed for 061. It excludes the exact provider-granted ADMIN-only edge for `current_user = session_user = database owner = all five pilot-table owners`. Unexpected grantor, effective USAGE/SET, additional unsafe members, runtime ownership, privileged membership paths or reachable ADMIN delegation fail closed. Every direct application LOGIN is checked. The separate runtime is NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOREPLICATION and has no provider-owner membership.

Everything else in 061 executes: role safety, cutover attestation, a positive safe LOGIN, six existing policies, append-only audit trigger, all 15 tenant FK validations, the original table revokes/grants and ENABLE/FORCE RLS on all five pilot tables. No provider role or membership is altered. No RLS or audit trigger is disabled.

The ordinary ledger checksum continues to identify the original source file. An additional append-only `novalure_migration_execution_receipts` row records the actual executed SQL checksum, original source checksum, profile, exact target, reviewed runner commit, plan digest and sanitized catalog proof. This row, 061 DDL and ledger insertion share one transaction; a ledger failure rolls all three back. Runtime has no access to either migration metadata table. Neither ledger nor receipt is presented as proof of an unmodified 061 execution.

The local test profile is separate, requires a real loopback PostgreSQL instance with a matching test-owned data directory/postmaster identity, and cannot select the Neon target through an environment flag.

## Complete fresh-build path

`scripts/qa-neon-g24.mjs` refuses a dirty/uncommitted checkout, any different target, pre-existing source/restore databases, or pre-existing run-owned runtime role. It creates new databases using template0 inside the fresh QA branch. The inherited parent database is used only for branch/database identity and role provisioning; its business data is neither copied into the source database nor queried.

All forward SQL files through 085 execute. Rollback files are not forward migrations. There is no local pgvector substitution: the real Neon `vector` extension is required.

Order: 001–059, **062**, 060, compatibility-handled 061, remaining forward migrations 063–085. File numbering has historical gaps. 062 depends on 051, not 060. Its original UPDATE of audit_logs would conflict with the statement-level append-only trigger installed by 060 even with zero affected media events. In this fresh-build-only path, 062 runs before that trigger exists. Media, share and bot-send tables must be empty, and the audit table must contain only the exact unchanged migration-030 seed event. All 062 statements run unchanged; the original seed is retained. This is not evidence that an existing customer database is ready for a legacy media cutover.

061 precedes 068, which removes two pilot FKs, and 080, which replaces the pilot policies. The other manual cutovers 057 and 065 execute after their predecessors. Existing safe `novalure_app` grants are inherited with ADMIN=false/INHERIT=true/SET=false; Sales migrations supply their own specific privileges. There are no blanket grants or manual post-migration permission repairs.

## Actual restore and security proof

The runner adds only explicitly synthetic tenant/project/actor/contact fixtures after the original migration seeds have been verified. It checks default deny, tenant/project isolation, cross-tenant FK enforcement, monotone versions/stale CAS, immutable audit/command/migration receipts, reservation-request state and the expected FORCE RLS tables.

A native `pg_dump` custom archive is restored with `pg_restore --single-transaction --exit-on-error` into a second new empty database on the same QA branch. Direct TLS connections validate the server against trusted CA certificates. Credentials and dump files remain Git-ignored; logs/evidence exclude credentials and row payloads.

Before/after snapshots compare tables, columns, constraints/FKs, indexes, RLS, policies, role memberships, relation/column/schema/function/default grants, functions, triggers, views, extensions, sequences, complete data digests and the migration ledger. Security probes are repeated after restore; the source snapshot must remain unchanged. This does not claim cross-cluster role recovery, point-in-time recovery or Production disaster recovery.

## Reproduction

1. Use the reviewed clean commit, pinned Node 24.14.0/npm 11.9.0 and PostgreSQL client tools via `CRM_QA_PG_BIN`.
2. Create the explicitly authorized fresh QA branch; this run's reviewed profile is hard-pinned to its identity. Reusing a different branch requires a new reviewed profile change.
3. Store the already authorized QA admin connection only in ignored `.npm-cache/qa/g24-private-config.json`, with projectId, branchId, databaseName, restoreDatabaseName, runtimeRole, adminUrl, branchName and branchCreatedAt. Never commit this file.
4. Run `node scripts/qa-neon-g24.mjs .npm-cache/qa/g24-private-config.json`. The runner refuses to resume, erase or repair a pre-existing database.
5. Inspect sanitized `.npm-cache/qa/g24/evidence.json`, both catalog snapshots and native restore results. Run `npm run test:neon:061`, all existing regression suites, browser E2E, typecheck, lint, build, dependency audit and secret scans. Independently review evidence before changing G24 status.

This task's final measured results and review verdict are recorded separately after execution; this design document alone is not a PASS assertion.
