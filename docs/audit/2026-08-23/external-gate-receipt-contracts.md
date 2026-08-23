# External gate receipt contracts

Status: **contract implemented; real receipts remain absent and therefore BLOCKED**

These contracts close the gap between a string such as `PASS` or `SIGNED` and a
verifiable, independently signed observation. They do not create approvals,
GitHub attestations, monitoring observations, accessibility evidence or company
data. A release gate may use their result only when the relevant validator
returns `status: VERIFIED` for the exact final Preview runtime.

## Shared trust boundary

`scripts/lib/external-gate-receipts.mjs` exports:

- `externalGateReceiptRoles`
- `externalGateTrustAnchorRecordType`
- `canonicalJson`
- `sha256`
- `validateExternalGateRuntimeBinding`
- `validateExternalGateTrustContext`
- `loadExternalGateTrustContext`
- `buildExternalGateReceiptSigningPayload`
- `verifyExternalGateReceipt`

The trust anchor uses the same `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR` envelope
as final release approvals. It may contain release-approval and gate-receipt
keys. The gate validator does not impose a total key count; it requires the
exact role used by the receipt and rejects duplicate roles or key IDs. Every key
is `ACTIVE`, Ed25519, role-bound and signer-subject-bound.

Supported gate roles:

- `accessibility-owner`
- `github-actions-attestor`
- `observability-owner`
- `runtime-logs-owner`
- `cleanup-owner`
- `supply-chain-owner`
- `company-profile-approver`
- `provider-acceptance-attestor`
- `performance-manual-owner`
- `performance-rum-attestor`
- `blob-migration-attestor`

The production verifier must construct `trustContext` as
`{ anchor, expectedSha256 }` only after reading a bounded regular trust-anchor
file outside the repository and comparing its exact bytes to an independently
fixed SHA-256. `loadExternalGateTrustContext` implements that boundary and
rejects repository-local files, symlinks, hard links, malformed keys and wrong
digests. Private signing keys must never enter the repository, Vercel
environment, evidence directory or CI artifact.

Every receipt has a strict schema, payload digest, exact signature reference
and detached Ed25519 signature. The signing payload is returned by
`buildExternalGateReceiptSigningPayload`. A real signer signs those exact bytes
outside this repository. Changing the payload, role, key, signer, candidate,
deployment, artifact digest or trust-anchor digest invalidates the receipt.

## Accessibility manual acceptance

`scripts/lib/accessibility-manual-acceptance-receipt.mjs` exports:

- `accessibilityManualAcceptanceRole`
- `accessibilityManualAcceptanceRecordType`
- `accessibilityManualEvidenceRecordType`
- `accessibilityRequiredManualCheckIds`
- `validateAccessibilityManualAcceptanceReceipt`

The validator requires all eight manual checks in the frozen matrix order. It
hashes the complete signed matrix, every individual evidence document, the
ordered individual-evidence digest bundle and the automated schema-v4 evidence.
Each individual document is candidate/deployment/branch/database-bound, covers
DE and EN, has evidence-backed PASS observations, and identifies the tester and
test contexts. Matrix `owner`, `signature` or `SIGNED` strings alone have no
authority. The independent `accessibility-owner` receipt must be signed after
the latest manual test.

The final accessibility gate must call this validator and accept PASS only from
its `VERIFIED` return value. The matrix, all eight individual documents, the
automated evidence, receipt and sidecars must be frozen in the evidence commit.

## Protected GitHub workflow provenance

`scripts/lib/protected-workflow-provenance-receipt.mjs` exports:

- `githubArtifactAttestationAction`
- `githubArtifactAttestationCliPins`
- `githubArtifactAttestationCliVersion`
- `protectedWorkflowProvenanceRole`
- `protectedWorkflowProvenanceRecordType`
- `protectedWorkflowArtifactManifestRecordType`
- `protectedWorkflowEvidenceFiles`
- `validateVerifiedGitHubAttestationOutput`
- `verifyGitHubArtifactAttestation`
- `validateProtectedWorkflowProvenanceReceipt`

The protected workflow grants only `contents: read`, `id-token: write` and
`attestations: write` to the producer job. It creates a deterministic tar from
the exact four QA evidence files and a matching manifest, then calls
`actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6` (v4.2.0). The immutable
upload contains the tar, manifest, GitHub/Sigstore bundle and SHA-256 sidecars in
addition to the four original QA files. Floating Action tags, a missing OIDC
permission, a missing bundle, symlinks, hard links or an expanded evidence
inventory fail closed.

