# A11y Preview Fixture Lifecycle

Stand: 24.08.2026

## Zweck

`scripts/qa-a11y-preview-fixture-lifecycle.mjs` schließt den technischen Lifecycle für die zwei action-time A11y-Surfaces `publicForm` und `publicFunnel`. Die Strecke ist ausschließlich für einen sauberen Checkout des exakten finalen Preview-SHA vorgesehen. Sie erzeugt keine Production-Daten und ersetzt weder die signierte manuelle WCAG-Abnahme noch den geschützten Evidence-Freeze.

Der Orchestrator verwendet die bestehenden Public-Runtime-Verträge statt eines zweiten Sonderwegs:

1. Read-only Attestierung des exakten Neon-Preview-Projekts/-Branches, `neondb`, Rolle `novalure_app` und zweier verschiedener `is_qa=true`-Workspaces.
2. Read-only Attestierung von Deployment-Host/-ID, Branch, SHA, DB-Target-Digest, RLS/Least-Privilege und beider persisted Cookie-Sessions über Capability schema v2.
3. Zwei neue, zufällige, vorher nie versiegelte `purpose=public-runtime-preview`-Batches über `qa-public-runtime-batch-provision.mjs`: Primary und Cross-Tenant.
4. Atomar registrierte aktive Form, Funnel, Blueprint-Aktivierung und einmaliger Publish-Token-Cutover nur im Primary-Batch.
5. Exakte `404`-Negativtests aus der Cross-Tenant-Session gegen Form-Auflösung, Funnel-Blueprint und Tokenstatus.
6. Direkter stdin-Pipe-Handoff von `publicFormUrl`, `publicFunnelUrl` und optionalem Preview-Share-Link an `a11y-browser-matrix.mjs --read-only --fixture-input-stdin`. Es wird keine URL-Datei angelegt und keine URL in den Lifecycle-Output übernommen.
7. Reset beider Batches in `finally` über `POST /api/admin/qa-reset` mit Dry-run, gebundenem Plan-Digest und Execute-Bestätigung.
8. Vor der ersten Surface-Creation wird der kanonische Inhalt aller operativen Public-/CRM-Tabellen gehasht; nach beiden Resets müssen Digest und Zeilenzahl exakt zur Baseline zurückkehren und `remainingBatchObjectCount()` muss null liefern. Dadurch blockieren auch gleich große Content-Drifts und nichtregistrierte Nebenzeilen den PASS.
9. Zusätzlich: genau ein ausgeführtes Reset-Audit je Batch, null lebende registrierte Form-/Funnel-/Funnel-Step-Zeilen, null zugehörige Visit-Zeilen und null unbekannte Ledger-Ressourcentypen. Retained Append-only-Tabellen werden separat vor/nach dem Lauf inventarisiert. Für jede Tabelle müssen alle gehashten Baseline-Primärschlüssel nach dem Lauf weiterhin vorhanden sein; bloß gleiche oder höhere Summenzähler reichen nicht.
10. Erst nach Browser-PASS, beiden Resets, unabhängigen Restzählern, exaktem operativem Pre/Post-Digest und dem Append-only-Membership-Nachweis wird `a11y-fixture-lifecycle.json` samt SHA-256-Sidecar exklusiv geschrieben. Es bindet den Browserartefakt-Digest, einen frischen Run-Identifier, beide Batch-Fingerprints, die exakte Preview-Runtime und alle Reconciliation-Inventare. Ohne dieses Artefakt ist ein vorhandenes Browser-PASS-Artefakt für Freeze und Final-Verifier wertlos.

Production ist zusätzlich an die unveränderlichen Recovery-Trust-Anchor-IDs `misty-cloud-70835427 / br-snowy-fog-aldx77v8` sowie an eine bekannte Production-Origin gebunden. Stimmen diese Werte nicht exakt oder überschneiden sie sich mit Preview, endet der Lauf vor der Provisionierung.

## Einmaliger Aufruf

