# Registered autonomous CRM access

Implemented on the isolated successor of `a1a1995529916c78622d421aa25add5442910a91`.
The real-internal workload and its explicit delegation assignments are separate
from the preserved synthetic canary principal. The new registration does not
inherit the canary's resources, scopes or expiry.

## Supported operations

`POST /api/integrations/evelyn/access` supports a minimized read of one assigned
internal Task or Project and a version-checked update of an assigned Task title.
All 16 canonical departments and bounded subagent identifiers can receive a
separate registered assignment. Each assignment fixes the workspace, actor,
project, source record, department, agent, mission/task ID and permitted actions.
Task reads return title, status, priority, version and update time. Project reads
return name, type, status and update time. Record data must have context
`NOVALURE_INTERNAL` and purpose `crm_sales`.

Contact, Company, Unit, lead, offer, reservation, sale and communication access
needs its existing record visibility, field, price and business rules integrated
in a later scope. HR records, private material, banking and legal decisions have
no operation in this endpoint. A department name alone supplies no record rights.

## Authentication and effect boundary

The existing Vercel OIDC verifier pins issuer, audience, source team, project,
subject, environment, signature and time claims. The CRM independently resolves
the dedicated real-workload registration. Cookies and browser origins are denied.

The `x-evelyn-delegation` credential is
`v1.<grant UUID>.<base64url JSON>.<Ed25519 signature>`.
The signed payload has exactly `issuedAt`, `expiresAt`, `nonce` and `requestHash`.
The digest is the existing `crmPayloadDigest` of the complete body. The signed
UTF-8 bytes are `crm-autonomous-access-v1.POST./api/integrations/evelyn/access.<grant UUID>.<payload segment>`.
The credential lasts at most 300 seconds. Its public SPKI key is stored in the
assignment. The protected Evelyn worker host resolves the private signing key
and fresh OIDC tokens for each request. Workers receive bound read/update tools.

Request JSON has exactly `contractVersion`, `operation`, `correlationId`,
`idempotencyKey`, `expectedVersion` and `patch`. `Read` uses a null version and
empty patch. `UpdateTask` accepts only a nonempty trimmed title of at most 200
characters with no control/format characters, and a positive expected version.
The command idempotency key and transport nonce use UUID v4.

The transaction locks the real workload, assignment, both stored actors,
workspace and explicit positive project permission. The normal CRM member,
project, capability and RLS checks also run. This explicit project grant remains
required for an internal operator. Delegation validity is checked after nonce,
command and record lock waits and immediately before mutation/output. Revocation
is serialized with in-flight work. A request that lost the response uses the
same complete command body, correlation and idempotency key with fresh transport
credentials. It returns the original receipt after current authorization.

Successful access events record the registered department, agent and mission,
real workload identity, resource, action and hashes. A composite foreign key
binds attribution to the immutable grant. Events, nonce use and the effect share
one transaction. A failed/expired operation adds no successful access event.

## Protected noninteractive registration

The staged migration is `migrations/staged/evelyn_autonomous_access.sql`.
It creates no workload, grant, actor, signing key or business record. Keep it out
of the automatic historical migration path until its exact target and ordered
predecessors have passed the existing release gates.

The host-side `registerAutonomousCrmAccess` function in
`src/lib/crm-autonomous-registration.ts` takes an already protected database
connection and public assignment metadata. It requires ownership of both
registration tables and rejects superuser, BYPASSRLS and runtime roles. It uses
one transaction, verifies the exact existing workload and project grant and
rejects changed registrations under an existing ID. Its connection and the
private delegation key remain in protected host custody. The function has no
HTTP/model-facing registration route.

The installer identity must already own the affected metadata relations or have
the established authority to install their policies. Policies bind to that
designated non-runtime owner and the exact internal workspace. SELECT policies
permit authentication metadata lookup. Lock policies use scoped UPDATE USING
with `WITH CHECK(false)` for PostgreSQL row locks. They grant no successful
metadata update. Runtime registration-table rights remain absent. The exact
installation owner and effective membership/privileges need target verification.

Workload and grant expiry default to null for authorization until revocation.
OIDC and delegation credentials continue to expire and renew automatically.
An explicitly finite assignment stops at its expiry. The protected owner can
revoke a grant with a parameterized `UPDATE crm_autonomous_access_grants SET
revoked_at=clock_timestamp() WHERE id=$1`, or stop the workload through its
registered disable/kill/revoke fields. The single fixed workload registration is
retained for audit and renewed/re-enabled only through the authorized protected
owner lifecycle. A changed department, agent, resource or signing key requires
a fresh grant ID after revoking the old grant. Normal runtime cannot provision,
renew, reactivate or expand authority.

