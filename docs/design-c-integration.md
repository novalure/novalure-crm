# Evelyn CRM – Integration von Design C

Stand: 19. Oktober 2026. Dieser Bericht beschreibt die Integration in die bestehende authentifizierte CRM-Anwendung; die frühere statische Demo unter `design-c/` bleibt separat und synthetisch. **Die UI-Integration ist umgesetzt und geprüft; die vollständige Abnahme bleibt durch vier bestehende Backend-Leseverträge blockiert.** Es wird keine vollständige Entwicklungsabnahme oder Produktivfreigabe behauptet.

## Grundlage

- Integrationsbranch: `codex/evelyn-crm-design-c-integration`.
- Fachliche Basis: `aa6b329942ab19c165bc610822f03ed5874af189` aus Paket 2.1 / PR [#88](https://github.com/novalure/novalure-crm/pull/88), auf Paket 2 `a04273f37fb3417b180626bd878920ab89f73609` und Studio-Paket 1 aufbauend.
- Ursprüngliches Design: `37338cba018ab7b5a00cc59edb746de8796ee724`, kontrolliert als `b7a1ab62f7aa1f8d7ae98da7ae1a18847dfbd4c0` übernommen. Die Designrichtung wurde nicht neu ausgewählt.
- Frisch beobachtete CRM-Production bleibt `ea668e625b8c778c2f79dd6a33210e731bb8a662`, Deployment `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk`, `READY`. Paket 2/2.1 und diese UI-Integration sind damit nicht als produktiv bereitgestellt belegt.

## A–H: integrierte Darstellung und reale Anschlüsse

| Bereich | Aktueller Integrationsstand und Grenze |
| --- | --- |
| **A. Design** | Vorhandene C-Tokens, Inter, dunkelblaue Navigation, helle Flächen, violettblaue Akzente und gemeinsame Primitiven werden in `.crm-app.design-c` verwendet. `evelyn-design-c.css` und `evelyn-domain-panels.css` kapseln CRM-/Domänendarstellung; öffentliche Seiten bleiben außerhalb dieses Themes. Bestehender mobiler Drawer, Fokusführung, Felder, Tabellen und Dialoge bleiben erhalten. |
| **B. CRM** | Die bestehende `CrmWorkspace` bleibt Controller. `getCoreCrmData` und `/api/crm/core` liefern die bestehenden serverautorisierten DTOs. `EvelynCommandCenter` zeigt Anfragen, offene Aufgaben, Projekte, Termine und datierte CRM-Einträge aus dem gewählten Scope; verfügbare Aktionen öffnen bestehende Bereiche. Unbekannte Kunden-/Angebotsaggregate werden nicht aus Kontakt- oder Dealzahlen erfunden. |
| **C. Kunden/Mandanten** | Kontakte, bestehende Unternehmensprofile und Kundenverwaltung verwenden ihre bisherigen Controller, darunter `/api/crm/customer-access` und `/api/settings/company-profile`. Der vorhandene Workspace-/Projektwechsel bleibt maßgeblich. `CrmCommandSearch` durchsucht nur bereits geladene, scopebegrenzte Datensätze und erlaubte Navigationseinträge; es gibt keinen neuen globalen Suchzugriff. Ein Kunden-Gesamtzähler fehlt im Core-Vertrag und bleibt im Command Center nicht verfügbar. |
| **D. Studio** | Profil, Websiteanfragen, Lead-/Vertriebsabläufe, Projektkontext und geschützte Dateiverweise bleiben bestehen. Das universelle Knowledge Center aus Paket 2/2.1 bleibt im Studio-Profil eingebunden. Intake, Release-Bindung, Kalender-/Webchatprovider und Vertragsabläufe werden durch die visuelle Integration nicht geändert oder aktiviert. |
| **E. Immobilien** | Bestehende Objekt-, Projekt-, Einheiten-, Reservierungs-, Interessenten-, Dokument- und Vermarktungskomponenten erhalten C-Darstellung. Die bisherigen Loader/Workflows bleiben erhalten. Fehlende Modulquellen erhalten einen sichtbaren Verfügbarkeitszustand; es werden keine fiktiven Objekte oder zusätzlichen Immobilienmodelle eingeführt. |
| **F. Knowledge** | Die tatsächliche `KnowledgeCommandCenter` nutzt `/api/knowledge-center` mit Bereichen, Quellen, Dokumentimport, Verarbeitungsstatus, Versionen, konkreten Freigaben, Zuordnungen und Nutzungslimits. Migrationen 101–103 stammen unverändert aus der Fachbasis. Serverseitige `available`-/Entitlement-/Permissionzustände bleiben maßgeblich. Die Integration führt diese Migrationen nicht produktiv aus. |
| **G. Assistenten/Evelyn** | Die bestehende Botverwaltung und ihre Knowledge-/Chat-/Evaluationscontroller bleiben erhalten. Die unten dokumentierten Kanal-/Freigabe-/Aktionslesewege sind unter der tatsächlichen Runtime-Rolle jedoch blockiert; ihre Betriebsfähigkeit ist nicht abgenommen. Vorbereitete Beispieldialoge und künstliche Statistikreihen werden nicht als Livebetrieb angeboten. Der allgemeine Evelyn-Dialog ist ohne nachgewiesenen Dienstcallback als nicht verfügbar gekennzeichnet. Das neue Briefing ist ausdrücklich eine deterministische CRM-Zusammenfassung, keine KI-Analyse oder erfundene KI-Aktivität. |
| **H. Kundenportal** | Die vorhandenen Kundenrollen/-profile verwenden dieselbe CRM-Oberfläche mit gefilterten Menüs. Dashboard, Projekte und lesender Knowledge-Self-Service bleiben auch im Immobilienprofil erreichbar; Botverwaltung und Einstellungen benötigen die bestehenden Fähigkeiten. Der anschließende Modulfilter und die Serverrechte bleiben wirksam. Knowledge-Self-Service bleibt unter der authentifizierten Root-Seite mit `#knowledge` erreichbar: private Datei-/Text-/Websitequellen, Prüfung/Freigabe nach Berechtigung sowie getrennte Assistentenzuordnungen. Es wird keine neue Portalroute oder Datenbank eingeführt. Abo-/Zahlungs-/Voiceproviderdaten ohne tatsächlichen Anschluss bleiben nicht verfügbar. |

## I. Sicherheit und Datenherkunft

`selectAuthoritativeCrmPresentation` übernimmt nur Fachkollektionen mit `moduleSources[key] === "database"` ohne Modulfehler. `unavailableCrmSectionCollections` verhindert, dass eine nicht geladene Sammlung als bestätigter Leerbestand erscheint. Die alten unangebundenen Zusatzkollektionen aus `crm-source` werden nicht als Geschäftsdaten verwendet. Formulare beginnen ohne Beispieldatensätze und akzeptieren bestätigte leere Datenbankantworten. Kundenverwaltung verwirft API-Fallbackdaten. Kontakte, Leadverläufe, Newsletter und Bots kennzeichnen fehlende Zusatzdaten; Newsletterversand bleibt ohne Einwilligungs-/Sperrlistendaten gesperrt. Legacy-Analysen, Kommunikation, Datenhygiene und Sequenzen ohne verifizierten Anschluss zeigen einen Verfügbarkeitszustand statt erfundener Scores. Formulare/Kundenverwaltung unterstützen im vorhandenen API-Vertrag nur den angemeldeten Workspace; in gewechselten Managed-Workspaces werden sie ausdrücklich als nicht verfügbar dargestellt. Verfügbarkeitsinformationen bleiben von echten leeren API-Ergebnissen getrennt.

Command-Center-Zähler benötigen gültigen geladenen Scope, verfügbare Navigation und bestätigte Datenherkunft; `mock`, `fallback`, Fehler oder fehlende Kundenquelle ergeben **keine willkürliche 0**. `LIMITED` kennzeichnet Ausschnitte statt Gesamtzahlen. Der bestehende `isBusinessKpiRecord`-Filter schließt synthetische Geschäftsdatensätze aus; bekannte synthetische Leadbezüge werden auch bei Aufgaben/Terminen ausgeschlossen. Die bisherigen umfangreichen Dashboardberechnungen bleiben bestehen und werden nur bei hinreichend geladenen Quellen angezeigt.

Authentifizierung, RBAC, RLS/FORCE RLS, Projektgrants, CSRF, Knowledge-Entitlements, Kanalrechte und Audit bleiben bei den bisherigen Serververträgen. Es gibt keine neuen API-, Auth-, Datenbank- oder Geschäftslogikverträge. Die bestehende Testausführung `test:sales` wurde um `--conditions=react-server` ergänzt, damit der vorhandene `server-only`-Schutz auch im Testprozess korrekt aufgelöst wird; der Schutz wurde nicht entfernt.

Die lokale Prüfung mit der **unveränderten Vorgängerkette `091–096 → 100 → 101 → 102 → 103`** und nicht privilegierter Testrolle `sales_qa_*` mit `novalure_app`-Mitgliedschaft legt vier bereits vorhandene Zugriffsblocker offen. Die folgenden bestehenden GET-Routen liefern derzeit HTTP 500; der zugrunde liegende Datenbankfehler ist SQLSTATE `42501` (fehlendes SELECT-Recht), kein bestätigter Leerbestand:

| Blockierter Endpunkt | Betroffene Legacy-Tabelle / vorhandener Aufruf |
| --- | --- |
| `/api/bots/channels` | `bot_channel_webhooks` / `listBotChannelWebhookEvents` in `runtime-repositories.ts` |
| `/api/approvals` | `approval_requests` / direkte Abfrage in der bestehenden Route |
| `/api/bots/actions` | `bot_document_sends` / direkte Abfrage in der bestehenden Route |
| `/api/meetings/oauth/status` | `provider_connections` / `getProviderConnection` in `calendar-connections.ts` |

Für diese vier Tabellen wurde kein bereits freigegebener scoped Read-Adapter gefunden. Workspace-Filter und `withCrmRead` ersetzen keine fehlenden Tabellenrechte. APIs, Authentifizierung und Datenbank bleiben unverändert; es werden keine Ad-hoc-Grants, Rollenwechsel, RLS-Ausnahmen oder zusätzlichen Migrationen eingesetzt, um die Prüfung grün erscheinen zu lassen. Bot-/OAuth-Lesezustände dürfen daraus weder „0 offen“ noch „nicht verbunden“ ableiten. Diese Blocker begrenzen die vollständige Entwicklungsabnahme unabhängig vom erfolgreichen UI-Build.

## J. Tatsächlich ausgeführte Prüfungen

| Prüfung | Bisheriger Stand |
| --- | --- |
| TypeScript, Root-Build, Lint | Bestanden; die aktuellen JavaScript-/CSS-Artefakte einschließlich der letzten Accessibility-Korrekturen wurden gebaut, optimierter Root-Build mit 104 generierten Seiten. Zwei bestehende Source-Smokes wurden an die C-Klassen angepasst; sichtbare Geometrie wird zusätzlich im Browser geprüft. |
| Neue Integrationsprüfungen | 13 reine Daten-/Navigationsprüfungen plus 14 Loader-/SSR-Prüfungen bestanden: unbekannt versus leer, Fixture-Ausschluss, Kundenrollen sowie Formulare/Kunden/Leads/Newsletter. |
| Bestehende Unit-/Komponentenprüfungen | 243 bestanden, einschließlich Designgrundlagen, Navigation, Auth-/CSRF-/Rollen- und Scopeprüfungen; Studio-Navigationsprüfungen zusätzlich bestanden. |
| Knowledge | 118 Knowledge-Prüfungen bestanden; nach Bot-Verfügbarkeitskorrektur 14 Knowledge-/Bot-UI-Prüfungen bestanden. |
| Sales | Erster Lauf 92/93; der einzige Druck-/Chromiumtest bestand im isolierten Nachlauf mit vorhandener Chromium-Auswahl. Kein erneuter vollständiger Lauf daraus abgeleitet. |
| Authentifizierte Browserabnahme | Vollständiger Lauf 48/50; Mandanten-/Studio-Wechsel nach UUID-freier Testdatenkorrektur im gezielten Nachlauf 4/4 bestanden. Verbleibender No500-Kontrolltest scheitert an den vier dokumentierten Backend-Endpunkten. 24 Responsive-Prüfungen bestanden; vier axe-Scans ohne Verstöße, keine Browserausnahmen oder beobachteten Fremddatenlecks. |

Lokaler Gesamtprüfpfad mit synthetischer wegwerfbarer PostgreSQL-Instanz und regulärem Passwort-/TOTP-Login:

```sh
npm run build
npm run qa:sales:server -- --built --design-c
# In einem zweiten Terminal, sobald der lokale Harness bereit ist:
npm run qa:design-c-integration
```

Der Server benötigt offenes stdin; `stop` beendet die eigenen Prozesse. Der Harness verweigert `.env`-Dateien und verwendet ausschließlich generierte Loopback-Testbindungen. Seine lokale Kontextdatei enthält synthetische Zugangsdaten und wird nicht veröffentlicht. Diese Prüfung belegt keine Neon-Produktionsrolle, gehostete Preview oder produktive Benutzerfunktion.

## K. Revision und Deployment

Integrationsrevision: Git-HEAD des oben genannten Branches. Der zugehörige Entwurfs-PR wird im Abschlussbericht verlinkt; seine GitHub-CI ist separat von diesen lokalen Nachweisen zu bewerten. Geschützte Preview-URL und Deployment-ID: **nicht erstellt**. Automatische Vercel-Deployments sind für den Integrationsbranch explizit deaktiviert. Keine produktive Datenbank, Domain, Kundenakte, Telefonnummer, Stripe-/Vapi-Konfiguration oder Production-Bereitstellung wurde verändert.

## L. Übergabe an Paket 3/4

Paket 3 ist inzwischen als [PR #89](https://github.com/novalure/novalure-crm/pull/89), Revision `b019a16811bd1d0d7c180ff013b76cea34c6e5bf`, verfügbar. Der Quellvergleich wurde nur lesend ausgeführt; der beobachtete GitHub-Qualitätsjob ist fehlgeschlagen. Diese Revision wurde nicht zusammengeführt und ihre behaupteten Testresultate wurden nicht als eigene Nachweise übernommen.

Konkrete Übergabe nach geprüftem Quellvergleich:

- Drei Überschneidungen in `knowledge-command-center.tsx`: Navigation, Quellenstatus und Ersatz der alten Review-/Historienansicht. C-Layoutklassen erhalten; Paket-3-Lifecycle-Panel übernimmt den bestehenden Freigabe-/Historienablauf vollständig, ohne Doppelengine.
- `KnowledgeLifecyclePanel` verwendet `source`, `snapshot`, `language`, `scopedPath`, `onChanged`, `showHistory`. Workflowstatus und Inhaltsversion bleiben getrennt; der freigegebene Live-Zeiger bleibt maßgeblich für Assistentenwissen.
- Maintenance-/Monitoring-/Lifecycle-Felder erhalten die vorhandenen `.evelyn-domain-*`-Hooks. Schreib-/Publish-/Tarifrechte sowie konkrete Versions-/Revisions-/Grundangaben unverändert übernehmen.
- URL-Monitoring lädt erlaubte Intervalle vom Server und verwendet `/monitoring` sowie `/scans` mit `sourceId`/`expectedVersion`. Keine eigene UI-Scannerlogik oder angenommene Aktivierung.
- Migrationen 104 und danach 105 bauen auf 101–103 auf. Paket 3 liefert einen vom Host aufzurufenden, scopebegrenzten Scheduleradapter; ein neuer produktiver Cron ist damit nicht automatisch eingerichtet.

Für Paket 4 bleiben: Behebung und erneute Browserprüfung der vier Backend-Leseblocker, kontrollierter Paket-3-Abgleich sowie eine isolierte geschützte Preview mit Migrationen 101–103 und tatsächlichen Runtime-Rollen. Für die vier oben blockierten Legacy-Tabellen sind zuerst ausdrücklich geprüfte mandanten-/projekt-/botbegrenzte Leserverträge und deren Rechte-/RLS-Abnahme erforderlich; `crm_synthetic_approval_requests` ist ein anderer Vertriebsfreigabevertrag und kein Ersatz für `approval_requests`. Fehler-/Verfügbarkeitsbehandlung darf die fehlenden Verträge nicht als erfolgreiche Datenantwort tarnen. Fehlende Kunden-/Angebots-/Aboaggregate und der allgemeine Evelyn-Dienst benötigen jeweils einen vorhandenen autorisierten Datenvertrag; sie werden nicht durch UI-Demodaten ersetzt. Externer Studio-Webchat, Voiceprovider und der gesonderte Produktionsrelease behalten ihre eigenen technischen Freigaben.

Kompakte Prüfnachweise und ausgewählte Ansichten: [verification.json](../qa/design-c-integration-2026-10-19/verification.json). Der vollständige Browserlauf und der gezielte Nachlauf werden getrennt ausgewiesen; es wird kein vollständiger grüner Lauf daraus konstruiert.