Der Input darf nur aus einem Secret-Store oder einem im Arbeitsspeicher erzeugten Prozess direkt an stdin geschrieben werden. Keine JSON-Datei anlegen, keine Werte als CLI-Argumente verwenden und den kompletten Befehl nicht in eine Shell-History mit eingebetteten Secrets schreiben.

```text
node scripts/qa-a11y-preview-fixture-lifecycle.mjs --execute --input-stdin
```

Das stdin-Objekt hat exakt folgende Struktur:

```json
{
  "schemaVersion": 1,
  "confirmation": "RUN_A11Y_PREVIEW_FIXTURE_LIFECYCLE",
  "expectedGitSha": "<40-char final candidate SHA>",
  "expectedGitRef": "codex/<exact branch>",
  "expectedDeploymentId": "dpl_<exact deployment>",
  "previewOrigin": "https://<exact-deployment>.vercel.app",
  "expectedNeonProjectId": "<isolated Preview project>",
  "expectedNeonBranchId": "br-<isolated Preview branch>",
  "databaseUrl": "<novalure_app Preview URL; stdin only>",
  "productionOrigin": "https://www.novalure-crm.app",
  "productionDatabaseHost": "<exact Production deny host>",
  "productionNeonProjectId": "misty-cloud-70835427",
  "productionNeonBranchId": "br-snowy-fog-aldx77v8",
  "shareUrl": "<optional exact Preview /?_vercel_share=... URL or empty>",
  "primary": {
    "workspaceId": "<QA workspace A>",
    "actorUserId": "<workspace A reset actor>",
    "batchMarker": "QA-TEST-YYYYMMDD-HHMM-<unique suffix>",
    "sessionCookie": "novalure_session=<persisted cookie>"
  },
  "crossTenant": {
    "workspaceId": "<different QA workspace B>",
    "actorUserId": "<workspace B reset actor>",
    "batchMarker": "QA-TEST-YYYYMMDD-HHMM-<different suffix>",
    "sessionCookie": "novalure_session=<different persisted cookie>"
  }
}
```

Beide Actors müssen in ihrem jeweiligen Workspace `role=owner`, `product_role=platform_admin`, `status=active` sein. Die Workspaces, Actors, Cookies, Batch-Marker und später erzeugten Batch-IDs müssen verschieden sein. Der lokale Checkout muss exakt Branch/SHA entsprechen und vollständig sauber sein.

`NOVALURE_QA_A11Y_OUTPUT_DIR` ist ein Basisverzeichnis. Für jeden Lauf wird darunter exklusiv ein neues leeres `a11y-run-<uuid>`-Verzeichnis erzeugt; der Browser schreibt JSON und Sidecar mit `wx`, nicht über bestehende Dateien. Fehlt die Variable, wird `artifacts/qa/a11y-browser-matrix` als Basis verwendet. Bestehende Login-/MFA-Credentials bleiben Eingaben des A11y-Runners. Ein optionales Password-Reset-Result-Fixture wird ausschließlich als validierte action-time URL über `NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL` übergeben; dieser Lifecycle erzeugt ausschließlich Form und Funnel. Ein gebündeltes Playwright kann über den explizit allowgelisteten `NOVALURE_PLAYWRIGHT_MODULE_PATH` geladen werden.

## Geheimnis- und Artefaktgrenze

- Datenbank-URL, beide Session-Cookies, Share-Link und Publish-Token erscheinen nur im stdin-/Prozessspeicher.
- Der Publish-Token wird ausschließlich als Bestandteil der Funnel-URL direkt an den Child-Prozess gepiped.
- Der A11y-Child erhält keine Kopie des Parent-Environments. Eine feste Allowlist übergibt nur notwendige OS-/Browser-Werte und die exakt benannten `NOVALURE_QA_PREVIEW_*`-A11y-Fixture-Credentials; Datenbank-, Vercel-, Resend- und sonstige Provider-Secrets bleiben ausgeschlossen.
- Nach einem Browserlauf werden die beiden exakten A11y-Evidence-Dateien byteweise gegen Form-URL, Funnel-URL, Share-Link, Token, Cookies, DB-URL, Login-E-Mail, Passwort, TOTP-Secret und die optionale `NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL` geprüft. JSON muss parsebar sein; Sidecar-Dateiname und neu berechneter Browser-SHA-256 müssen exakt übereinstimmen.
- stdout enthält nur Candidate-/Deployment-Bindung, Run-ID, Batch-Fingerprints, Null-Rest-Status sowie die Browser- und Lifecycle-SHA-256-Werte.
- Der Lifecycle schreibt keine Handoff-Datei und enthält keine SQL-DELETE-Strecke.

