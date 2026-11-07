# Projekt-Wizard: echter lokaler Browser-/Server-/Datenbanknachweis

Die fachliche Ausgangsbeobachtung und der abschließende Korrekturlauf verwenden echte Next-Seiten und API-Routen, reguläre Passwort-/TOTP-Anmeldungen, serverseitig ausgestellte HttpOnly-Sessions, echte CSRF-Prüfung und eine frische eingebettete PostgreSQL-Instanz. Es gibt keine ersetzten HTTP-Antworten, keine direkt aufgerufenen Route-Handler und keinen vorgegebenen Session-Cookie.

| Nachweis | Ergebnis | Einordnung |
| --- | --- | --- |
| Unveränderter Commit `3492729aa8cb48459bad650fca91c9095aa9534e` | 5 PASS / 4 FAIL bei 9 Beobachtungschecks | Historischer Verlust der vier sichtbaren Wizard-Angaben |
| Eingefrorener korrigierter App-Stand | **15/15 PASS, Exit 0** | Neuer ausdrücklich privater Wizard-Vertrag und gezielte Rechte-/Reload-Prüfungen |

Die beiden Inventare sind absichtlich verschieden. Die alte UI lieferte andere Felder und eine unpassende freie Pipelineauswahl; die Korrektur führt serverseitig autorisierte Optionen sowie einen getrennten privaten Lesepfad ein. Daher wird kein identischer synthetischer Rot-/Grün-Testbestand behauptet.

## Reproduzierte Ausgangslage

Vor Produktänderungen wurden App und Migrationen direkt aus dem exakten 349-Commit per Git-Archiv in einen eigenen ignorierten Quellordner eingefroren. Die kanonisch auf LF normalisierte Shell entspricht dessen Git-Objekt. Die später gestartete Next-Instanz liest ausschließlich diese Kopie; die parallelen Produktänderungen können die Baseline nicht beeinflussen.

Der Browser meldet sich mit dem frischen synthetischen Konto regulär an, liest den im Formular angezeigten TOTP-Schlüssel, bestätigt die Enrollment-Schritte und erhält eine echte opaque HttpOnly-v2-Session. Er bedient Projektname, Notizen, Zuständigen, Funnel-Auswahl und die damals angebotene Investment-Pipeline, löst genau einen echten Create aus und liest danach per tatsächlichem Seitenreload, Core-GET und RLS-gebundener SQL-Abfrage.

Create200, CSRF, Session und gespeicherte Projekt-UUID sind bestätigt. Im tatsächlichen POST fehlen Notizen, Zuständiger und Funnel. Die Pipelineauswahl steht lediglich als `defaultPipelineId="pipeline_investment"` im Request; die Datenbank erzeugt stattdessen ihre kontextabhängige `novalure_sales_pipeline`. Projektzeile und Core-Reload enthalten die gewählten Metadaten nicht. Diese Beobachtung bedeutet nicht, dass private Notizen künftig in Core gehören: Die Korrektur speichert und liest sie ausdrücklich separat.

Maßgeblich sind `baseline/results.json`, `baseline/run.txt` und der durch den dortigen Harness-Hash gebundene historische Quelltext `baseline/harness.mjs.txt`.

## Abschließender Korrekturlauf

Der finale Lauf wurde nach dem gemeldeten Runtime-Freeze mit einem neuen Cluster und einer neuen App-Kopie ausgeführt. Seine 15 bestandenen Checks belegen:

