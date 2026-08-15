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
internal/admin product-role set. First privileged login creates a ten-minute
TOTP enrollment challenge. Pending TOTP and recovery values are AES-GCM
encrypted only until confirmation; they are scrubbed on use, cancellation,
attempt exhaustion or expiry cleanup.

After confirmation, the TOTP secret remains encrypted and each recovery code is
stored only as a keyed 64-character hash. Recovery-code consumption locks both
the challenge and code row so concurrent attempts yield one successful session
and one code can never be reused. TOTP and enrollment challenges are also
atomically one-time.

The deliberately unresolved product gate is recovery administration: there is
no specification yet for support-assisted factor reset, re-enrollment approval,
fresh recovery-code display, step-up duration or lost-device identity proofing.
The server therefore exposes no unsafe disable/bypass endpoint. A user who loses
both TOTP and all recovery codes requires the approved recovery product and
operations flow before access can be restored.

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
