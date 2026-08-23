# Public Form/Funnel Preview Gate

Stand: 23.08.2026

## Zweck und Sicherheitsgrenze

`scripts/public-runtime-preview-e2e.mjs` ist der mutierende, fail-closed Gate-Runner für die öffentlichen Form-/Funnel-Surfaces des exakten Preview-Candidates. Er erstellt ausschließlich in zwei isolierten QA-Workspaces temporäre Fixtures, publiziert sie, führt echte öffentliche Submissions aus und entfernt alle resetpflichtigen Daten über den atomaren QA-Batch-Vertrag.

Production-Origins, Production-Datenbankziele, Kunden-Workspaces und nicht deploymentgebundene Batches werden vor der ersten Mutation abgewiesen. Datenbank-URL, beide Session-Cookies und ein optionaler Vercel-Share-Zugang werden nur als begrenztes stdin-JSON akzeptiert. Diese Werte dürfen weder in Argumenten, temporären Dateien, Logs noch in Evidenzen erscheinen.

Der einzige freigabefähige Ausführungsweg ist der manuell gestartete, auf `main` geschützte Job `protected-preview-public-runtime` in `.github/workflows/livegang-e2e.yml`. Er verwendet den exakt gepinnten Trusted-Harness-SHA, checkt den Candidate separat aus, erzeugt ein eigenes deterministisches Public-Artefakt und lässt es durch GitHub Artifact Attestations/OIDC attestieren. Das Four-File-Two-Tenant-Artefakt darf dafür nicht wiederverwendet werden.

## Capability schema v2

Vor jeder Mutation ruft der Runner `/api/admin/qa-batch-capability?batchId=<id>` für beide Sessions getrennt auf. Ein Lauf ist nur zulässig, wenn die Antwort exakt `version: 2`, `atomicRegistration: true` und alle folgenden atomaren Flächen als `true` bestätigt:

- `formUpsert`
- `formPublicSubmit`
- `funnelCreate`
- `blueprint`
- `tokenRotation`
- `funnelPublicSubmit`
- `reset`

Außerdem müssen Candidate-SHA, Branch, Deployment-ID/-Host, Neon-Projekt/-Branch, Rolle `novalure_app`, RLS-/Least-Privilege-Nachweis, Cookie-Session, Workspace, Actor und Batch vollständig übereinstimmen. Die Capability bestätigt pro Batch zusätzlich `purpose: public-runtime-preview`, leeres Ledger, null Auditzeilen und keine frühere Ausführung. Jede Abweichung endet vor der Mutation mit `FAIL`.

## Zwei frische Einmal-Batches provisionieren

Für jeden geschützten Lauf werden zwei neue, voneinander verschiedene QA-Batches benötigt:

1. Primary: Actor, Fixture-Owner und `qa_batches.created_by_user_id` sind identisch. Nur dieser Workspace erzeugt Form/Funnel und deren Nachfahren.
2. Cross-Tenant: eigener Actor, eigene Cookie-Session, eigener QA-Workspace und eigener Batch. Dieser Batch muss bis zum abschließenden Seal null Zielobjekte enthalten.

Eine Batch-ID aus einem früheren Lauf oder Deployment darf niemals wiederverwendet werden. Nach dem finalen Preview-Deployment und vor dem Workflow-Dispatch wird der Provisioner zweimal aus einem sauberen Checkout des exakten Candidate-Commits ausgeführt:

```text
node scripts/qa-public-runtime-batch-provision.mjs --execute --input-stdin
```

Alternativ steht `npm run qa:preview:public-runtime:provision-batch` zur Verfügung. Das stdin-Objekt hat exakt diese Felder:

- `schemaVersion: 1` und `confirmation: PROVISION_PUBLIC_RUNTIME_PREVIEW_BATCH`
- `actorUserId`, `workspaceId`, eindeutiger `batchMarker`
- `expectedGitSha`, `expectedGitRef`, `expectedDeploymentId`
- `expectedNeonProjectId`, `expectedNeonBranchId`
- `productionDatabaseHost`, `databaseUrl`