The local verifier never trusts copied `GITHUB_*` or caller-provided issuer,
subject, run or workflow strings. It reads bounded regular artifact, bundle,
trusted-root and GitHub CLI files; compares the artifact bytes and bundle bytes
to their manifest/receipt digests; and invokes the official GitHub CLI offline
with `--bundle`, `--custom-trusted-root`, exact certificate identity and issuer,
exact signer/source repository, workflow SHA/ref, SLSA predicate,
`--deny-self-hosted-runners` and `--no-public-good`. GitHub CLI 2.97.0 is pinned
by executable SHA-256 for `linux-x64` and `win32-x64`; any other binary or
platform is rejected before execution.

After successful Sigstore/X.509/DSSE verification, the validator independently
checks the one in-toto subject name and digest, certificate SAN and OIDC issuer,
workflow/source SHA and ref, GitHub-hosted runner, trigger, repository and the
run invocation ID/attempt. It binds the certificate, statement, complete CLI
verification result, verified timestamps, trusted root, verifier binary and
raw bundle digests to the external Ed25519 `github-actions-attestor` receipt.
`SIGNED_VERIFICATION_RECEIPT` alone is not a PASS result. Only the object
returned by the in-process cryptographic verifier can produce `VERIFIED`.

The final two-tenant gate repeats this verification from external file paths and
explicitly requires `status === VERIFIED`. The Public Form/Funnel gate requires
its own independently verified public-runtime artifact and bundle and compares
their artifact, bundle, workflow SHA/ref and run ID to its signed workflow
receipt. The protected workflow uses a separate producer job, six-file staging
root, deterministic tar, `NOVALURE_PUBLIC_RUNTIME_ARTIFACT_MANIFEST` and
Sigstore bundle for Public evidence. It never mixes or reuses the four-file
Two-Tenant artifact. Neither gate can reuse an unverified or merely
self-declared receipt.

The two-tenant gate must require this validator in addition to its business
matrix. Public Form/Funnel proof artifacts that rely on protected GitHub
execution may reuse the verified receipt only when their exact artifact digest
and file manifest are included in the signed artifact payload.

## Operational receipts

`scripts/lib/operational-gate-receipts.mjs` exports:

- `operationalGateSpecifications`
- `validateOperationalGateReceipt`
- `validateOperationalGateReceipts`

The four exact inventories are:

- Observability: alert delivery, error ingestion, runtime alerting, synthetic
  alarm, log-drain delivery and trace ingestion.
- Runtime logs: bounded window, no unhandled errors, request correlation,
  target-deployment filtering, log-drain delivery and trace correlation.
- Cleanup: QA batch reset, zero database rows, zero Blob objects, zero provider
  sessions, zero auth sessions and historical-artifact disposition.
- Supply chain: CodeQL, dependency review, production npm audit, license policy,
  SBOM, secret scan and pinned Actions.

Each observation must be PASS, occur inside the bounded observation window and
carry independent evidence and source-record digests. The signed payload binds
the exact candidate runtime, provider/source type, run ID, run attempt, run URL
digest and aggregate artifact digest. The receipt must be signed after the
window closes. A string-only operational JSON cannot pass.

Generic attestation gates must use these validator results:

- `observability` -> `observability-owner`
- `runtime-logs` -> `runtime-logs-owner`
- `cleanup-null-rest` -> `cleanup-owner`
- `security-supply-chain` -> `supply-chain-owner`

## Provider acceptance

`scripts/lib/provider-acceptance-receipts.mjs` verlangt sechs vollständige,
extern signierte Abnahmen: vier getrennte Resend-Receipts für Passwort-Reset,
Workspace-Einladung, Einladungs-Resend und Customer-Access-Einladung sowie je
einen vollständigen Kalender-Roundtrip für Google Calendar und Microsoft
Graph. Jede Receipt bindet den exakten Preview-Runtime-Target, einen
ausschließlich für QA freigegebenen Zielfingerprint, Providerkonto und
-umgebung, das Provider-Log-Artefakt, ein begrenztes Beobachtungsfenster und das
vollständige Outcome-Inventar. Ein Kalenderprovider kann den anderen nicht
ersetzen. Der bestehende Fail-closed-Collector bleibt wahrheitsgemäß `BLOCKED`
und kann nicht durch geänderte Statusstrings in PASS umetikettiert werden.

