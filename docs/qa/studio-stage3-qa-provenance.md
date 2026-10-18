# Studio Stage 3 QA provenance

The read-only fingerprint helper accepts only the authentic G24 database
(weathered-term-98273025 / br-spring-snow-alupo8u4 /
qa_g24_pr63_20260917_r3), or the new isolated target
(super-block-59791927 / br-ancient-term-awip1q3q / neondb).
It never reads the unclassified source neondb. It never provisions a provider,
executes a migration, changes a role or fabricates a ledger.

Run with Node24: node scripts/studio-stage3-qa-fingerprint.mjs CONFIG OUTPUT.
Both paths and the private URI file must be within Git-ignored .npm-cache/qa.
OUTPUT must be new. CONFIG contains mode (source/restore), branchId,
databases (one exact database name), uriFile and expectedHost (the exact direct
host read from the authorized provider metadata). It uses verified TLS and a
real repeatable-read read-only transaction with connected target verification.
The URI and row contents are never printed.

The report hashes full ledger rows (including application times), complete
execution receipts, every public stored table/materialized-view row and listed
OID-free DDL/RLS/ACL categories. It includes enums/domains/schema metadata.
Only hashes/counts and aggregate QA-marker results are returned. Marker checks
are not a complete PII/free-text scan: unknown rows/tables/schemas require
host-side owner review. Cluster roles/memberships are separately fingerprinted
because provider roles legitimately differ across projects.

Historical G24 evidence proves its actual native dump/restore (83 forward
migrations,42 ledger rows,141 data tables/118 rows); it is not a new restore
pass. New native archive, selected DB-only restore, exact target, before/after
source and target hashes need fresh evidence. No schema-only ledger recreation,
local-loopback bootstrap on Neon, omitted ACL/owner restoration, or source/
Production role mutation is allowed. The 061 receipt retains its actual
original source target and SQL execution checksum after native restore.

Target global application roles require their own explicit reviewed setup;
pg_dump does not include global roles. Database owner/ACL/RLS/ledger/receipt/
data must remain unchanged. Runtime membership SET=false and historical g24
principal NOLOGIN are separate deliberate target restrictions, never claims
that the global role graph is byte-identical. Actual runtime security must
still be verified after restore and later original migrations.


## Prepared native selected-database restore runner

Not executed by the implementing agent. The runner is pinned to the source and
new target above and refuses a dirty/uncommitted checkout, any nonempty target,
existing application-role names, unapproved source hashes, incomplete authentic
ledger/061 proof, non-18 native clients, or signature drift. It makes no DROP,
source write, migration, provider request or ledger-recreation call.

After exact-code independent inspection, use Node24 and the existing native18
clients through absolute CRM_QA_PG_BIN. The ignored config contains sourceUriFile,
sourceHost,targetUriFile,targetHost,approvedSourceReport and artifactDirectory.
The source report must be independently reviewed and use current fingerprint
semantics. URI files and report are ignored private files. artifactDirectory
must be a NEW child of an existing ignored QA directory. It is restricted to
the current Windows SID and SYSTEM before any password or native dump is
written. The URI never appears in arguments, reports or error output.

Invoke node scripts/studio-stage3-qa-restore.mjs CONFIG --run-authorized-restore.
This explicitly performs target writes. Do not confuse it with the read-only
fingerprint command. It creates only three previously absent, run-owned roles:
novalure_app LOGIN INHERIT with a fresh random password, novalure_tenant_app
NOLOGIN NOINHERIT, and g24_qa_20260917_r3 NOLOGIN NOINHERIT for preserved ACLs.
All lack SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS. The sole application
membership is app-to-tenant ADMIN=false,INHERIT=true,SET=false. Provider roles
and source roles are untouched; source global-role equality is not claimed.

Native PG passwords use only the child environment. TLS roots are explicit.
pg_dump includes only the selected database in custom format, retaining owner,
ACL/RLS, authentic ledger/receipt and data. pg_restore uses exit-on-error and
single-transaction without clean/no-owner/no-acl. Before/after source and
restored database fingerprints must match. The report records the actual
native archive SHA/bytes, client versions and deliberate role restrictions.
Raw native stderr stays in the ACL-private artifact directory, not the console.
A failed run stays FAIL, keeps artifacts and never drops/repairs/resumes data or
rotates an existing role. Host-side diagnosis and a new explicit plan are
required. Later original migrations remain separately gated.
