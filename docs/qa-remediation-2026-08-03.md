# Novalure CRM QA remediation report — 2026-08-03

## Decision

**NICHT BEREIT FÜR AUTHENTIFIZIERTEN ENDTEST**

The application changes are implemented and locally verified, but the release remains intentionally blocked until the additive database migration, private Blob store, malware scanner, staging browser matrix, and production restore point are available and verified.

## Implemented remediation

- Central workspace access policy prevents non-platform administrators from mutating or resetting another owner.
- `novalureAdmin` receives the intended internal CRM capabilities.
- Sessions carry a database-backed version and are invalidated by password or access changes.
- Login and password-reset throttling uses persistent HMAC-keyed database records; login failures are neutral.
- Redirect inputs use one strict same-origin sanitizer.
- Security headers, request IDs, real 404 responses, permanent legacy redirects, `robots.txt`, `sitemap.xml`, localized legal metadata and localized 404 content are present.
- New media writes require a separately configured private Blob store. App routes stream verified media without exposing a storage URL. Documents remain quarantined until a real scanner returns a clean result.
- The legacy-media migration is resumable, uses a manifest, verifies size and SHA-256, switches the database atomically, deletes the public source and verifies anonymous deletion.
- Database diagnostics derive expected migrations from the migration directory and compare them with the schema ledger, required tables and indexes.
- Reservation mutations use one database transaction with row locks, idempotency, deal/unit synchronization, task/outbox/audit/analytics writes and conflict responses.
- Contact restore is workspace-scoped and transactional, preserves linked records, handles active/duplicate conflicts, writes audit and analytics events, and has a paginated DE/EN archive UI.
- Google, Teams and meeting notification workers use bounded batches, fair workspace rotation, deadlines, provider timeouts, leases, retries and dead-letter handling. Reservation expiry uses `SKIP LOCKED`.
- Production dependency vulnerabilities identified by the QA prompt were updated or minimally overridden.

## Local evidence

- Fresh `npm ci` with isolated cache: passed (422 packages).
- Existing static contract tests: 83/83 passed.
- New remediation contract tests: 11/11 passed.
- Total local tests: 94/94 passed.
- ESLint: passed.
- `tsc --noEmit`: passed.
- `git diff --check`: passed.
- Production build with Next.js 16.2.11: passed; 78 static/dynamic route entries generated.
- `npm audit --omit=dev`: 0 vulnerabilities at every severity.
- Installed dependency evidence: Next.js 16.2.11, `@vercel/blob` 2.6.1, Sharp 0.35.3, PostCSS 8.5.25, Undici 6.28.0, DOMPurify 3.4.13.
- Local production HTTP checks: public and legal pages 200; missing general/form/booking routes 404; unauthenticated contacts API 401; legacy routes 308; reset redirect contains no email; external login redirect resolves to `/`; security headers and request IDs present; no server errors recorded.
- Current unchanged production deployment remains `READY`, but the last-24-hour runtime aggregation still contains two 60-second timeouts on `/api/cron/teams-alerts` and `/api/cron/meeting-reminders`. These are on the old production commit and cannot be used as evidence for the local fix.

The 83 existing tests and the 11 new tests are source/static contract tests. They are not presented as database integration, production E2E, or persistence evidence.

## Release blockers

1. No isolated staging database credential or branch-management access is available in this workspace. Migration `048_qa_security_and_reliability.sql`, rollback/parallelism tests, tenant/RBAC integration tests, consistency scans and read-only owner verification therefore have not been run against a real database.
2. Production must have a current database restore point before migration. Production migration and deployment were not attempted without it.
3. A dedicated private Vercel Blob store must be configured through `NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN` (or `PRIVATE_BLOB_READ_WRITE_TOKEN`). The existing public store credential must remain separate as `LEGACY_PUBLIC_BLOB_READ_WRITE_TOKEN` during migration.
4. A genuine malware scanner and callback secret must be configured. Without it, documents correctly remain quarantined rather than being reported as clean.
5. The local browser daemon could not start in the restricted runtime, and the Playwright browser download was blocked by the environment's TLS clock/certificate error. The required viewport screenshots and DOM measurements must therefore be executed on the Vercel preview.
6. Two successful scheduled production runs for Google Alerts, Teams Alerts and Property Reservations can only be proven after a safe production promotion.
7. GitHub publication is blocked by repository integration permissions. Branch creation returned HTTP 403 (`Resource not accessible by integration`), and the local HTTPS remote has no write credential. The verified work is committed at the local branch HEAD of `fix/qa-remediation-2026-08-03`; no remote branch or pull request is claimed.

## Safe release order

1. Create an isolated staging database branch and a production restore point.
2. Configure the private Blob store and scanner in Preview.
3. Apply migration 048 to staging and run DB/RBAC/tenant/reservation/cron/contact/media integration tests with outbound integrations disabled.
4. Run the private-media migration in dry-run and apply modes; verify the manifest and anonymous deletion.
5. Deploy the exact branch commit to Preview and complete the five-viewport browser, CSP report-only/enforced and public HTTP matrix.
6. Recreate the production restore point, apply the same additive migration, verify invariants and promote the exact tested build.
7. Run only safe public production smokes, invalidate old setup/reset tokens, verify the technical owner read-only, and observe two scheduled cron runs.

Current production remains on commit `a4e8e4d0b4b392e9af8c5326b3d76feb0b368763` until these blockers are cleared.
