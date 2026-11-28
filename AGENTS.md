<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# CRM development and release

Apply the owner's [testing and release amendment of 28 November 2026](docs/testing/risk-based-test-policy.md) to ongoing chats and future development. Separate bounded releases from the complete CRM system acceptance, reuse valid evidence, refresh affected checks and decide Medium findings by their actual release impact. Keep one candidate and closure list with the existing coordinator; do not add receipt/hash/status loops without a concrete integrity or security reason.

Read the affected code and existing evidence first. Low-risk documentation/presentation needs relevant inspection; bounded functional work needs affected checks and one meaningful acceptance; security/authentication/authorization, tenant/RLS, migrations, shared runtime, governance and CI need full applicable coverage and independent review. Preserve original data, audit, secrets, synthetic test isolation, actual required CI, trusted exact-head App checks and branch protection. A new classifier/reviewer source does not claim deployed activation.

Use an isolated branch/worktree and preserve others' changes. Fix ordinary technical failures and continue under existing authority. Request personal login/MFA only for the prepared dependent step; continue unrelated work. Update the existing current task state once with actual verification and remaining limitations.
