# External Integration Gateway

## Canonical boundary

Customer websites never receive database credentials. Browsers and customer systems call the CRM over HTTPS. The server resolves a publishable `nov_pk_…` site identifier through `external_integrations`, validates the exact origin and requested capability, applies abuse and replay controls, and derives workspace, project, form, and public actor context exclusively from the registry. Caller-supplied tenant, project, actor, or integration UUIDs are not routing inputs.

The database remains private behind the existing `novalure_app` runtime. That role must remain non-owner, non-superuser, without `BYPASSRLS`, and a member only of the constrained tenant runtime role required by the existing application. Migration 095 continues to enforce RLS and FORCE RLS on forms and submissions. Migration 096 adds FORCE RLS to all gateway tables and grants the runtime only the exact security-definer gateway functions plus the established tenant-scoped application permissions.

`novalure_public_form_lookup` is a historical migration artifact only. Migration 096 sets it to `NOLOGIN`, removes its password, revokes schema usage and old function execution, and the application no longer reads a dedicated lookup connection variable.

The remaining source references are intentionally classified: migration 095 and its QA document preserve audit history; the 095-only isolation fixture proves the historical boundary before 096; the Website Sales transaction fixture asserts the old environment variable is absent and the role is disabled after 096. Production runtime, environment manifests, Candidate QA, and credential bootstrap/reset scripts contain no dependency on that variable or login.

## Registry and capabilities

An integration maps one public site key to one workspace and optionally one project and form. Status is `test`, `active`, `disabled`, or `revoked`; mode is `training` or `real_customer`. Allowed origins are normalized exact origins. Capabilities are allowlisted and independently enforced:

- `form.read` and `form.submit`
- `chat.start` and `chat.message`
- `lead.create`
- `callback.request` and `appointment.request` for later narrow operations

Widget configuration is attached to the integration and cannot enable a capability the integration does not have. Onboarding creates the mapping and key server-side, begins in test/training mode, runs synthetic routing checks, and activates only after those checks pass. It never provisions a Neon role or password.

The Website Sales signed endpoint remains separate. Its fixed form exclusion, HMAC validation, transaction, idempotency receipt, recovery behavior, and KPI-safe synthetic handling are not routed through the generic browser gateway.

## Public operations

- `GET /api/public/integrations/forms` returns only the published form view and public widget configuration.
- `POST /api/public/integrations/forms/submissions` validates bounded JSON and configured fields, uses durable rate limits and idempotency, persists the form transaction, and returns only a public reference.
- `POST /api/public/integrations/chat/sessions` starts an idempotent scoped session.
- `POST /api/public/integrations/chat/messages` appends a replay-safe visitor message.
- `GET /api/public/integrations/chat/sessions` returns the authenticated session context and its bounded recent messages.

Training chat records are marked synthetic and have no lead, email, calendar, outreach, contract, offer, or other external effect. Real-customer chat effects require separately implemented narrow operations and their own capability and policy checks.

Legacy public form links are adapters over the new server-only functions. They preserve published URLs without restoring the retired login architecture. Unpublished forms and the Website Sales form remain excluded.

## Abuse, audit, and response policy

Origin, status, capability, form ownership, and active owner/admin checks fail closed. Public JSON is size bounded. Submission and chat writes require caller-stable idempotency keys. Public submissions and chat/read traffic use durable opaque-hash rate-limit buckets; raw IP addresses, tokens, and payloads are not stored in those buckets. Session tokens are returned once as scoped bearer material and only their SHA-256 hashes are stored.

Accepted, denied, duplicate, and failed requests emit structured logs with a correlation ID, operation, status, and latency but no site key, session token, personal identifier, tenant ID, database error, or SQL. Resolved operations also append tenant-scoped `external_integration_events` records. Platform alerts should cover elevated denials, rate limits, 5xx responses, latency, downstream failures, and unexpected cross-scope probes.

Public responses may contain public form fields, widget display configuration, a receipt, or a scoped chat session token. They never contain workspace IDs, internal project or actor IDs, database identity, topology, SQL, stack traces, or secrets.

## Future server-to-server credentials

Browser site keys are not authentication for privileged operations. A later backend credential may use a `nov_sk_…` value or signed token, but must be stored only as a one-way keyed hash, belong to exactly one integration, carry an explicit capability subset and expiry, support overlapping rotation and immediate revocation, and emit issuance/revocation/use audit events. No such credential may grant tenant administration or database access. V1 deliberately does not issue a server secret until a concrete backend operation needs it.

## Recovery and revocation

Disabling or revoking an integration makes resolution return no row. Revocation timestamps are constrained by status. Compromise of a public site key is handled by rotating the integration key and maintaining the origin/capability boundary; compromise of a chat token is bounded to its integration session and can be blocked by closing that session or revoking the integration.

Database recovery follows the approved snapshot/restore procedure and exact migration ledger checks. Application recovery rolls back to the last verified deployment only if its schema contract is compatible. RLS, FORCE RLS, and the disabled lookup role are never weakened as a recovery tactic.
