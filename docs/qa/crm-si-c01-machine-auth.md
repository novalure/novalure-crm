# CRM-SI-C01 — Evelyn CRM Production machine authentication

## Decision and boundary

The CRM contract endpoint now has two deliberately separate authentication modes:

- `simulation`: the existing hashed `qa-crm-v1` credential, synthetic QA workspace gate and pre-registered audit binding remain unchanged.
- `PRODUCTION`: a short-lived asymmetric OIDC/JWKS JWT is accepted only when the explicit Production enablement flag, exact issuer, exact audience and every registry/policy gate pass.

The Production mode does not consume a human cookie, refresh token, MFA session or trusted development identity header. Human login, MFA and CSRF behavior are unchanged. A JWT presented to a human route is rejected as a human session.

## Exact Production contract

Endpoint: `POST /api/crm/contract/v1`

Authentication: `Authorization: Bearer <signed workload JWT>`. No cookie and no browser `Origin` header are accepted. Tokens use ES256 or RS256, have an exact configured issuer and audience, contain `iat`, `exp` and `jti`, and may live for at most 300 seconds.

Required private claims:

- `service_identity_id = EVELYN_CRM_SERVICE_IDENTITY`
- `consumer = EVELYN`
- `tenant_id = workspace_id = 11111111-1111-4111-8111-111111111111`
- `environment = PRODUCTION`
- `role = Evelyn.Service`
- explicit `capabilities`

The only Production resource alias in this contract is `EVELYN_INTERNAL_CANARY_SYNTHETIC`. It resolves through a persisted tenant/project/resource binding. Production requests are restricted to `Contact` `Read` and a single-field, CAS-bound synthetic `Update`; unsupported Proposal, Contract, Sale, approval and identity/permission operations fail before business execution.

## Registry, revocation and rotation

Migration 088 extends the existing `crm_service_principals` registry instead of creating a parallel identity system. Production entries store identity/subject, workspace, consumer, environment, role, authentication type, issuer, audience, capability set, credential reference, state, validity, accepted key IDs, credential version, overlap and last verification time. They store no token, private key or raw secret.

Authentication requires registry state `ACTIVE`, an unrevoked/unexpired entry, active non-Owner service membership, exact key ID and a token capability set contained by the registry set. `REVOKED`, `EXPIRED` and `DISABLED` fail closed. Rotation supports up to four accepted key IDs during a bounded external overlap; remove the old key ID after verification.

## RLS, audit and stops

The service actor remains an `agent`/`project_sales_member` RLS anchor solely because the current CRM database policies require a persisted actor UUID. The machine authorization role is separately and exactly `Evelyn.Service`; it is not Owner/Admin and cannot change its own registry. The tenant runtime role is checked as non-superuser and `NOBYPASSRLS` on every transaction.

Every successful Production machine operation appends `crm_service_audit_events` with `actor_type = SERVICE_IDENTITY`, identity, service role, consumer, environment, tenant, correlation ID, action, object, JTI hash, outcome and timestamp. Writes also mark the existing CRM audit/domain event actor metadata as `SERVICE_IDENTITY`; they are never labeled as a human or as Franz.

Valid authentication never overrides active `GLOBAL`, `CRM`, `TENANT` or `ACTION` kill switches. Missing/invalid claims, missing resource/project authority and missing runtime context default to deny.

## A3 and D11

Machine authorization grants no Proposal or Contract Owner approval capability. Production parsing exposes neither final Proposal A3 nor Contract A3 operations. Migration 087 Owner triggers and authority digests remain unchanged. CRM remains source of truth, resource/project/division scoping stays in the existing transaction path, and no shadow CRM is introduced.

The implementation is based on U1-C03 SHA `16ea5699da208f0a6208b0dfa923c46a99cad4cd`. It does not modify recovered Property modules, migration 087 Expand/Backfill/Contract/Rollback files or build metadata. Convergence order is: resolve and merge U1-C03, rebase this branch without rewriting migration 087, run exact-SHA CI/Preview, then perform W02. D11 and D27 are not closed until the live Production proof is archived.

- D11 repository status: `ADVANCED / MACHINE_AUTH_IMPLEMENTED_AWAITING_LIVE_BOOTSTRAP`; source-of-truth, RLS, division and Owner-A3 contracts remain intact.
- D27 repository status: `ADVANCED / OIDC_JWKS_RUNTIME_MODEL_IMPLEMENTED_AWAITING_PROVIDER_BOOTSTRAP`; provider identity, public keys and Production configuration are intentionally external.

## Repository verification

`scripts/crm-machine-auth-tests.ts` verifies signatures and claim negatives, no-auth/cookie denial, Production canary read/write, A3 denial, audit attribution, registry revocation, key rotation overlap, all kill-switch levels and PostgreSQL NOBYPASSRLS/no-context behavior. The pre-existing QA service contract suite remains a regression gate.