Der Provisioner prüft einen sauberen lokalen Candidate, die isolierte Neon-Preview, Rolle `novalure_app`, Datenbank `neondb`, den QA-Workspace und den aktiven Actor. Er schreibt Metadaten mit Candidate-SHA, Deployment-ID und `purpose: public-runtime-preview` in einer `SERIALIZABLE`-Transaktion. Ein noch nicht ausgeführter Public-Runtime-Batch desselben Deployments im Workspace blockiert die Provisionierung. stdout enthält ausschließlich die neu erzeugte Batch-ID, den Marker, die Deployment-ID und die Workspace-ID.

Provisionierungsinput und Runnerinput werden im Arbeitsspeicher an stdin übergeben. Keine Klartextdatei erzeugen und keine Shell-History mit Zugangsdaten verwenden. Beide erzeugten IDs müssen anschließend in dasselbe Action-Time-Bundle aufgenommen werden; erst danach darf das Bundle als sensitive Environment-Secret `NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64` für `go-live-preview` gesetzt werden.

## Action-Time-Eingabe

Direkte lokale Vertragsausführung:

```text
node scripts/public-runtime-preview-e2e.mjs --execute --input-stdin
```

Das stdin-JSON erlaubt ausschließlich:

- Primary: `actorUserId`, `batchId`, `batchMarker`, `sessionCookie`, `workspaceId`
- Cross-Tenant: `crossTenantActorUserId`, `crossTenantBatchId`, `crossTenantBatchMarker`, `crossTenantSessionCookie`, `crossTenantWorkspaceId`
- Candidate/Deployment: `expectedDeploymentId`, `expectedGitRef`, `expectedGitSha`, `previewOrigin`
- Datenbank: `databaseUrl`, `expectedNeonProjectId`, `expectedNeonBranchId`, `productionDatabaseHost`
- Deny-/Zugangsziel: `productionOrigin`, optional `shareUrl`

Die beiden Workspaces, Batches und Sessions müssen verschieden sein. Der geschützte Workflow setzt zusätzlich die unveränderliche Policy `fresh-deployment-bound-single-use-v1`; fehlt sie oder weicht sie ab, startet der Runner nicht.

## Ausgeführte Matrix

Nach Target-, Capability- und Share-Access-Attestierung führt der Runner in dieser Reihenfolge aus:

1. Negativverträge für nicht existente/ungültige Public Form- und Funnel-Endpunkte.
2. Kanonischer Baseline-Hash aller resetpflichtigen Public-/CRM-Tabellen sowie separater Hash der bewusst retained Append-only-/Rate-Limit-/Idempotency-Tabellen.
3. Aktive Form mit `ownerUserId === actorUserId === batch.created_by_user_id`, atomar im Primary-Batch registriert.
4. Funnel-Erzeugung, Blueprint-Aktivierung, Publish-Token-Cutover und Abruf der echten öffentlichen Seite.
5. Cross-Tenant-Zugriff auf Form-Auflösung, Funnel-Blueprint und Tokenstatus; alle drei müssen exakt `404` liefern.
6. Echte Wartezeit von mindestens 901 Sekunden. Die alten Form- und Funnel-Proofs müssen danach exakt mit `400 submission_proof_expired` abgelehnt werden.
7. Proof-Refresh unter derselben Idempotency-Identität; der revidierte Proof muss akzeptiert werden.
8. Parallele Form- und Funnel-Submissions plus Retry. Direkt in der Preview-Datenbank wird exakt eine persistierte Submission samt erlaubter CRM-Verknüpfung bewiesen.
9. Zweite Publish-Token-Rotation. Der neue Token muss `200` liefern, die alte URL `404` oder `410`; Blueprint-Digest und erwartete Revision dürfen nicht driften. Beide Tokenwerte werden anschließend per Repository-Scan als nicht eingecheckt bewiesen.
10. Dry-run/Execute-Reset des Primary-Batches mit gebundenem Plan-Digest sowie Seal des Cross-Tenant-Batches. Der Secondary-Batch muss null erzeugte/gelöschte Objekte melden.
11. Erneuter operativer Inventarhash und Null-Rest-Abfrage über alle Batch-Ledgerobjekte.

