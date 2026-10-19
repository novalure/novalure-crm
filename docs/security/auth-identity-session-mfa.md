# Central authentication identity, sessions, reset and MFA

This document describes the P2-04 security contract introduced by migration
`056_auth_identity_sessions_mfa.sql`. The migration is additive and must be
reviewed and applied through the normal migration ledger; application code does
not apply it automatically.

## Required production configuration

Production startup calls `assertAuthSecurityConfiguration()` and fails closed
unless each value contains at least 32 characters:

- `NOVALURE_SESSION_SECRET` — existing CSRF signing secret with domain separation.
- `NOVALURE_AUTH_ENCRYPTION_KEY` — AES-256-GCM key material for pending enrollment and active TOTP secrets.
- `NOVALURE_AUTH_RATE_LIMIT_SECRET` — HMAC key for low-entropy rate-limit subjects and recovery-code hashes.

`DATABASE_URL` (or the existing supported Postgres aliases) remains mandatory
for login. `NOVALURE_TRUST_AUTH_HEADERS=1` is ignored in every production
runtime, including non-Vercel `NODE_ENV=production` starts.

Client IPs are accepted only from Vercel's `x-vercel-forwarded-for`, or outside
Vercel from the exact header named by `NOVALURE_TRUSTED_CLIENT_IP_HEADER` when a
trusted reverse proxy overwrites that header. Generic `x-forwarded-for`,
`x-real-ip` and `cf-connecting-ip` values are ignored. Without a trusted source,
the IP limiter intentionally collapses into one fail-closed opaque
`unavailable` bucket while the independent normalized-email bucket remains
active.

Secret rotation is intentionally not guessed by the application. Rotating the
encryption key makes existing encrypted TOTP secrets unreadable; a staged
key-ring/reencryption runbook is therefore a product and operations gate before
rotation. Rate-limit-secret rotation invalidates unused recovery-code hashes.

## Migration behavior

One `auth_identities` row is created per normalized email, and every
`workspace_users` membership references it. The backfill never chooses the
oldest membership:

- one distinct existing password hash becomes the central credential;
- no password becomes `reset_required`;
- conflicting password hashes become `reset_required` rather than selecting an
  arbitrary workspace password;
- an empty email or a case-insensitive duplicate inside one workspace aborts
  the migration for explicit data repair.

The legacy membership password column remains as a compatibility mirror during
the transition. Authentication reads only the central credential.

## Login and sessions

Login always queries the central identity and performs a real scrypt operation
for both known and unknown identities. Distributed Postgres buckets protect the
normalized-email and IP dimensions with progressive, capped backoff. Success
clears only the corresponding login buckets.

An identity with several active memberships receives an opaque, one-time
workspace-selection challenge. No membership is selected by creation order.
The selected membership is stored in a random opaque session:

- the browser receives `v2.<32 random bytes>`;
- Postgres stores only SHA-256 `token_hash` plus `created_at`, `last_seen_at`,
  `expires_at`, `revoked_at` and the selected identity/membership;
- active membership, active identity, expiry, revocation and MFA assurance are
  checked on every request;
- `GET /api/auth/session` is strictly read-only; the CRM mount uses a
  one-time-CSRF-protected `POST` to update `last_seen_at` or atomically rotate
  sessions older than 30 minutes without extending their absolute eight-hour
  expiry;
- logout revokes the server row before clearing the cookie;
- password reset revokes all identity sessions, password change revokes other
  sessions and rotates the current session, and every admin status, role or
  product-role change atomically revokes all sessions for the affected
  membership, including changes that keep the membership active.

## Privileged MFA

MFA is required for technical `owner`/`admin` memberships and the current
internal/admin product-role set. An already enrolled identity must also complete
MFA for its ordinary memberships; changing workspace or role does not bypass its
factor. First privileged login creates a ten-minute
TOTP enrollment challenge. Pending TOTP and recovery values are AES-GCM
encrypted only until confirmation; they are scrubbed on use, cancellation,
attempt exhaustion or expiry cleanup.

