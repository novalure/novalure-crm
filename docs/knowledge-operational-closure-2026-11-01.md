# Knowledge Center: Betriebsabschluss, Stand 1. November 2026

Dieser Auftrag betrifft ausschließlich das Knowledge Center in `novalure/novalure-crm`, PR #120 und die Betriebsfortsetzung in PR #122. Er ist unabhängig von Paket 4 der gemeinsamen Lernplattform. Die früheren CRM-Berichte bleiben datierte Historie.

**Betriebsabnahme noch offen:** Die tatsächliche Anwendungs-/DB-Bindung, ein normaler privater Dateiabruf und ein vollständiger isolierter Datenbankrestore sind bestätigt. Zwei der fünf privaten Dateien sind im getrennten Zielstore wiederhergestellt und geprüft; drei fehlen noch. Ein täglicher nativer DB-Sicherungsplan mit sieben Tagen Aufbewahrung ist aktiv. Ein vollständiger DB-/Privatdatei-Sicherungslauf und dessen betriebliche Abnahme bleiben offen. Der erste Restoreversuch verursachte einen Produktionsvorfall; er wird unten ausdrücklich offengelegt.

| Bereich | Tatsächliches Ergebnis |
| --- | --- |
| Produktionsanwendung und eingeschränkte DB-Rolle | Reguläre CRM-Sitzung; Antwort und nativer Laufzeitlog über dieselbe Korrelations-ID bestätigt |
| Normaler privater Dateiabruf | HTTP 200 mit Sitzung, unabhängig HTTP 401 ohne Sitzung; 996 Bytes und SHA256 erfasst |
| Isolierter vollständiger DB-Restore | Quelle vorher = Restore = Quelle nachher: 200 Tabellen, 5.092 Zeilen, 28 Katalogkategorien, zwei Sequenzen |
| Vollständiger Privatdatei-Restore | Teilweise: zwei PDFs mit 21.323 von insgesamt 44.260 Bytes wiederhergestellt; drei der fünf referenzierten privaten Assets fehlen noch |
| Regelmäßige DB-Sicherung | Nativer Plan täglich um 03:00 UTC, sieben Tage Aufbewahrung; am 01.11. um 15:59:27 UTC verifiziert. Ausschließlich Datenbank |
| Backup-Aufrufer | Geschützt bereitgestellt; erster tatsächlicher Gesamtlauf am 01.11. um 16:44:52 UTC mit HTTP 503 / `INCOMPLETE` beendet. Danach wieder pausiert; Backup-Cron aus |
| Sicherer Preview-Weg | 65 geerbte Schlüssel geleert und fünf Schutzflags ausschließlich für den eigenen Branch; unveränderte geteilte/produktive Records nachgewiesen |
| CI, echter Vercel-Check und Merge | Native Quality, Secret Scan und Vercel-Preview für `52f009c` erfolgreich; [PR #120](https://github.com/novalure/novalure-crm/pull/120) am 01.11. um 14:44:11 UTC als `a45625d` zusammengeführt |
| Betriebsfortsetzung PR #122 | Native Quality, Secret Scan und Vercel-Preview für `ad7f647` erfolgreich; [PR #122](https://github.com/novalure/novalure-crm/pull/122) am 01.11. um 16:44:00 UTC als `8baace9` zusammengeführt |

## Tatsächliche Laufzeitbindung

Am 01.11. um 15:08:53 Uhr Europe/Vienna wurde `/api/system/database` über eine regulär angemeldete CRM-Sitzung geöffnet. Die Antwort passt zum nativen Produktionslog mit Korrelations-ID `975b89af-e93d-4af5-89cb-47c9edaccd4f`.

- Deployment: `dpl_HPDsGkXp4M4LVp7TSpuHh7jKyAeC`, produktiver Git-Stand `6daf9b697cd8faef1c8166f16bf1853aaba3153a`.
- Tatsächlich konsumierte Datenbank: `misty-cloud-70835427 / br-spring-night-alyu48yp / neondb`.
- `current_user` und `session_user`: `novalure_app`; `leastPrivilege=true`, `runtimeProof.status=PASS`.
- Keine Superuser-, BYPASSRLS-, CREATE-, Replikations-, Eigentümer- oder Read/Write-All-Rechte; keine erreichbaren erhöhten Rollen. Die geforderten RLS-Tabellen bleiben geschützt.

Die Diagnosehülle meldet weiterhin `ok:false`: Der administrative Migrationsledger ist nicht verfügbar; zwei administrative Company-Profile-Tabellen erscheinen in der eingeschränkten Sicht als fehlend. Eine getrennte Kataloglesung als `neondb_owner` bestätigt, dass beide Tabellen existieren. Es wurden weder Tabellen neu angelegt noch Runtime-Rechte erweitert. Der frühere separate Ledger-/Quellvergleich bleibt sein eigener Nachweis.

## Normaler privater Dateiabruf

Die vorhandene Route `/api/media/files/38281e11-b877-44a5-8f9c-8303d37bf7b5` wurde mit der regulären Sitzung abgerufen. Das native Requestprotokoll bestätigt am 01.11. um 15:12:27 Uhr Europe/Vienna HTTP 200 auf dem erwarteten Produktionsdeployment. Ein unabhängiger Abruf ohne Cookie erhielt HTTP 401.

Der Benutzer stellte die tatsächlich heruntergeladenen Bytes bereit: 996 Bytes, SHA256 `67f9107c8362338fd6630e15c29c55ec840b8236c75ff3ebebc12a3ec9bf74cc`. Dateiinhalte, Dateinamen, Cookies und Tokens sind nicht Teil der Repositorynachweise.

Der legitime CLI-Metadatenzugriff bestätigt den vorhandenen privaten Store `store_vCn7LiyRocYNC8pM`. Dieser meldet sechs Objekte und 47.047 Bytes; die Datenbank enthält fünf referenzierte private Assets mit 44.260 Bytes. Die Abweichung wurde erfasst und nicht stillschweigend als zusätzliche Datenbankreferenz behandelt.

Die gespeicherte sensible Produktionsvariable lieferte beim genau adressierten normalen API-Zugriff `decrypted:false` und keinen Wert. Ein einmaliger, offiziell unterstützter Development-OIDC-Zugang hatte passende Team-/Projekt-/Development-Claims; der Quell-Blobdienst verweigerte den Dateiabruf mit HTTP 403. Diese abgewiesene Development-Anforderung wurde nicht wiederholt oder umgangen. Die spätere reguläre Production-Verbindung ist unten getrennt dokumentiert.

Später wurde der getrennte private Zielstore `store_Xq45pbZfYunmR6ah` im Backup-Projekt `prj_bmEuDFXrLvSX2VXtt2GQ9Mbrfrlk` zunächst mit ausschließlich Development-OIDC-Zugriff eingerichtet. Zwei vom Benutzer normal heruntergeladene PDFs wurden dort wiederhergestellt: **zwei von fünf Dateien, 21.323 von 44.260 Bytes**. Das vollständige Zielinventar stimmte mit diesen beiden erwarteten Objekten überein; Größe, SHA256 und Rücklesen wurden geprüft. Ein anonymer Zielabruf wurde mit HTTP 403 abgewiesen. Die Teilwiederherstellung schrieb weder in den Quellstore noch in die Produktionsdatenbank. Der sanitisierte Beleg `partial-restore-2-of-5-receipt.json` wurde am 01.11. um 15:49:43 UTC abgeschlossen; seine Prüfsumme und Ergebnisse stehen im [maschinenlesbaren Bericht](../qa/knowledge-operational-closure-2026-11-01/operational-evidence.json). Drei Dateien beziehungsweise 22.937 Bytes fehlen weiterhin; die fehlenden Bildbytes werden nicht aus Inlineansichten rekonstruiert.

### Knowledge-TXT und berechtigter Dateizugriff

Die gezielte [TXT-Diagnose](../qa/knowledge-operational-closure-2026-11-01/operational-evidence.json) bestätigt Asset `e48e2909-09ef-4ef4-8598-ce582ea8519a` mit `text/plain`, 953 Bytes und passender privater Manifestreferenz im Workspace `8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101`. Die allgemeine Media-Route schließt Dateien im Knowledge-Privatbereich bereits bei der Datenbanksuche aus. Ihr HTTP 404 belegt deshalb keinen fehlgeschlagenen Blobabruf und keine fehlenden physischen Bytes.

Die passende normale Route ist der [Knowledge-Dokumentabruf mit Versions- und Workspace-ID](https://www.novalure-crm.app/api/knowledge-center/sources/6a4b1ef0-9196-4bdc-a965-8c1aa832aac5/document?versionId=258d0747-f470-49a2-b2c5-9c1143ac014c&workspaceId=8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101). Sie benötigt die reguläre berechtigte CRM-Sitzung und prüft Workspace-Mitgliedschaft und MFA. Der Workspace-Parameter ist im produktiven Quellstand ausdrücklich unterstützt. Ein erfolgreicher Download oder Restore der TXT-Bytes ist bisher nicht belegt.

## Vorfall beim ersten Restore und Stabilisierung

Der erste Aufruf von `restore_snapshot` ließ `finalize` weg. Dadurch finalisierte der Provider den Restore und verschob den bestehenden Produktions-Endpunkt auf `br-spring-night-alyu48yp`. **Dieser Versuch war nicht isoliert und verletzt die beabsichtigte Produktionsschutzgrenze.** Er wird nicht nachträglich als erfolgreicher isolierter Test ausgewiesen.

Der ursprüngliche Stand blieb in `br-snowy-fog-aldx77v8` erhalten. Der vollständige Vergleich um 15:04 Uhr Europe/Vienna bestätigte dort alle 200 Tabellen mit 5.551 Zeilen, 28 Katalogkategorien und zwei Sequenzen unverändert gegenüber der Quelle vor dem Vorfall. Die produktiv gebundene Kopie unterschied sich zu diesem Zeitpunkt nur in den Zeitfeldern eines erfolgreich abgeschlossenen leeren Reminder-Admission-Laufs; dessen Jobliste war leer. Zusätzlich existierte die vom Provider angelegte Rolle `token_roles`.

Spätere Änderungen betreffen laut vollständigem lokalen Vergleich fünf Authentifizierungs-/Betriebstabellen; alle 195 anderen Tabellenhashes blieben gleich. Die beobachteten Zeilenzahlen und Zeitpunkte sind im maschinenlesbaren Beleg enthalten. Daraus wird keine pauschale Behauptung über sämtliche externen Providerwirkungen abgeleitet.

Der bereits aktive Datenstand einschließlich späterer regulärer Änderungen wurde beibehalten. Nur Name und Default-Zuordnung wurden daran angeglichen:

- Tatsächliche Produktion: `main`, Branch `br-spring-night-alyu48yp`, unveränderter aktiver Endpunkt `ep-wandering-union-alem0781`.
- Ursprünglicher Stand: `knowledge-ops-preincident-20261101`, Branch `br-snowy-fog-aldx77v8`; der ausschließlich neu entstandene Endpunkt `ep-young-queen-alvm4ypc` ist deaktiviert. Dieser Stand enthält spätere Writes nicht und ist kein freigegebener sofortiger Rollback.
- Kein weiterer Produktionsreset, Endpunktwechsel, SQL-Abgleich, Schema-/Grant-Eingriff oder CRM-Deployment zur Stabilisierung.

Ein weiterer CLI-Dispatchfehler bei der Prüfung eines Credential-Injektionsbefehls erzeugte ein eigenes Hilfsprojekt `presence` mit drei Deployments. Es hatte keinen Git-Link und keine Umgebungsvariablen; die einzige Quelldatei enthielt Boolean-Prüfungen zweier Variablennamen. Dieses Projekt wurde gesperrt, geprüft und vollständig gelöscht. Das CRM-Projekt erhielt dadurch kein Deployment. Der fehlerhafte CLI-Befehl wird nicht mehr verwendet.

## Erfolgreicher isolierter Datenbankrestore

Der getrennte zweite Lauf verwendet ausdrücklich `finalize:false`, einen neuen Namen und keine bestehende Ziel-Branch-ID:

- Snapshot `snap-fragrant-breeze-al24d0gr`, erstellt 01.11.2026 um 15:24:08 Uhr Europe/Vienna; konsistenter Datenpunkt 15:23:47 Uhr.
- Isolierte Zielbranch `br-orange-brook-al5f6n0f`, `knowledge-ops-isolated-restore-20261101-1424z`, `default=false`, `primary=false`, Restorestatus `restored`.
- Eigener Endpunkt `ep-raspy-union-al4lz6jx`, auf 0,25 CU begrenzt; nach den Prüfungen deaktiviert und im abschließenden Readback `idle`.
- Vor jedem Ziel-SQL-Lauf wurde bestätigt, dass der produktive Endpunkt weiterhin auf der tatsächlichen Produktionsbranch lag.

Die Vergleiche laufen als wiederholbar lesende Read-only-Transaktionen mit vollständiger Eigentümersicht ohne aktive RLS-Filter. Sie umfassen alle gespeicherten Zeilen in `public` und `neon_auth`, den Katalog einschließlich Ledger/Rollen/Grants/RLS sowie die logischen Sequenzstände. Systemschemas werden nicht als Geschäftsdaten mitkopiert; es gab keine fremden Tabellen oder Large Objects im geprüften Ausgangsinventar.

Quelle vor dem Snapshot (15:23:33), Restore (15:25:02) und Quelle danach (15:25:06) stimmen ohne ausgenommene Deltas exakt überein: **200 Tabellen, 5.092 Zeilen, 28 Katalogkategorien und zwei Sequenzen**. Gesamt-SHA256 `349aea3e534def11ba511028029c5730d567368f98de75be06d095f1d9c982c4`.

Auch alle privaten Asset- und Knowledge-Versionsreferenzen sind vorhanden: fünf private Assets; ein Knowledge-Asset mit zwei historischen Versionsreferenzen; keine fehlenden Assetreferenzen oder Objektschlüssel. Dieser DB-Lauf stellte keine physischen Blob-Dateibytes wieder her. Der spätere separate Dateilauf deckt bislang zwei der fünf Dateien ab. Eine frische authentifizierte Abnahme einer wiederhergestellten Gesamtanwendung wurde nicht behauptet.

## Sicherungsfenster und Betriebsbewertung

Die bestätigte PITR-Historie beträgt 21.600 Sekunden, also sechs Stunden. Das ist das Zeitfenster für einen historischen Rückgriff, keine gemessene Zusage von sechs Stunden Datenverlust. Fehler, die erst am nächsten Morgen oder nach einem Wochenende auffallen, können außerhalb dieses Fensters liegen.

Für die tatsächliche Produktionsbranch `br-spring-night-alyu48yp` ist inzwischen ein **nativer täglicher Snapshot-Plan um 03:00 UTC mit 604.800 Sekunden beziehungsweise sieben Tagen Aufbewahrung aktiv**. Der [Provider-Readback](../qa/knowledge-operational-closure-2026-11-01/native-database-backup-schedule.json) bestätigt dies am 01.11. um 15:59:27 UTC. Der Produktionsendpunkt `ep-wandering-union-alem0781` bleibt unverändert an diese Branch gebunden, aktiv und `disabled=false`. Das PITR-Fenster bleibt bei sechs Stunden; der Tarif wurde nicht geändert. Die Aktivierung belegt den Plan, noch keine spätere planmäßige Ausführung.

Der tägliche Plan verbessert die DB-Sicherungsabdeckung über das PITR-Fenster hinaus. Er sichert keine privaten Blob-Dateibytes. Der [Runner für gemeinsame DB-/Privatdatei-Sicherung](crm-full-backup-runner.md) erhielt zunächst einen minimalen geschützten Aufrufer im bestehenden Backup-Projekt: Production-Deployment `dpl_FYQUe8K9oFtufsgfRVpRpcNHy522`, Status `READY`, Node.js 24. Der bestehende SSO-Schutz blieb erhalten. Ein neuer sensibler `CRON_SECRET` wurde ausschließlich im Backup-Projekt eingerichtet; sein Wert wurde weder ausgegeben noch lokal gespeichert. Bei diesem Preflight-Stand waren der Zeitplan leer (`crons:[]`) und `CRM_FULL_BACKUP_ENABLED=false`.

Die native authentifizierte Vorabprüfung am 01.11. um 16:27:57 UTC erhielt HTTP 200 mit `PLAN_ONLY_NO_REMOTE_IO`, `status=BLOCKED` und ausschließlich `NEON_API_KEY` in der Liste fehlender Voraussetzungen. Sie führte keine Quellstore- oder Datenbankzugriffe aus. Ein Aufruf ohne Cron-Berechtigung erhielt HTTP 401. Die Production-OIDC-Identität wird bereits regulär vom nativen Workload bereitgestellt und über den SDK-Kontext weitergereicht; dafür fehlt kein externes Secret. Der [Deployment- und Preflightbeleg](../qa/knowledge-operational-closure-2026-11-01/backup-preflight-deployment.json) bestätigt diesen abgegrenzten Stand.

Die regulären Production-OIDC-Storeverbindungen sind inzwischen eingerichtet und am 01.11. um 16:40:19 UTC zurückgelesen: Quellverbindung `spc_mFUHkGw3AuUfslt0` zum Backup-Projekt mit Präfix `BACKUP_SOURCE_BLOB`; Zielverbindung `spc_rDycowIUHZ7rBFcQ` für Development und Production. Die bestehende CRM-Verbindung `spc_kYVPVyeV690yocE2` behielt ID, Production-Umgebung und Präfix `NOVALURE_PRIVATE_BLOB`. Die Development-Zielverbindung blieb erhalten. Der [Verbindungsbeleg](../qa/knowledge-operational-closure-2026-11-01/backup-blob-connections.json) dokumentiert die normale Einrichtung ohne Kopieren bestehender Production-Credentials. Die frühere Grant-Lücke ist damit behoben; ein erfolgreicher Gesamtlauf ist dadurch noch nicht nachgewiesen.

Für den aktuellen Versuch wurde der Quellsnapshot `snap-silent-shape-alvreahy` am 01.11. um 16:42:48 UTC angelegt; gemeldeter Ablauf: 08.11. um 16:45 UTC. Der tatsächliche Gesamtlauf auf Backup-Deployment `dpl_GXFQ6g8yBAmFX6NDABDYUEcfYEZ6` endete am 01.11. um 16:44:52 UTC mit **HTTP 503 / `INCOMPLETE`**. Die vollständige Inventarisierung des Zielpräfixes `crm-full-backups/` fand um 16:47:40 UTC null Objekte; eine getrennte Liste mit 16 Neon-Branches zeigte keine `crm-backup`-Branch. Diese Beobachtungen belegen keinen vollständigen Sicherungssatz. Der Produktionsendpunkt blieb aktiv, `disabled=false` und unverändert auf `br-spring-night-alyu48yp`.

Ein als sensibel hinterlegter Wert in der Production-Umgebung des Backup-Projekts hat den Neon-Zugang nicht bestätigt: Ein genau projektbezogener authentifizierter Leseaufruf erhielt HTTP 401; die Prüfung führte keine Mutationen aus. Ein gültiger Neon-Managementzugang ist deshalb weiterhin **nicht belegt**. Die korrigierte Übergabe über die regulären Benutzeroberflächen ist noch offen; die Vercel-Browseranmeldung benötigt dafür die normale MFA-/Profileinrichtung. Codes werden nicht im Chat angefordert. Native Production-OIDC-Identität und Storeverbindungen sind vorhanden und werden nicht als fehlende externe Secrets ausgewiesen.

Nach dem fehlgeschlagenen Versuch wurde das FULL-Flag wieder auf `false` gesetzt und die Fehlerdiagnose des Backup-Aufrufers bereitgestellt. Der Backup-Cron bleibt aus. Ein neuer tatsächlicher Gesamtlauf folgt erst nach belegbar gültiger Schlüsselübergabe; es gibt weiterhin keinen `FULL`-Nachweis.

Zusammen mit den drei noch fehlenden Privatdateien reicht der nachgewiesene Stand **nicht für eine belastbare vollständige Recovery-Abnahme**. Ein vollständiges Anwendungs-/Datei-RTO und ein akzeptiertes Geschäfts-RPO sind nicht nachgewiesen. Aus sechs Stunden PITR und täglicher DB-Sicherung mit sieben Tagen Aufbewahrung wird keine vollständige Datei-Recovery- oder RPO-/RTO-Zusage abgeleitet.

## Erhaltene Funktionen und Nachweise

Websiteüberwachung, Teams, Kalender, Mandantentrennung und deren bestehende Anwendungszeitpläne wurden nicht umkonfiguriert. Der oben belegte native DB-Sicherungsplan ist eine separate neue Einstellung. Die bestätigte Monitoringkonfiguration und die zehn erfolgreichen geplanten Läufe aus dem Bericht vom 31.10. werden wiederverwendet; es wurde kein zusätzlicher Scan ausgelöst. Ebenso bleiben die sechs Migrationsquellchecksummen, die bereits produktiv enthaltene Undici-/Zod-Korrektur und der Code-Review des unveränderten Implementierungsstands gültig für ihren jeweiligen Scope.

Für den eigenen Preview-Branch sind ausschließlich 70 neue Records angelegt: 65 leere Überschattungen und fünf Auth-/Worker-Schutzflags. Alle geteilten Recordmetadaten blieben identisch. Bekannte QA-Integrationen verweisen auf getrennte Neon-Projekte; ihre prefixed Variablen werden nicht als Runtime-Datenbankfallback gelesen. Die automatische Bereitstellung wurde nur für diesen Branch zugelassen. Die vorhandene Sperre automatischer Main-Deployments bleibt aktiv; die Zusammenführung ersetzt den laufenden CRM-Release nicht. Produktions-Geheimnisse wurden nicht übernommen.

Für den finalen Head `52f009c8b4709fd36647634b6f7ce54444fe3799` sind die nativen Pflichtprüfungen tatsächlich erfolgreich: [Quality #41316658465](https://github.com/novalure/novalure-crm/actions/runs/41316658465), einschließlich Audit, Produktionsbuild und integrierter Design-C-/Knowledge-Abnahme, sowie [Secret Scan #41316658454](https://github.com/novalure/novalure-crm/actions/runs/41316658454). Der echte Vercel-Preview-Check für `dpl_AJdxskiWDGx67nPU6G1nHNnSrsHw` war ebenfalls erfolgreich. Der manuelle Candidate-Job war übersprungen und wird nicht als bestanden gezählt. [PR #120](https://github.com/novalure/novalure-crm/pull/120) wurde am 01.11. um 14:44:11 UTC als `a45625d` zusammengeführt. Dies ist kein neues CRM-Produktionsdeployment. Unveränderte bestandene Tests wurden nicht manuell wiederholt.

Die Betriebsfortsetzung [PR #122](https://github.com/novalure/novalure-crm/pull/122) wurde am 01.11. um 16:44:00 UTC mit Mergecommit `8baace9abaa4bf8dc44d904f541a90ff39c5b9dc` zusammengeführt. Für Head `ad7f64757dcb06c7af0414bc6b251fc0efeb2385` bestanden [Native Quality #41326808191](https://github.com/novalure/novalure-crm/actions/runs/41326808191) mit 10 Minuten 43 Sekunden Laufzeit, [Secret Scan #41326808327](https://github.com/novalure/novalure-crm/actions/runs/41326808327) und der echte Vercel-Check `dpl_J78PwN5rssmgNRtVTRPrLTHiCqZ1`. Bestandene Codeprüfungen ersetzen die fehlende erfolgreiche betriebliche Gesamtsicherung nicht.

## Verbleibende konkrete Schritte

Der getrennte private Zielstore enthält weiterhin nur die zwei verifizierten Original-PDFs; drei Dateibytesätze fehlen noch. Der geschützte Production-Aufrufer, die native Production-OIDC-Identität und beide Production-Storeverbindungen sind eingerichtet. Offen ist die technisch korrekte, anschließend erfolgreich zu validierende Übergabe des projektbezogenen Neon-Managementschlüssels. Danach sind der tatsächliche gepaarte Sicherungslauf, die isolierte Wiederherstellung und ihre vollständige Prüfung durchzuführen, bevor der regelmäßige Backup-Cron aktiviert werden kann. Bestehende sensible Werte werden nicht im Chat angefordert; die abgewiesene Development-Berechtigung am Quellstore wird nicht umgangen.

Erst mit den restlichen Dateien kann der vollständige Fünf-Dateien-Satz nach Bytes/SHA256 und anonymem Zugriffsschutz geprüft werden. Die bereits verifizierten zwei PDFs bleiben ein Teilnachweis. Es fehlt keine weitere pauschale Freigabe. Die noch nicht erfolgreich validierte Schlüsselübergabe und die noch nicht genügende vollständige Sicherungsabdeckung bleiben ausdrücklich offen.

[Maschinenlesbare Ergebnisse](../qa/knowledge-operational-closure-2026-11-01/operational-evidence.json) · [verwendete Read-only-Fingerprint-SQL](../qa/knowledge-operational-closure-2026-11-01/database-fingerprint.sql) · [PR #120: finale Plattformchecks und Mergequittung](https://github.com/novalure/novalure-crm/pull/120).