## Local evidence and remaining activation

`npm run test:crm-autonomous-access` passed the 13 new groups with no skips.
The preserved legacy machine-auth source passed its five groups. CI runs legacy authentication in its existing sales
suite and adds only the new groups. The new groups use the
real handler, Ed25519 signatures and a disposable PostgreSQL database with a
separate non-superuser, non-BYPASSRLS bootstrap owner. They cover all departments,
missing registration, wrong keys/actor selectors, private/foreign resources,
project revocation, expired grants, four actual lock-wait expiry cases, concurrent
and idempotent writes, immutable audit attribution and rejected owner metadata
mutation. Receipt replay is also denied after the source task moves outside its
registered project. The extra metadata FORCE-RLS probe includes strict tenant/actor fixture
views and is local evidence.

The paired local acceptance used the actual compiled Evelyn connector at
`c8fad7ea3b5f943cef25af285d3c1e06e81c4b46`, this real CRM handler and PostgreSQL.
It confirmed a read, a committed write with a lost response, recovery of its
original receipt and denial after grant revocation. The ignored local acceptance
driver is `.npm-cache/qa/paired-autonomous-access-tests.mts`. Its one focused
cross-repository acceptance group passed against the final handler source.

No real workload/grant registration, key custody, actual provider token call or
deployment is evidenced by these local results. The active release coordinator
must integrate this small successor delta, obtain exact native CI and independent
App review, and close the existing eight gates for the same revision/target.
Then the protected host can apply the staged SQL, register approved real-internal
assignments and verify the exact login-free runtime with scoped audit evidence.

## Current release integration handoff — 2026-11-07

This eight-path access delta is now composed in its own worktree and branch,
`codex/crm-access-integration-20261107`, on the observed sole release candidate
`30974726885cb47490f0f03d2b0b1cf0161318f3` (parent `14f4ca5c`).
It imports the reviewed access package `8144c426` without changing the active
release, History, recovery, common command implementation or production ledger.
The release coordinator must adopt the integration commit before it becomes the
sole candidate; this branch does not create a second release owner.

The only functional composition change enters `withCrmCommandPreflight` before
retaining delegation or nonce locks in the `UpdateTask` effect transaction. Initial
authentication lookups finish in autocommit before that transaction. This uses History's
canonical workspace/idempotency command lock before project/business locks.
The nested command uses the same transaction and reentrant lock. Read access
continues through `withCrmRead`. Current-grant, source-scope and credential-time
checks before mutation and before receipt disclosure remain in place.

One new local PostgreSQL regression holds that exact command lock, observes two
real request waiters, proves both delegation and nonce locks remain available,
revokes the grant, and verifies two denials with no effect, receipt or success
event. After restoring the synthetic grant, two fresh retries converge on one
effect and one original receipt. The final focused run passes 5/5 groups: that
case plus existing protected registration, nonce/receipt replay (including a
moved source), parallel writes, and the four credential-expiry lock waits.
Receipt: `.npm-cache/qa/access-integration/targeted.tap`. Repository TypeScript
(`tsc --noEmit`) and affected-file ESLint pass. No whole build or broad regression
was repeated.

```powershell
node --conditions=react-server --import tsx --test --test-concurrency=1 --test-name-pattern='protected noninteractive|nonce replay|parallel writes|History command preflight|expiry during' scripts/crm-autonomous-access-tests.ts
```

Unchanged evidence from the original access package and History is reused in its
recorded scope. The earlier 13/13 access suite and paired client acceptance were
not rerun or promoted to this revision. No browser, native CI, provider token,
production registration or deployment is claimed. The observed release ledger
still records 0/8 production gates and `approvedRelease=false`.

### Protected activation procedure (prepared; not executed)

After the coordinator has exact-revision/target gate evidence, pin the existing
non-runtime metadata/schema owner, database and migration order. The staged SQL
is unchanged; SHA256 is
`b2b9f7e1cf891e5214551239c41fd74ad0913fd2db18512124ff87d7757b47e5`.
Numbered source migrations currently end at 201; this package reserves no number
and the coordinator must qualify the actual source ledger before activation.
The migration creates no authorization records and must run in one transaction.

For a protected host, the following one-shot driver can be saved outside tracked
source as `.npm-cache/qa/register-approved-access.mts`. It uses an existing
host-provided connection secret, prints no credentials, and accepts only a public
assignment manifest. This driver does not evaluate or replace release gates;
running it requires the already verified target and bootstrap authority.