After confirmation, the TOTP secret remains encrypted and each recovery code is
stored only as a keyed 64-character hash. Recovery-code consumption locks both
the challenge and code row so concurrent attempts yield one successful session
and one code can never be reused. TOTP and enrollment challenges are also
atomically one-time. Migration `106_auth_mfa_hardening.sql` additionally persists
the last accepted TOTP counter on the identity. Verification accepts six digits
with a 30-second step and at most one adjacent step of clock drift, and atomically
requires a counter newer than the last accepted counter across all challenges.
Enrollment records its confirming counter too. Another login during that step
must use the next authenticator code or an unused recovery code.

Independent email/IP MFA buckets survive successful password checks and newly
issued challenges. The invoker function `reserve_mfa_rate_limit_attempt` locks
both buckets, admits five initial attempts, then schedules progressive backoff
from one second up to one hour. A denied retry does not extend the deadline;
after it expires, another attempt can proceed. Successful MFA clears its own
buckets. The existing per-challenge five-attempt budget remains in force.

Challenges and sessions retain the exact password version originally proved.
Issuance, challenge consumption and every session read/touch/rotation compare it
to the current identity, including after a concurrent password reset. Reset and
password change invalidate pending challenges and scrub enrollment payloads;
password change refreshes only the retained current session's version before its
normal rotation. Enrolling MFA revokes existing unverified sessions and cancels
other pending enrollments.

The enrollment UI displays a locally generated QR code for the existing TOTP
provisioning URI by default. The server-only QR encoder returns an inline PNG
with a four-module quiet zone, standard black/white contrast and medium error
correction. No external QR or image service receives provisioning secrets.
The manual key remains available behind the translated setup-key disclosure,
with a clipboard button and selectable fallback when clipboard access fails.
QR generation failure opens manual setup automatically. Both paths use the same
six-digit confirmation and existing MFA security checks. The shared enrollment
component is intended for reuse by the future tenant customer portal under the
[binding CRM authentication masterplan](../masterplan/crm-authentication.md).

The deliberately unresolved product gate is recovery administration: there is
no specification yet for support-assisted factor reset, re-enrollment approval,
fresh recovery-code display, step-up duration or lost-device identity proofing.
The server therefore exposes no unsafe disable/bypass endpoint. A user who loses
both TOTP and all recovery codes requires the approved recovery product and
operations flow before access can be restored.

## MFA update integration (2026-10-19)

The isolated `codex/evelyn-crm-mfa-update` branch starts from verified CRM main
`5741a591f186e766750ecb8977972ec9b37e133a`. The open staff-login PR #77 overlaps
the login page and requires normal manual conflict review; its navigation/copy
changes are not imported. Design C, Knowledge Center and Studio branches are not
modified or merged. Migration number 106 avoids their already reserved 097–105;
recheck the ledger and competing branches immediately before integration.

Apply 106 through the existing checksummed migration process before enabling the
updated application, in a coordinated rollout. It adds MFA counter and password
version state, extends only the limiter scope constraint, and installs the MFA
limiter function. It preserves factor ciphertext, recovery hashes/usage, accounts,
roles, memberships and RLS. Current existing sessions/challenges receive their
matching password version; proofs older than the latest password change remain
invalid and require sign-in. No migration or user change was made in production.
Do not rotate the encryption or recovery-hash keys for this update.

Validation is local and synthetic: `npm run test:mfa` exercises the actual auth
functions against disposable PostgreSQL using a non-superuser runtime, unchanged
MFA migration SQL, independent TOTP generation, concurrent submissions and
deterministic pauses around real database queries for reset races. Its historical
bootstrap stops at 079, substitutes the optional pgvector column/index, and
excludes the historical manual media cutover; it does not claim full-schema or
production validation. The existing auth/CSRF/redirect tests, TypeScript, lint
and production build remain required. Live QA helpers use unused recovery codes
for rapid subsequent logins instead of replaying the enrollment TOTP.
The own-password regression calls the real function within a tenant transaction
for the existing audit RLS; it does not claim validation of the complete
settings/password HTTP route.

