# Production-Cutover-Receipt – PRE_ACTIVATION_READY

Stand: 02.09.2026

Status: **Vertrag implementiert, keine Production-Aktion ausgeführt, keine Freigabe behauptet**

## Sicherheitsgrenze

Der Vertrag in `scripts/lib/production-cutover-receipt.mjs` kann ausschließlich einen bereits vollständig ausgeführten und extern belegten Cutover als `PRE_ACTIVATION_READY` verifizieren. Er führt selbst weder Vercel-, Neon-, Blob-, Alias- noch Monitoring-Aktionen aus. Er darf keine Beobachtung nach Launch-Aktivierung behaupten: Der abschließende Production-Smoke muss die Anwendung nach Alias-Promotion ausdrücklich noch `SAFE_CLOSED` sehen.

Schema-Version **2** beseitigt die frühere zirkuläre Abhängigkeit ausdrücklich: Cutover-Signaturen sind vor der Alias-Promotion ungültig. Die Promotion findet bei sicher geschlossenem Launch-Flag statt; erst der danach bestandene Safe-Closed-Smoke schließt die Cutover-Evidence ab.

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
- Jedes Cutover-Receipt muss zusätzlich innerhalb von **5 Minuten** nach `completedAt` signiert sein. Die späteste der drei Signaturen ist die früheste zulässige Grenze für die nachfolgende Aktivierungs-Lease.
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

Die dependency-sichere Apply-Reihenfolge ist:

`057`, `060`, `062`, `065`, `068`, `069`, `070`, `071`, `072`, `073`, `074`, `075`, `076`, `077`, `078`, `079`, `080`, `081`, `082`, `083`, `084`, `061`.

`061` ist bewusst der letzte Datenbank-Cutover. Die zwei Audit-Snapshot-FKs sind zu diesem Zeitpunkt bereits durch `068` entfernt und werden von der korrigierten `061` nicht mehr validiert. `062` setzt sowohl `051` als auch `060` voraus und beweist innerhalb derselben Runner-Transaktion, dass der ursprüngliche FORCE-RLS-Zustand exakt wiederhergestellt und der Append-only-Guard nach dem eng begrenzten Legacy-Scrub wieder aktiviert ist.

Jeder Eintrag muss `APPLIED_PASS`, den Git-Blob-Digest, Cutover-Evidence, Postcondition-Evidence und einen zeitlich geordneten Apply-Zeitpunkt tragen. `061`, `062`, `065` und `080`–`084` akzeptieren ausschließlich `EXPLICIT_APPLIED_PASS_CUTOVER`; ein erfundenes `DEFERRED_PASS` ist unmöglich. In Production sind **alle 22 Migrationen** des Vertrags `FULL_PRODUCTION_CHAIN_057_084_RLS_LAST_V2` geschützt: Jede benötigt zusätzlich zu `--allow-manual-cutover` und genau einer `--only`-Migration ein kanonisches, extern gespeichertes Evidence-Dokument (`--production-promotion-evidence`), einen extern gespeicherten Trust Anchor (`--production-promotion-trust-anchor`) und dessen SHA-256 (`--production-promotion-trust-anchor-sha256`). Der Runner prüft die zwei unabhängigen Ed25519-Receipts für Preview und Recovery offline, bindet Candidate, Production-Zielidentität, den Planvertrag, die Checksummen der vollständigen 22er-Kette und den Evidence-Digest in den Dry-run-Plan-Token. Der Production-Ledger darf dabei nur ein exaktes Präfix der festgelegten Reihenfolge sein; insbesondere wird `061` erst nach allen 21 Vorgängern akzeptiert.

Der über die CLI gelieferte Trust-Anchor-Digest genügt nicht als eigener Vertrauensanker. Ein zweiter, code-reviewter Pin in `scripts/lib/production-migration-promotion-evidence.mjs` muss `status=ACTIVE` und exakt denselben SHA-256 tragen. Er steht derzeit bewusst auf `PENDING_SECURITY_OWNER_KEY`; deshalb bleibt jeder Production-Migrationsversuch auch mit formal gültigem externem Bundle fail-closed. Erst ein gesondert geprüfter Commit des Security Owners darf diesen Pin aktivieren. Der danach erfasste, query-gebundene Post-Ledger muss exakt dieselben 22 Versionen und Candidate-Checksummen enthalten.