```typescript
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { registerAutonomousCrmAccess } from "../../src/lib/crm-autonomous-registration";

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
const connectionString = process.env.CRM_AUTONOMOUS_BOOTSTRAP_URL;
if (!connectionString || !["stage", "upgrade-personal", "register"].includes(manifest.phase) ||
    !manifest.database || !manifest.registrar) throw Error("BOOTSTRAP_INPUT_REQUIRED");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  const target = (await client.query(`select current_database() as database,
    current_user as registrar,rolsuper,rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
  if (target.database !== manifest.database || target.registrar !== manifest.registrar ||
      target.rolsuper || target.rolbypassrls ||
      ["public", "novalure_app", "novalure_tenant_app"].includes(target.registrar))
    throw Error("BOOTSTRAP_TARGET_OR_OWNER_DENIED");
  if (manifest.phase !== "register") {
    const upgrade = manifest.phase === "upgrade-personal";
    const sql = await readFile(upgrade ? "migrations/staged/evelyn_autonomous_personal_source.sql"
      : "migrations/staged/evelyn_autonomous_access.sql", "utf8");
    const expected = upgrade ? "159ad97378d3e02f05bc1545e28a074cbbccbd5b84ce97497a20150d86b4865e"
      : "b2b9f7e1cf891e5214551239c41fd74ad0913fd2db18512124ff87d7757b47e5";
    if (createHash("sha256").update(sql).digest("hex") !== expected)
      throw Error("BOOTSTRAP_SOURCE_MISMATCH");
    await client.query("begin");
    try { await client.query(sql); await client.query("commit"); }
    catch { await client.query("rollback"); throw Error("BOOTSTRAP_STAGE_FAILED"); }
    console.log("AUTONOMOUS_SCHEMA_STAGED");
  } else {
    const receipt = await registerAutonomousCrmAccess(client, manifest.assignment);
    console.log(JSON.stringify(receipt));
  }
} catch {
  console.error("AUTONOMOUS_BOOTSTRAP_FAILED");
  process.exitCode = 1;
} finally { await client.end(); }
```

Invoke with `node --conditions=react-server --import tsx .npm-cache/qa/register-approved-access.mts <public-manifest.json>`
from the exact CRM checkout. The public manifest has `phase`, exact `database`,
exact `registrar`, and for registration an `assignment` matching
`AutonomousCrmRegistration`. Its IDs must identify existing approved internal
actors, explicit project permissions and a real allowed source; it contains only
the Ed25519 public SPKI key, never the private key or connection secret. One
fixed workload registration per approved source profile is retained. Revocation and replacement follow the
owner-only lifecycle above; normal runtime never calls this driver.

On Evelyn, compose the reviewed `createRegisteredCrmDepartmentConnector` from
client revision `84a08c82beff329ae8cc6f5e8891b49a1ae3bc04`. The protected host must
supply `resolveGrant` from its approved immutable assignment, `resolveSigningKey`
from protected Ed25519 custody, and fresh OIDC tokens through the existing token
provider. Keep the fixed CRM origin/path and source issuer/team/project/subject
pins. Map Task reads/writes to `Read`/`UpdateTask`; Project permits `Read` only.
The host assignment's finite `expiresAt` is a renewable observation lease,
separate from the durable server authorization; its refresh must not add scope
or require a personal session. Persist `UNKNOWN` pending operations and resume
the original complete command body with fresh transport credentials.

These host bindings, actual signing custody, real registrations, exact hosted
deployment, native review/CI and remaining target gates are open. No arbitrary
department-wide business-entity access or new financial/legal authority is added.

### Separate native personal source (source implementation; inactive)

Registration alone could not authorize the real `franz-personal` caller through
the former production-only verifier and SQL bundle. The additive personal source
now exists exclusively in the real delegated gateway; the original
`crm-machine-auth.ts`, synthetic callers and original staged SQL remain byte-identical.
The personal verifier requires both global `CRM_MACHINE_AUTH_ENABLED=1` and
server flag `CRM_AUTONOMOUS_PERSONAL_SOURCE_ENABLED=1` on the production CRM target.
Missing/disabled global switch blocks every machine source before JWT verification;
missing native flag denies the personal source. The fixed
profile is:

| Field | Exact value |
| --- | --- |
| issuer | `https://oidc.vercel.com/novalure` |
| audience | `urn:novalure:crm:production` |
| owner | `team_sjD78IkSicXJK6TAOR1JC7Wv` |
| project | `prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I` |
| subject | `owner:novalure:project:evelyn:environment:franz-personal` |
| environment | `franz-personal` |
| custom environment | `env_sue274zKgFxQJiKfw64x7BmEfEwE` |
| real identity | `EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY` |
| internal workspace | `8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101` |

