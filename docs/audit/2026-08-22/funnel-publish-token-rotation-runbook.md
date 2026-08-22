# Funnel publish-token rotation

Status: code-complete, no live rotation executed. The customer surface remains `LAUNCH-OFF` while the launch policy is unsigned.

## Runtime contract

- `POST /api/funnels/:funnelId/publish-token/rotate` is the future customer endpoint. It is RBAC/CSRF protected and currently fails closed through `funnelPublishTokenRotation`.
- `GET /api/admin/funnels/:funnelId/publish-token/cutover` returns only the current non-secret publication revision for the selected tenant.
- `POST /api/admin/funnels/:funnelId/publish-token/cutover` is the explicitly separate INTERNAL cutover. It requires a cookie-authenticated `platform_admin`, `funnels:write`, `funnels:publish`, `novalure:internal`, a one-time CSRF token and an `Idempotency-Key` header.
- The POST body is exactly `{ "expectedRevision": <integer> }`. Token fields and all additional fields are rejected.
- The new 256-bit token is returned only by the request that commits the rotation. A same-key replay returns the revision and `replayed: true`, never the token.
- The funnel row is locked `FOR UPDATE`. The expected revision makes concurrent different-key requests single-winner; the idempotency hash makes same-key requests replay-safe.
- Token replacement, revision increment and the secret-free audit event commit in one tenant transaction. The audit event stores only the before/after publication revision.
- Normal blueprint saves and restores lock the same funnel row in a tenant transaction and merge only client-managed tracking keys. They never create, copy or write `publishToken`, `publicToken`, `publicationRevision` or `publicationRotationRequestHash`.
- Authenticated blueprint GET/save/restore responses cross one explicit response allowlist. Server tracking, rotation hashes and publication tokens are not serializable through those endpoints.
- Live access reads the stored token. Rotation therefore invalidates the old link immediately after commit. Submission proofs are bound to the publication revision, so proofs issued through the old link are invalid immediately as well.
- Live submission persistence receives the verified publication revision and compares it while holding the funnel `FOR UPDATE` lock. A rotation that commits first leaves every CRM/domain CTE ineligible and returns a stale-proof response without finalizing the old abuse lease.
- `/preview/*` responses are `private, no-store` and `no-referrer`. Before scoring, hashing or persistence, the server removes capability query parameters and fragments from URL answers and visitor URLs; canonical answers, UTM and visitor metadata containing current, old or capability-shaped tokens fail closed. The capability must still never be pasted into tickets, logs or analytics because the initial inbound URL necessarily contains it.

## Approved cutover sequence

1. Confirm the selected workspace and funnel IDs out of band. Do not place a token in tickets, logs, screenshots or audit notes.
2. GET the INTERNAL cutover endpoint and record only the revision.
3. Obtain a route-bound one-time CSRF token for the POST path.
4. POST the exact expected revision with a new random idempotency key.
5. Copy the returned token directly into the approved secret handoff channel. It cannot be retrieved again with a replay.
6. Verify that the old live URL returns 404, the new URL renders, an old submission proof is rejected and a newly issued proof succeeds.
7. Record only funnel ID, workspace ID, revision and verification result in the release evidence.

No step in this repository change contacts Vercel, Production, Resend, a calendar provider or any other external system.
