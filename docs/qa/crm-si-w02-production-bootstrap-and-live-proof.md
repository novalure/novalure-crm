# CRM-SI-W02 — Production bootstrap and live proof

Run this package only after the exact CRM-SI-C01 commit has green CI, an approved SHA-bound Preview, migration 088 is approved for Production, and its U1-C03 parent has converged. Do not promote or merge merely because this document exists.

## 1. Create the external workload identity

Create exactly `EVELYN_CRM_SERVICE_IDENTITY` in the approved workload identity provider. Use asymmetric signing with ES256 or RS256 and published HTTPS JWKS. Do not create a password, human login, browser session, refresh token or Owner/Admin account.

Configure token claims exactly as documented in `config/evelyn-crm-service-identity.json`. Token TTL must be at most 300 seconds. Preserve a unique `jti` and an attributable external issuance log.

Franz is needed only if the identity provider or Production database requires a one-time Owner-authorized administrative registration. Franz must not supply a recurring cookie, MFA approval, refresh token or personal credential to the runtime.

## 2. Bind value-free Production configuration

Configure names/scopes without copying values into tickets, logs or the repository:

- `CRM_SERVICE_IDENTITY_ISSUER`: Production only; exact workload issuer.
- `CRM_SERVICE_IDENTITY_AUDIENCE`: Production only; exact CRM audience.
- `CRM_SERVICE_IDENTITY_JWKS_URL`: Production only; HTTPS public-key set.
- `EVELYN_CRM_SERVICE_CREDENTIAL_REFERENCE`: Production only; provider reference, not key material.
- `CRM_SERVICE_IDENTITY_PRODUCTION_ENABLED`: leave disabled until registry/migration checks pass; enable explicitly for the proof window.

The Production database connection must remain the non-owner tenant runtime role. Confirm `rolsuper = false`, `rolbypassrls = false`, `rolcreaterole = false` before enabling.

## 3. Register the CRM identity and canary

Through the approved administrative migration/bootstrap channel, insert one `crm_service_principals` entry with:

- identity/consumer/environment/role: `EVELYN_CRM_SERVICE_IDENTITY` / `EVELYN` / `PRODUCTION` / `Evelyn.Service`
- workspace and tenant alias: `11111111-1111-4111-8111-111111111111`
- auth type: `OIDC_JWKS`; no `token_hash`
- exact subject, issuer, audience, public key ID and secret reference from the provider registration
- capabilities initially limited to `crm.contacts.read`; add `crm.contacts.write` only for the optional bounded write proof
- state `ACTIVE`, explicit validity, credential version 1 and no revocation timestamp
- a dedicated active non-Owner RLS actor and explicit project read grant

Bind `EVELYN_INTERNAL_CANARY_SYNTHETIC` to one internal synthetic Contact in that workspace/project. Its name must be visibly synthetic and contain no real customer, personal, credential or canary-secret data. No other Production resource alias is accepted by the contract.

## 4. Enable and prove

Enable `CRM_SERVICE_IDENTITY_PRODUCTION_ENABLED` for the controlled proof, obtain a fresh workload token, and call `POST /api/crm/contract/v1` without cookies. Archive value-redacted evidence for:

1. successful `Read` of `EVELYN_INTERNAL_CANARY_SYNTHETIC`;
2. a different workspace/tenant claim denied;
3. missing auth, malformed token and expired token denied;
4. an Owner/Proposal A3 operation denied;
5. a Contract A3 operation denied;
6. `crm_service_audit_events` shows `SERVICE_IDENTITY`, identity, role, workspace, environment, correlation, action/object and JTI hash, and does not show Franz/HUMAN;
7. each GLOBAL, CRM, TENANT and ACTION stop blocks the otherwise valid request, then is restored to its prior state;
8. registry state `REVOKED` blocks a fresh valid token, followed by an approved restoration or replacement identity;
9. the tenant runtime role remains NOBYPASSRLS and wrong/no tenant context returns no canary data.

Optional synthetic write: temporarily add `crm.contacts.write`, submit one CAS-bound `SYNTHETIC:` name update, verify both service and CRM command audit rows, then restore the original synthetic value and remove the write capability. Never touch real customer data.

## 5. Rotation proof

Publish a new provider key, add its key ID to `accepted_key_ids`, increment `credential_version`, record `rotation_overlap_until`, and prove both old and new short-lived tokens during the controlled overlap. Cut over issuance, remove the old key ID, revoke the old provider key and prove the old token/key is denied. No private key is exported.

## 6. Evidence and status

Record exact application Git SHA, deployment ID, migration ledger checksum, provider identity ID, non-secret key IDs, timestamps and redacted request/result/audit references. Do not record bearer tokens or environment values.

Only after all proofs pass may the status advance from `ADVANCED / MACHINE_AUTH_IMPLEMENTED_AWAITING_LIVE_BOOTSTRAP`. D11 and D27 remain open until their separate acceptance criteria and Production evidence are complete.