RSA signature, issuer/audience, complete native bundle, UUIDv4 JTI, current expiry,
not-before and issued-at freshness (at most five minutes) are checked. A fresh
transport token does not authorize any resource without the separate registered
grant and Ed25519 key. Source audit retains `environment: franz-personal`.

After the original staged schema, run the driver's `upgrade-personal` phase once
against the exact gated target as the same designated non-runtime schema owner.
The separate upgrade adds the native custom-environment column and one complete
two-profile CHECK, preserves UNIQUE identity and fixed issuer/owner/project pins,
retains the old seven-argument authenticator as production-only, and adds a narrow
eight-argument native authenticator. Only its EXECUTE permission is granted to the
existing tenant runtime; no registry write, role, principal, grant or key is seeded.
The current grant-lock function accepts only the complete registered production
or native bundle and preserves all member/project/lifetime locks.

The registrar's optional `sourceProfile: "FRANZ_PERSONAL"` selects only the fixed
native constants; omission/`PRODUCTION` preserves the old profile. Use a separate
workload ID and grant/public-key registration with the actual existing A1 task,
department, agent, internal actor and explicit project/resource permission.
Readback compares the complete saved source bundle, so an existing production
workload cannot be reinterpreted as personal. The normal native caller already
requests fresh OIDC through its real host; it must not impersonate production.

Local author evidence: one targeted composite case passed using actual RSA JWT
bytes and disposable PostgreSQL: production registration before/after the staged
upgrade, personal default-off/unregistered denial, own Describe/Read/Update/replay,
native audit attribution, invalid signature/claims, cross-profile grant/key denial,
seven-argument native denial, runtime registry isolation and revocation. Global
machine switch absent/disabled denies before any JWT verifier is called. CRM
strict typecheck and affected lint passed.
The composite runs in `scripts/crm-autonomous-personal-source-tests.ts` with its
own disposable fixture. The old access test module is byte-identical to `c7121ce`;
its registration/event/version assumptions cannot be changed by this new fixture.
The existing `test:crm-autonomous-access` command composes both modules normally.
Its final ordinary invocation passed 18/18, zero skipped: 17 unchanged access
groups plus the isolated native case. This one affected-module composition run
was required after independent review caught shared fixture interference; no
unrelated regression suite was run. Earlier client/History evidence retains its
original scope and is not a fresh hosted or production check.

No actual target upgrade, native flag, registration, key custody, source deployment,
provider/SSO role or production gate was activated by this implementation. These
remain exact-target activation steps after independent review and applicable gates.

## Department and module successor — 26 November 2026

This successor starts from the observed deployed source
`dea8c63c3b299918c423dbb62b754cc5e5e39ced`, preserving its property/HEIC release.
It selectively reuses the reviewed delegation and personal-source implementation;
it does not import the unrelated 152-commit release divergence. The preceding
sections retain their historical revision and evidence scope.

`crm-autonomous-access-v2` uses the same fixed endpoint and six-field command
envelope. No command selects a tenant, actor, department, entity or record.
OIDC authenticates the exact production or separately enabled native personal
source. A registered Ed25519 signature binds the complete command, nonce and
short expiry to its exact assignment. No personal browser session or MFA is
required by the machine route, including execution of a previously approved
business command after the approving human has logged out.

The receiver intersects the canonical 16-department policy in
`config/crm-department-access-policy.json`, immutable server assignment, explicit
project permissions, field masks and normal CRM/RLS rules. The policy snapshot
is copied byte-for-byte from Evelyn policy version
`crm-department-access-2026-11-26.1`; SHA256 is
`d1d5d07d4ddfbb968c5af671ac1dae2c5bc2eca909f348f38f9867ee3007931d`.
An individual department name confers no record authority. The protected registrar
rejects department/field combinations outside that policy. Runtime cannot create
or alter an assignment, choose an administrator role or provision its own key.

For V2, `BuyerLead` accepts only `Käufer`; `Qualification` accepts `Käufer` and
`Investor`, matching its delegated native qualification command. Existing typed
sources must be registered with `registerAutonomousCrmAccessFromOperator` on a
dedicated idle connection authenticated as the actual original `leads` owner.
It owns one transaction, SHARE-locks the exact source/workspace/project/internal
classification and purpose, then uses `SET LOCAL ROLE` for the actual protected
registry owner. The metadata-only registration entry rejects these existing
sources; it accepts no caller-supplied source proof. No new SQL helper, table
grant or role membership is installed. Current runtime predicates recheck the
type for reads, descriptions, updates and receipt readback after later type drift.
New BuyerLead records still use the fixed `Käufer` creation default. Service-v1
keeps its separate existing contract.
The operator needs existing `SET` authority for that actual registry owner;
`INHERIT true / SET false` alone is insufficient. The wrapper checks the real
permission and rolls back with `AUTONOMOUS_REGISTRAR_ROLE_UNAVAILABLE` otherwise.
It never adds membership or relaxes the non-BYPASS owner check. The audited
native SET-false baseline needs the existing Root operator's separately admitted,
temporary SET lease on its own membership edge, followed by exact restoration.
That lease stays outside this wrapper and must be bound to the actual native
registration plan. Local composition tests do not establish that admission.