- Tatsächliche Anmeldung mit Passwort und im echten UI eingerichteter MFA; echte HttpOnly-Session.
- Reales Create200 mit serverseitiger Autorisierung, CSRF und Idempotenzschlüssel. Die positive UI-Anlage erfolgt einmal. Zwei zusätzliche absichtliche negative POSTs erzeugen keine weiteren Projekte.
- Auswahl ausschließlich aus `wizard-options`, einschließlich tatsächlich aufgelöstem Actor, zulässigem Zuständigen, interner Funnel-Referenz, stabilem Typ-Key und der zum Kontext passenden Pipelinevorlage.
- Exaktes `project.wizard` im Create-Receipt ohne private Notiz und ohne Actor-Bindungsfeld. Core bleibt absichtlich ohne zusätzliche Wizard-Projektion; der private Marker fehlt im gesamten Create-Reply und Core-Body.
- Tatsächlicher Seitenreload und `wizard-details` liefern die gespeicherten IDs, berechtigt aufgelösten Namen und die privaten Notizen des Erstellers. Eine neue eigene Pipeline-UUID gehört zum neu angelegten Projekt und zum gewählten kontextabhängigen Vorlagen-Key.
- Die sichtbare aufgeklappte Zusammenfassung zeigt nach Reload Typ, Zuständigen, Pipeline, Funnel-Referenz und Erstellernotiz.
- RLS-gebundene SQL-Leseabfragen über die eingeschränkte Runtime-Rolle bestätigen gemeinsame Settings und die gesonderte Actor-Notiz. Die Funnel-Anzahl bleibt eins; für das neue Projekt wird kein Funnel geklont.
- Ein tatsächlich gespeichertes Command-Receipt und drei zugehörige Auditzeilen enthalten den privaten Marker nicht. Die Abfragen binden sich an Workspace, Actor, UI-Idempotenzschlüssel, Reply-CommandID beziehungsweise Reply-AuditReference. Eine neue Projekt-UUID wird nicht als generischer Receipt-`resource_id` vorausgesetzt.
- Ein Request mit veränderter `expectedActorId` wird trotz echter gültiger Cookie-/CSRF-Anmeldung mit 403 abgewiesen; die Datenbank enthält kein entsprechendes Projekt.
- Ein gültig angemeldeter Create ohne CSRF wird mit 403 abgewiesen; ebenfalls keine entsprechende Projektzeile.
- Ein separat per Passwort und echtem TOTP angemeldeter zugewiesener Manager erhält mit eigenem Cookie die gemeinsamen Metadaten, aber keine Erstellernotiz. Sein tatsächlicher Reload zeigt „Keine privaten Notizen“.
- Keine Browserexception, kein HTTP500 und kein externer Browserrequest im finalen Lauf.

Screenshots der tatsächlich neu geladenen Ansichten wurden zusätzlich visuell geprüft:

- `fixed/creator-reloaded-summary.png`
- `fixed/assigned-manager-reloaded-summary.png`

## Quellen- und Datenbankbindung

`fixed/results.json` enthält die tatsächlichen POST-/Reply-/Readbackwerte, gezielte SQL-Ergebnisse, alle 15 Checks, Lifecycle-Ergebnisse, die Hashes der angewandten Migrationsdateien und die Bytehashes sämtlicher **852 erfasster App-Eingabedateien**. Nach Prozessende wurden alle 852 Bytehashes mit dem unveränderten Arbeitsstand verglichen; sie stimmen überein. `browser-source-bindings.json` ergänzt kanonische LF-Hashes der acht fachlich veränderten Runtime-Dateien und die unveränderten sechs vorhandenen Infrastrukturhelfer.

Finaler Harness-SHA256:

`4ab894f26f2ee7010fe6d1a8a499c989f0f33a11b55fe6e90b1fb5b4cf308e5c`

Migration 197, LF-SHA256:

`5d43b02c14011b11415e915d981df047581fb483bc1a145ee98b7c75cd071af1`

Der Anwendungsprozess verbindet sich ausschließlich mit seiner frischen Rolle `sales_qa_<zufällig>`. `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole` und `rolreplication` sind jeweils false. Keine 196er Rollen-Testmigration wurde hinzugefügt oder für die App benötigt. Bootstrap/Fixture-Seeding erfolgen mit dem schon vorhandenen lokalen Helfer; fachliche API-Ausführung und die beschriebenen SQL-Leseabfragen verwenden die bestehende eingeschränkte Runtime-Rolle.

