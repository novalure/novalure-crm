# Evelyn CRM – Integration von Design C

Stand: 19. Oktober 2026. Dieser Bericht beschreibt die Integration in die bestehende authentifizierte CRM-Anwendung; die frühere statische Demo unter `design-c/` bleibt separat und synthetisch. **Die vier Backend-Leseblockaden sind behoben und lokal abgenommen. Die Design-C-Entwicklungsabnahme beruht auf den getrennt dokumentierten Integrations- und gezielten Nachläufen; eine Produktivfreigabe ist damit nicht verbunden.** Ausgangspunkt dieses Abschlusses ist PR #91 bei `485575a1fd6e8be92b1e4446c4e9b414858fdd85`.

## Grundlage

- Integrationsbranch: `codex/evelyn-crm-design-c-integration`.
- Fachliche Basis: `aa6b329942ab19c165bc610822f03ed5874af189` aus Paket 2.1 / PR [#88](https://github.com/novalure/novalure-crm/pull/88), auf Paket 2 `a04273f37fb3417b180626bd878920ab89f73609` und Studio-Paket 1 aufbauend.
- Ursprüngliches Design: `37338cba018ab7b5a00cc59edb746de8796ee724`, kontrolliert als `b7a1ab62f7aa1f8d7ae98da7ae1a18847dfbd4c0` übernommen. Die Designrichtung wurde nicht neu ausgewählt.
- Zuletzt dokumentierte CRM-Production ist `ea668e625b8c778c2f79dd6a33210e731bb8a662`, Deployment `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk`, `READY`. Paket 2/2.1 und diese UI-Integration sind damit nicht als produktiv bereitgestellt belegt.

## A–H: integrierte Darstellung und reale Anschlüsse

| Bereich | Aktueller Integrationsstand und Grenze |
| --- | --- |
| **A. Design** | Vorhandene C-Tokens, Inter, dunkelblaue Navigation, helle Flächen, violettblaue Akzente und gemeinsame Primitiven werden in `.crm-app.design-c` verwendet. `evelyn-design-c.css` und `evelyn-domain-panels.css` kapseln CRM-/Domänendarstellung; öffentliche Seiten bleiben außerhalb dieses Themes. Bestehender mobiler Drawer, Fokusführung, Felder, Tabellen und Dialoge bleiben erhalten. |
| **B. CRM** | Die bestehende `CrmWorkspace` bleibt Controller. `getCoreCrmData` und `/api/crm/core` liefern die bestehenden serverautorisierten DTOs. `EvelynCommandCenter` zeigt Anfragen, offene Aufgaben, Projekte, Termine und datierte CRM-Einträge aus dem gewählten Scope; verfügbare Aktionen öffnen bestehende Bereiche. Unbekannte Kunden-/Angebotsaggregate werden nicht aus Kontakt- oder Dealzahlen erfunden. |
| **C. Kunden/Mandanten** | Kontakte, bestehende Unternehmensprofile und Kundenverwaltung verwenden ihre bisherigen Controller, darunter `/api/crm/customer-access` und `/api/settings/company-profile`. Der vorhandene Workspace-/Projektwechsel bleibt maßgeblich. `CrmCommandSearch` durchsucht nur bereits geladene, scopebegrenzte Datensätze und erlaubte Navigationseinträge; es gibt keinen neuen globalen Suchzugriff. Ein Kunden-Gesamtzähler fehlt im Core-Vertrag und bleibt im Command Center nicht verfügbar. |
| **D. Studio** | Profil, Websiteanfragen, Lead-/Vertriebsabläufe, Projektkontext und geschützte Dateiverweise bleiben bestehen. Das universelle Knowledge Center aus Paket 2/2.1 bleibt im Studio-Profil eingebunden. Intake, Release-Bindung, Kalender-/Webchatprovider und Vertragsabläufe werden durch die visuelle Integration nicht geändert oder aktiviert. |
| **E. Immobilien** | Bestehende Objekt-, Projekt-, Einheiten-, Reservierungs-, Interessenten-, Dokument- und Vermarktungskomponenten erhalten C-Darstellung. Die bisherigen Loader/Workflows bleiben erhalten. Fehlende Modulquellen erhalten einen sichtbaren Verfügbarkeitszustand; es werden keine fiktiven Objekte oder zusätzlichen Immobilienmodelle eingeführt. |
| **F. Knowledge** | Die tatsächliche `KnowledgeCommandCenter` nutzt `/api/knowledge-center` mit Bereichen, Quellen, Dokumentimport, Verarbeitungsstatus, Versionen, konkreten Freigaben, Zuordnungen und Nutzungslimits. Migrationen 101–103 stammen unverändert aus der Fachbasis. Serverseitige `available`-/Entitlement-/Permissionzustände bleiben maßgeblich. Die Integration führt diese Migrationen nicht produktiv aus. |
| **G. Assistenten/Evelyn** | Die bestehende Botverwaltung und ihre Knowledge-/Chat-/Evaluationscontroller bleiben erhalten. Die unten dokumentierten Kanal-/Freigabe-/Aktionslesewege verwenden jetzt begrenzte Leserverträge unter der tatsächlichen Runtime-Rolle. Vorbereitete Beispieldialoge und künstliche Statistikreihen werden nicht als Livebetrieb angeboten. Der allgemeine Evelyn-Dialog ist ohne nachgewiesenen Dienstcallback als nicht verfügbar gekennzeichnet. Das neue Briefing ist ausdrücklich eine deterministische CRM-Zusammenfassung, keine KI-Analyse oder erfundene KI-Aktivität. |
| **H. Kundenportal** | Die vorhandenen Kundenrollen/-profile verwenden dieselbe CRM-Oberfläche mit gefilterten Menüs. Dashboard, Projekte und lesender Knowledge-Self-Service bleiben auch im Immobilienprofil erreichbar; Botverwaltung und Einstellungen benötigen die bestehenden Fähigkeiten. Der anschließende Modulfilter und die Serverrechte bleiben wirksam. Knowledge-Self-Service bleibt unter der authentifizierten Root-Seite mit `#knowledge` erreichbar: private Datei-/Text-/Websitequellen, Prüfung/Freigabe nach Berechtigung sowie getrennte Assistentenzuordnungen. Es wird keine neue Portalroute oder Datenbank eingeführt. Abo-/Zahlungs-/Voiceproviderdaten ohne tatsächlichen Anschluss bleiben nicht verfügbar. |

## I. Sicherheit und Datenherkunft

`selectAuthoritativeCrmPresentation` übernimmt nur Fachkollektionen mit `moduleSources[key] === "database"` ohne Modulfehler. `unavailableCrmSectionCollections` verhindert, dass eine nicht geladene Sammlung als bestätigter Leerbestand erscheint. Die alten unangebundenen Zusatzkollektionen aus `crm-source` werden nicht als Geschäftsdaten verwendet. Formulare beginnen ohne Beispieldatensätze und akzeptieren bestätigte leere Datenbankantworten. Kundenverwaltung verwirft API-Fallbackdaten. Kontakte, Leadverläufe, Newsletter und Bots kennzeichnen fehlende Zusatzdaten; Newsletterversand bleibt ohne Einwilligungs-/Sperrlistendaten gesperrt. Legacy-Analysen, Kommunikation, Datenhygiene und Sequenzen ohne verifizierten Anschluss zeigen einen Verfügbarkeitszustand statt erfundener Scores. Formulare/Kundenverwaltung unterstützen im vorhandenen API-Vertrag nur den angemeldeten Workspace; in gewechselten Managed-Workspaces werden sie ausdrücklich als nicht verfügbar dargestellt. Verfügbarkeitsinformationen bleiben von echten leeren API-Ergebnissen getrennt.

Command-Center-Zähler benötigen gültigen geladenen Scope, verfügbare Navigation und bestätigte Datenherkunft; `mock`, `fallback`, Fehler oder fehlende Kundenquelle ergeben **keine willkürliche 0**. `LIMITED` kennzeichnet Ausschnitte statt Gesamtzahlen. Der bestehende `isBusinessKpiRecord`-Filter schließt synthetische Geschäftsdatensätze aus; bekannte synthetische Leadbezüge werden auch bei Aufgaben/Terminen ausgeschlossen. Die bisherigen umfangreichen Dashboardberechnungen bleiben bestehen und werden nur bei hinreichend geladenen Quellen angezeigt.

Authentifizierung, RBAC, RLS/FORCE RLS, Projektgrants, CSRF, Knowledge-Entitlements, Kanalrechte und Audit bleiben bei den bisherigen Serververträgen. Die ursprüngliche UI-Integration änderte diese Verträge nicht. Der gezielte Abschluss ergänzt ausschließlich die unten beschriebenen GET-/Datenbank-Leseverträge; Authentifizierungs- und Schreibverträge bleiben erhalten. Die bestehende Testausführung `test:sales` wurde um `--conditions=react-server` ergänzt, damit der vorhandene `server-only`-Schutz auch im Testprozess korrekt aufgelöst wird; der Schutz wurde nicht entfernt.

### Abschluss der vier Leser

Die ursprüngliche Prüfung bei `485575a` mit **unveränderter Vorgängerkette `091–096 → 100 → 101 → 102 → 103`** und nicht privilegierter Runtime `sales_qa_*` legte vier tatsächliche SQLSTATE-`42501`-Fehler offen. Die Tabellen und bestehenden Backend-Abläufe waren vorhanden. Es fehlten freigegebene DTO-Leseadapter; ein Workspace-Filter oder `withCrmRead` allein konnte die fehlenden Tabellenrechte nicht ersetzen. Das waren keine künstlichen Testfehler und keine fehlenden Kommunikations-, Freigabe-, Versand- oder OAuth-Funktionen.

| GET-Pfad | Nachgewiesene Ursache | Gezielte Korrektur |
| --- | --- | --- |
| `/api/bots/channels` | Direkter Zugriff auf `bot_channel_webhooks` ohne Runtime-SELECT/Lesevertrag; der zweite Kontenleser benötigte denselben sicheren Kontext. | `crm_read_bot_channels` projiziert vorhandene Konten und die letzten 12 Ereignisse über gespeicherte Konto→Bot→Projekt-Beziehungen. Keine Rohpayloads, Credentials, Lease-/Reply-Token oder Providerresultate. |
| `/api/approvals` | Direkter Zugriff auf `approval_requests` ohne Runtime-SELECT/Lesevertrag; der bisherige DTO gab beliebiges Payload-JSON zurück. | `crm_read_approvals` erhält `bots:approve`, Statusfilter und vorhandene Produzententypen (Botgespräch, Toollauf, Bot, Leadworkflow, Call Insight sowie Vorgänge ohne Entity-ID). Gespeicherte Beziehungen werden auf Mandant/Projekt geprüft. Payload-Felder sind begrenzt; Tool-IDs werden nur nach verifizierter Gesprächszuordnung ausgegeben. |
| `/api/bots/actions` | Direkter Zugriff auf `bot_document_sends` ohne Runtime-SELECT/Lesevertrag; auch `meeting_bookings` war Teil desselben GET. Ungeschützte Metadaten-/Empfängerfallbacks waren kein sicherer Ersatz. | `crm_read_bot_actions` liest vorhandene Sendungen und Buchungen über echte Beziehungen. Kontakte behalten ihre bestehende Eigentümersichtbarkeit; Medienverweise bleiben privat. Keine Empfängerdaten aus JSON, keine Share-Token, Providerresultate oder Versandaktionen. |
| `/api/meetings/oauth/status` | `getProviderConnection` las `provider_connections` einschließlich privater `config` ohne freigegebenen Runtime-Lesevertrag. | `crm_read_calendar_connections` projiziert ausschließlich gespeicherten Microsoft-/Google-Status, Label, Ablaufzeit, Scopes und einen generischen Fehlerhinweis. Kein `config`, Entschlüsseln, Refresh, OAuth-Start oder Provideraufruf. |

Die additive Migration **106** definiert ausschließlich eng begrenzte `STABLE SECURITY DEFINER`-Lesefunktionen mit festem Suchpfad, expliziter aktiver Mitgliedschaft, tatsächlichem RBAC, Klassifikation, Mandanten-/Projekt-/Botprüfung und `EXECUTE` nur für `novalure_tenant_app`. Private Hilfsfunktionen sind für Runtime/PUBLIC gesperrt. Bestehende Tabellenrechte, RLS/FORCE RLS, Schreibregeln und Auditpfade werden nicht verändert. Dienstidentitäten erhalten über diese menschlichen UI-Leser keine zusätzlichen Scopes. Migration 106 wurde ausschließlich in wegwerfbaren lokalen Datenbanken angewendet; es gab keine produktive Migration.

Alle vier Routen verwenden `withCrmRead`, frisch geladene Mitgliedschaft und den vorhandenen Workspace-Resolver. Queryparameter werden auf erlaubte Schlüssel, Eindeutigkeit und UUID geprüft. Nicht autorisierte Scopes scheitern geschlossen. Erfolgreiche Antworten tragen `source: database` und `private, no-store`; fehlende Funktionen/Tabellen oder fehlerhafte DTOs werden als sanitiertes HTTP 503 gemeldet. Autorisierte leere Quellen bleiben echte 200-Leerzustände. Fehler werden nicht durch Demoantworten verborgen.

Kalenderverbindungen sind im vorhandenen Modell workspaceweit: Es existieren keine Projekt-/Benutzerzuordnungen, weshalb der Kalenderleser solche Filter ablehnt. Im gewechselten Managed-Workspace wird dessen autorisierter Status gelesen und schreibgeschützt angezeigt; die bestehenden OAuth-/Settings-Schreibpfade bleiben an den Sitzungsworkspace gebunden. Nicht scopingfähige Buchungs-/Benachrichtigungsleser, deren Mutationen, Freigabelinks sowie die Bot-Dokumentauswahl/Uploads werden dort ausdrücklich gesperrt und nicht aus dem Sitzungsworkspace übernommen. Kanal-/Freigabe-/Aktionshistorien bleiben im gewählten autorisierten Scope lesbar, während ihre bestehenden ungescopten Schreibaktionen nur im Sitzungsworkspace angeboten werden. Bot-Teilquellen werden unabhängig geladen, damit eine nicht erlaubte Freigabequelle keine erfolgreichen Geschwisterleser überschreibt. Kalenderstatus bleibt bis zum verifizierten Lesen unbekannt.

`meeting_bookings` hat keine verifizierbare Botzuordnung. Bei explizitem Botfilter liefert der zusätzliche Buchungsteil deshalb `meetingBookingsAvailable: false` und keinen erfundenen offenen Zähler. Projektfilter verwenden die vorhandene Kontaktbeziehung. Ungebundene workspaceweite Legacy-Vorgänge benötigen die bestehende Managerberechtigung und werden nicht einem angefragten Projekt/Bot zugeordnet. Die Universal Booking Engine bleibt separat.

Betroffene Implementierungsdateien: `migrations/106_crm_operational_readers.sql`, `src/lib/db/crm-operational-readers.ts`, `src/lib/operational-read-http.ts`, die vier genannten API-Routen sowie gezielte Quellen-/Scopekorrekturen in `bot-command-center.tsx`, `calendar-command-center.tsx` und dessen Aufruf in `crm-workspace.tsx`. Globale Design-, Navigations-, Dashboard-, Portal-, Studio- und Immobiliengestaltung bleiben unverändert. Paket 3 wurde nicht übernommen; 104/105 bleiben frei für dessen bestehende Migrationen.

## J. Tatsächlich ausgeführte Prüfungen

Die folgende Tabelle bewahrt die ursprünglichen Integrationsnachweise. Der neue Leser-Nachlauf steht im anschließenden Abschlussbeleg; aus getrennten Nachläufen wird kein neuer vollständiger Browserlauf konstruiert.

| Prüfung | Bisheriger Stand |
| --- | --- |
| TypeScript, Root-Build, Lint | Bestanden; die aktuellen JavaScript-/CSS-Artefakte einschließlich der letzten Accessibility-Korrekturen wurden gebaut, optimierter Root-Build mit 104 generierten Seiten. Zwei bestehende Source-Smokes wurden an die C-Klassen angepasst; sichtbare Geometrie wird zusätzlich im Browser geprüft. |
| Neue Integrationsprüfungen | 13 reine Daten-/Navigationsprüfungen plus 14 Loader-/SSR-Prüfungen bestanden: unbekannt versus leer, Fixture-Ausschluss, Kundenrollen sowie Formulare/Kunden/Leads/Newsletter. |
| Bestehende Unit-/Komponentenprüfungen | 243 bestanden, einschließlich Designgrundlagen, Navigation, Auth-/CSRF-/Rollen- und Scopeprüfungen; Studio-Navigationsprüfungen zusätzlich bestanden. |
| Knowledge | 118 Knowledge-Prüfungen bestanden; nach Bot-Verfügbarkeitskorrektur 14 Knowledge-/Bot-UI-Prüfungen bestanden. |
| Sales | Erster Lauf 92/93; der einzige Druck-/Chromiumtest bestand im isolierten Nachlauf mit vorhandener Chromium-Auswahl. Kein erneuter vollständiger Lauf daraus abgeleitet. |
| Authentifizierte Browserabnahme | Vollständiger Lauf 48/50; Mandanten-/Studio-Wechsel nach UUID-freier Testdatenkorrektur im gezielten Nachlauf 4/4 bestanden. Verbleibender No500-Kontrolltest scheitert an den vier dokumentierten Backend-Endpunkten. 24 Responsive-Prüfungen bestanden; vier axe-Scans ohne Verstöße, keine Browserausnahmen oder beobachteten Fremddatenlecks. |

### Aktueller Leserabschluss

- **12/12 Datenbanktests bestanden:** echte nicht privilegierte Runtime, unveränderte Vorgänger plus 106, gespeicherte/fehlende Quellen, autorisierte Leerzustände, technische Rollen einschließlich berechtigter Viewer-Lesefälle, frische Mitgliedschaft, Dienstidentitäten, Mandanten-/Projekt-/Botgrenzen, Kontakteigentümer, gemischte Beziehungen, erlaubte Freigabemodelle, keine zusätzlichen Tabellen-/Schreibrechte. Eine echte fehlende Funktion (`42883`) wird in einer rollbackgebundenen lokalen Prüfung nachgewiesen und anschließend wiederhergestellt.
- **14 Bot- und 7 Kalender-Quellen-/Scopeprüfungen bestanden**, zusätzlich 5 bestehende Kalender-Accessibilityprüfungen. Nach der letzten Kalenderkorrektur wurden die 7+5 betroffenen Prüfungen erneut bestanden. Fremde Workspaces zeigen keine Sitzungsworkspace-Dateien, Buchungen, Empfänger, Freigabelinks oder unbestätigten Einstellungszähler.
- **27 bestehende Design-C-Kompatibilitätsprüfungen bestanden**, dazu 19 relevante bestehende Kontakt-/OAuth-/Versand-Share-/Accessibilityprüfungen. Die 5 Maschinen-Auth-Prüfungen bestehen nach der unten genannten reinen Fixturekorrektur.
- **TypeScript, relevante Lint-Regeln und optimierter Produktionsbuild bestanden**, 104 generierte Seiten. Letzter App-Commit: `8608e728e9c4081ce1d259abe74c92e9c88d285e`, Build-ID `a_VQWjyuCc-T0Gq4P1sRg`; der Prüfbeleg enthält zusätzlich den Dateifingerprint einschließlich Testharness.
- **Gezielter authentifizierter Browserlauf: 30/30 bestanden.** Vier echte GETs/Leerzustände, acht tatsächlich abgefangene Quellen-/Netzwerkfehler, gespeicherte synthetische Vorgänge, private Datenprojektion, reale Rollen-/Mandanten-/Projektwechsel, inaktive gewordene Berechtigungen und gesperrte ungescopte Altpfade. Keine beobachteten 5xx, Browserausnahmen, externen Browserrequests, operativen Mutationen oder Fremddatenlecks. Regulärer Passwort-/TOTP-Login; keine injizierten Sitzungen. Keine neuen axe-Scans oder vollständigen 50/50 behauptet.

Drei zusätzliche **Testprobleme** wurden unabhängig von den vier echten SQL-Zugriffsfehlern korrigiert: Der historische Maschinen-Auth-Test wendete 092 erst nach Knowledge-Erweiterungen an (79 statt der unverändert geforderten 68 FORCE-RLS-Relationen); sein dedizierter Fixtureaufbau endet jetzt vor 092 bei Migration 90. Außerdem führte dieselbe Hash-URL im Browser zu keinem neuen Dokumentrequest; der Fehler-Injektionstest erzwingt jetzt einen Reload und verlangt einen tatsächlich abgefangenen GET. Der Login-Negativtest adressiert außerdem die tatsächliche Fehlermeldung statt zusätzlich den leeren Next-Routenansager mit derselben ARIA-Rolle zu treffen. Abgebrochene Vorläufe sind keine Abnahmenachweise; Passwort-/TOTP-Negativfälle bleiben bestehen.

Die vier Backend-Leseblockaden sind im Entwicklungsumfang geschlossen. Eine tatsächliche Anwendung von 106 in anderen Zielumgebungen sowie Preview/Production bleiben gesondert freizugeben. Der letzte ursprüngliche GitHub-Lauf bei `485575a` war wegen der genannten Fixturechronologie rot. Dieser Beleg wird vor dem abschließenden Push erstellt; **das tatsächliche CI-Ergebnis am endgültigen PR-Head steht anschließend in der Beschreibung und den Checks von [PR #91](https://github.com/novalure/novalure-crm/pull/91/checks)** und wird nicht aus lokalen Tests abgeleitet.

Gezielter lokaler Prüfpfad mit synthetischer wegwerfbarer PostgreSQL-Instanz und regulärem Passwort-/TOTP-Login:

```sh
npm run test:crm-operational-readers
npm run build
npm run qa:sales:server -- --built --design-c
# In einem zweiten Terminal, sobald der lokale Harness bereit ist:
npm run qa:design-c-integration -- --readers-only
```

Der Server benötigt offenes stdin; `stop` beendet die eigenen Prozesse. Der Harness verweigert `.env`-Dateien und verwendet ausschließlich generierte Loopback-Testbindungen. Seine lokale Kontextdatei enthält synthetische Zugangsdaten und wird nicht veröffentlicht. Diese Prüfung belegt keine Neon-Produktionsrolle, gehostete Preview oder produktive Benutzerfunktion.

## K. Revision und Deployment

Integrationsrevision: Git-HEAD des oben genannten Branches. Der zugehörige Entwurfs-PR wird im Abschlussbericht verlinkt; seine GitHub-CI ist separat von diesen lokalen Nachweisen zu bewerten. Geschützte Preview-URL und Deployment-ID: **nicht erstellt**. Automatische Vercel-Deployments sind für den Integrationsbranch explizit deaktiviert. Keine produktive Datenbank, Domain, Kundenakte, Telefonnummer, Stripe-/Vapi-Konfiguration oder Production-Bereitstellung wurde verändert.

## L. Übergabe an Paket 3/4

Paket 3 ist inzwischen als [PR #89](https://github.com/novalure/novalure-crm/pull/89), Revision `b019a16811bd1d0d7c180ff013b76cea34c6e5bf`, verfügbar. Der ursprüngliche Quellvergleich wurde nur lesend ausgeführt; der damals beobachtete GitHub-Qualitätsjob ist fehlgeschlagen. Diese Revision wurde nicht zusammengeführt und ihre behaupteten Testresultate wurden nicht als eigene Nachweise übernommen.

Konkrete Übergabe nach geprüftem Quellvergleich:

- Drei Überschneidungen in `knowledge-command-center.tsx`: Navigation, Quellenstatus und Ersatz der alten Review-/Historienansicht. C-Layoutklassen erhalten; Paket-3-Lifecycle-Panel übernimmt den bestehenden Freigabe-/Historienablauf vollständig, ohne Doppelengine.
- `KnowledgeLifecyclePanel` verwendet `source`, `snapshot`, `language`, `scopedPath`, `onChanged`, `showHistory`. Workflowstatus und Inhaltsversion bleiben getrennt; der freigegebene Live-Zeiger bleibt maßgeblich für Assistentenwissen.
- Maintenance-/Monitoring-/Lifecycle-Felder erhalten die vorhandenen `.evelyn-domain-*`-Hooks. Schreib-/Publish-/Tarifrechte sowie konkrete Versions-/Revisions-/Grundangaben unverändert übernehmen.
- URL-Monitoring lädt erlaubte Intervalle vom Server und verwendet `/monitoring` sowie `/scans` mit `sourceId`/`expectedVersion`. Keine eigene UI-Scannerlogik oder angenommene Aktivierung.
- Migrationen 104 und danach 105 bauen auf 101–103 auf. Paket 3 liefert einen vom Host aufzurufenden, scopebegrenzten Scheduleradapter; ein neuer produktiver Cron ist damit nicht automatisch eingerichtet.

Die vier Leseblocker werden mit diesem Abschluss behandelt. Separat bleiben der kontrollierte Paket-3-Abgleich und eine isolierte geschützte Preview mit den freizugebenden Migrationen und tatsächlichen Runtime-Rollen; `crm_synthetic_approval_requests` ist ein anderer Vertriebsfreigabevertrag und kein Ersatz für `approval_requests`. Fehler-/Verfügbarkeitsbehandlung darf die fehlenden Verträge nicht als erfolgreiche Datenantwort tarnen. Fehlende Kunden-/Angebots-/Aboaggregate und der allgemeine Evelyn-Dienst benötigen jeweils einen vorhandenen autorisierten Datenvertrag; sie werden nicht durch UI-Demodaten ersetzt. Externer Studio-Webchat, Voiceprovider und der gesonderte Produktionsrelease behalten ihre eigenen technischen Freigaben.

Kompakte Prüfnachweise und ausgewählte Ansichten: [verification.json](../qa/design-c-integration-2026-10-19/verification.json). Der ursprüngliche vollständige Browserlauf, der damalige Workspace-Nachlauf und der neue Leser-Nachlauf werden getrennt ausgewiesen; es wird kein vollständiger grüner Lauf daraus konstruiert.
