# Attachment receipt replay: current scope after provider I/O

Base: `88a2e71daa6fd13158b416d7de0c0a9547b46aff`. Branch: `codex/personal-mail-acl-replay-20261105`. Isolated worktree: `C:/Projects/novalure-crm-personal-mail-acl-replay-20261105`.

This successor addresses independent finding `MAIL-ACL-M01` from `C:/Projects/crm-live-acceptance-20261104/reviews/personal-mail-acl-88a2e71d-independent.json`. Previously, `savePersonalAttachment` closed its first authority transaction before provider I/O. Its second current association check ran only inside the generic command callback. A matching prior receipt skipped that callback, so revoking project access during the repeated provider read could still return old private file metadata.

After provider I/O and file inspection, the existing binding/current association check now runs in an outer fresh `withCrmRead` transaction **before** `executeCrmCommand` can inspect a successful old receipt. The nested command reuses that transaction and the existing membership/session/message/association/project-grant locks. Connection/message revision and hash comparisons likewise precede receipt lookup. No second command architecture, new capability, provider scope, role, grant, route, dependency, schema or UI was added. Unassociated private owner access and permanent own-byte erasure are unchanged. No provider I/O is moved inside the final locked transaction.

The new regression case first stores a received attachment, proves its normal matching receipt replay, then revokes `can_read` and `can_edit_deals` from the synthetic provider transport immediately before the repeated attachment read returns. Google and Microsoft cases must fail with `PROJECT_FORBIDDEN` before exposing receipt metadata. The after-check proves no new attachment or store receipt, unchanged stored bytes hash, no send POST, and direct metadata/download still denied. Microsoft uses its actual immutable-message-ID path. The original code reproduced the failure: **24 total / 22 pass / 2 fail** (one failing case plus parent); the unchanged raw TAP is retained as Base64/byte count/SHA256 in `artifacts/personal-mail-acl-replay/before-fix.transport.json`.

Final affected-module loopback run: **24/24**, zero fail/skip; TypeScript without incremental reuse and affected-file lint both pass. `artifacts/personal-mail-acl-replay/evidence.json` binds exact executed source/test bytes and artifacts. The run uses actual disposable loopback PostgreSQL, the ordinary non-owner tenant role, existing two-tenant cases and injected synthetic provider transports. It performs no real mailbox/provider request, production database connection, paid call, send, push, release or deployment. Historical 23/23, 43/43, browser and build receipts remain historical and are not summed or represented as new runs.

Local commands:

```text
node --conditions=react-server --import tsx --test --test-reporter=tap scripts/personal-mail-reply-tests.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js src/lib/db/crm-mailbox-reply-repository.ts scripts/personal-mail-reply-tests.ts --max-warnings=0
```

Exact-SHA independent review of this successor, shared integration/schema/required checks, native CI/Linux and real App/provider acceptance remain separate. This correction is not a full mail workflow or production acceptance.
