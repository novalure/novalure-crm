# Regelmäßiges Datenbank- und Privatdatei-Backup

Der Node-24-Runner nutzt die bestehende Neon-/Vercel-Blob-Umgebung und verändert die laufende CRM-Anwendung nicht. Der tatsächliche kombinierte Lauf v3 ist mit HTTP 200 / `FULL` und unabhängigem Index-/Provider-Readback bestanden. Der geschützte Aufrufer im vorhandenen Backup-Projekt ist täglich um **03:15 UTC** aktiv. Der echte projektbezogene Neon-Schlüssel ist nativ mit HTTP 200 validiert und als sensible Production-Variable gespeichert; Production-OIDC-Identität und beide Storeverbindungen sind vorhanden. Die erste planmäßige Cron-Ausführung ist noch nicht beobachtet.

## Abgegrenzter Sicherungsumfang

`FULL_DATABASE_AND_DATABASE_REFERENCED_PRIVATE_FILES` bezeichnet einen festen nativen Neon-Snapshot der konfigurierten Datenbank und **sämtliche darin gespeicherten privaten `media_assets`**, einschließlich privater Bilder und aller historischen Knowledge-Versionsreferenzen. Der Snapshot enthält den vollständigen Branch-Datenbankstand; seine isolierte Kopie wird über alle nicht-systemischen Schemas, Tabellen, Katalogkategorien und Sequenzzustände geprüft. Die Inventarisierung benötigt keine SQL-Verbindung zum Produktionsendpunkt.

Das ist kein Nachweis eines vollständigen Backups der gesamten Anwendung. Öffentliche beziehungsweise `legacy-public`-Dateien werden separat aufgeführt und nicht kopiert. Objekte des Quellstores ohne Datenbankreferenz werden ebenfalls separat aufgeführt. Eine authentifizierte Abnahme einer wiederhergestellten Gesamtanwendung wird nicht behauptet. Das Manifest verschweigt diese Ausnahmen nicht.

Die alten Package-4-Skripte bleiben unverändert auf synthetische QA-Ressourcen begrenzt. Deren Schutzprüfungen werden nicht umgangen. Wiederverwendet werden ausschließlich die reinen Katalogabfragen, Datenbankmetadaten und kanonische Hash-Darstellung.

## Bedienung

Der Standardmodus liest ausschließlich lokale Konfiguration und Credential-Präsenz beziehungsweise lokale Identitätsclaims. Er ruft keinen Provider auf:

Ein vorhandener Credential-Wert ist damit noch nicht als gültige Anmeldung bestätigt. Die reale Providerprüfung ist ein eigener Nachweis; ein fehlgeschlagener Lauf bleibt `INCOMPLETE`.

```sh
node scripts/crm-full-backup.mjs
node scripts/crm-full-backup.mjs --plan
```

Eine optionale JSON-Konfiguration darf nur die in `defaultCrmBackupConfig` definierten nicht geheimen Bindungen sowie entweder `snapshotId` oder `pointInTime` mit `pitrBranchLimit` enthalten. Credentials in einer solchen Datei werden abgewiesen. Aktuelle Standardbindungen:

| Ressource | Bindung |
| --- | --- |
| Neon-Projekt | `misty-cloud-70835427` |
| Quellbranch / laufender Default | `br-spring-night-alyu48yp`, `main` |
| Unveränderlicher Produktionsendpunkt | `ep-wandering-union-alem0781` |
| Datenbank | `neondb` |
| Privater Quellstore | `store_vCn7LiyRocYNC8pM` |
| Privater Zielstore | `store_Xq45pbZfYunmR6ah` |
| Backup-/Restore-Projekt | `prj_bmEuDFXrLvSX2VXtt2GQ9Mbrfrlk` |
| Team | `team_sjD78IkSicXJK6TAOR1JC7Wv` |

Mit regulär bereitgestellten Zugangsdaten erfolgt eine tatsächliche Ausführung ausdrücklich:

```sh
node scripts/crm-full-backup.mjs --execute
node scripts/crm-full-backup.mjs --execute --snapshot snap-EXACT-ID --backup-id backup-EXACT-RUN-ID
```

Ohne `--snapshot` wird der jüngste verfügbare Snapshot des exakt konfigurierten Quellbranches ausgewählt. Der Runner erstellt keine Snapshots und ändert keine nativen Snapshot-Zeitpläne. Ein unveränderlicher Claim im privaten Zielstore verhindert einen zweiten Restore für denselben Snapshot. Ein unterbrochener Claim wird nicht automatisch übergangen oder durch eine weitere Restore-Anfrage ersetzt; er bleibt ausdrücklich zu prüfen.