## Public Form/Funnel protected receipt

`scripts/lib/public-runtime-protected-receipt.mjs` bindet die fünf mutierenden
Public-Proofs an ein einziges, vom Two-Tenant-Artefakt getrenntes geschütztes
Workflow-Artefakt und dieselbe konkrete QA-Batch-UUID. Das Inventar besteht aus
exakt zwei langen Proof-Refreshes, zwei Live-Submissions, einer Publish-Token-
Rotation und dem gemeinsamen Cleanup. Jeder Observation-Status wird gegen den
erwarteten Erfolgs- oder Ablehnungsbereich geprüft; Observationen müssen streng
zeitlich geordnet sein. Beide langen Form-/Funnel-Proofs müssen mindestens 15
Minuten umfassen, den alten Proof ablehnen und den erneuerten Proof akzeptieren.
Die beiden Submission-Proofs verlangen exakt eine persistierte Erzeugung und
null zusätzliche Objekte beim idempotenten Replay. Die Tokenrotation bindet
verschiedene Alt-/Neu-Token-Digests, Ablehnung des alten Tokens, erhaltene
Publikationsrevision und Repository-Scan.

Response-, Datenbank-, Cleanup- und Einzelartefakt-Digests sind vollständig
inventarisiert. Der Cleanup verlangt positive Erzeugungszahlen, exakt gleiche
Löschzahlen, Null-Rest und identische Vor-/Nachinventare. Der
`github-actions-attestor` signiert Manifest, Proof-Inventar,
Artifact-Attestation, Workflow/Main-Harness-SHA und GitHub-Run-ID. Read-only-
Negativtests, falsche Reihenfolge, kurze Sessions, Replay-Duplikate,
Token-Wiederverwendung oder frei gesetzte PASS-Strings erfüllen diesen Vertrag
nicht.

Der separate Protected-Public-Producer startet den fest verdrahteten
`public-runtime-preview-e2e`-Runner mit ausschließlich in-memory übergebenem
Action-Input und erzeugt erst bei einem vollständigen Parent-PASS die sechs
Dateien. Der mutierende Runner verlangt Capability schema v2 mit sieben exakt
benannten atomaren Public-Surfaces sowie zwei frische, deploymentgebundene und
noch nie verwendete QA-Batches. Primary Actor, Fixture-Owner und Batch-Creator
müssen identisch sein; ein separater Actor/Workspace/Batch beweist die
Cross-Tenant-Ablehnung und wird danach mit null Zielobjekten versiegelt. Form-
und Funnel-Fixtures, parallele Retries, der mindestens 15 Minuten alte Proof,
die Revision und die Publish-Token-Rotation werden tatsächlich gegen Preview
ausgeführt. Der operative Cleanup muss Null-Rest und identische Inhaltshashes
beweisen; bewusst retained Audit-, Rate-Limit-, CSRF- und Idempotency-Zeilen
werden getrennt inventarisiert und nicht als resetpflichtige Residuen
fehlklassifiziert. Erst eine reale geschützte Ausführung kann die Attestation
erzeugen; Unit- oder simulierte PASS-Evidenz ist kein Releasebeleg.

## Performance acceptance

`scripts/lib/performance-acceptance-receipts.mjs` trennt die technische Lighthouse-Matrix von zwei unabhängigen externen Receipts: `performance-manual-owner` für Mobile/Assistive-Technology, Screenreader und Zoom/Reflow sowie `performance-rum-attestor` für ein mindestens 24 Stunden langes providergebundenes RUM-Fenster mit mindestens 100 Samples. Der finale Verifier berechnet alle Lighthouse-Budgets selbst neu, verlangt vollständige positive Scores/Metriken und eine echte Bundle-Baseline und prüft die p75-Werte erneut gegen die gebundene Budget-Policy. Leere Metriken, Nullscores, fehlende Baseline oder bloße Manual/RUM-PASS-Strings sind ungültig.

## Legacy Blob migration

