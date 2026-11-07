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

`npm run test:crm-autonomous-access` executes the 13 new groups. The final local
run of these groups together with the unchanged five legacy machine-auth groups
passed 18/18 with no skips. CI runs legacy authentication in its existing sales
suite and adds only the new groups. The new groups use the
real handler, Ed25519 signatures and a disposable PostgreSQL database with a
separate non-superuser, non-BYPASSRLS bootstrap owner. They cover all departments,
missing registration, wrong keys/actor selectors, private/foreign resources,
project revocation, expired grants, four actual lock-wait expiry cases, concurrent
and idempotent writes, immutable audit attribution and rejected owner metadata
mutation. The extra metadata FORCE-RLS probe includes strict tenant/actor fixture
views and is local evidence.

The paired local acceptance used the actual compiled Evelyn connector at
`c8fad7ea3b5f943cef25af285d3c1e06e81c4b46`, this real CRM handler and PostgreSQL.
It confirmed a read, a committed write with a lost response, recovery of its
original receipt and denial after grant revocation. The ignored local acceptance
driver is `.npm-cache/qa/paired-autonomous-access-tests.mts`. Its 14 groups include
the 13 new CRM groups and one cross-repository acceptance group.

No real workload/grant registration, key custody, actual provider token call or
deployment is evidenced by these local results. The active release coordinator
must integrate this small successor delta, obtain exact native CI and independent
App review, and close the existing eight gates for the same revision/target.
Then the protected host can apply the staged SQL, register approved real-internal
assignments and verify the exact login-free runtime with scoped audit evidence.
