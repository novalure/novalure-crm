# Knowledge Center Betriebsabschluss vom 31. Oktober 2026

Die tägliche produktive Websiteüberwachung ist bestätigt. Der Betriebsabgleich verbindet den aktuellen CRM-Release mit den installierten Paket-4-Migrationen und den vorhandenen Recovery-Ressourcen. Die tatsächlich konsumierte Datenbank-/Privatstore-Bindung des laufenden Artefakts und ein aktueller vollständiger Produktionsrestore bleiben gesonderte, noch offene Nachweise.

Die allgemeine Ausführungsfreigabe wurde am 31.10.2026 erneut ausdrücklich erteilt. Es fehlt keine weitere pauschale Freigabe. Für einen authentifizierten Anwendungsnachweis wird eine reguläre berechtigte CRM-Sitzung benötigt; administrative Datenbank-/Providerrechte ersetzen sie nicht.

| Auftrag | Ergebnis |
| --- | --- |
| Produktive Websiteüberwachung bestätigen und bei Bedarf ergänzen | Bestätigt; vorhandene gültige Konfiguration wurde beibehalten |
| Deployment, Datenbank, private Dateien und Wiederherstellung abgleichen | Aktuelle Metadaten, echte Runtime-Rollenverbindung und sechs Quellchecksummen bestätigt; unten benannte Artefakt-/Datei-/Restore-Nachweise offen |
| Abschlussdokumentation aktualisieren | Dieser Bericht und maschinenlesbarer Nachweis angelegt; historischer Paket-4-Bericht erhält einen aktuellen Hinweis |

## Produktive Websiteüberwachung

Der laufende CRM-Release ist `6daf9b697cd8faef1c8166f16bf1853aaba3153a`, Deployment `dpl_HPDsGkXp4M4LVp7TSpuHh7jKyAeC`. Sowohl `www.novalure-crm.app` als auch `novalure-crm.vercel.app` sind diesem produktiven READY-Deployment zugeordnet.

Die Websiteüberwachung besitzt eine aktivierte tägliche Quellkonfiguration mit passender gespeicherter MFA-Delegation. Benutzer, Identität, Modul, Vertrag, Websiteimport und Monitoring sind aktiv. Der Host-Dispatcher prüft täglich um 06:00 UTC, derzeit 07:00 Uhr Europe/Vienna. Er verlangt weiterhin ausdrückliche Mandanten-/Quellen-/Actorbindung und die vorhandene Cron-Authentifizierung.

Der tatsächliche geplante Lauf vom **31.10.2026, 07:00:54 bis 07:00:57 Uhr Europe/Vienna** ist erfolgreich abgeschlossen:
- Ergebnis `changed`, ein Versuch, kein Fehler.
- Ein persistenter Änderungsvorschlag ist offen; er wurde weder angenommen noch veröffentlicht.
- Lauf, Vorschlag und Audit stimmen über Quell-/Konfigurationsrevision, delegierten Actor und Host-Run-ID überein.
- Die aktive veröffentlichte Version stammt weiterhin vom 21.10.2026. Der Vorschlag hat keine Veröffentlichung oder neue Entwurfsversion erzwungen.
- Seit dem ersten geplanten Lauf am 22.10. sind zehn geplante Läufe erfolgreich abgeschlossen; keine terminalen Fehler in dieser abgefragten Laufmenge.
- Monatsverbrauch: 13 von 100 Scans. Nächste Fälligkeit: **01.11.2026, 07:00 Uhr Europe/Vienna**.

Ein zusätzlicher Scan, eine erzwungene Fälligkeit oder eine neue Delegation waren deshalb nicht erforderlich. Die vorhandene Konfiguration wurde nicht überschrieben. Der bereitgestellte gehostete Dispatcher betreibt tägliche Intervalle; daraus wird keine produktive Weekly-/Monthly-Aktivierung abgeleitet.

## Datenbank und Anwendungsartefakt

Die geprüfte Produktionsdatenbank ist `misty-cloud-70835427 / br-snowy-fog-aldx77v8 / neondb`, PostgreSQL 17.11. Ihr Ledger enthält 73 Einträge; 118 Tabellen besitzen FORCE RLS.

Die SQL-Dateien 101–106 wurden frisch vom exakten produktiven Git-Commit geladen und per UTF-8-/LF-SHA256 mit dem gespeicherten Produktionsledger verglichen: **sechs von sechs stimmen überein**. Es wurde keine Migration ausgeführt.

Eine tatsächliche Connector-Verbindung als `novalure_app` bestätigt:
- `current_user` und `session_user` sind `novalure_app`.
- Neon-Projekt und -Branch entsprechen dem geprüften Ziel.
- Superuser, BYPASSRLS, CREATE DATABASE und CREATE ROLE sind deaktiviert.
- Der administrative Migrationsledger ist dieser Rolle nicht zugänglich. Der erhaltene Permission-Denied-Fehler ist kein fehlgeschlagener Rollenlogin.