## Netzwerk und Ende der lokalen Prozesse

Der unveränderte Node-Netzwerkguard erlaubt ausschließlich die beiden exakten lokalen HTTP-/PostgreSQL-Ports und sperrt andere Socket-, DNS- und Fetch-Ziele. Provider-/Produktionsumgebungsvariablen werden nicht weitergereicht; `.env`-Dateien werden vor dem Start ausgeschlossen. Der Browser erlaubt ausschließlich den eigenen lokalen Ursprung und eingebettete Data-/Blob-Ressourcen.

Der finale Lifecyclebericht nennt **2 vom Nodeguard verhinderte Verbindungsversuche**. Ziele, Ursache und zeitliche Verteilung vor/nach dem Wizard werden von diesem vorhandenen Helfer nicht erfasst. Diese Zahl wird weder als null ausgegeben noch als Funnel-, Versand- oder Provideraktion interpretiert. Belegt sind die strikte Sperre und kein zugelassener Remotezugriff durch die geschützte App. Externe Browserrequests: 0. Es wurde kein zusätzlicher Lauf oder eine Quellinstrumentierung nur für diesen Zähler vorgenommen.

Browser und Next wurden geschlossen; der Next-Helfer bestätigt kooperativen Stop. PostgreSQL wurde nach frischer SQL-Identitätsprüfung ausschließlich über seinen eigenen Datenordner gestoppt; `listenerClosed=true` und Cleanup `ok=true`. Keine fremden Prozesse wurden beendet. Die eigenen Daten-/Logordner bleiben ignoriert für die Prüfung erhalten; es wird keine vollständige Dateilöschung behauptet. Passwörter, MFA-Schlüssel und Cookies werden nicht in die exportierten Nachweise geschrieben.

## Grenzen und ausgeschlossene Vorproben

Alle Geschäftsdaten sind neu erzeugt und harmlos. Dies ist reale lokale Anwendungspersistenz, keine Produktions-, Cloud-, Provider-, Zustellungs- oder vollständige Rollenfreigabe. Die zwei internen Manageridentitäten und gezielten negativen Requests ersetzen keine vollständige Berechtigungsmatrix. Die generische bestehende Sales-Schemavorbereitung hat dokumentierte historische Auslassungen und eine lokale Anpassung der optionalen RAG-Vector-Spalte. Dieser Browserlauf ist keine vollständige Produktions-Upgrade-/Schema-Owner-Probe.

`preflight/` bewahrt reine Aufbauprobleme: rohe CRLF-/LF-Prüfung, einen zu frühen UI-Klick, einen ungeeigneten Type-Selector und eine nicht vereinbarte `Core.project.wizard`-Annahme. Keiner davon gilt als Produktfehler. `early-loopback-pre-freeze/` erhält den frühen Lauf mit korrekt gespeicherten Feldern, dessen Receipt-Filter noch fälschlich `resource_id=projectId` annahm. Der Zähler null war kein gefundenes Notizleck. Maßgeblich für die Korrektur ist ausschließlich der abschließende `fixed/`-Stand.

Die früheren 107/7/29- und synthetischen Save-Suiten wurden nicht pauschal erneut ausgeführt. Dieser Nachweis bezieht sich auf den tatsächlichen Wizard-/Privatnotizpfad.

Ausführung im isolierten Worktree: `node --import tsx scripts/project-wizard-fields-browser-tests.mjs`. `CRM_QA_WIZARD_REVISION=<Commit-SHA>` erstellt eine neue eigene Git-Archivkopie von App und Migrationen genau dieses Commits; `CRM_QA_WIZARD_OUTPUT=<lokales Verzeichnis>` trennt Reviewer- und Producerbelege. Der Baseline-Modus `CRM_QA_WIZARD_BASELINE=1` verwendet die zuvor eingefrorene 349-Kopie. Ein späterer unabhängiger Commitlauf bleibt ein eigener Nachweis; hier wird kein bereits erfolgter unabhängiger Review oder Deployment behauptet.
