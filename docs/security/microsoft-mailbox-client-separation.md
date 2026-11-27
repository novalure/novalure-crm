# Separate Microsoft mailbox client

Verified Microsoft preview authorization and code exchange require the
request's HTTPS origin to equal the configured callback origin. This catches a
preview opened at one host while inheriting a different production origin;
configure the intended preview origin and its exact registered callback before
consent. A mismatch stops before client authentication or token exchange. An
already consumed state may require starting again. This comparison depends on
request URL and host configuration; it does not attest the Vercel project,
deployment, branch, Entra app, database isolation or ownership of an origin.
The configured origin and callback still need independent target verification.

The mailbox may use a separate Microsoft Entra application from the calendar.
Configure `MICROSOFT_MAILBOX_CLIENT_ID` and `MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD`
for the mailbox. In `client-secret` mode also configure
`MICROSOFT_MAILBOX_CLIENT_SECRET`; in `vercel-oidc` mode use a narrowly scoped
federated trust for the intended Vercel project and environment instead. These
are server-only settings. Do not put credentials or tokens in the repository.

When any mailbox-specific setting exists, the mailbox uses only the mailbox
client settings. Incomplete mailbox configuration fails closed: the calendar
client secret or client ID is not used to fill missing mailbox settings. With
no mailbox-specific setting or identity mode, shared-client mailbox access is
disabled unless the deployment explicitly configures
`MICROSOFT_MAILBOX_ALLOW_LEGACY=1`. The existing calendar configuration is
unaffected; Google mailbox authorization is unaffected.

A dedicated Microsoft mailbox setting selects the verified identity path.
`MICROSOFT_MAILBOX_IDENTITY_MODE=verified-preview` selects Vercel Preview.
The production candidate adds an explicit `verified-production` mode. It
requires the CRM Vercel project and production target, the exact canonical
HTTPS CRM origin, the dedicated federated Entra application and an explicit
`MICROSOFT_MAILBOX_PRODUCTION_RELEASE_SHA` matching the CRM build's revision.
There is no secret-based production option in this mode. The environment and
build values guard against configuration drift. Independent deployment-source
and federation checks are still required before enabling the mode.
Missing, empty or unsupported identity mode fails closed, including
when only one dedicated setting exists; it does not fall back to the shared
calendar client or silently start a legacy mailbox connection. The verified
path also requires a complete dedicated client configuration: removing all of
its keys while retaining the verified mode cannot select the calendar client.
When a calendar client ID is configured, it must differ from the dedicated
mailbox client ID, with case and surrounding whitespace ignored. These checks
do not prove the Microsoft registration, federated trust or actual provider
permissions; those remain independently verified deployment gates. The modes
require `VERCEL=1` and a matching `VERCEL_ENV`, but those environment values are
configuration signals, not independent proof of the host or deployment identity.
Verified
authorization requires the state-bound nonce and a verified refresh requires the
specific tenant, not `common`. Existing legacy connections are not converted or
deleted: when a dedicated client is introduced they cannot sync under incomplete
configuration or be silently promoted to a verified identity. **A personal
reconnection alone is not yet an established recovery path for an existing
legacy row**: the current account-binding checks also reject a verified login
for that row after disconnect. Do not reassign historical private copies; a
separately reviewed reconciliation and actual database tests are needed.

The legacy exception is deployment-wide, not per user or workspace. It may
only be set deliberately for an inventoried legacy deployment, never inferred
from existing calendar credentials. Values other than absent, `0`, or `1` fail
closed. `1` cannot coexist with any dedicated mailbox key or any verified
identity mode; a contradictory configuration fails closed. Without `1`, losing
all dedicated mailbox keys and the identity-mode key now disables Microsoft
mailbox authorization, rather than selecting legacy. It does not set an
exception for any existing deployment automatically.

Before enabling this release on any target, inventory its existing mailbox
connections and approved configuration. Deploying without an explicit legacy
exception will prevent existing shared-client Microsoft mailboxes from starting,
reconnecting or syncing; it does not delete their data. A scoped, reviewed
legacy configuration and rollback plan are required where compatibility is
actually needed. Remove the exception as part of a separately checked transition
before enabling a dedicated app; setting both fails closed.

One read-only target observation on 2026-11-25 found zero rows when grouping
`crm_mailbox_connections` by provider and status in production project
`misty-cloud-70835427`, branch `br-spring-night-alyu48yp`, database `neondb`;
the queried owner had `BYPASSRLS`. This observation supports the current target
inventory only. It does not establish the state of other databases, future
connections, other mailbox-related tables, or the readiness of any release.

