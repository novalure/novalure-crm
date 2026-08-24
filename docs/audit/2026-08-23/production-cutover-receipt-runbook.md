# Production-Cutover-Receipt – PRE_ACTIVATION_READY

Stand: 24.08.2026

Status: **Vertrag implementiert, keine Production-Aktion ausgeführt, keine Freigabe behauptet**

## Sicherheitsgrenze

Der Vertrag in `scripts/lib/production-cutover-receipt.mjs` kann ausschließlich einen bereits vollständig ausgeführten und extern belegten Cutover als `PRE_ACTIVATION_READY` verifizieren. Er führt selbst weder Vercel-, Neon-, Blob-, Alias- noch Monitoring-Aktionen aus. Er darf keine Beobachtung nach Launch-Aktivierung behaupten: Der abschließende Production-Smoke muss die Anwendung nach Alias-Promotion ausdrücklich noch `SAFE_CLOSED` sehen.

Ohne kanonische externe Evidence-Datei, unabhängig digest-gepinnten Trust Anchor und alle drei gültigen Ed25519-Signaturen bleibt die nachgelagerte Launch-Aktivierung geschlossen. Die getrennten Rollen sind:

- `production-cutover-dba`
- `production-cutover-platform-operations`
- `production-cutover-release-observer`

Alle drei Rollen signieren denselben kanonischen Evidence-Digest erst nach Abschluss sämtlicher belegter Cutover-Schritte. Receipt-ID, Key-ID und Signature-Reference dürfen nicht wiederverwendet werden.

## UTC- und Freshness-Grenze

Jeder Zeitwert im Cutover-Dokument und in seinen Receipts ist ausschließlich als strikt kanonischer UTC-Wert der Form `YYYY-MM-DDTHH:mm:ss.sssZ` zulässig. Offset-Schreibweisen, fehlende Millisekunden, normalisierte unmögliche Kalendertage und nicht ganzzahlige Verifikationsuhren werden abgewiesen.

`PRE_ACTIVATION_READY` ist bewusst kurzlebig:

- Der vollständige Cutover-Lauf muss beim Readiness-Check innerhalb der letzten **30 Minuten** begonnen und abgeschlossen worden sein; sowohl `startedAt` als auch `completedAt` liegen in diesem Fenster.
- Jeder der drei Receipts muss nach dem Cutover-Abschluss signiert sein und liegt unter derselben maximalen 30-Minuten-Freshness-Grenze.
- Für unvermeidbare NTP-/Provider-Abweichungen werden höchstens **60 Sekunden Future-Skew** akzeptiert; ein weiter in der Zukunft liegender Abschluss oder Receipt schlägt fehl.
- `launchReadinessValidUntil` ist operativ spätestens `startedAt + 30 Minuten`; das ist wegen der ebenfalls geprüften späteren Abschluss- und Receipt-Zeiten die strengste Grenze. Danach muss neue, vollständig signierte Cutover-Evidence aus einem neuen vollständigen Lauf erzeugt werden; ein altes Receipt darf nicht erneut zur Launch-Bereitschaft erhoben werden.

Die Bibliotheksfunktionen akzeptieren für deterministische Offline-Tests ein injizierbares `nowEpochMs`; operative Aufrufer verwenden standardmäßig `Date.now()`. Die Uhr ist kein signierter Payload-Bestandteil, sondern die lokale, fail-closed Freshness-Entscheidung zum tatsächlichen Readiness-Zeitpunkt.

## Fest gebundene Ziele

- Vercel-Projekt: `prj_R32Okl6AHijTohvuKmryuTLjWMsk`
- Production-Alias: `www.novalure-crm.app`
- Staged Deployment: exakte `dpl_...` und exakter unveränderlicher `*.vercel.app`-Host
- Staging-Befehl: exakt `vercel --prod --skip-domain`; während Staging darf keine Domain zugeordnet sein
- Neon Production: `misty-cloud-70835427 / br-snowy-fog-aldx77v8 / neondb`
- vorheriges Deployment: exakte, vom staged Deployment verschiedene Rollback-ID samt Host

## Datenbank- und Recovery-Gate

Vor jeder Migration muss ein belegtes Production-Backup mit aktivem PITR vorliegen. Ein unabhängiger Restore-Branch – niemals `br-snowy-fog-aldx77v8` – muss aus genau diesem Snapshot wiederhergestellt und per identischem Datenfingerprint sowie Reconciliation-Digest bestanden haben. Der Restore-Drill deklariert zwingend `productionMutationPerformed=false`.

