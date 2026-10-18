# Studio Stage 3 normal-login QA fixture

Prepared tooling only. No account, database, HTTP or MFA operation was executed by the author.

The fixture is restricted to Neon project super-block-59791927, branch br-ancient-term-awip1q3q, database neondb. The actual current and session user and database owner must all be neondb_owner, with the exact existing provider administrator profile: SUPERUSER=false, BYPASSRLS=true, LOGIN=true, CREATEDB=true and CREATEROLE=true. Root's read-only provider-role-provenance.json confirmed that this profile is identical in the empty parent and the owned Stage3 branch. The fixture makes no role changes. This is a seed-only provider administrator; the application runtime novalure_app remains strictly non-owner/non-superuser/non-BYPASSRLS under its existing checks. Migration 098 must have its current committed LF-normalized checksum, using the same CRLF-to-LF rule as db-migrate, and the existing fixed Studio operator must remain active. The source QA database and other branches are not used.

Direct writes are limited to one synthetic foreign workspace and two synthetic owner/customer_owner memberships. One membership belongs to Studio workspace 8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101; the other belongs to a deterministic separate synthetic workspace. Existing identity triggers create the two normal active password identities. No contact, lead, task, invitation, email, integration, role, grant, session or MFA state is seeded. Existing triggers and policies remain active. A conflicting identity, user or workspace stops the entire transaction; the script never adopts an existing identity or rotates a password.

The ordinary login accounts are st1-studio-owner@example.invalid and st1-foreign-owner@example.invalid. Their deterministic user/workspace IDs are exported as loginPlan. These are login identities. The separate synthetic enquiry contact is st1-qa@example.invalid, optionally with +353000000000; the same values must be present in the dedicated Preview recipient allowlists. The live harness has no contradictory hardcoded contact. It reads qaEmail/qaPhone from its private configuration.

## Review and execution

First run the offline tests:

    node --conditions=react-server --import tsx --test scripts/studio-stage3-login-fixture-tests.mjs scripts/studio-enquiry-live-qa-tests.mjs

Only after the exact-revision review and the root task's explicit fixture execution approval, create an ACL-private configuration inside the ignored .npm-cache/qa directory. It contains approvalId, target equal to exported fixtureTarget, adminUriFile pointing to the existing private direct owner URI, and credentialsFile pointing to a NEW file in an existing ACL-private directory. Both private paths remain below .npm-cache/qa. No URI or password belongs in chat, command arguments, source or logs.

The script validates the private files' effective ACL (current Windows user and SYSTEM only; restrictive POSIX permissions elsewhere). It saves fresh random passwords with exclusive file creation before any mutation, then verifies the target again in the transaction. No existing credentials file is overwritten. Run only with:

    node --import tsx scripts/studio-stage3-login-fixture.mjs <ACL-private-config.json> --run-authorized-fixture

A failure or uncertain commit requires read-only reconciliation by the root task. Do not rerun with new credentials, reset passwords or delete the private evidence to bypass an identity collision. The database fixture deliberately changes the post-restore data fingerprint; preserve the earlier authentic restore proof and record the separate synthetic fixture operation rather than claiming the restored data are still byte-identical.

## Normal MFA and access evidence

The integrated live harness performs the normal password POST to /api/auth/login. A privileged owner receives the existing novalure_login_challenge cookie. For first enrollment it fetches ONLY /login?step=mfa_enrollment with that cookie, reads the normally rendered TOTP key and ten recovery codes, saves them to an exclusive ACL-private file BEFORE confirmation, then submits a valid TOTP and recoveryCodesSaved=1 through the same ordinary challenge route. No MFA key/session is inserted into the database by QA tooling.

The private MFA file is adjacent to the already private live configuration, named by the fixed runId/account label. It is bound to the exact synthetic user, workspace and Neon target. On subsequent login the harness uses that stored synthetic TOTP key for the existing mfa_verification flow. It never resets MFA or overwrites a prior enrollment file. Unknown enrollment outcomes remain blocked for reconciliation; there is no automatic retry.

The helper requires a verified ordinary cookie session with the exact synthetic owner/user/workspace and trustedAuthHeaders=false and demoAuth=false. Cookies, rendered secrets, recovery codes, raw HTML, passwords and database URLs are never logged. The returned cookie is a sensitive in-memory capability used only for the existing same-workspace lead/private-media reads and foreign-workspace denial checks. The signed handoff's transport and receipt checks remain unchanged.

Deployment metadata, /api/version, actual database identity, private configuration, review and Preview activation gates precede normal authentication. The HTTP wrapper adds only the two exact same-origin MFA challenge page paths; arbitrary login URLs, origins and redirects remain rejected. No change to Vercel protection, MFA policy, authentication runtime, TLS configuration, EF1 or Production is made. This prepares API authentication evidence; visual lead acceptance still requires the actual protected CRM UI in the allowed external browser.