Changed files for this bounded update:

| Purpose | Files |
| --- | --- |
| TOTP and login challenge enforcement | `src/lib/auth/mfa-core.ts`, `src/lib/auth/mfa.ts`, `src/lib/auth/auth-flow.ts` |
| Durable MFA throttling | `src/lib/auth/rate-limit-core.ts`, `src/lib/auth/rate-limit.ts` |
| Session and credential-change binding | `src/lib/auth/session-store.ts`, `src/lib/auth/session.ts`, `src/lib/auth/password-reset.ts`, `src/lib/db/settings-access-repositories.ts` |
| Existing MFA form | `src/app/login/page.tsx` |
| Additive schema | `migrations/106_auth_mfa_hardening.sql` |
| Synthetic regressions and MFA QA compatibility | `scripts/mfa-security-tests.ts`, `scripts/auth-security-tests.mjs`, `scripts/qa-sales-browser.mjs`, `scripts/qa-livegang-api.mjs` |
| Test invocation, CI and documentation | `package.json`, `.github/workflows/livegang-e2e.yml`, `docs/security/auth-identity-session-mfa.md` |

The QR follow-up in the same PR additionally changes the dependency lockfile,
`src/lib/i18n.ts`, `src/components/mfa-enrollment-setup.tsx`,
`src/lib/auth/mfa-qr.ts`, `scripts/mfa-qr-tests.ts`,
`scripts/mfa-qr-browser-tests.mjs`, the CRM masterplan supplement and its README
link. `npm run test:mfa` includes independent PNG decoding of the exact existing
URI and retains all MFA security regressions. `npm run test:mfa:qr:browser`
exercises native browser enrollment through QR and manual keys, translations,
responsive display and clipboard handling with synthetic local accounts. This
does not claim a physical Microsoft/Google Authenticator device scan.

Lost-device support when both authenticator and recovery codes are unavailable,
support-assisted factor reset, disable and re-enrollment still need the approved
identity-proofing/operations specification described above. Password reset does
not remove MFA. This branch introduces no factor-reset or administrator bypass.

## Password reset privacy and replay resistance

Public reset requests always return the same confirmation, never retain the
email in the final URL and use the same distributed limiter for existent and
nonexistent identities. The email link carries the mail token only in its URL
fragment, which browsers do not send to the server or HTTP access logs. The
non-mutating, private `no-store` GET landing response has
`Referrer-Policy: no-referrer`, issues a short-lived signed form nonce and uses
a CSP-nonced inline bootstrap to read the fragment and call
`history.replaceState` before any subsequent request. Only the exact-Origin,
`Sec-Fetch-Site: same-origin` signed POST sends the token in its body,
atomically consumes it, sets a 15-minute HttpOnly exchange cookie and redirects
to `/login/reset-password?lang=…`; server logs, browser history, the final URL
and password form contain neither email nor reset token.

The reset form carries an HMAC bound to the exchange cookie and requires the
exact trusted Origin plus `Sec-Fetch-Site: same-origin`. Successful confirmation
atomically consumes the exchange, updates the central password, activates only
the invited membership associated with an invitation, invalidates all other
reset material, revokes sessions and appends the audit event.

## Audit and retention

Authentication events use the dedicated `auth_audit_events` table. It grants
the application insert/select only, and a database trigger rejects update or
delete. Events store opaque IDs, keyed IP hashes, user-agent hashes and bounded
non-secret metadata; raw passwords, cookies, reset tokens, MFA codes and email
addresses are excluded.

Expired sessions, challenges and limiter buckets need an operations-approved
retention job. Such a job must never mutate or delete `auth_audit_events` and is
not introduced here because retention periods are a product/legal decision.
