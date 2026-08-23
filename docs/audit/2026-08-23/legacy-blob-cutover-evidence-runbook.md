# Legacy Blob Cutover Evidence Runbook

This collector is a Preview-only, read-only post-finalize verifier. It does not migrate or delete objects. It reconstructs schema-v2 object-level evidence from the immutable cutover journal and then rechecks the connected Preview database and both Blob stores.

## Preconditions

- The candidate SHA, Preview branch, deployment ID/host, Neon branch and both Blob store IDs are exact and independently supplied.
- `legacy-blob-cutover.mjs` has completed delayed finalize for the same run ID.
- The cutover journal remains under `artifacts/qa/legacy-blob-cutover`; the collector opens it as a bounded, single-link regular file and recomputes its digest from the bytes it parses.
- Drafts, receipts, trust anchors and final proofs are kept outside the repository. Proof, draft and receipt JSON files require matching `.sha256` sidecars plus an independently supplied raw SHA-256 digest.
- Production hosts, branches and store IDs must not match any Preview target. Production mutation is always recorded as `false`.

## Phase 1: collect an unsigned draft

Set the protected Preview runtime/cutover variables plus:

- `NOVALURE_LEGACY_BLOB_TARGET_STORE_FINGERPRINT`
- `NOVALURE_LEGACY_BLOB_EVIDENCE_OUTPUT_PATH` (absolute, outside the repository, new file in an existing non-symlink directory)

Run:

```text
npm run qa:legacy-blob-cutover:evidence -- --draft
```

The command exits non-zero with `PENDING_EXTERNAL_RECEIPT` by design. A draft is not release evidence. Before writing it, the collector verifies:

- no `legacy-public` database rows remain;
- every journaled asset has one exact private database row;
- every target object is reread and matches the journaled bytes and SHA-256;
- the old authenticated store listing is empty;
- each old object is absent through authenticated reads and denied through an unauthenticated read;
- candidate, deployment, Neon branch, source store, target store, journal and rollback inventory are bound in the evidence digest.

## Phase 2: independent receipt

An external `blob-migration-attestor` reviews the draft and signs the exact receipt payload with an Ed25519 key from the out-of-repository release trust anchor. The receipt must bind all of these values:

- draft evidence digest and journal digest;
- source and target object-inventory digests;
- database-reference inventory digest;
- rollback artifact digest;
- source and target store fingerprints;
- exact candidate, deployment, branch, host and Preview database branch runtime.

Do not generate a receipt inside the collector and do not reuse a receipt from another draft or run.

## Phase 3: recheck and emit the final proof

Supply the external draft, receipt and trust anchor paths and their independently distributed digests:

- `NOVALURE_LEGACY_BLOB_DRAFT_PATH` / `NOVALURE_LEGACY_BLOB_DRAFT_SHA256`
- `NOVALURE_LEGACY_BLOB_RECEIPT_PATH` / `NOVALURE_LEGACY_BLOB_RECEIPT_SHA256`
- `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_PATH` / `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_SHA256`
- a new `NOVALURE_LEGACY_BLOB_EVIDENCE_OUTPUT_PATH`

Run:

```text
npm run qa:legacy-blob-cutover:evidence -- --final
```

The final phase repeats all live read-only checks against the same journal bytes. It succeeds only if the evidence digest is identical to the draft and the detached Ed25519 receipt verifies against the external trust anchor. Any missing file, symlink, hardlink, path escape, changed journal, expired draft, database/store drift, content drift or signature mismatch is fatal.

## Lifecycle integration

`preview-blob-lifecycle.mjs --execute` requires the verified final proof and trust anchor through:

- `NOVALURE_LEGACY_BLOB_PROOF_PATH` / `NOVALURE_LEGACY_BLOB_PROOF_SHA256`
- `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_PATH` / `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_SHA256`

It loads and verifies these files before reading a share URL or making a network request, then passes the verified proof into `runPreviewBlobLifecycle`. Missing or pending proof remains NO-GO.
