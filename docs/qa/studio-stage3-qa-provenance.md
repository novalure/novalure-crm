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
Version2 additionally captures the actual current database owner, encoding and
locale/collation properties, connection/template properties, effective database
ACL (including PUBLIC defaults via acldefault/aclexplode with role names), and
pg_db_role_setting entries specific to this database. Database identity is
normalized as CURRENT_DATABASE/ALL_DATABASES rather than its differing name;
setting names/scopes are retained but every setting value is hashed. Database
owner/ACL/properties/settings have their own fingerprint and do not disappear
into the separately allowed cluster-role differences. Reports predating this
metadata cannot authorize a restore. Version4 separates setdatabase=0
ALL_DATABASES role settings from this database fingerprint. Those global role
settings retain role/name/scope and hashed values in database.globalRoleSettings,
and participate in the separate clusterRolesSha256. CURRENT_DATABASE settings,
including settings for a specific role on this database, remain mandatory exact
database metadata. The source's historical global novalure_app.search_path is
reported; it is not copied into a new role or required before that role exists.
Any new runtime-role configuration requires its own explicit checked setup.
Version3 also records the actual server version and the installed extension
name/version/schema/owner. It hashes OID-free extension-member identities,
definitions and owners, and records effective extension and public-schema ACLs
for the reviewed pre-restore subset check. Unknown extension-member catalog
classes fail closed. Earlier reports without this profile cannot authorize the
new restore. No application row, function body or setting value is printed.
Only hashes/counts, nonsecret catalog metadata and aggregate QA-marker results
are returned. The single company profile is accepted only with exact migration036 static
operator fields AND migration078's mandatory needs_review status with both
approved_by_user_id and approved_at null. No approval is inferred or set.
Exactly three auth identities must link one-to-one by ID and email to the three
synthetic workspace users. Marker checks
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
Source-before versus source-after checks additionally require unchanged
clusterRolesSha256, including the separately hashed ALL_DATABASES role settings.
That source drift check is deliberately separate from source-versus-target
database equality; target runtime-role restrictions remain independently checked.

Target global application roles require their own explicit reviewed setup;
pg_dump does not include global roles. Database owner/ACL/RLS/ledger/receipt/
data must remain unchanged. Runtime membership SET=false and historical g24
principal NOLOGIN are separate deliberate target restrictions, never claims
that the global role graph is byte-identical. Actual runtime security must
still be verified after restore and later original migrations.


## Prepared native selected-database restore runner

Not executed by the implementing agent. The runner is pinned to the source and
new target above and refuses a dirty/uncommitted checkout, any initially nonempty target,
or differing source/target database owner, effective CONNECT/CREATE/TEMPORARY
ACL, properties or settings before any target role/password/database write.
The connected target must actually be owned by neondb_owner, beyond merely
connecting as that role. The same metadata is rechecked before role creation
and native restore, and is included again in post-restore comparisons. The
runner never changes a source or target database ACL/owner/setting to satisfy
this equality. This is necessary because pg_restore without --create leaves
the target database object in place. It also refuses
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
fingerprint command. It creates three previously absent, run-owned roles:
novalure_app LOGIN INHERIT with a fresh random password, novalure_tenant_app
NOLOGIN NOINHERIT, and g24_qa_20260917_r3 NOLOGIN NOINHERIT for preserved ACLs.
All lack SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS. The sole application
membership is app-to-tenant ADMIN=false,INHERIT=true,SET=false. Provider roles
and source roles are untouched; source global-role equality is not claimed.

The prepared cross-version profile is specifically PostgreSQL17.11 source to
PostgreSQL18.6 target with PG18 native clients. It is not a general disaster-
recovery or same-server-version claim. Source pgcrypto1.3 and vector0.8.0 must
both be verified as public/neondb_owner in the approved source report; the sole
initial target extension must be plpgsql1.0/pg_catalog/cloud_admin. Both source
versions must be advertised by the target before any role or extension write.
The runner issues only the two fixed CREATE EXTENSION statements with explicit
VERSION '1.3' and VERSION '0.8.0'. It never rewrites the native archive or its SQL,
updates an existing extension, or substitutes the target's newer defaults.