Der Blob-PASS-Pfad verwendet keine caller-only Digest-Zeichenfolge mehr. Die
gehashte Gate-Evidenz enthält ein vollständiges,
Candidate-/Deployment-/Store-gebundenes Legacy-Migrationsinventar mit positiver
Objekt- und Bytezahl. Quell- und Zielinventar werden objektweise nach Asset-Key,
Content-Hash und Bytezahl abgeglichen. Jede Datenbankreferenz bindet den
gehashten Datensatz und exakt den neuen Zielobjektpfad. Das geordnete
Rollback-Inventar reconciled für jedes Objekt Quellpfad, Zielpfad, Content-Hash
und Größe; Altstore-Liste und Lesezugriffe müssen anschließend gesperrt sein.

Der Verifier berechnet Evidence-, Journal-, Quell-/Zielinventar-,
DB-Referenz- und Rollback-Digests aus den gelesenen Strukturen neu. Für PASS ist
zusätzlich ein externes Ed25519-Receipt der Rolle `blob-migration-attestor`
erforderlich, das Runtime, beide Store-Fingerprints und alle genannten Digests
nach dem Beobachtungszeitpunkt bindet. Eine synthetische `0 -> 0 -> 0`-
Migration, ein geänderter Store, abweichender Content, fehlende DB-Referenz,
unvollständiges Rollback oder eine selbst deklarierte Signatur bleibt NO-GO.

## Company-profile approval

`scripts/lib/company-profile-approval-receipt.mjs` exports:

- `companyProfileApprovalRole`
- `companyProfileApprovalRecordType`
- `companyProfileSnapshotRecordType`
- `validateCompanyProfileApprovalReceipt`

The snapshot must be `APPROVED` and locked, have a positive profile version,
complete country and required-field preflights, zero missing required fields,
content/workspace/profile digests and a matching approval audit event. The audit
event records previous and approved versions and occurs at the approval time.
The trusted `company-profile-approver` must be the snapshot approver and sign
the complete snapshot digest after approval.

The final release-document check must require this validator independently of
legal-page approval. Snapshot, audit receipt, external approval receipt and
sidecars must be candidate-bound and frozen in the evidence commit. Current
`needs_review`, unlocked, unsigned or string-only profile state remains NO-GO.

## Read-only verifier CLI

`scripts/external-gate-receipt-verify.mjs` is a network-free verifier. It reads
bounded regular inputs and prints only a verification summary. It never signs a
receipt or invents an observation. Common arguments are:

```text
--kind <accessibility|protected-workflow|observability|runtime-logs|cleanup|supply-chain|company-profile>
--runtime <exact-runtime.json>
--receipt <external-receipt.json>
--trust-anchor <absolute-out-of-repository-path>
--expected-trust-anchor-sha256 <independently-fixed-digest>
```

Accessibility additionally requires the matrix, automated evidence and ordered
individual-evidence bundle. Protected workflow verification requires:

```text
--artifact <absolute-attested-tar-path>
--artifact-manifest <manifest.json>
--attestation-bundle <absolute-sigstore-bundle-path>
--expected-artifact-digest <sha256>
--expected-workflow-ref <owner/repo/.github/workflows/livegang-e2e.yml@refs/heads/main>
--expected-workflow-sha <40-character-main-harness-sha>
--github-cli <absolute-pinned-gh-2.97.0-binary-path>
--sigstore-trusted-root <absolute-trusted_root.jsonl-path>
--expected-sigstore-trusted-root-sha256 <independently-fixed-sha256>
```

The final release verifier accepts the same five external file/root bindings
through `NOVALURE_PROTECTED_WORKFLOW_*` environment variables for the
two-tenant gate and `NOVALURE_PUBLIC_WORKFLOW_*` for the Public Form/Funnel
gate. Supplying only part of either five-variable set is rejected. Operational
gates require an independently supplied exact source identity. Company-profile
verification requires the full approval snapshot.

## Tests

`scripts/external-gate-receipt-contract-tests.mjs` uses ephemeral Ed25519 keys
only. It covers parsed verified GitHub claims and fail-closed behavior for a
tampered bundle, subject mismatch, artifact-digest mismatch, self-asserted OIDC
issuer, missing trust context, wrong key, sparse inventory, payload tampering,
wrong provider and altered company-profile state. The CI workflow contract also
rejects a missing `id-token: write`, missing producer and floating Action tag;
the final-contract tests prove that signed receipts without local artifact and
bundle verification cannot become PASS.

```text
node --test scripts/external-gate-receipt-contract-tests.mjs
```