Der Verifier liest aus dem angegebenen Candidate-Commit die regulären Git-Blobs und berechnet deren SHA-256 neu. Exakt folgende Reihenfolge ist zulässig:

`057`, `060`, `061`, `062`, `065`, `068`, `069`, `070`, `071`, `072`, `073`, `074`, `075`, `076`, `077`, `078`, `079`.

Jeder Eintrag muss `APPLIED_PASS`, den Git-Blob-Digest, Cutover-Evidence, Postcondition-Evidence und einen zeitlich geordneten Apply-Zeitpunkt tragen. `061`, `062` und `065` akzeptieren ausschließlich `EXPLICIT_APPLIED_PASS_CUTOVER`; ein erfundenes `DEFERRED_PASS` ist unmöglich. Der danach erfasste, query-gebundene Post-Ledger muss exakt dieselben 17 Versionen und Candidate-Checksummen enthalten.

## Blob-, Deployment- und Monitoring-Gate

Der Production-Blob-Store-Fingerprint muss vom Preview-Blob-Store-Fingerprint verschieden sein. Die Legacy-Migration bindet Vorinventar, Migrationsbeleg und Postinventar; migrierte Anzahl muss der Legacy-Ausgangsanzahl entsprechen und der Legacy-Rest muss exakt null sein.

Nach Ledger, Blob und Monitoring-Bereitschaft gilt die Reihenfolge:

1. staged Production Deployment ohne Domain;
2. Rollback-Ziel `READY`;
3. Pre-Promotion-Smoke am staged Host, weiterhin `SAFE_CLOSED`;
4. exakte Alias-Promotion vom vorherigen zum staged Deployment;
5. Post-Promotion-Smoke über `www.novalure-crm.app` mit Ergebnis `PASS_SAFE_CLOSED`;
6. Abschluss der Evidence;
7. danach drei externe Signaturen.

Monitoring verlangt vor Staging jeweils digest-gebundene Nachweise für Error-Ingestion, synthetischen Alarm und Alarmzustellung. Dies ist nur Readiness, kein erfundenes Post-Aktivierungs-Beobachtungsfenster.

## Offline-Verifikation

```text
npm run release:verify-production-cutover -- \
  --document <absolute-external-production-cutover.json> \
  --trust-anchor <absolute-external-trust-anchor.json> \
  --expected-trust-anchor-sha256 <sha256> \
  --candidate <40-char-candidate-sha> \
  --staged-deployment-id <dpl_...> \
  --staged-deployment-host <immutable-host.vercel.app> \
  --rollback-deployment-id <dpl_...> \
  --rollback-deployment-host <immutable-host.vercel.app>
```

Die Cutover-Datei muss kanonisches JSON, regulär, größenbegrenzt, unverlinkt und außerhalb des Repositorys liegen. Der Loader bindet Realpath, `dev`, `ino`, Linkzahl, Größe und `mtime` über den offenen Dateihandle. Der Offline-Verifier ist read-only und netzwerkfrei.

Für eine Vercel-Runtime ohne `.git` existiert zusätzlich `verifyProductionCutoverReceiptBundle`. Dieser prüft Candidate/Target, den neu berechneten vollständigen Evidence-Digest, UTC-/Freshness-Grenzen und die drei externen Receipt-Signaturen, führt aber absichtlich keine Git- oder Provider-Abfragen aus. Der operative Offline-Verifier bleibt die Instanz, welche Git-Blobs und sämtliche Subbelege vollständig validiert.

## Launch-Bindung

Das nachfolgende `NOVALURE_LAUNCH_ACTIVATION_RECEIPT` bindet zusätzlich:

- `productionDeploymentHost`
- `productionCutoverEvidenceSha256`
- `productionCutoverDbaReceiptSha256`
- `productionCutoverPlatformOperationsReceiptSha256`
- `productionCutoverReleaseObserverReceiptSha256`

Der Launch-Verifier akzeptiert nur ein Cutover-Ergebnis für denselben Candidate, dieselbe Production-Deployment-ID und denselben staged Host. Die Aktivierungsprüfung muss außerdem vor `launchReadinessValidUntil` erfolgen. Ein fehlender, geänderter, zukünftiger, veralteter oder anders signierter Cutover-Nachweis verhindert die Aktivierung.