Before initial setup there must be no user-namespace-dependent objects, extra
schemas, default ACLs, event triggers, foreign-data wrappers/servers,
publications or large objects. After extension installation and immediately
before native restore, only the exact source extension-member identities,
definitions, owners and versions may exist. Recursive dependency inventory also
detects extra objects using those members. Public-schema owner/ACL baseline
cannot drift. Effective pre-restore extension privileges are restricted to
standard owner/PUBLIC EXECUTE or USAGE and must be a subset of the actual source
privileges for the exact catalog/object/grantor/grantee/privilege/grant-option
row. The only eligible grantors are the observed cloud_admin and neondb_owner;
grantee must be PUBLIC or that same grantor, with no grant option. Extension
ownership alone never authorizes a member privilege: source member definitions
and owners still have their exact structure hash. Native restore, not this setup, reapplies the source's later tenant
grants. The full final schema/ACL and extension-profile fingerprints must still
equal source exactly. Unsupported members, unavailable versions, wider rights,
catalog/version drift or cross-version catalog incompatibility stop safely;
there is no fallback to weaker fingerprints or altered owner/ACL restoration.

Native PG passwords use only the child environment. TLS roots are explicit.
pg_dump includes only the selected database in custom format, retaining owner,
ACL/RLS, authentic ledger/receipt and data. pg_restore uses exit-on-error and
single-transaction without clean/no-owner/no-acl. Before/after source and
restored database-object, public-schema, ledger, receipt and data fingerprints must match. The report records the actual
native archive SHA/bytes, client versions and deliberate role restrictions.
Raw native stderr stays in the ACL-private artifact directory, not the console.
A failed run stays FAIL, keeps artifacts and never drops/repairs/resumes data or
rotates an existing role. Host-side diagnosis and a new explicit plan are
required. Later original migrations remain separately gated.

## Prepared target database normalization (separate from native restore)

Not executed by the implementing agent. The observed API-created target neondb
has the same locale/properties/owner as source but three additional effective
CONNECT/CREATE/TEMPORARY grants to neon_superuser, all non-grantable and granted
by neondb_owner. The runner does not exempt, revoke or alter these ACLs. It keeps
this database intact under st1_stage3_provider_baseline, then creates a separate
neondb from the unmodified template0 with OWNER neondb_owner.

Only super-block-59791927/br-ancient-term-awip1q3q and PostgreSQL18.6 are accepted.
The initial database inventory must be exactly neondb, postgres, template0 and
template1. Only the four known provider roles cloud_admin, neon_service,
neon_superuser and neondb_owner may exist with the exact observed LOGIN/
SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE attributes, verified unchanged against
the target's parent. These existing attributes are observed, never granted or
changed. Both new names must be absent. The source must have no
CURRENT_DATABASE settings. Initial target properties/settings must equal source
and its ACL must be exactly source plus those three observed provider rights.
The same pristine catalog gate used by native restore checks absence of user
objects/extra schemas/global objects, standard public-schema ACLs and the sole
initial plpgsql extension. No foreign client sessions or prepared transactions
are allowed; none are terminated. Any unexpected metadata fails before setup.

Use Node24 from a reviewed clean commit:

```
node scripts/studio-stage3-qa-prepare-target.mjs CONFIG NEW_PLAN --preflight
node scripts/studio-stage3-qa-prepare-target.mjs CONFIG NEW_EVIDENCE --run-authorized-prepare
```

All files must be within ignored .npm-cache/qa. CONFIG contains targetUriFile,
targetHost and approvedSourceReport; the mutable invocation additionally needs
approvedPreflightFile. Only the exact direct target host/private owner URI is
used, with explicit certificate verification/system CAs and fixed driver
options. URI query options are never passed to the driver. Preflight is a real
read-only transaction and writes only a new private plan file. Before the second
command, independently inspect the exact code and this preflight. The second
command requires that plan's same commit, an age of at most one hour, and a
fresh identical target preflight; no failed attempt is automatically resumed.

The three fixed target commands are CREATE DATABASE st1_stage3_management
TEMPLATE template0 OWNER neondb_owner, ALTER DATABASE neondb RENAME TO
st1_stage3_provider_baseline (after closing the original connection), and CREATE
DATABASE neondb TEMPLATE template0 OWNER neondb_owner. The new management and
restore databases must have the exact source database fingerprint. The renamed
provider baseline must retain its original database OID, complete fingerprint
and pristine catalog. A mismatch never causes GRANT/REVOKE, DROP, automatic
rename-back, source write, role/credential change, extension install, migration
or ledger creation. The runner does not connect to postgres or templates.

CREATE DATABASE cannot run inside a transaction. A failed or uncertain command
therefore leaves all databases intact, records the attempted phase as FAIL and
requires host-side inspection and a separately reviewed plan. Success proves
only this selected empty-target preparation; it does not prove native restore,
tenant isolation, current migrations or application readiness. The subsequent
original owner/ACL/RLS/data/ledger/061 native restore and all exact fingerprints
remain required. PostgreSQL's template0/transaction restrictions are documented
in [CREATE DATABASE](https://www.postgresql.org/docs/18/sql-createdatabase.html)
and [ALTER DATABASE](https://www.postgresql.org/docs/18/sql-alterdatabase.html).
