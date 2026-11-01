# Regelmäßiges Datenbank- und Privatdatei-Backup

Der Node-24-Runner nutzt die bestehende Neon-/Vercel-Blob-Umgebung und verändert die laufende CRM-Anwendung nicht. Der eigene geschützte HTTP-Aufrufer ist im vorhandenen Backup-Projekt als Production-Prüfbetrieb bereitgestellt; Ausführung und Cron bleiben deaktiviert. Die echte Production-OIDC-Identität kommt aus dem Vercel-Ausführungskontext. Ohne den projektbezogenen Neon-Managementschlüssel bleibt der Gesamtlauf vor dem ersten Remote-Aufruf `BLOCKED`.

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

Eine optionale JSON-Konfiguration darf nur die in `defaultCrmBackupConfig` definierten nicht geheimen Bindungen und `snapshotId` enthalten. Credentials in einer solchen Datei werden abgewiesen. Aktuelle Standardbindungen:

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

## Erforderliche normale Berechtigungen

- `NEON_API_KEY`: Management-Credential ausschließlich für das benannte Neon-Projekt, regulär vom berechtigten Operator bereitgestellt. Storage-/AI-/Functions-Schlüssel sind kein Ersatz. Verbindungs-URIs werden nur für die neue isolierte Kopie abgerufen und ausschließlich im RAM verwendet.
- Production-OIDC: Der regulär bereitgestellte Aufrufer übernimmt das unveränderte aktuelle Token über `getVercelOidcTokenSync()` aus dem Vercel-Ausführungskontext. Ein Development-Token oder abgewiesener Development-Zugriff wird nicht umgedeutet oder erneut als Production-Zugriff versucht. Für einen anderen legitimen Operator-Aufrufer erwartet die CLI `VERCEL_OIDC_TOKEN` mit exakt diesen Bindungen. Im Prüfmodus erfolgen weder Refresh noch Netzwerkzugriff.
- Reguläre Production-OIDC-Verbindungen des Backup-Projekts zum Quell- und Zielstore. Der vorhandene CRM-Production-Zugriff und dessen Variablen bleiben unverändert. Unterschiedliche Präfixe, etwa `BACKUP_SOURCE_BLOB` und `BACKUP_TARGET_BLOB`, verhindern eine versehentliche Ersetzung der CRM-Konfiguration. Der SDK-Aufruf verwendet jeweils eine explizite Store-ID.

Der belegte normale Vercel-Vertrag für eine solche zusätzliche Verbindung ist `POST /v1/storage/stores/{storeId}/connections`, Header `x-vercel-use-oidc: 1`, Body `{projectId, envVarEnvironments:["production"], envVarPrefix, skipReadWriteToken:true}`. Diese normale Backup-Quellverbindung ist inzwischen eingerichtet. Die vorhandene Zielverbindung wurde per `PATCH /v1/storage/stores/{storeId}/connections/{connectionId}` um Production erweitert, einschließlich ausdrücklich beibehaltenem Development. Der [Readback](../qa/knowledge-operational-closure-2026-11-01/backup-blob-connections.json) bestätigt beide Bindungen und die erhaltene CRM-Verbindung. Der Runner selbst konfiguriert keine Grants. Das Provider-Grant begrenzt Projekt und Umgebung; eine Einschränkung auf reine Leseaktionen ist in diesem Vertrag nicht belegt. Der Quelladapter stellt deshalb ausschließlich `get/list` bereit, während `put` stets die andere, explizit gebundene Ziel-Store-ID verwendet. Der Runner besitzt keinen Delete-Port.

Es werden keine vorhandenen sensiblen Read-write-Werte ausgelesen, keine privaten Cookies gespeichert und keine neuen Claims erzeugt. Credential-Werte gelangen weder in Ausgaben noch in Dateien oder Manifeste. Die detaillierten Dateilisten verbleiben im privaten Zielstore.

## Geschützter Aufrufer im bestehenden Backup-Projekt

`scripts/prepare-crm-backup-workload.mjs` erzeugt in einem neuen Ordner außerhalb des CRM-Repositories ein eigenes Deploymentpaket. Es kopiert ausschließlich acht benannte Runner-/Bibliotheks- und Paketdateien, erzeugt `/api/backup` und bindet `.vercel/project.json` fest an das Backup-Projekt und Team. CRM-Anwendungsdateien, Git-Historie und lokale `.env`-Dateien werden nicht übernommen. Vorhandene Ausgabeordner werden nicht überschrieben.