### Isolierter Zweig aus der Datenhistorie

Der optionale PITR-Modus kopiert einen ausdrücklich gewählten UTC-Zeitpunkt aus der Historie des gebundenen Quellbranches. Er führt einen eigenen Claim pro Zeitpunkt und schreibt die angefragte Zeit, die von Neon gemeldete tatsächliche WAL-Zeit und den zugehörigen LSN ins private Manifest. Der Quellendpunkt bleibt gebunden. Der neue Child-Branch startet ohne Compute und bleibt nach der Sicherung mit bestätigtem deaktiviertem Compute als Wiederherstellungskopie erhalten. [Neon Branch API](https://neon.com/docs/reference/api/branches/create-project-branch)

```sh
node scripts/crm-full-backup.mjs --plan --point-in-time 2026-11-06T03:00:00Z --pitr-branch-limit 1
```

Nach Freigabe des exakten Stands aktiviert `CRM_FULL_BACKUP_COPY_MODE=point-in-time` im bestehenden dedizierten Backup-Aufrufer den Zeitpunkt 03:00 UTC des jeweiligen Tages. Der Zeitplan bleibt bei 03:15 UTC. `CRM_FULL_BACKUP_PITR_BRANCH_LIMIT` muss die genehmigte Zahl aufbewahrter PITR-Zweige setzen. Der Provider muss den Zeitpunkt in der tatsächlich verfügbaren Historie des Quellbranches bestätigen. Ein bereits beanspruchter Punkt, abgelaufene Historie, das Zweiglimit und unklare Providerantworten sperren den Versuch. Der Runner startet pro Claim höchstens einen Branch-Aufruf. Vor Aktivierung sind die tatsächliche Kapazität und Kostendeckung, die Aufbewahrung der Datenkopie, die zugelassene Release-Revision und der Rückweg zu prüfen.

Der geschützte Zielstore reserviert die genehmigten Plätze projektweit und unveränderlich vor dem Branch-Aufruf. Bei der erstmaligen Freigabe und bei einem Wechsel des Limits ist abzugleichen, dass jeder vorhandene verwaltete PITR-Zweig durch eine Reservierung gedeckt ist. Bei einem unklaren Ausgang bleibt ein reservierter Platz gesperrt. Für die laufende Aufbewahrung und eine später zugelassene Freigabe belegter Plätze braucht es einen eigenen Betriebsablauf. Manuelle Läufe und Veröffentlichungswechsel werden mit dem Zeitplan koordiniert.

## Erforderliche normale Berechtigungen

- `NEON_API_KEY`: Management-Credential ausschließlich für das benannte Neon-Projekt, regulär vom berechtigten Operator bereitgestellt. Storage-/AI-/Functions-Schlüssel sind kein Ersatz. Verbindungs-URIs werden nur für die neue isolierte Kopie abgerufen und ausschließlich im RAM verwendet.
- Production-OIDC: Der regulär bereitgestellte Aufrufer übernimmt das unveränderte aktuelle Token über `getVercelOidcTokenSync()` aus dem Vercel-Ausführungskontext. Ein Development-Token oder abgewiesener Development-Zugriff wird nicht umgedeutet oder erneut als Production-Zugriff versucht. Für einen anderen legitimen Operator-Aufrufer erwartet die CLI `VERCEL_OIDC_TOKEN` mit exakt diesen Bindungen. Im Prüfmodus erfolgen weder Refresh noch Netzwerkzugriff.
- Reguläre Production-OIDC-Verbindungen des Backup-Projekts zum Quell- und Zielstore. Der vorhandene CRM-Production-Zugriff und dessen Variablen bleiben unverändert. Unterschiedliche Präfixe, etwa `BACKUP_SOURCE_BLOB` und `BACKUP_TARGET_BLOB`, verhindern eine versehentliche Ersetzung der CRM-Konfiguration. Der SDK-Aufruf verwendet jeweils eine explizite Store-ID.

Der belegte normale Vercel-Vertrag für eine solche zusätzliche Verbindung ist `POST /v1/storage/stores/{storeId}/connections`, Header `x-vercel-use-oidc: 1`, Body `{projectId, envVarEnvironments:["production"], envVarPrefix, skipReadWriteToken:true}`. Diese normale Backup-Quellverbindung ist inzwischen eingerichtet. Die vorhandene Zielverbindung wurde per `PATCH /v1/storage/stores/{storeId}/connections/{connectionId}` um Production erweitert, einschließlich ausdrücklich beibehaltenem Development. Der [Readback](../qa/knowledge-operational-closure-2026-11-01/backup-blob-connections.json) bestätigt beide Bindungen und die erhaltene CRM-Verbindung. Der Runner selbst konfiguriert keine Grants. Das Provider-Grant begrenzt Projekt und Umgebung; eine Einschränkung auf reine Leseaktionen ist in diesem Vertrag nicht belegt. Der Quelladapter stellt deshalb ausschließlich `get/list` bereit, während `put` stets die andere, explizit gebundene Ziel-Store-ID verwendet. Der Runner besitzt keinen Delete-Port.

Es werden keine vorhandenen sensiblen Read-write-Werte ausgelesen, keine privaten Cookies gespeichert und keine neuen Claims erzeugt. Credential-Werte gelangen weder in Ausgaben noch in Dateien oder Manifeste. Die detaillierten Dateilisten verbleiben im privaten Zielstore.

## Geschützter Aufrufer im bestehenden Backup-Projekt

`scripts/prepare-crm-backup-workload.mjs` erzeugt in einem neuen Ordner außerhalb des CRM-Repositories ein eigenes Deploymentpaket. Es kopiert ausschließlich neun benannte Runner-/Bibliotheks- und Paketdateien einschließlich des vorbereiteten [Backupfehler-Warnadapters](backup-failure-warning-2026-11-03.md), erzeugt `/api/backup` und bindet `.vercel/project.json` fest an das Backup-Projekt und Team. CRM-Anwendungsdateien, Git-Historie und lokale `.env`-Dateien werden nicht übernommen. Vorhandene Ausgabeordner werden nicht überschrieben.

```sh
node scripts/prepare-crm-backup-workload.mjs --output /absolute/new-backup-directory
```

Das Standardpaket enthält **keinen Cron**. Der bereitgestellte Aufrufer prüft GET, einen neuen projektlokalen `CRON_SECRET` mit mindestens 32 Zeichen, die exakte Workload-Bindung und eine URL ohne Steuerparameter. Standard ist `CRM_FULL_BACKUP_ENABLED=false`: ausschließlich der lokale CLI-Plan, ohne Providerzugriff. Fehler und unbekannte Felder werden vor HTTP-Ausgabe und Logging entfernt. Die Deployment Protection bleibt erhalten; für berechtigte manuelle Prüfungen wird reguläres `vercel curl` verwendet.

Tatsächlich geprüft am 01.11.2026 um 16:27:57 UTC: Production-Deployment `dpl_FYQUe8K9oFtufsgfRVpRpcNHy522` im eigenen Backup-Projekt, Node 24. Autorisierte Planprobe HTTP 200, `BLOCKED`, einzig fehlendes Credential `NEON_API_KEY`; Anfrage ohne Cron-Zugang HTTP 401. Es gab keine Quellstore- oder Datenbankanfrage. Der [Deploymentbeleg](../qa/knowledge-operational-closure-2026-11-01/backup-preflight-deployment.json) enthält die Hashes der tatsächlich gepackten Dateien.

Der erste reale Lauf am 01.11. um 16:44:52 UTC meldete HTTP 503/`INCOMPLETE`. Auch der [spätere autorisierte Versuch](../qa/knowledge-operational-closure-2026-11-01/authorized-combined-backup-execution.json) um 18:00:09.614 UTC auf `dpl_Kj5bXmJUtYhpeD4Uem3jEQkKtZdj` scheiterte mit HTTP 503 und `NEON_REQUEST_FAILED`, erwarteter Snapshot `snap-ancient-hat-al16xd1i`. Der Zielpräfix-Readback um 18:02:57 UTC war vollständig und leer, ohne Claim. Die vorhandene Branchlesung zeigte keine neue Backup-Restorebranch; Produktion blieb auf ihrer bisherigen Branch. Der Provider-HTTPstatus dieses Versuchs ist in dessen Ausführungsquittung nicht enthalten.

Die [getrennte Read-only-Diagnose](../qa/knowledge-operational-closure-2026-11-01/readonly-neon-access-diagnosis.json) um 18:06:10.804 UTC auf `dpl_2MAUirQhzhcGsftFmBYwK3Wi1xwZ` erhielt für Projekt-, Branch- und Endpunkt-GET jeweils HTTP 401, ohne Mutation, SQL- oder Blobzugriff. Ein weiterer schreibgeschützter Durchlauf auf `dpl_641Xv4z6qVGUprJW2DDhp3vACLqW` bestätigte dies um 18:18:34.994 UTC. Die damaligen Deployments hatten das FULL-Flag aus und `crons:[]`; die nativen Credential-Metadaten waren noch von 16:42:01.603 UTC. Beide Fehlbefunde bleiben als Zustand vor der erfolgreichen neuen Übergabe erhalten.

Anschließend wurde über die reguläre Neon-Oberfläche der echte neue Schlüssel `crm-full-backup-20261101-1820z` für genau `misty-cloud-70835427` erzeugt. Ein nativer Helper-Projekt-GET erhielt HTTP 200 und passende Identität. Die native CLI meldete danach `SAVED` für `NEON_API_KEY`, sensibel und ausschließlich Production im bestehenden Backup-Projekt; die Metadaten wurden auf 18:19:48.409 UTC aktualisiert. Der Wert blieb im RAM. Der [Übergabebeleg](../qa/knowledge-operational-closure-2026-11-01/neon-management-credential-handoff.json) trennt diese tatsächlichen nativen Ergebnisse von der zuvor unbestätigten GUI-Speichermeldung und enthält keine Credentialwerte oder erfundenen Quellartefakthashes.

Validierte CLI-Fehlercodes bleiben als `failureCode` erhalten; rohe Providerfehler und Credentials werden ausgeschlossen. Die nachfolgende begrenzte Providerkorrektur erhält zusätzlich numerische Codes wie `NEON_HTTP_401`. Für sie sind 15 von 15 lokalen Providerprüfungen bestanden; die nativen Pflichtprüfungen für den finalen Head und die Mergequittung werden im zugehörigen Abschluss-Pull-Request belegt. Diese lokalen Prüfungen sind kein neuer vollständiger Betriebslauf.

Der danach tatsächlich ausgeführte [Gesamtlauf v3](../qa/knowledge-operational-closure-2026-11-01/combined-backup-full-execution.json) erhielt um 18:21:11.162 UTC HTTP 200 / `FULL`. Satz `backup-802b8e81-ebfb-4609-939f-3e9fd4782070` bindet Snapshot `snap-ancient-hat-al16xd1i` mit Datenpunkt **17:59:39 UTC**, isolierte Branch `br-late-bonus-alphwux4`, fünf private Dateien / 44.260 Bytes und zwei historische Referenzen an Manifesthash `eec51b47c3a1eedb68263952634f77f97ce087cff4dd52b9203607f3edf3468b`. Das ist ein neuer DB-Datenpunkt gegenüber dem früheren manuellen Restore um 14:23:47 UTC.

Der [unabhängige private Index-Readback](../qa/knowledge-operational-closure-2026-11-01/combined-backup-index-readback.json) bestätigte um 18:21:31.813 UTC FULL-Commitmarker, Manifesthash und Bindungen, ohne INCOMPLETE-Marker. Eine Target-Listung und vier Kontroll-GETs benötigten keine Quell-/Neonaufrufe oder Writes. Der [Provider-Readback](../qa/knowledge-operational-closure-2026-11-01/combined-backup-provider-readback.json) bestätigt den eigenen Restore-Endpunkt `ep-fancy-dawn-al0gh7wn` deaktiviert und idle; Restorebranch default/primary jeweils false. Produktion blieb unverändert auf ihrem bisherigen Endpunkt und Deployment. Der Scope ist vollständige Datenbank plus alle datenbankreferenzierten privaten Dateien; `wholeApplicationBackup=false`, öffentliche/Legacy-Dateien und unreferenzierte Objekte sind nicht mitgesichert.

Anschließend bestätigt der [Cron-Aktivierungsbeleg](../qa/knowledge-operational-closure-2026-11-01/backup-cron-activation.json) um 18:22:55.562 UTC `dpl_D2reD5otiHjAHvFgRqohV4KCPwSy` als Production / `READY`, `/api/backup` mit `15 3 * * *`, `disabledAt=null` und `CRM_FULL_BACKUP_ENABLED=true`. Alle neun Codehashes entsprechen dem bestandenen FULL-Paket. Credential-Metadaten und OIDC-Verbindungen blieben erhalten; die Aktivierung verursachte genau ein Deployment, keinen zusätzlichen Backup-Lauf und keine Neon-/CRM-Aktion. Nächster vorgesehener Termin: **02.11. 03:15 UTC / 04:15 Europe/Vienna**. Die erste planmäßige Ausführung bleibt unbeobachtet. Das DB-Snapshotfenster um 03:00 UTC und die CRM-Anwendungszeitpläne bleiben erhalten.

Der getrennte manuelle Dateirestore ist inzwischen vollständig: fünf Originalpfade und 44.260 Bytes, einschließlich TXT, mit Source-/Target-SHA256 und jeweils anonymem HTTP 403. Zwei vorhandene PDFs wurden wiederverwendet; nur drei fehlende Originalobjekte wurden append-only ergänzt. Der normale temporäre Operatorzugang war ausschließlich dem neuen Backup-Projekt zugeordnet und ist wieder entfernt; ein frischer Development-Zugriff auf die Quelle erhält HTTP 403. Das Provider-Grant wurde nicht als read-only ausgegeben. Siehe [Dateibeleg](../qa/knowledge-operational-closure-2026-11-01/manual-private-file-restore.json).

Eine schmale Read-only-Abfrage auf der bereits geprüften isolierten Datenbank bestätigt alle fünf IDs, Workspaces, Originalpfadhashes, Größen und MIME-Typen sowie beide historischen Dokumentreferenzen einschließlich Original-SHA256. Der bestandene Vollvergleich des Datenpunkts 14:23:47 UTC wird wiederverwendet; der 200-Tabellen-Scan wurde nicht wiederholt. Der Zielcompute ist danach wieder deaktiviert und idle, der Produktionsendpunkt unverändert. [Gemeinsamer Zuordnungsbeleg](../qa/knowledge-operational-closure-2026-11-01/database-file-reference-pairing.json).

Ein Archivpräfix allein wird vom unveränderten Media-Reader nicht als Originalpfad akzeptiert. Eine isolierte App-Abnahme benötigt zusätzlich ihre eigene Restore-DB- und Zielstore-Credentialbindung; sie wird durch die bestandenen Daten-/Dateiwiederherstellungen nicht behauptet. Tatsächlicher FULL-Lauf und regelmäßige Aktivierung sind belegt; eine erste planmäßige Ausführung wird nicht vorweggenommen.

PR #123 ist seit 01.11. um 17:33:20 UTC als `ed6db844e3850c05b344c923b5c92151fe486c6c` zusammengeführt. Für den finalen Head `aa9536b3b875fb3eebba05a9e64c8d7b9fa37ccd` sind [Quality #41331277944](https://github.com/novalure/novalure-crm/actions/runs/41331277944) in 7 Minuten 58 Sekunden und [Secret Scan #41331277640](https://github.com/novalure/novalure-crm/actions/runs/41331277640) in zwölf Sekunden erfolgreich; Vercel-Deployment `dpl_7zE64Br4DrMJLkni9Kf9KGGqnQrz` war `READY`. Der manuelle Candidate-Job war `SKIPPED`. Diese Quittungen gelten für den zusammengeführten Stand, nicht vorab für die nachfolgende Providerkorrektur.

## Ablauf und Abschluss

1. Lokale Bindungs- und Credential-Prüfung. Der erste Provider-Zugriff ist die authentifizierte Quellstore-Inventarisierung, bevor ein Neon-Restore angefordert wird.
2. Produktionsprojekt, Endpunktbindung sowie Default-/Primary-Branch und Name lesen. Stabile IDs und Bindungen müssen vor und nach Provider-Schritten unverändert bleiben; normale Aktivitätszeitstempel sind kein Fehlersignal.
3. Genau einen nativen Snapshot auswählen und einen neuen Restore mit fest verdrahtetem `finalize_restore:false` anfordern. `target_branch_id` wird nicht gesendet. Es gibt keinen Finalize-Port. Ein finalisierter, zum Default gewordener oder fremder Rückgabebranch wird abgewiesen.
4. Sämtliche von Restore bereits angelegten beziehungsweise später auf der isolierten Kopie gefundenen Endpoints berücksichtigen. Ausschließlich diese Kopie wird für lesende SQL-Abfragen verwendet. Aktive RLS-Filter, externe Fremdtabellen, unvollständige Referenzen oder falsche Bindungen verhindern den Abschluss.
5. Für jede private Datei die tatsächlichen gestreamten Bytes, Größe und SHA256 prüfen. Falls historische Versionen einen Byte-Hash enthalten, muss dieser ebenfalls passen. Exakt passende vorhandene Originalpfade im Zielstore werden nach echtem Rücklesen wiederverwendet; für diese Objekte erfolgt kein erneutes `put`. Andere Kopien werden ausschließlich im neuen Backup-Präfix append-only mit `allowOverwrite:false` und `addRandomSuffix:false` geschrieben und danach vollständig zurückgelesen.
6. Alle isolierten Endpoints abschalten und anschließend nochmals vollständig lesen: `disabled:true` **und** `current_state:idle` müssen für jeden Endpoint tatsächlich beobachtet sein. Das ist ein zeitpunktbezogener Nachweis, keine Behauptung, dass ein Provider nie einen späteren Verfügbarkeitscheck ausführt.
7. Privates kanonisches Manifest schreiben und zurücklesen. Ein Index-Kandidat ist noch kein Erfolg. Erst der abschließende, überprüfte `FULL.json`-Marker bindet den Manifest-Hash an Snapshot, Datenbankfingerprint, Dateien, historische Referenzen und Cleanup-Receipts. Bei Fehlern wird `INCOMPLETE` geschrieben, soweit die Zielberechtigung dies zulässt; die CLI meldet keinen vollständigen Erfolg.

Bei einer unklaren Restore-Antwort wird die Mutation nicht blind wiederholt. Produktionsdrift beendet weitere Neon-Mutationen. Die Produktion wird vom Runner niemals durch einen weiteren Restore, Endpoint-Wechsel, Rollback, eine Migration oder geänderte Grants „repariert“.

## Index und Aufbewahrung

Die Zielobjekte liegen unter `crm-full-backups/sets/<backupId>/`; der Index unter `crm-full-backups/index/`, Snapshot-Claims unter `crm-full-backups/snapshots/<snapshotId>/`. Ein Index-Kandidat allein darf nicht als FULL gelesen werden: Der vollständige Marker und dessen Manifest-Hash müssen passen; widersprechende INCOMPLETE-Evidence darf nicht ignoriert werden.

Die Aufbewahrung ist zunächst ausschließlich ein lokaler Plan:

```sh
node scripts/crm-full-backup.mjs --retention-index /private/path/verified-backup-index.json
```

`planBackupRetention` berücksichtigt nur fertig geprüfte FULL-Sätze mit passendem Quell-/Zielstore und eigenem Präfix. Der jüngste FULL-Satz bleibt geschützt. Source-, fremde und bereits anderweitig vorhandene wiederverwendete Objekte sind niemals Löschziele. Vor einer späteren tatsächlichen Bereinigung müssen Manifest, Referenzen, Ownership und vorhandener jüngster FULL-Satz erneut geprüft werden. Dieser Code löscht keine Dateien, Branches oder Snapshots. Die Aufbewahrung eines nativen Snapshots ist separat vom Dateibestand zu berücksichtigen; ein abgelaufener oder nicht mehr verfügbarer Datenbank-Recoverypunkt ist kein aktuell verwendbarer FULL-Satz.

Das produktive PITR-Fenster von sechs Stunden allein reicht für spät erkannte CRM-Fehler nach einer Nacht oder einem Wochenende nicht aus. Der bestätigte native DB-Plan täglich um 03:00 UTC mit sieben Tagen Aufbewahrung verbessert die Datenbankabdeckung, sichert aber keine Blob-Dateien. Der kombinierte FULL-Lauf und sein täglicher Cron um 03:15 UTC sind nun belegt; die erste planmäßige Ausführung steht noch aus. Geschäfts-RPO und vollständiges Anwendungs-RTO sind nicht vereinbart beziehungsweise gemessen; automatische Aufbewahrungs-Löschungen bleiben ein Plan ohne tatsächliche Ausführung.

## Gezielte lokale Prüfungen

```sh
npm run test:crm-full-backup
```

Die Prüfungen verwenden ausschließlich lokale Provider-Ports. Sie belegen die Sicherheitsgrenzen des Runners, keine neue Production-Abnahme, keine neuen Blob-Berechtigungen und keinen tatsächlich durchgeführten Backup-Lauf. Provider-Aktivierung, Zeitplanbelege und eine reale vollständige Ausführung werden separat protokolliert.

Offizielle Provider-Verträge: [Neon Snapshot-Restore](https://neon.com/docs/reference/api/snapshots/restore-snapshot), [Endpoint-Update](https://neon.com/docs/reference/api/endpoints/update-project-endpoint), [Backup und Aufbewahrung](https://neon.com/docs/guides/backup-restore). Die vorhandenen Website-, Teams- und Kalender-Zeitpläne werden von diesem Paket nicht bearbeitet.