This is a versioned code default plus environment configuration, not a protected
persistent tenant policy. An authorized configuration writer can set `1` and
remove the dedicated settings, and an old deployment or restored configuration
can still permit the previous fallback. Independent, durable policy and
deployment/restore/rollback enforcement are still required for production;
successful configuration or these local checks do not establish that boundary.

In verified-preview mode the initiating and completing requests must use the
same personally authenticated cookie session. The stored OAuth-state digest is
keyed and binds that state to workspace, user, authenticated identity and
session identifiers. The provider-facing state is signed but not encrypted:
it already contains the workspace and user identifiers. The authenticated
identity and session identifiers are not added to that state. `withCrmRead`
must still revalidate and lock the persisted session;
the cookie-session shape alone is not authentication. A changed, rotated,
revoked or expired session requires starting the connection again. Likewise an
in-flight verified-preview flow started before this binding was deployed must
be restarted; already stored connections are not converted or deleted. The
legacy shared-client and Google flows retain their previous state format.
During a mixed-version rollout an old instance can still start and complete
an unbound verified-preview flow; do not enable the protected mode until all
instances handling the flow run the reviewed revision. New instances reject
previously created unbound verified-preview state rather than consuming it.
State signatures use the existing timing-safe signature comparison. PostgreSQL
state-hash lookup is not claimed to be a constant-time database operation.
After the token exchange, the session is checked again before signing-key
verification, and after verification before mailbox-metadata requests. Calls
already in flight when a session is revoked cannot be assumed cancellable,
and revocation can race after a transaction ends.
The subsequent database operation revalidates the session before saving.
The existing session-lock function uses transaction-start `now()` for expiry;
a lock wait past expiry is not covered by a wall-clock recheck. For the verified
Microsoft flow, OAuth-state consumption now locks the scoped state row first,
then checks both the persisted and signed expiration against the database wall
clock before marking it consumed. Real PostgreSQL lock-wait, concurrent replay,
rollback and restricted-role tests have not yet established that behavior.
Google and the explicitly enabled legacy flow retain their previous state
expiry behavior. The synthetic tests do not prove database-role/RLS isolation,
cookie handling, real Microsoft behavior or production readiness.

The mailbox application should request only the delegated permissions required
for the personal, read-only mailbox flow. Creating an application or declaring
permissions does not grant access: each user's consent and provider policies
still apply. A different client ID cannot refresh tokens issued to the previous
client. Changing clients requires reauthorization; safe reconciliation of
previously stored legacy connections remains an unresolved prerequisite.

Production enablement requires independently verified 170/182/212 database
lineage, the exact deployed source, the production callback registered for the
dedicated Entra app, and federation restricted to the CRM production project
and environment. Retest personal connection, token renewal, private inbox
handling and operational recovery before customer rollout. The production
release setting must be set for each reviewed build. The isolated test proves
authorization for its own temporary app and does not carry over its consent.
The production connection, save and sync paths additionally require the central
CRM Neon database and its restricted application role, enforced mailbox row
security, the validated identity constraint and an enabled identity trigger.
The server validates the pooled connection destination as well as each
database transaction that can authorize provider access or persist data from
that connection. It rejects connection-string overrides of PostgreSQL settings.
The runtime check identifies the expected catalog entries. Release validation
must still compare their definitions and the migration ledger. Recovery on a
different branch needs a reviewed target change before mailbox access resumes.

The installed Vercel OIDC SDK reports HTTP exchange failures as unstructured
errors and exposes no response status or per-call cancellation parameter. In a
synthetic test, responses with the same error text at HTTP 401 and HTTP 503 are
indistinguishable to this integration. The conservative path therefore treats
both as configuration-class failures, which can incorrectly show a personal
reconnection request during a provider outage. It does not infer status from an
untrusted message. A future separately reviewed transport or SDK with structured
status is needed to classify those provider failures accurately. Explicit
timeouts and recognized network causes use the temporary-unavailability path;
the deadline does not prove that an underlying SDK request was cancelled.
The client-auth helper is also used by Microsoft calendar features, so its
eight-second deadline and typed errors affect those callers as well. Synthetic
unit checks do not establish working calendar authorization, event operations,
or production compatibility; those shared flows still require their own
integration and rollout verification.
