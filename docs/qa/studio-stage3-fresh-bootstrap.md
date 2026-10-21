# Studio Stage3: prepared original-SQL QA bootstrap

This is a separate, explicit fresh-test-database path. It is not a G24/native
restore, a source clone, or a Production disaster-recovery proof. The previous
prepare remains FAIL after creating only st1_stage3_management. The native
default-ACL permission probe remains BLOCKED_PROVIDER_42501 with confirmed
rollback and unchanged rights. No original archive/owner/ACL is omitted or
rewritten to make that blocked import pass.

The new runner is prepared only; its implementing agents did not execute main,
connect to a provider, or change any database. Eight offline tests exercise the
83 actual repository SQL files through synthetic transaction/catalog adapters,
including complete ordering/ledger behavior and negative guards. Those tests
do not prove that the SQL has run on Neon. The existing 061 compatibility tests
and the new exact Studio-QA profile are separate evidence.

## Exact starting state and independent plan

Only super-block-59791927 / br-ancient-term-awip1q3q / PostgreSQL18.6 is accepted.
The current five database names must be neondb, postgres, st1_stage3_management,
template0 and template1; the future st1_stage3_provider_baseline must be absent.
The original API neondb OID is16396, the explicitly created empty management OID
is32768, and postgres OID is5. Both complete current database/catalog hashes are
fixed in freshBootstrapBaseline. The original provider roles/attributes and
membership graph are checked. No application role may already exist.

The new read-only plan independently binds the current API/management catalogs,
both OIDs, the reviewed historical plan SHA17784722dcebd0e8d213e2b040ce5c9d5c5cc392ac48fb42f7aed3e44cbeedf9,
its actual failed-prepare evidence, approved source history, the confirmed
rolled-back native denial, the new clean commit, reviewed application source
revision and every original SQL checksum. Merely finding an existing management
database or a partial older run never authorizes reuse or automatic continuation.

Only this runner's exact PIDs/database/owner identities are accepted in changed
databases. Other client backends must be cloud_admin in unchanged postgres with
state exactly idle; their inventory/count is diagnostic and is not an approval
criterion because the provider pool can change. Unknown roles/databases/states
or prepared transactions fail; sessions are never terminated.

Root must independently review the exact code and actual new read-only plan
before running the explicit mutable mode. The same commit and application source
revision, canonical plan digest and age at most one hour are required. A fresh
read-only capture must match the reviewed bound plan before any DDL.

## Exact actions and truthful migration evidence

The existing management database is read only and remains empty. An explicitly
pinned neondb_owner connection to postgres manages the two database commands;
postgres itself remains owned by cloud_admin and is never modified. The runner
renames the original API neondb to st1_stage3_provider_baseline, verifies its
original OID/catalog/ACL, and creates a new neondb TEMPLATE template0 OWNER
neondb_owner. The new database must match the known pristine management database,
including its empty default ACL inventory, rather than the G24 extension/default
ACL catalog. Neither source nor provider roles/ACLs are altered. Both retained
databases are fingerprinted again after successful bootstrap.

A fresh novalure_app LOGIN INHERIT is created before migration001, with
NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS. Its new random
password is written only to the ACL-private run directory. Original001 installs
the target's supported pgcrypto/vector versions; actual versions are recorded,
without a historical-version or source-catalog equivalence claim.

All83 original forward SQL files001–085 are read from the exact committed Git
objects and normalized to LF. Historical numbering includes two different013
files and no058/059/063. Only062 moves: after051 and immediately before060,
using the existing fresh-media, absent audit-trigger/060-ledger and exact
original030 audit-seed guards. No media/audit data is repaired or removed.

Original060 creates the safe tenant group. Before061 the runner grants only
novalure_tenant_app to the new runtime role with ADMIN=false,INHERIT=true,SET=false
and records the actual reviewed application source SHA in the QA cutover role
comment. Direct applyNeon061Compatibility uses the new fixed studio-stage3-qa
target/profile. Its original source checksum, two guarded creator-edge exclusions,
full role/reachability checks,15 validated FKs and forced RLS remain intact. The
actual new G27 execution creates its own immutable receipt. No G24 receipt or
historical ledger row is copied, inferred or marked executed in advance.

Every migration runs in a transaction. Only after its actual SQL succeeds is its
original checksum inserted into the ledger (041 onward) and committed together.
Original001–040 execution is separately recorded in run evidence.061 uses its
actual execution receipt. Final checks require42 genuine ledger rows through085
and exactly the new correctly bound061 receipt. The runner stops after085.

Original086–098 require the normal separately reviewed db-migrate test-target
dry-run/plan-token/application sequence, including explicit manual-cutover flags
where required. Full current RLS, tenant, CRM/media and application-path tests
remain necessary before app binding or acceptance. No mail/calendar/marketing
integration or Production/EF1 access is activated by this bootstrap.

CREATE DATABASE/rename and the complete83-migration sequence cannot be one atomic
transaction. Failure records a fixed phase/code, rolls back the current migration
and retains all databases, roles, genuine earlier ledger rows and private
artifacts. It never drops, repairs, replays or resumes a partially completed run.
Host-side inspection and a new concrete reviewed plan are required.

## Host CLI

Use Node24 from the independently reviewed clean commit:

```
node scripts/studio-stage3-qa-fresh-bootstrap.mjs CONFIG NEW_PLAN --preflight
node scripts/studio-stage3-qa-fresh-bootstrap.mjs CONFIG NEW_RUN_DIRECTORY --run-authorized-fresh-bootstrap
```

CONFIG contains exact target={projectId,branchId,databaseName,runtimeRole},
targetHost, targetUriFile, cutoverSourceSha and historyFiles with exactly
sourceReport, originalPreflight, failedPrepare, startInventory and nativeDenial.
The mutable mode additionally requires approvedPlanFile. The application source
SHA must name a real commit that is an ancestor of the current reviewed commit.
Do not put URI/password values in chat, command arguments, tracked files or logs.

Inputs and outputs are restricted to ignored .npm-cache/qa with verified private
access. A new run directory receives current-user/SYSTEM-only Windows ACLs (0700
on POSIX), verified before evidence or credentials are stored. Runtime credentials
use a new0600/ACL-inherited file. Database clients use fixed direct host/port/
database/user options and verified system TLS roots; URI query/ambient PG options
cannot select a different target or disable certificate checks. Console and
failure output contain only bounded status, phases and fixed error codes.

The committed original-preflight fixture contains only the already reviewed
catalog/role/hash metadata needed to verify the exact historical plan digest.
It contains no URI, password, signing key, customer attachment or application row.
