# U1-C04 Production source ingest

Status: **COMPLETE FOR CONTROLLED SOURCE INGEST**. Release readiness remains partial and no Production action was performed.

## Package and safety verification

- Package: `U1-C04-PRODUCTION-SOURCE-INGEST-dpl_ESYdRFQruH4CcsMnmrnBhZ5vQqah.tar`
- Calculated SHA-256: `973587963a98cee1e9e6133f3c23814304553fd67ac60352d4aad3c87fe210f4`
- Expected SHA-256: exact match
- Archive entries: 45 regular files (`manifest.json`, `README.txt`, 43 sources)
- Archive path guard: PASS; every entry is relative under `U1-C04-PRODUCTION-SOURCE-INGEST/`
- Links/devices/traversal/absolute paths: none
- Manifest verification: 43/43 exact sizes, SHA-1/provider file IDs and SHA-256 digests passed before repository mutation

The archive was inspected and extracted only into an isolated temporary directory. It was not overlaid on the repository. Each destination was checked before the 43 verified files were copied. The package manifest is preserved at `config/u1-c04-production-source-package-manifest.json`.

## Reconciliation decision

All 43 recovered sources match the latest corresponding content already present in the repository's historical production lineage. Forty-two files are byte-identical. `src/components/property-text-editor.tsx` contains mixed CRLF/LF in the package; its Git-normalized LF content is code-identical and has SHA-256 `d14f395bccfaa3988dfdaa8f4b31c69033f21cd05aac149637a23a6ec80abafe`.

The full historical production branch was deliberately not merged: it contains unrelated older application and test changes that conflict with the newer U1 authorization contract. Only the verified 43 package sources and the minimum supporting type definitions, repository modules and locked dependencies required to compile those sources were added. The newer U1 tenant, command, idempotency, approval and CRM-authority controls remain intact.

Supporting source obtained from the matching historical production lineage:

- `src/lib/db/property-expose-repositories.ts`
- `src/lib/db/property-media-mutation.ts`
- `assetAvailable` compatibility fields on Property media/document types
- `originAssetId` on the Property unit navigation scope
- locked TipTap, PDF and image-processing dependencies used directly by the recovered sources

## Validation boundary

`scripts/production-media-schema-preflight.mjs` is read-only and fail-closed in Production. Its local execution returns `SKIPPED_NON_PRODUCTION`; that is not Production evidence. No Production database, provider, deployment, migration, traffic, environment or customer-data operation was attempted.

Executed validation on the controlled ingest worktree:

- clean `npm ci --offline`: PASS, 510 packages installed from the verified lock/cache
- `npm run ci:toolchain`: PASS, Node `24.14.0` and npm `11.9.0`
- `npm run test:u1-c04:source-ingest`: PASS, 2/2
- `npm run test:u1-c03:manifests`: PASS, 2/2
- local production-media preflight: `SKIPPED_NON_PRODUCTION` as designed
- `node --test scripts/production-media-schema-preflight-tests.mjs`: PASS, 5/5
- `npm run typecheck`: PASS
- `npm run lint`: PASS with zero warnings
- `npm run test:unit`: PASS, 232/232
- `npm run test:integration`: PASS, 15/15
- `npm run test:protected-preview-access`: PASS, 17/17
- `npm run test:sales`: PASS, 93/93
- `npm run test:sales:final`: PASS, 50/50
- `npm run test:sales:migrations`: PASS, 15/15, including native `pg_dump`/`pg_restore`
- `npm run test:d11`: PASS, 87/87
- `npm run test:d11:migrations`: PASS, 1/1
- `npm run test:build-metadata`: PASS, 1/1
- `npm run test:neon:061`: PASS, 11/11
- `npm run test:g08`: PASS, 54/54
- `npm run build`: PASS, Next.js `16.3.8`
- `npm run security:production`: PASS, 0 vulnerabilities
- redacted source/config/docs/package secret scans: PASS, 0 findings
- authoritative framework check in the clean control-plane worktree: `MASTERPLAN_SYNC_PASS`, framework `2.0.0`, digest `38e7946b4073c4b6eb49f4c1ca62429b4fb41b1935c22dc9a8dd16ee9d6a9c0b`

The first registry-backed clean install failed because npm could not validate the host's intercepted registry certificate chain. TLS verification was not disabled. The exact lockfile tarballs were downloaded through the system trust store, checked against every lockfile integrity value, added to the local npm cache, and the clean offline install then passed. A whole-directory secret scan found only generated `.next` build metadata; scoped scans of tracked source, scripts, config, docs and package definitions passed with zero findings. A full-history scan is not usable on this checkout because an existing historical temporary DOCX lock file requires an unavailable text converter; it is not treated as a passing gate.

Remaining release gates are the exact Production environment name/scope export, exact-SHA CI, SHA-bound Preview QA, the read-only Production media-schema preflight, and the exact D11 PostgreSQL 18 restore/rollback evidence bundle.
