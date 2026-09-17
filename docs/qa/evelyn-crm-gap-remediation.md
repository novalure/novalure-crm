# CRM Sales Readiness — Evelyn Gap Remediation

**Stand: 2026-09-17. Finaler Gesamtstatus: BLOCKED. Lokale Code-/Testgates PASS; vollständige Verkaufs-/Integrationsfreigabe bleibt gesperrt.**

Repository: novalure/novalure-crm. Branch: codex/crm-sales-readiness-high-gaps. Ausgangscommit: c3705927e2b47fc8fb0d52bfd28e5b8feff2f600. Auditquelle: [Evelyn Phase 2A, Commit 8119798](https://github.com/novalure/evelyn/tree/8119798a97347eb1c96126c6a14308e158e20862/docs/integrations/crm), Tag phase-2a-crm-contract-v1. Evelyn wurde ausschließlich gelesen.

Dieser Bericht trennt Ausgangsbefund, lokale Implementierung und Ausführungsnachweis. Das CRM bleibt alleinige operative Source of Truth. Keine reale Evelyn-Verbindung und kein Produktionsnachweis werden behauptet.

## Status und Zählung

Ursprünglich: **18 High, 9 Medium**, insgesamt 27 Lücken. Die High-Ausgangsprüfung ergab **16 CONFIRMED, 0 ALREADY_FIXED, 0 PARTIALLY_FIXED, 0 NO_LONGER_APPLICABLE, 2 NOT_VERIFIED (G24/G25)**. Das ist die Prüfung vor diesen Änderungen, keine nachträgliche Erfolgszählung.

Aktuelle Abhilfe: LOCAL_IMPLEMENTED = konkrete Abhilfe im benannten lokalen Pfad, abschließende Gates gesondert; PARTIAL = ursprüngliche Reichweite weiter offen; PENDING = Abschlussprüfung/Umsetzung läuft; NOT_VERIFIED = Nachweis nicht erhoben. LOCAL_IMPLEMENTED bedeutet weder produktiv angewendet noch sämtliche historischen CRM-Pfade abgesichert.

**11/18 High-Gaps im geprüften lokalen Umfang behoben:** G03, G04, G05, G07, G09, G10, G11, G12, G13, G15, G25. **7 High-Gaps verbleiben:** G01, G02, G06, G08, G16, G17 teilweise; G24 NOT_VERIFIED. Die breite historische CRM-Reichweite bei G02/G16/G17 wird bewusst nicht als vollständig behoben gezählt. Aktuelle Nachbewertung: 0 CONFIRMED ohne Maßnahme, 11 ALREADY_FIXED durch diesen Branch, 6 PARTIALLY_FIXED, 0 NO_LONGER_APPLICABLE, 1 NOT_VERIFIED. Das unterscheidet sich von der oben eingefrorenen Baseline-Zählung. Neue unabhängige Code-Reviewbefunde: Critical 0 / High 0 / Medium 0. Ursprüngliche verbleibende Medium-Gaps: 8 (G19 lokal behoben).

## Konkrete Implementierungs- und Testreferenzen

Die Kürzel in den Gap-Tabellen benennen folgende geänderte Dateien und Testquellen. „Test vorhanden“ ersetzt keine Ausführung; finale Ergebnisse stehen im Prüfprotokoll.

| Kürzel | Geänderte Implementierung | Tests |
| --- | --- | --- |
| F | [080 Command-/RLS-Migration](../../migrations/080_crm_command_safety.sql), [crm-command.ts](../../src/lib/crm-command.ts), [tenant-client.ts](../../src/lib/db/tenant-client.ts), [transaction-context.ts](../../src/lib/db/transaction-context.ts), [client.ts](../../src/lib/db/client.ts) | [crm-command-tests.ts](../../scripts/crm-command-tests.ts): sichere DB-Rolle, Tenant-/Projekt-/Klassifikation, atomarer Commit/Rollback, Receipt/Event/Audit, Replay/Parallelität, Dashboard-RLS |
| C | [Core-Route](../../src/app/api/crm/core/route.ts), [Startseite](../../src/app/page.tsx), [Loader](../../src/lib/db/crm-loaders.ts) | F: nebenwirkungsfreier Core-Read und keine Mockmodule |
| I | [Inventory-Repository](../../src/lib/db/property-inventory-repositories.ts), [Units-Route](../../src/app/api/crm/units/route.ts), bestehende Ledger 069 | F: Ledger, Dubletten, stale Unitupdates, fremde Gebäude, Preis-/Statusbypass |
| A | [081 Angebotsmigration](../../migrations/081_crm_offer_workflow.sql), [Angebotsmodell](../../src/lib/offer-workflow.ts), [Repository](../../src/lib/db/offer-repositories.ts), [Route](../../src/app/api/crm/offers/route.ts), [UI](../../src/components/offer-workflow.tsx) | [offer-workflow-tests.ts](../../scripts/offer-workflow-tests.ts): Version/Freigabe, Actor/Sitzung, Revision, Versand/UNKNOWN, Annahme/Ablehnung, Follow-up, Kundenübergang, RLS/FKs, Druckisolierung |
| B | [082 Projektverkaufsmigration](../../migrations/082_crm_property_sales_workflow.sql), [Modell](../../src/lib/property-sales.ts), [Repository](../../src/lib/db/property-sales-repositories.ts), [Route](../../src/app/api/crm/property-sales/route.ts), [Suchprofil-Sync](../../src/lib/db/broker-entity-repositories.ts), [UI](../../src/components/property-sales-workflow.tsx) | [property-sales-tests.ts](../../scripts/property-sales-tests.ts): kompletter Flow B, Pflichtfelder, Handover, Statusübergänge, Autorität/Entzug, Tenant/FKs, Dubletten/Rennen, Auditrollback |
| L | [CRM-Write-Repository](../../src/lib/db/crm-write-repositories.ts), [Recommendation](../../src/lib/db/recommendation-runtime-repositories.ts), [Reservierungen](../../src/lib/db/reservation-repositories.ts), [Property Department](../../src/lib/db/property-department-repositories.ts), Lead-/Deal-/Stage-Routen | [legacy-sales-tests.ts](../../scripts/legacy-sales-tests.ts): Lead-/Deal-Replay, stale Updates, direkte Qualifizierung/Dealabschluss verweigert, fremder Tenant |
| U | [DealPipeline](../../src/components/deal-pipeline-workspace.tsx), [LeadInbox](../../src/components/lead-inbox.tsx), [UnitBoard](../../src/components/unit-board.tsx), [ReservationBoard](../../src/components/reservation-board.tsx), [CRMWorkspace](../../src/components/crm-workspace.tsx), [Typen](../../src/lib/crm-types.ts), [i18n](../../src/lib/i18n.ts) | [Browserlauf](../../scripts/qa-sales-browser.mjs), bestehende UnitBoard-/LeadInbox-Regressionstests |
| CAS | [083 Core-CAS](../../migrations/083_crm_core_cas.sql), Write-Repository, Contact-/Task-/Project-DTO/Loader/API/UI | [core-cas-tests.ts](../../scripts/core-cas-tests.ts): lokale PostgreSQL-Nachweise; finaler Gesamtlauf PASS |

## Alle 18 ursprünglichen High-Gaps

| ID | Ursprünglicher Status und Beschreibung | Baseline-Reaudit | Aktuelle Abhilfe | Maßnahme / Dateien | Testgegenstand und Ergebnis | Restrisiko |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | MISSING: enger Dienstprincipal/Scopes | CONFIRMED | PARTIAL | F: enges Scopevokabular, Tenant/Projekt/Klassifikation/Zweckprüfung; Dienstkontext endet immer mit SERVICE_INTEGRATION_DISABLED. | F: kein Serviceprincipal/private Datenzugriff; final PASS. | Kein Tokenissuer oder aktivierter Dienstprincipal. Menschliche Sales-Rollen ersetzen nicht spätere Dienstauthentifizierung. |
| G02 | BLOCKED: RLS-Pilot ohne Application-Cutover | CONFIRMED | PARTIAL (Core/Sales lokal behoben) | F/C/I/A/B/L: gemeinsame Tenanttransaktion, sichere Runtime-Rolle, RLS auf benötigten Sales-Tabellen. | F: non-owner/no-bypass, Isolation, Poolreuse, Rollback; final PASS. | Keine pauschale Härtung sämtlicher historischer Finance-/Bot-/Media-/Providerpfade; Produktionsstand G24. |
| G03 | BLOCKED: GET repariert Pipelines | CONFIRMED | LOCAL_IMPLEMENTED | C: Reparaturaufrufe aus Core-GET und Server-Startseite entfernt. | F: Core-Read erzeugt keine Pipeline; final PASS. | Fehlende Pipelines benötigen ausdrücklichen Schreibprozess, keinen versteckten Read-Sideeffect. |
| G04 | BLOCKED: DB-/Mockdaten vermischt | CONFIRMED | LOCAL_IMPLEMENTED | C: leere fehlgeschlagene Module statt operativer Mockdaten; Fehler/Herkunft sichtbar; expliziter Demo-Modus getrennt. | F: Core ohne Mockmodule; final PASS. | Leere/limitierte Antworten beweisen keine Vollständigkeit; G23 bleibt. |
| G05 | MISSING: atomare Versionsprüfung | CONFIRMED | LOCAL_IMPLEMENTED | F/I/A/B/L: Lead/Deal/Unit/Offer/Flow-B-CAS. CAS/083 ergänzt Contact/Task/Project und deren bestehende Einstiege. | F/A/B/L/CAS: stale Konkurrenz, monotone Version/DTO; CAS-Tests 8/8 im finalen Root-Gesamtlauf PASS. | CAS für vorhandene Contact/Task/Project/Lead/Deal/Inventory/Offer-/Sales-Einstiege belegt. Andere historische Entitäten nicht automatisch abgedeckt. |
| G06 | PARTIAL: Lead-/Deal-Deduplizierung ohne vollständigen Digest | CONFIRMED | PARTIAL | F/L: atomare Receipts mit Tenant/Actor/Operation/Scope/Version/Wirkungsdigest, Legacy-Lead/Deal eingebunden. | F/L/A/B: Replay, geänderter Payload, parallele Requests; final PASS. | Kein universeller Vertrag aller alten Update-Endpunkte; caller-stabile Schlüssel/Unknown-Recovery je Einstieg prüfen. |
| G07 | PARTIAL: Inventory-Ledger nicht angeschlossen | CONFIRMED | LOCAL_IMPLEMENTED | I/F: vorhandene Unit-/Building-Ledger an atomare Commands angeschlossen; Dubletten überschreiben nicht. | F: Ledger, doppelte Unitnummer, stale Parallelität; final PASS. | Nur umgestellte Inventorypfade; kein Exactly-once über Providergrenzen. |
| G08 | MISSING: gebundene ApprovalReference/Zweischritt | CONFIRMED | PARTIAL | A: unveränderliche Revision, Digest, Actor, frische persistierte Sitzung, Ablaufzeit, offer.send; Änderungen invalidieren Freigabe. | A: alte Freigabe/falscher Actor/abgelaufene Sitzung/Widerruf; final PASS. | Angebotsfreigeber muss autorisiert konfiguriert sein. Keine zwei unabhängigen Evelyn-Freigabekanäle aktiv; Vertrag/Zahlung gesperrt. |
| G09 | PARTIAL: Preis-/Statusquelle ohne Projektbefugnis | CONFIRMED | LOCAL_IMPLEMENTED | B/I: ausdrückliche Preis-/Reservierungs-/Verkaufsbefugnis und Quellbeleg; Actor/Zeit/Version; generischer Bypass gesperrt. | B/F: unbefugt, Entzugsrennen, Auditrollback, Statusbypass; final PASS. | Menschlicher Quellbeleg, kein externer Wahrheitsnachweis; keine Portal-/Websitesynchronisation. |
| G10 | BLOCKED: Anlage sofort verbindlich reserviert | CONFIRMED | LOCAL_IMPLEMENTED | B/U: requested unverbindlich, Unit bleibt verfügbar; eigener autorisierter Confirm; Legacy-Mutation gesperrt. | B: bestätigungspflichtiger Übergang, Dubletten; U: requested in beiden Boards; final PASS. | Keine automatische Bestätigung oder erfundene Freigabe für Legacyreservierungen; frühzeitige Stornierung nicht aktiviert. |
| G11 | PARTIAL: getrennte Reservierungs-/Unit-/Deal-/Auditwrites | CONFIRMED | LOCAL_IMPLEMENTED | F/B: Businessdaten, Belege, Receipt, Audit und internes Event in einer Transaktion; SQL-Abbruch kann keinen Erfolg vortäuschen. | F/B/A: komplette Rollbacks, Auditfehler, Rennen; final PASS. | PostgreSQL-Atomarität, kein atomarer Mehrsystem-/Providervertrag. |
| G12 | MISSING: kanonische freigegebene Angebotsakte | CONFIRMED | LOCAL_IMPLEMENTED | A: Positionen/EUR netto/Gesamtverpflichtung, Revision/Approval, Versandstatus/-beleg, Follow-up, Antwort, atomarer Kundenübergang. | A/L/U: positive/negative komplette Flows; Browserabschluss 13/13 PASS. | Versand ausschließlich manuell attestiert; keine Providerzustellung. Wiederkehrende Verpflichtungen vollständig erfassen; Vertrag/Zahlung gesperrt. |
| G13 | MISSING: autorisierte Sale-Bestätigung | CONFIRMED | LOCAL_IMPLEMENTED | B: property_sales mit Unit/Reservation/BuyerLead/Contact, Projektbefugnis, Actor/Quelle; Unit sold atomar. | B: unbefugt, fehlende Bestätigung, doppelter Verkauf/verkaufte Unit; final PASS. | Kein notarieller oder Provider-Beleg geprüft, keine externe Statussynchronisation. |
| G15 | MISSING: kanonische Bauträger-/Projektautorität | CONFIRMED | LOCAL_IMPLEMENTED | B: Projekt-Developer-FK und Rechte je Projekt/Benutzer/Ansprechpartner; getrennte Preis-/Reservation-/Salebefugnisse. | B: fremder FK, Selbstzuweisung, delegierter Actor/Entzug; final PASS. | Beauftragung muss real dokumentiert werden; Rollenname allein reicht nicht; kein automatisches Legacybackfill. |
| G16 | PARTIAL: fehlender positiver Projektlesegrant | CONFIRMED | PARTIAL (Core/Sales lokal behoben) | F/C/I/A/B: positive Projektprüfung/RLS im Actor-/Tenantkontext; neuer UI-Workspaceparameter. | F/B/A: Tenant/Projekt/Empfänger-Impersonation; U-Nachreview; final PASS. | Explizite Managerrollen haben breite Rechte; keine Gesamtgarantie historischer Endpunkte. |
| G17 | MISSING: Klassifikation und Zweckgrenze | CONFIRMED | PARTIAL (Core/Sales lokal behoben) | F: gespeicherter Operating-Model-Kontext, data_classification, crm_sales; PRIVATE_FRANZ/UNCLASSIFIED nicht geöffnet. | F: Owner sieht private Daten nicht, aktive Mitgliedschaft; final PASS. | Kein umfassendes Privacy-Audit sämtlicher historischer Finance-/Kommunikationsdaten. |
| G24 | NOT VERIFIED: produktive Migrationen/Constraints/Rolle/Cutover | NOT_VERIFIED | NOT_VERIFIED | Keine Produktions-DB erhoben oder verändert; lokale Nachweise getrennt. | F/A/B/CAS lokal; Production NOT RUN. | Separat autorisierte Bestandsdaten-/Rollen-/Migrationsprüfung erforderlich; lokale Fixtures ersetzen sie nicht. |
| G25 | NOT VERIFIED: aktuelle CRM-/Recovery-/Sales-E2E-Nachweise | NOT_VERIFIED | LOCAL_IMPLEMENTED (lokaler synthetischer Nachweis) | Lokale echte PostgreSQL-Tests und Browser-QA, keine Evelyn-Fakes als CRM-Persistenzersatz. | F/A/B/L/CAS/U; 365/365 Prüfungen PASS, Browser/Desktop/Mobile 13/13 PASS. | Kein Produktionsnachweis; Preview-QA gesondert; alte Testberichte nicht als aktuelles PASS übernehmen. |

## Alle 9 ursprünglichen Medium-Gaps

Nur Voraussetzungen der High-Lücken und Kernflows wurden bearbeitet.

| ID | Ursprünglicher Status und Beschreibung | Baseline-Reaudit | Aktuelle Abhilfe | Maßnahme / Dateien | Tests und Ergebnis | Restrisiko |
| --- | --- | --- | --- | --- | --- | --- |
| G14 | PARTIAL: Company-/Lebenszykluscontract | CONFIRMED | PARTIAL | A: Organisation verbinden/anlegen, Annahme setzt bestehende Organisation auf Kunde. | A: Annahme/Ablehnung/Kundenübergang; final PASS. | Kein allgemeiner Company-CRUD oder automatisches Kundenkonto/externes Onboarding. |
| G18 | MISSING: atomare versionierte Domänen-Outbox | CONFIRMED | PARTIAL | F: internes crm_domain_events-Ledger mit Sequence, ID, Tenant/Actor/Correlation, Command-/Auditbindung. | F: atomarer Commit/Rollback, Unveränderlichkeit; final PASS. | Kein Publisher, Consumer oder vollständiger Evelyn-Replay-/Eventvertrag aktiviert. |
| G19 | PARTIAL: Qualifikation und Handover verteilt | CONFIRMED | LOCAL_IMPLEMENTED für Flow B | B: validierte Pflichtfelder, Unit/Priorität/Quelle, Suchprofil-Sync und versionierter Empfängerbeleg. | B: complete-Flag ersetzt keine Pflichtdaten, Doppelhandover/Empfänger; U; final PASS. | Vollständigkeit ist keine materielle Prüfung von Finanzierungsnachweisen. |
| G20 | PARTIAL: Appointment/Viewing/Zeitzonen nicht konsistent | CONFIRMED | PARTIAL | B: explizite Viewingzeit/IANA-Zone und Statusmaschine. | B: Endzeit, Zone, Statussprung; U; final PASS. | Kalender-/Meetingprovider, Verfügbarkeit, Puffer/No-show-Automation aus; optionale calendar_event_id beweist keine Integration. |
| G21 | PARTIAL: generischer Kommunikations-/Deliveryvertrag | CONFIRMED | PARTIAL | A: Empfänger/Revision/Digest mit manuellem Versandbeleg, UNKNOWN verhindert blindes Neuqueuing. | A: Scopebindung/Unknown; final PASS. | MANUALLY_ATTESTED ist keine Providerzustellung; kein allgemeiner kanalübergreifender Appendvertrag. |
| G22 | PARTIAL: uneinheitliche Fehler/Responses | CONFIRMED | PARTIAL | F/A/B: maschinenlesbare Codes, Correlation/Contractversion, Audit-/Commandreferenzen, Redaktion. | F/A/B: negative Commands und unbekannte DB-Fehler; final PASS. | Legacy-Routen nicht global vereinheitlicht. |
| G23 | PARTIAL: Listenlimits ohne vollständigen Cursorvertrag | CONFIRMED | PARTIAL | C: collectionCompleteness=LIMITED; vorhandene Unitpagination. | C/F: keine vorgetäuschte vollständige Datenbasis; final PASS. | Kein globaler Cursor-/Sync-/Reportingvertrag für große Bestände. |
| G26 | NOT VERIFIED: Provider/Cron/Deployment-Betrieb | NOT_VERIFIED | NOT_VERIFIED | Keine externe Integration aktiviert; Preview erst nach lokalen Gates und bestehender Verbindung. | Provider/Production NOT RUN; Preview separat. | Vorhandener Code beweist keinen sicheren aktiven Betrieb. |
| G27 | PARTIAL: Geld-/Budgetsemantik uneinheitlich | CONFIRMED | PARTIAL | A/B/I: sichere Integer-Cents, Angebots-EUR/netto/Gesamtverpflichtung, strukturierte Budgets und autorisierte Preise. | A/F/B: Präzision/Überlauf/Perioden; final PASS. | Historische Preis-/Budgettexte und sämtliche Steuer-/Währungssemantik nicht migriert; keine erfundenen Netto-/Autoritätsbelege. |

## Die beiden Kernflows und ihre Grenzen

**Flow A:** Kontakt und Lead werden mit Deal und Organisation verbunden. Die Angebotsakte hält Empfänger, Positionen und Gesamtverpflichtung. Die konfigurierte Person genehmigt genau Revision/Digest mit frischer persistierter Sitzung und Ablaufzeit. Änderungen erfordern neue Freigabe. QUEUED bedeutet vorbereitet, nicht gesendet. Manuelle Versandattestierung bindet Fassung/Empfänger; UNKNOWN verhindert blindes Neuversenden. Nachfassen wird als manuelle Aufgabe geplant/erledigt/gestoppt. Annahme/Ablehnung speichern einen Kundenbeleg, stoppen offene Aufgaben und ändern Deal/Organisation atomar.

salesApprovalUserId muss durch einen autorisierten Setup-Prozess gesetzt werden. Ohne Konfiguration bleibt Freigabe gesperrt. Dieser Bericht fordert keine Änderung produktiver Settings. Angebotsfreigabe ist keine Vertragsfreigabe; Vertrags-/Zahlungsversand und zwei unabhängige Evelyn-Freigabekanäle bleiben deaktiviert.

**Flow B:** Bauträgerprojekt/Einheit werden einer Käuferanfrage zugeordnet. Strukturierte Qualifizierung speichert Budget, Finanzierung, Kaufzeitraum, Nutzung, Unit, Priorität und Quelle. Aktuelle Vollständigkeit wird serverseitig ermittelt. Handover bindet Qualifikationsversion und berechtigten Empfänger. Viewing besitzt Zeiten/Zone und kontrollierte Zustände. requested bleibt unverbindlich und die Unit verfügbar; nur projektbezogene Befugnis plus Quelle darf reservieren bzw. verkaufen. Status/Akte/Audit werden gemeinsam persistiert.

Die Formulare sind in DealPipeline, LeadInbox und UnitBoard integriert. Nichtkäuferbezogene Leadübergaben behalten den autorisierten Legacy-CAS-Pfad. Parentlisten werden aktualisiert; Nachladefehler werden als bereits gespeichert, aber veraltete Übersicht kenntlich gemacht. Desktop 1440×1000 und Mobile 390×844 wurden im lokalen Chrome geprüft. Kontakt-/Lead-/Unit-Anlage erfolgte über authentifizierte CSRF-APIs; die neuen Angebots- und Projektverkaufsprozesse wurden in der tatsächlichen UI bedient.

## Reviewbefunde und Nachprüfung

Ein Nichtautor der CRM-Implementierung prüfte UI, Datenschutz, Einbindung und Gap-Reichweite. Im Quellcode-Nachreview waren folgende konkreten Fehler korrigiert:

| Befund | Priorität | Korrektur / Nachweisgrenze |
| --- | --- | --- |
| Angebotsdruck konnte gesamtes CRM inklusive fremder Deals/interner Daten erfassen. | High | Isoliertes sandboxed Druckiframe klont ausschließlich den React-escaped Angebotsartikel. Kein parent window.print/innerHTML/document.write; DRAFT gesperrt. Gezielter lokaler Chrome-Regressionsfall beweist Ausschluss fremder/interner Daten und sicheren HTML-artigen Text. |
| Parent-Unit-/Leadstatus blieb nach Mutation alt. | Medium | Snapshot- und Parentrefresh, lokale Overrides nach erfolgreichem Refresh entfernt. |
| Nichtkäufer-Leadübergabe fälschlich in Käuferprozess gezwungen. | Medium | Nur Käufer/Investor werden dorthin geleitet; andere Typen behalten generischen autorisierten CAS-Einstieg. |
| Workspacekontext im neuen Projektverkaufsformular fehlte. | Medium | Alle GET/POST verwenden workspaceId; beide Parents reichen Kontext durch, Remount beim Workspacewechsel. |
| requested fehlte in Typ/Loader/Boards. | Medium | Unverbindliche Anfrage sichtbar, Bestätigen ersetzt erneute Anfrage; kein Zählen als reservierte Unit. |
| Leere Angebotsdatumsfelder warfen unbehandelten Fehler. | Medium | Validierung vor ISO-Konvertierung mit sichtbarer Fehlermeldung. |

Dieser Nachreview ist ein Codebefund, keine eigene neue Browser-/DB-Ausführung des Reviewers. Separater unabhängiger Securityreview sowie abschließender CAS-/Dashboard-/Transport-Nachreview: PASS, keine offenen Critical/High-Codebefunde. Die Runtime-Rollenprüfung, vorzeitige Reservierungsablaufaktion, Autoritätsentzugsrace, Legacy-Expiry und Suchprofilbypass wurden vor dieser Abnahme korrigiert. Der UI-Reviewer schrieb anschließend diesen Bericht; dessen eigene Berichtserstellung ist kein unabhängiger Review des fertigen Dokuments.

## Tatsächlich ausgeführte Prüfungen / finale Abschlussgates

Ausgeführt am 2026-09-17 mit Node **24.14.0**, npm **11.9.0**, PostgreSQL **18.4** und lokalem Chrome. Keine übersprungenen Tests. Die Zahlen sind disjunkt nach ausführbaren Testsuites zugeordnet; eine Suite kann mehrere Testarten enthalten. Node zählt auch test()-Eltern mit Unterfällen; diese native Zählweise bleibt transparent erhalten.

| Prüfung | Finales Ergebnis / Befehl |
| --- | --- |
| Unit / bestehende Regression | **232/232 PASS** — npm run test:unit |
| Bestehende Integration | **15/15 PASS** — npm run test:integration |
| Migration/DB-CAS | **8/8 PASS** — scripts/core-cas-tests.ts innerhalb test:sales |
| RBAC/Security | **45/45 PASS** — 28 crm-command-tests + 17 test:protected-preview-access (lokale Contracttests, keine Preview-QA) |
| Workflow | **52/52 PASS** — 22 Offer inkl. realer Browser-Druckisolierung, 24 Property-Sales, 6 Legacy |
| E2E | **13/13 PASS** — npm run qa:sales:e2e, eigener Start und sauberer Stop des lokalen Clusters |
| Gesamt | **365/365 PASS**, 0 failed, 0 skipped, 0 cancelled |
| Typecheck | **PASS** — npm run typecheck |
| Lint | **PASS** — npm run lint, max-warnings=0 |
| Build | **PASS** — npm run build, kein Deployment |
| Toolchain | **PASS** — npm run ci:toolchain |
| Dependency Audit | **PASS** — npm audit --audit-level=moderate, gesamte Dependencystruktur: 0 Critical/High/Moderate/Low |
| Secret Scan | **PASS** — Gitleaks 8.30.1, vollständige PR-Historie (122 Commits), vorgeschlagener Projektbaum und sämtliche origin-Refs (164 Commits); drei exakt begrenzte historische False-Positive-Fingerprints, siehe unten |
| Unabhängiger Review | **PASS** für geänderten Code, Critical 0 / High 0 / Medium 0; ursprüngliche Capability-Gaps siehe Register |
| Flow A | **PASS lokal/manuell**, Annahme und Ablehnung in DB-Tests, Annahme zusätzlich Browser |
| Flow B | **PASS lokal**, gesamte Kette inklusive autorisierter Statuswechsel im Browser und DB |
| Preview | **READY, ausschließlich Preview** — siehe Abschlussabschnitt |
| Preview QA | **PARTIAL** — Login per vorhandenem Vercel-Zugang HTTP 200; anonyme Core-API HTTP 401, keine Businessdaten; Browser erreicht Vercel-Schutzseite |
| Production DB / Provider / echter Versand | **NOT RUN**, keine Aktivierung/Änderung |

Die neuen Salesmigrationen 080–083 liefen unverändert in frischen synthetischen Clustern, einschließlich geprüfter RLS/Constraints/Append-only-Regeln und Rollback bei Teilfehlern. Der Bootstrap wendet 80 Vorwärtsdateien mit den nachstehend genannten historischen Ausnahmen an. Die Browserprüfung verwendet eine persistierte synthetische MFA-Sitzung; echter Credential-/Login-Austausch und externe Zustellung sind nicht nachgewiesen.

Lokale Rohprotokolle liegen ignoriert unter .npm-cache/qa/final-*.log, final-audit.json und sales-browser-results.json. Keine Cookies, lokalen DB-Verbindungen oder generierten Auth-Werte werden eingecheckt. Der versionierte Nachweis [evelyn-crm-local-evidence.json](evelyn-crm-local-evidence.json) enthält ausschließlich Testzähler und Datei-Hashes. CI wurde um isolierte PostgreSQL- und Chromiumprüfungen erweitert; der GitHub-Lauf wird separat vom lokalen Nachweis betrachtet.

Ein zusätzlich ausgeführter Scan aller lokalen Git-Refs enthielt sechs redigierte Treffer in zwei fremden, nicht in main enthaltenen Arbeitsbranches. Diese gehören nicht zur PR-Historie. Drei davon lagen auch in den von GitHub mitgeladenen origin-Refs und ließen den ersten CI-Scan scheitern. Ein unabhängiger Reviewer bestätigte reine Dokumentationsprosa, einen öffentlichen Providernamen und ein synthetisches Test-Idempotenzliteral (keine UUID). .gitleaksignore dokumentiert ausschließlich die drei exakten Commit-/Datei-/Regel-/Zeilen-Fingerprints auf de42e6b; keine globale Pfad- oder Regel-Ausnahme. Danach bestand der vollständige origin-Ref-Scan (164 Commits). Die weiteren drei Treffer liegen ausschließlich in einem fremden lokalen Arbeitsbranch, der nicht zum PR oder GitHub-Checkout gehört. Alle fremden Branchdateien blieben unverändert. Der vorgeschlagene PR-Baum und seine vollständige eigene Historie sind befundfrei.

## Begrenzung der lokalen PostgreSQL- und Browsernachweise

Der [DB-Harness](../../scripts/lib/local-sales-db.mjs) erstellt einen isolierten lokalen synthetischen PostgreSQL-Cluster auf 127.0.0.1 und eine nicht privilegierte Runtime-Rolle. Er konsumiert keine bestehende Produktions-Verbindungszeichenfolge. [Browserharness](../../scripts/qa-sales-browser-server.mjs) und [Testtransport](../../src/lib/db/local-test-transport.ts) bleiben lokal. Eine synthetische persistierte MFA-Sitzung im Browser ist kein geprüfter realer Credential-/Login-Austausch.

Historische Schemaausnahmen sind ausdrücklich Bestandteil der Nachweisgrenze:

1. Migration 001: Die portable PostgreSQL-Distribution enthält keine optionale pgvector-Erweiterung. Nur Extension/RAG-Embeddingtyp und ivfflat-Index werden im Fixturebootstrap ersetzt/ausgelassen (embedding real[]). Das beweist keine pgvector-/RAG-Kompatibilität.
2. 062_private_media_contract_cutover.sql wird nicht angewendet. Der historische manuelle Media-Cutover kollidiert im generischen Bootstrap mit dem append-only Audittrigger. Die Auditsperre bleibt aktiviert. Dieser Cutover ist nicht als bestanden zu behandeln.
3. Rollbackdateien werden nicht als Vorwärtsmigrationen ausgeführt.
4. Der Ledger verwendet den Hash der Originaldatei; bei bewusst angepasster 001 beweist dieser daher nicht byteidentisch ausgeführtes Original-SQL. Ausnahmen stehen im Harness und migration-evidence.json.

Die neuen Salesmigrationen 080/081/082 und 083 bestanden im finalen autorisierten lokalen Salespfad unverändert. Produktive Bestandsdaten, angewandte Checksums, Rollen und Cutover bleiben unbekannt. NOT VALID-Constraints und Legacydaten sind vor einem separat genehmigten Rollout ausdrücklich zu prüfen.

## Externe Änderungen und Stopppunkt

Reale Evelyn-Verbindung deaktiviert; kein Dienstprincipal ausgegeben, keine Events extern publiziert. MANUALLY_ATTESTED bedeutet menschlicher Beleg und keine geprüfte Providerzustellung. Core-/Sales-RLS, CAS und lokales E2E sind keine pauschale Freigabe aller historischen CRM-/Finance-/Providerfunktionen.

Keine produktive DB verändert, kein Production Deployment, keine produktiven Kundendaten/Secrets für Tests. Evelyn und novalure-website bleiben unverändert. Änderungen gehören ausschließlich in diesen CRM-Branch. PR nicht mergen. PR und Preview sind im folgenden Abschlussabschnitt dokumentiert.

**Nächster empfohlener Schritt:** Franz prüft den fertigen PR, die verbleibenden Integrations-/Produktionsvoraussetzungen und die belegte lokale Abnahme und entscheidet separat über Merge und kontrollierten weiteren Rollout. Hier nicht ausführen.

## GitHub und Preview-Abschluss

- PR [#63](https://github.com/novalure/novalure-crm/pull/63): OPEN, Ready for Review, **nicht gemergt**.
- Implementierungscommit: 58b95d73ee7e620a5ec93d7ecb0efa61e8496e12. Nachfolgende Änderungen betreffen ausschließlich diesen Bericht und eng begrenzte historische Gitleaks-Triage.
- [Preview des geprüften Implementierungsstands](https://novalure-umdrtgonn-novalure.vercel.app), Deployment dpl_ARaEcZQAPGXVmjJR8DKHQ9PcBYio: READY, target=preview. Die bestehende Gitverknüpfung hat productionBranch=main; dieser Featurebranch wurde nicht nach main übernommen.
- Linux-GitHub-CI am Implementierungscommit: Quality (einschließlich isolierter PostgreSQL-/Chromiumabläufe und Build) PASS; Production Dependency Audit/SBOM PASS. Finaler Nachweis auf ba228ae509ccc75c3a66ac298913cb1347436310: [Quality und Dependency/SBOM PASS](https://github.com/novalure/novalure-crm/actions/runs/35234107290), [Gitleaks PASS](https://github.com/novalure/novalure-crm/actions/runs/35234107445). Der bestehende nur manuell auslösbare externe QA-Job wurde bewusst nicht gestartet und ist im PR-Workflow SKIPPED, kein lokaler Pflicht-Test wurde übersprungen.
- Preview-HTTP: anwendungseigene Loginseite 200 mit korrektem Novalure-Titel; anonyme Core-API 401 ohne Daten. Ein direkter Browseraufruf landet vor der App in Vercel Authentication. Kein App-Login, keine authentifizierten Preview-Salesaktionen oder Preview-Datenmigration ausgeführt; dafür ist eine nachweislich isolierte Testdatenbank mit erforderlichem Schema und Testkonto separat abzunehmen.
- Finale zusätzliche [Preview auf ba228ae](https://novalure-onwht9ktw-novalure.vercel.app), Deployment dpl_FNG3wRki4qRW2vb9FGhHM2qn38ve: READY, ebenfalls nur Preview; Login 200 und anonyme Core-API 401 separat erneut geprüft. Alle 467 normalisierten Quellhashes stimmen mit dem lokal getesteten Stand überein. Nach diesem Nachweis wird ausschließlich der Bericht ergänzt, kein Laufzeitcode geändert.
- Preview QA **PARTIAL**; lokale Desktop-/Mobile-/Workflowbelege sind keine Preview-Abnahme. Die bestehenden Preview-Provider-/Datenbankwerte wurden weder ausgelesen noch geändert; reine Ziel-/Schlüsselnamenmetadaten wurden geprüft.
- Production DB geändert: **NEIN**. Production deployed: **NEIN**. Evelyn-Verbindung: **NEIN**. Evelyn und novalure-website unverändert.

## Geänderte Dateien

- .gitleaksignore
- .github/workflows/livegang-e2e.yml
- docs/qa/evelyn-crm-gap-remediation.md
- docs/qa/evelyn-crm-local-evidence.json
- eslint.config.mjs
- migrations/080_crm_command_safety.sql
- migrations/081_crm_offer_workflow.sql
- migrations/082_crm_property_sales_workflow.sql
- migrations/083_crm_core_cas.sql
- next.config.ts
- package-lock.json
- package.json
- scripts/core-cas-tests.ts
- scripts/crm-command-tests.ts
- scripts/legacy-sales-tests.ts
- scripts/lib/local-sales-db.mjs
- scripts/lib/sales-browser-fixture.mjs
- scripts/offer-workflow-tests.ts
- scripts/phase0-smoke-tests.mjs
- scripts/property-department-smoke-tests.mjs
- scripts/property-sales-tests.ts
- scripts/qa-sales-browser-server.mjs
- scripts/qa-sales-browser.mjs
- scripts/qa-sales-e2e.mjs
- scripts/tenant-hardening-smoke-tests.mjs
- src/app/api/crm/broker/mandates/route.ts
- src/app/api/crm/broker/search-profiles/route.ts
- src/app/api/crm/contacts/route.ts
- src/app/api/crm/core/route.ts
- src/app/api/crm/dashboard-views/route.ts
- src/app/api/crm/deals/[dealId]/stage/route.ts
- src/app/api/crm/deals/route.ts
- src/app/api/crm/leads/route.ts
- src/app/api/crm/offers/route.ts
- src/app/api/crm/projects/route.ts
- src/app/api/crm/properties/route.ts
- src/app/api/crm/property-sales/route.ts
- src/app/api/crm/tasks/route.ts
- src/app/api/crm/units/route.ts
- src/app/page.tsx
- src/components/contact-command-center.tsx
- src/components/crm-workspace.tsx
- src/components/deal-pipeline-workspace.tsx
- src/components/lead-inbox.tsx
- src/components/mobile-daily-work.tsx
- src/components/offer-workflow.tsx
- src/components/property-sales-workflow.tsx
- src/components/reservation-board.tsx
- src/components/task-command-center.tsx
- src/components/unit-board.tsx
- src/instrumentation.ts
- src/lib/auth/session.ts
- src/lib/crm-command.ts
- src/lib/crm-types.ts
- src/lib/db/broker-entity-repositories.ts
- src/lib/db/client.ts
- src/lib/db/crm-loaders.ts
- src/lib/db/crm-write-repositories.ts
- src/lib/db/local-test-transport.ts
- src/lib/db/offer-repositories.ts
- src/lib/db/property-department-repositories.ts
- src/lib/db/property-inventory-repositories.ts
- src/lib/db/property-sales-repositories.ts
- src/lib/db/recommendation-runtime-repositories.ts
- src/lib/db/reservation-repositories.ts
- src/lib/db/tenant-client.ts
- src/lib/db/transaction-context.ts
- src/lib/i18n.ts
- src/lib/offer-workflow.ts
- src/lib/property-sales.ts