Für den letzten Schritt 061 führt der Standardrunner im Production-Pfad zusätzlich die zentral definierte Rollenprovisionierung aus `scripts/lib/tenant-cutover-role-provisioning.mjs` aus. Unter demselben Advisory Lock liegen Rollen-Preflight, exakt `novalure-tenant-cutover:<candidateCommit>` gebundener Kommentar, Membership-Postcondition, 061-SQL und Ledgerinsert in einer PostgreSQL-Transaktion. `novalure_app` darf dabei außer `novalure_tenant_app` keine über `SET` oder `USAGE` erreichbare Rolle besitzen. 061 entfernt außerdem sämtliche direkten Alt-ACLs von `novalure_app` auf den fünf Pilot-Tabellen und prüft anschließend den vollständigen Tabellen-, Spalten- und Owner-ACL-Graph einschließlich `PUBLIC` und SET-only-Rollen; nur die expliziten DML-Rechte von `novalure_tenant_app` sind erlaubt. Ein Fehler an einer dieser Stellen rollt auch Rollenmitgliedschaft, Kommentar und ACL-Änderungen zurück; eine alte, lediglich formatgültige Rollen-Attestation genügt nicht.

Die Down-Skripte `080`–`084` bleiben absichtlich Preview-only und dürfen nicht auf Production ausgeführt werden. Der Production-Rollback ist der zuvor belegte PITR-/Branch-Restore des unveränderten Snapshots; sobald produktive Daten in den neuen Strukturen liegen, ist ein destruktiver Schema-Down kein zulässiger Rollback.

## Blob-, Deployment- und Monitoring-Gate

Der Production-Blob-Store-Fingerprint muss vom Preview-Blob-Store-Fingerprint verschieden sein. Die Legacy-Migration bindet Vorinventar, Migrationsbeleg und Postinventar; migrierte Anzahl muss der Legacy-Ausgangsanzahl entsprechen und der Legacy-Rest muss exakt null sein.

Nach Ledger, Blob und Monitoring-Bereitschaft gilt ohne Überspringen oder Vorziehen die atomare Reihenfolge:

1. `PHASE_1_STAGE_PRECHECKS`: Production-Candidate mit `vercel --prod --skip-domain` ohne Domain stagen; Rollback-Ziel als `READY` verifizieren; Pre-Promotion-Smoke am unveränderlichen staged Host mit `SAFE_CLOSED` bestehen.
2. `PHASE_2_FLAGS_OFF`: `novalure-production-launch-activation` im Vercel-Projekt `prj_R32Okl6AHijTohvuKmryuTLjWMsk` und Environment `production` über einen frischen Remote-Read (`REMOTE_NO_STORE`) als exakt `OFF` beobachten. Evidence-Digest, Beobachtungszeit und positive Flags-Revision werden im Cutover-Dokument gebunden.
3. `PHASE_3_PROMOTE`: erst danach den exakten staged Deployment-Digest vom vorherigen Rollback-Deployment auf `www.novalure-crm.app` promoten.
4. `PHASE_4_SAFE_CLOSED_SMOKE`: erst nach der Promotion den Production-Alias prüfen; Deployment-ID muss dem staged Candidate entsprechen und das Ergebnis exakt `PASS_SAFE_CLOSED` sein.
5. `PHASE_5_SIGN_CUTOVER`: Evidence erst nach diesem Smoke mit `completedAt` abschließen; anschließend signieren DBA, Platform Operations und Release Observer denselben kanonischen Digest innerhalb von fünf Minuten.
6. `PHASE_6_ACTIVATION_LEASE`: der Launch Activation Attestor darf Receipt und höchstens 30-minütige Lease erst nach der spätesten Cutover-Signatur ausstellen. Die Lease muss vollständig vor `launchReadinessValidUntil` enden.
7. `PHASE_7_FLAGS_ON`: den signierten Capability-Wert erst danach in denselben Flag schreiben. Seine Flags-Revision muss strikt größer als die in `PHASE_2_FLAGS_OFF` gebundene Revision sein.
8. `PHASE_8_ACTIVATION_SMOKE`: unmittelbar danach den Alias und die freigegebenen `LAUNCH-ON`-/`INTERNAL-ONLY`-Surfaces als aktiv prüfen. Dieser Post-Aktivierungsnachweis ist kein Bestandteil von `PRE_ACTIVATION_READY` und darf niemals rückdatiert werden.

Bei jeder Abweichung ab `PHASE_3_PROMOTE` gilt: zuerst Flag auf `OFF`, dann das vorher verifizierte Deployment zurückpromoten, alte Candidate-Erreichbarkeit sperren und den Incident-/Beobachtungsnachweis fortführen. Ein fehlender Activation-Smoke ist kein GO.

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

Zusätzlich übernimmt der Launch-Verifier die in der frischen `OFF`-Beobachtung gebundene Flags-Revision exakt als `flagsRevisionFloor`. Dadurch kann nur ein späterer Control-Plane-Write (`revision > flagsRevisionFloor`) aktivieren. Aktivierungs-Receipt und `activationNotBefore` dürfen nicht vor der spätesten der drei Cutover-Signaturen liegen; `activationExpiresAt` darf die Cutover-Readiness nicht überschreiten.