```sh
node scripts/prepare-crm-backup-workload.mjs --output /absolute/new-backup-directory
```

Das Standardpaket enthält **keinen Cron**. Der bereitgestellte Aufrufer prüft GET, einen neuen projektlokalen `CRON_SECRET` mit mindestens 32 Zeichen, die exakte Workload-Bindung und eine URL ohne Steuerparameter. Standard ist `CRM_FULL_BACKUP_ENABLED=false`: ausschließlich der lokale CLI-Plan, ohne Providerzugriff. Fehler und unbekannte Felder werden vor HTTP-Ausgabe und Logging entfernt. Die Deployment Protection bleibt erhalten; für berechtigte manuelle Prüfungen wird reguläres `vercel curl` verwendet.

Tatsächlich geprüft am 01.11.2026 um 16:27:57 UTC: Production-Deployment `dpl_FYQUe8K9oFtufsgfRVpRpcNHy522` im eigenen Backup-Projekt, Node 24. Autorisierte Planprobe HTTP 200, `BLOCKED`, einzig fehlendes Credential `NEON_API_KEY`; Anfrage ohne Cron-Zugang HTTP 401. Es gab keine Quellstore- oder Datenbankanfrage. Der [Deploymentbeleg](../qa/knowledge-operational-closure-2026-11-01/backup-preflight-deployment.json) enthält die Hashes der tatsächlich gepackten Dateien.

Der erste reale Lauf am 01.11. um 16:44:52 UTC meldete HTTP 503/`INCOMPLETE`. Eine separate Read-only-Anmeldeprüfung wies den aus der Browserautomation übernommenen Wert mit HTTP 401 ab. Im privaten Backup-Namensraum wurden danach keine Objekte oder Claims und im Projekt keine neue Backup-Restorebranch gefunden. Die Ausführung ist wieder deaktiviert; der gültige Schlüssel wird über die normale direkte Dashboard-Übergabe eingerichtet. Validierte CLI-Fehlercodes bleiben künftig als `failureCode` in Antwort und Log erhalten; rohe Providerfehler und Credentials werden ausgeschlossen.

Nach erfolgreicher Credential-Prüfung ist zunächst ein tatsächlicher vollständiger Lauf zu prüfen. Erst dann wird der Aufrufer mit `CRM_FULL_BACKUP_ENABLED=true` und dem expliziten Paketflag `--enable-cron` täglich um **03:15 UTC** aktiviert. Die bestehenden Production-OIDC-Verbindungen und die Development-Verbindung des Zielstores werden dabei erhalten. Das native DB-Snapshotfenster um 03:00 UTC und die CRM-Anwendungszeitpläne werden nicht ersetzt. Aktivierung, echter FULL-Lauf und Aufbewahrung sind getrennte Nachweise; ein erfolgreicher Plan ist kein vollständiges Backup.

Für den anschließenden Dateirestore müssen sämtliche fünf Asset-Originalpfade im getrennten Zielstore vorhanden und rückgelesen sein. Der Archivpräfix allein wird vom unveränderten Media-Reader nicht als Originalpfad akzeptiert. Vorhandene PDFs werden wiederverwendet; die fehlenden Originalpfade werden erst aus einem tatsächlich verifizierten Archiv materialisiert. Eine isolierte App-Abnahme benötigt zusätzlich ihre eigene Restore-DB- und Zielstore-Credentialbindung; sie wird durch einen SDK-Archivlesetest nicht behauptet.

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

## Gezielte lokale Prüfungen

```sh
npm run test:crm-full-backup
```

Die Prüfungen verwenden ausschließlich lokale Provider-Ports. Sie belegen die Sicherheitsgrenzen des Runners, keine neue Production-Abnahme, keine neuen Blob-Berechtigungen und keinen tatsächlich durchgeführten Backup-Lauf. Provider-Aktivierung, Zeitplanbelege und eine reale vollständige Ausführung werden separat protokolliert.

Offizielle Provider-Verträge: [Neon Snapshot-Restore](https://neon.com/docs/reference/api/snapshots/restore-snapshot), [Endpoint-Update](https://neon.com/docs/reference/api/endpoints/update-project-endpoint), [Backup und Aufbewahrung](https://neon.com/docs/guides/backup-restore). Die vorhandenen Website-, Teams- und Kalender-Zeitpläne werden von diesem Paket nicht bearbeitet.
