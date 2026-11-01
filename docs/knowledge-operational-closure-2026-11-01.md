# Knowledge Center: Betriebsabschluss, Stand 1. November 2026

Dieser Auftrag betrifft ausschließlich das Knowledge Center in `novalure/novalure-crm` und PR #120. Er ist unabhängig von Paket 4 der gemeinsamen Lernplattform. Die früheren CRM-Berichte bleiben datierte Historie.

**Betriebsabnahme noch offen:** Die tatsächliche Anwendungs-/DB-Bindung, ein normaler privater Dateiabruf und ein vollständiger isolierter Datenbankrestore sind bestätigt. Das Archivieren und Wiederherstellen aller referenzierten privaten Dateibytes bleibt durch fehlende Blob-Berechtigung blockiert. Der erste Restoreversuch verursachte einen Produktionsvorfall; er wird unten ausdrücklich offengelegt.

| Bereich | Tatsächliches Ergebnis |
| --- | --- |
| Produktionsanwendung und eingeschränkte DB-Rolle | Reguläre CRM-Sitzung; Antwort und nativer Laufzeitlog über dieselbe Korrelations-ID bestätigt |
| Normaler privater Dateiabruf | HTTP 200 mit Sitzung, unabhängig HTTP 401 ohne Sitzung; 996 Bytes und SHA256 erfasst |
| Isolierter vollständiger DB-Restore | Quelle vorher = Restore = Quelle nachher: 200 Tabellen, 5.092 Zeilen, 28 Katalogkategorien, zwei Sequenzen |
| Vollständiger Privatdatei-Restore | Offen: fünf referenzierte private Assets mit 44.260 Bytes; Datenbankreferenzen allein ersetzen deren Dateisicherung nicht |
| Sicherer Preview-Weg | 65 geerbte Schlüssel geleert und fünf Schutzflags ausschließlich für den eigenen Branch; unveränderte geteilte/produktive Records nachgewiesen |
| CI, echter Vercel-Check und Merge | Exakte finale Plattformquittungen werden in [PR #120](https://github.com/novalure/novalure-crm/pull/120) geführt; kein Status wird selbst als Erfolg gesetzt |

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

Die gespeicherte sensible Produktionsvariable lieferte beim genau adressierten normalen API-Zugriff `decrypted:false` und keinen Wert. Ein einmaliger, offiziell unterstützter Development-OIDC-Zugang hatte passende Team-/Projekt-/Development-Claims; der Blobdienst verweigerte den Dateiabruf mit HTTP 403. Danach wurden keine Claims, Berechtigungen oder Storeverbindungen verändert. Es wurde kein leerer Zielstore angelegt, dessen Zugriff nicht belegbar gewesen wäre.

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

Auch alle privaten Asset- und Knowledge-Versionsreferenzen sind vorhanden: fünf private Assets; ein Knowledge-Asset mit zwei historischen Versionsreferenzen; keine fehlenden Assetreferenzen oder Objektschlüssel. Physische Blob-Dateibytes sind dadurch noch nicht wiederhergestellt. Eine frische authentifizierte Abnahme einer wiederhergestellten Gesamtanwendung wurde nicht behauptet.

## Sicherungsfenster und Betriebsbewertung

Die bestätigte PITR-Historie beträgt 21.600 Sekunden, also sechs Stunden. Das ist das Zeitfenster für einen historischen Rückgriff, keine gemessene Zusage von sechs Stunden Datenverlust. Fehler, die erst am nächsten Morgen oder nach einem Wochenende auffallen, können außerhalb dieses Fensters liegen.

Für die tatsächliche Produktionsbranch wurde kein automatischer nativer Snapshot-Zeitplan gefunden. Die neuen manuellen Snapshots sind konkrete Recoverypunkte, aber kein regelmäßiger Sicherungsprozess. Zusammen mit der noch fehlenden vollständigen Privatdateisicherung reicht der nachgewiesene Stand **nicht für eine belastbare betriebliche Recovery-Abnahme**. Ein vollständiges Anwendungs-/Datei-RTO und ein akzeptiertes Geschäfts-RPO sind nicht nachgewiesen. Aufbewahrung, Tarife und Zeitpläne wurden nicht erweitert.

## Erhaltene Funktionen und Nachweise

Websiteüberwachung, Teams, Kalender, Mandantentrennung und bestehende Zeitpläne wurden nicht umkonfiguriert. Die bestätigte Monitoringkonfiguration und die zehn erfolgreichen geplanten Läufe aus dem Bericht vom 31.10. werden wiederverwendet; es wurde kein zusätzlicher Scan ausgelöst. Ebenso bleiben die sechs Migrationsquellchecksummen, die bereits produktiv enthaltene Undici-/Zod-Korrektur und der Code-Review des unveränderten Implementierungsstands gültig für ihren jeweiligen Scope.

Für den eigenen Preview-Branch sind ausschließlich 70 neue Records angelegt: 65 leere Überschattungen und fünf Auth-/Worker-Schutzflags. Alle geteilten Recordmetadaten blieben identisch. Bekannte QA-Integrationen verweisen auf getrennte Neon-Projekte; ihre prefixed Variablen werden nicht als Runtime-Datenbankfallback gelesen. Die automatische Bereitstellung wird nur für diesen vorbereiteten Branch zugelassen. Die vorhandene Sperre automatischer Main-Deployments bleibt aktiv; die Zusammenführung ersetzt den laufenden CRM-Release nicht. Produktions-Geheimnisse werden nicht übernommen; der echte Buildcheck muss von Vercel kommen. Unveränderte bestandene Tests wurden nicht manuell wiederholt; vorgeschriebene finale Branch-Checks bleiben verpflichtend.

## Verbleibende konkrete Zugangsgrenze

Für den vollständigen Abschluss wird ein legitim berechtigter Blob-Backupzugang benötigt: Lesen der fünf referenzierten Quelldateien und Schreiben/Lesen eines getrennten privaten Zielstores. Das kann über eine passende normale Store-/Workloadberechtigung oder sicher injizierte dafür vorgesehene Credentials erfolgen. Bestehende sensible Werte werden nicht im Chat angefordert; die abgewiesene Development-Berechtigung wird nicht umgangen.

Erst danach können alle fünf Dateien archiviert, mit identischen Schlüsseln in den isolierten Zielstore geschrieben und vollständig nach Bytes/SHA256 sowie anonymem Zugriffsschutz verglichen werden. Es fehlt keine weitere pauschale Freigabe. Die technische Zugangsgrenze und die noch nicht genügende Sicherungsabdeckung bleiben ausdrücklich offen.

[Maschinenlesbare Ergebnisse](../qa/knowledge-operational-closure-2026-11-01/operational-evidence.json) · [verwendete Read-only-Fingerprint-SQL](../qa/knowledge-operational-closure-2026-11-01/database-fingerprint.sql) · [PR #120: finale Plattformchecks und Mergequittung](https://github.com/novalure/novalure-crm/pull/120).