## Fehler und Emergency Cleanup

Jeder Fehler nach einer erfolgreichen Batch-Provisionierung führt im `finally`-Block zu einem Resetversuch für jeden bereits erzeugten Batch. Der Cross-Tenant-Batch wird auch bei null Zielobjekten explizit versiegelt. Ein fehlgeschlagener Reset, Count-/Membership-Mismatch oder Restbestand ergibt immer `A11Y_FIXTURE_EMERGENCY_CLEANUP_FAILED`. Ein davor bereits geschriebenes Browserartefakt bleibt bewusst unvollständig: Es erhält kein Lifecycle-Artefakt und wird deshalb vom Freeze abgewiesen.

Bei diesem Fehler dürfen keine improvisierten SQL-Deletes ausgeführt werden. Der noch aktive Batch wird read-only über Workspace, `purpose=public-runtime-preview`, Candidate-SHA und Deployment-ID identifiziert und anschließend ausschließlich über den bestehenden QA-Reset-Dry-run/Execute-Vertrag bereinigt. Erst ein erneuter unabhängiger Null-Rest-Zähler schließt den Vorfall.

## Übergabe an Approval und Freeze

Nach dem Lauf werden die acht manuellen Evidence-Dokumente und die referenzlose Matrix erstellt. Die Matrix enthält genau die Rollen `Accessibility owner`, `Product owner`, `Release owner`; jede Rolle signiert einen eigenen Ed25519-Receipt. Alle drei Payloads enthalten dieselben Browser-, Matrix-, Manual-Bundle- und Lifecycle-Digests, aber ihren jeweils eigenen `approvalRole`, `receiptRole` und `recordType`.

Der Accessibility-Input für `scripts/final-preview-evidence-freeze.mjs` muss zusätzlich zu Source/Sidecar, Matrix, acht Manual-Pfaden und Trust-Anchor diese Felder enthalten:

```json
{
  "approvalReceiptPaths": {
    "accessibility-owner": "<absolute path>",
    "accessibility-product-owner": "<absolute path>",
    "accessibility-release-owner": "<absolute path>"
  },
  "lifecyclePath": "<absolute .../a11y-fixture-lifecycle.json>",
  "lifecycleSidecarPath": "<absolute .../a11y-fixture-lifecycle.json.sha256>",
  "runtime": {
    "branch": "codex/<exact branch>",
    "candidateCommit": "<exact 40-char SHA>",
    "databaseBranchId": "br-<exact Preview branch>",
    "databaseProjectId": "<exact Preview project>",
    "deploymentHost": "<exact Preview host>",
    "deploymentId": "dpl_<exact deployment>"
  }
}
```

Der Freeze liest Lifecycle und Sidecar als getrennte, nicht verlinkte reguläre Dateien, berechnet den SHA neu und akzeptiert nur den in allen drei Receipts signierten Digest. Der direkte Final-Verifier wiederholt Rollen-, Digest-, Runtime-, Observation- und Cleanup-Prüfung; ein handgebautes Final-Artefakt kann den Freeze daher nicht umgehen.

## Vorgeschlagene npm-Skripte

`package.json` wurde in dieser parallelen Umsetzung bewusst nicht verändert. Für die zentrale Integration sind diese Aliase vorgesehen:

```json
{
  "qa:preview:a11y:fixture-lifecycle": "node scripts/qa-a11y-preview-fixture-lifecycle.mjs --execute --input-stdin",
  "test:a11y:fixture-lifecycle": "node --test scripts/a11y-preview-fixture-lifecycle-contract-tests.mjs"
}
```

Der Contract-Test führt keine Netzwerk-, Vercel-, Neon- oder Production-Aktion aus.