All 15 existing CRM entity kinds have minimized assigned-record reads. Named
metadata commands cover contacts, companies/developers, project descriptions,
unit descriptions, lead provenance, tasks, internal calendar entries and timeline
summaries. Creation uses an explicitly registered new UUID and parent project.
Contact role and company type require supplied values; no opt-in is generated.
Unit creation requires supplied dimensions and creates a blocked draft with no
confirmed availability or price. Unconfirmed native price placeholders project as
null. Connected calendar retiming requires its existing provider reconciliation
path; generic internal updates cannot silently desynchronize it. Communications
record internal timeline notes and never send a provider message.

Qualification, viewing retiming, offer preparation, reservation requests and
guarded confirmations reuse the existing native CRM validators, repositories,
commercial authority checks and command transactions. The registrar's saved
related-resource IDs are a closed ceiling: native preparation checks current
deal/contact/lead/organization associations and refuses drift. Preparing an offer
does not implicitly create a new organization. Generic metadata commands cannot
change prices, unit availability, owner rights, consent or final commercial state.

Subagents require `delegationKind: SUBAGENT` and a real `parentGrantId`. The SQL
receiver locks the complete bounded ancestor chain in a total order, checks every
ancestor's current expiry/revocation/workload/project rights, and enforces the same
resource/mission/department plus subset scopes and fields. Parent revocation is
therefore enforced in the child's effect transaction, including the race after a
successful parent description. Description returns that authenticated lineage.

Business decisions use a separate human cookie/CSRF route and independently
reload the configured owner's real identity, active membership, session and fresh
persisted MFA. Immutable decisions bind exact grant, project, source, full command
hash, versions, expiry and idempotency. Reservation and sale confirmation retain
the native project mandate. Offer queueing additionally retains native exact
offer approval and consent and requires a separately recorded
`OWNER_QUALITY_ATTESTATION` for the same offer revision/content digest. That label
means explicit human quality attestation, not independent automated QA.
Agents cannot issue any of these decisions. Consumption, native effect, audit and
receipts share one transaction; a failed native command rolls consumption back.
Exact replay revalidates current grant, owner and revocation before disclosure.
Unknown-outcome recovery is receipt-only: the exact original command is signed
under `crm-autonomous-access-v2-reconcile.POST./api/integrations/evelyn/access`
and sent with `x-evelyn-reconcile-only: 1`. A missing receipt returns HTTP 404 /
`RECEIPT_NOT_FOUND` without creating a command or consuming business authority.
Changing or removing that mode invalidates the signature. Native preparation
also has an outer v2 receipt and a distinct inner native idempotency key.
The native offer operation queues its existing manual-attestation delivery path;
it does not claim that an email or contract was delivered.

Activation remains manual and target-gated. Apply, exactly once and transactionally,
`evelyn_autonomous_access.sql`, `evelyn_autonomous_personal_source.sql`,
`evelyn_autonomous_modules.sql`, then `evelyn_autonomous_business_authority.sql`.
The non-runtime schema owner must already own the affected metadata/business
tables and possess the narrowly documented authentication-metadata row-lock/read
rights. No stage grants those authentication rights to application runtime.
Stages seed no workload, assignment, signing key, human decision or business data.
Do not add these stages to the historical numbered migration runner.

Local synthetic acceptance includes real restricted PostgreSQL, Ed25519 signatures,
all department bindings, all entity projections, bounded native mutations,
commercial decisions/QC, concurrent confirmations, lost-response receipt recovery
and the actual compiled Evelyn client with RSA-JWT verification. The normal test
entry is `npm run test:crm-autonomous-access`; the separately invoked paired proof
requires `CRM_PAIRED_EVELYN_MODULE` and its exact `CRM_PAIRED_EVELYN_REVISION` and
runs `scripts/crm-autonomous-paired-client-tests.mts`. These are local integration
results. Live provider identity, protected key custody, real registrations,
deployment, post-deployment readback and all eight exact-target production gates
must be evidenced separately before claiming production completion.