Diese Verbindung ist ein echter Rollen-/Datenbanknachweis. Sie beweist für sich allein nicht, welches Credential das laufende CRM-Artefakt konsumiert. Der vorhandene geschützte Endpunkt `/api/system/database` liefert dafür Build, Umgebung und Runtime-Identität, verlangt aber eine reguläre berechtigte CRM-Sitzung. Eine solche Sitzung steht dieser Ausführung nicht zur Verfügung. Der benötigte Diagnoseauszug wurde separat angefragt; Authentifizierung und MFA wurden nicht umgangen.

## Private Dateien und Recovery

Die mandantenbezogenen Datenbankmetadaten enthalten vier Dateien mit `vercel-blob` und `storage_access=private`; keine davon ist als öffentlich markiert. Dateinamen, Dateiinhalte, Tokens und Verbindungspasswörter wurden nicht übernommen.

Die aktuelle providerseitige Privatstore-Zuordnung bleibt offen: Der Getter für die historische Store-ID und die Projekt-Connector-Abfrage lieferten HTTP 404; die Integrationskonfiguration HTTP 403. Diese Antworten beweisen weder eine Store-Löschung noch die konsumierte Token-/Storebindung. Ein authentifizierter Datei-Byte-Roundtrip wurde nicht durchgeführt.

Aktuell bestätigte Recovery-Metadaten:
- PITR-Aufbewahrungsfenster der Produktionsbranch: 21.600 Sekunden, also sechs Stunden.
- Geschützte Paket-4-Recovery-Branch `br-dark-night-al5bhrvv` existiert weiterhin; Stand 21.10.2026, 07:02:04 UTC. Ihr lesender Endpoint ist deaktiviert/idle.
- Eine weitere ungeschützte Vor-114-Branch vom 22.10.2026 existiert.
- Der konfigurierte Snapshot-Zeitplan ist leer; die gelisteten Snapshots stammen vom 11./12. Oktober. Daraus wird kein frischer täglicher Snapshotnachweis abgeleitet.

Der erhaltene vollständige Restorebeleg vom 20.10. ist ein erfolgreicher **synthetischer** Test mit 60 Ledgerzeilen und 17 privaten Dateien. Er bleibt gültig für seinen damaligen Scope, ist aber kein heutiger vollständiger Produktionsrestore mit 73 Ledgerzeilen. Bestehende Recovery-Ressourcen wurden weder zurückgesetzt noch gelöscht; produktive Daten und Dateien blieben unverändert.

## Noch offene Nachweise

1. Ein regulär authentifizierter Diagnoseauszug vom laufenden CRM, um Build, tatsächliche DB-Rolle und Neon-Bindung am Artefakt zu bestätigen.
2. Aktuelle Privatstore-Metadaten mit vorhandenem berechtigtem Zugriff sowie ein normal authentifizierter privater Dateiabruf.
3. Falls ein aktueller vollständiger Produktions-Recovery-Nachweis benötigt wird: getrennte isolierte Restoreprüfung von Datenbank und privaten Dateien auf einem aktuellen konsistenten Stand. Die hier durchgeführte Bestandsaufnahme ist kein Ersatz dafür.

Diese Punkte sind technische Zugangs-/Nachweisgrenzen. Sie werden nicht durch eine weitere allgemeine Zustimmung oder einen anonymen Healthcheck erfüllt. Die gültige produktive Websiteüberwachung kann währenddessen weiterlaufen.

## Erhaltene Historie und Änderungen dieser Ausführung

Paket 4 wurde am 21.10. über [PR #92](https://github.com/novalure/novalure-crm/pull/92) integriert; die späteren produktiven Studio-Knowledge-Nachweise stehen in [PR #98](https://github.com/novalure/novalure-crm/pull/98). Die früheren Blockertexte bleiben als datierte Historie erhalten und werden durch den aktuellen Hinweis eingeordnet.

Die Prüfungen dieser Ausführung waren lesend. Es gab keine Produktionsmigration, kein Deployment/Promote, keinen zusätzlichen Scan, keine neue Sitzung, keine Konfigurations-/Secretänderung im Betrieb und keinen Restore. Im Repository wurde lediglich der eigene Dokumentationsbranch angelegt und dessen automatische Deployments deaktiviert.

Detaillierte IDs, Zeiten, Berechtigungsgrenzen und Vergleichsergebnisse: [Produktionsbeobachtungen](../qa/knowledge-operational-closure-2026-10-31/production-observations.json).