Fehlschläge nach Aktivierung der Mutationsgrenze lösen in `finally` für beide Batches einen fail-closed Resetversuch aus. Kann dieser Notfall-Reset nicht vollständig bewiesen werden, bleibt der Lauf `FAIL/BLOCKED`; er erzeugt niemals einen PASS-Beleg.

## Cleanup- und Retention-Vertrag

Der Primary-Cleanup ist nur `PASS`, wenn:

- mindestens ein Batchobjekt erzeugt wurde;
- `deletedObjectCount === createdObjectCount`;
- `remainingObjectCount === 0`;
- der kanonische Inhaltshash aller operativen Tabellen bytegenau dem Baseline-Hash entspricht;
- Dry-run- und Execute-Plan-Digest übereinstimmen;
- der Batch anschließend durch ein ausgeführtes Reset-Audit versiegelt ist.

Audit-, Rate-Limit-, CSRF- und Idempotency-Zeilen sind absichtlich retained und werden deshalb nicht fälschlich als Null-Rest-Ziele behandelt. Sie erhalten einen getrennten Vorher-/Nachher-Hash und eine Zeilendelta-Evidenz. Ein retained Datensatz darf nie zur Behauptung eines operativen Cleanup-PASS verwendet werden.

## Geschützte Evidenz

Der Candidate-Runner schreibt zunächst `public-runtime-preview-evidence.json` samt SHA-256-Sidecar. Der Trusted-Harness validiert PASS, Candidate-/Deployment-/Batch-Bindung, Beobachtungsreihenfolge, mindestens 15 Minuten Proof-Alter, genau-einmal Persistenz, Tokenrotation und Cleanup und staged danach exakt sechs Single-Link-Dateien:

- `public-form-long-proof-refresh.json`
- `public-form-live-submission.json`
- `public-funnel-long-proof-refresh.json`
- `public-funnel-live-submission.json`
- `funnel-publish-token-rotation.json`
- `public-form-funnel-cleanup.json`

Diese sechs Dateien werden in lexikografischer Reihenfolge in ein separates deterministisches POSIX-Tar geschrieben. Manifest, Tar und Sidecars werden unveränderlich erzeugt; `actions/attest` ist auf eine exakte Commit-SHA gepinnt. Das Sigstore-Bundle wird als eigene read-only Evidence eingefroren und zusammen mit den sechs Dateien hochgeladen. Der finale Verifier verlangt die lokale kryptografische GitHub/Sigstore-Verifikation des exakten Artifact-Subjects; selbst deklarierte Issuer-/Subject-/Digest-Werte sind kein PASS-Ersatz.

URLs, Cookies, Datenbank-Zugangsdaten, E-Mail-Adressen und rohe Publish-Tokens werden vom Evidenz-Validator abgewiesen. In Evidenzen erscheinen nur Statuscodes, kanonische Digests, sichere IDs/Fingerprints und bounded Metadaten.

## Exit-Codes und Releaseentscheidung

- `0`: vollständige mutierende Matrix, genau-einmal Nachweis, Rotation, Tenant-Isolation und Null-Rest-Cleanup bestanden; lokale Evidenz ist PASS. Für den Release zählt zusätzlich nur das gültig attestierte geschützte Workflow-Artefakt.
- `1`: Target-, Capability-, HTTP-, Datenbank-, Proof-, Rotation-, Isolation-, Cleanup- oder Evidenzvertrag fehlgeschlagen.
- `2`: ausschließlich für einen expliziten `BLOCKED`-Status reserviert; darf nie in einen finalen PASS umgedeutet werden.

Ein lokaler grüner Test ersetzt keinen geschützten echten Preview-Lauf. Vor GO müssen zwei neue deploymentgebundene Batches provisioniert, der geschützte Job auf dem exakten finalen Candidate ausgeführt und das resultierende sechs-Datei-Artefakt samt Sigstore-Bundle durch den finalen Release-Verifier akzeptiert werden.
