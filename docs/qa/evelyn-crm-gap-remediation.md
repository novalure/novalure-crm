# CRM Sales Readiness — Final High-Gap Closure

**Stand: 2026-09-17. Gesamtstatus: BLOCKED. 17/18 ursprüngliche High-Gaps im dokumentierten Integrations-/Sales- und isolierten QA-Datenbankumfang geschlossen; nur G08 bleibt BLOCKED_WITH_PROVEN_REASON. G24 ist nach dem separaten Neon-/061-Auftrag CLOSED. Kein Merge, kein Production Deployment.**

Repository: novalure/novalure-crm. Branch: codex/crm-sales-readiness-high-gaps. Bestehender [Draft-PR #63](https://github.com/novalure/novalure-crm/pull/63). Ausgangspunkt dieses Abschlussauftrags: 61a3d65d86834b55e5e09e7fc39c307911035cb0; gemeinsamer PR-Basisstand c3705927e2b47fc8fb0d52bfd28e5b8feff2f600. Quelle: [ursprüngliche Evelyn Gap Analysis](https://github.com/novalure/evelyn/blob/8119798a97347eb1c96126c6a14308e158e20862/docs/integrations/crm/crm-gap-analysis.md), Tag phase-2a-crm-contract-v1, aufgelöster Commit 8119798a97347eb1c96126c6a14308e158e20862. Evelyn wurde ausschließlich gelesen.

Das CRM bleibt alleinige operative Source of Truth. Der neue eingeschränkte HTTP-Vertrag verarbeitet ausschließlich registrierte synthetische Ressourcen und Simulationen. Er ist keine reale Evelyn-Verbindung. Lokale erfolgreiche Tests sind weder Preview- noch Produktionsnachweise.

## Finales Register aller 18 ursprünglichen High-Gaps

REMEDIATED_AND_VERIFIED bezeichnet die konkret benannten und ausgeführten lokalen Vertrags-/Salespfade. Für sämtliche Zeilen bleiben Deployment, Datenbankaktivierung und reale externe Integration gesonderte Gates. Insbesondere G02/G16/G17 behaupten keine allgemeine Härtung aller historischen menschlichen Finance-/Bot-/Media-APIs: Diese sind für den eingeschränkten Dienstprincipal nicht erreichbar.

| Gap | Finaler Status | Umsetzung und tatsächlicher Nachweis | Grenze |
| --- | --- | --- | --- |
| G01 | REMEDIATED_AND_VERIFIED | Migration 084, crm-service-contract.ts und /api/crm/contract/v1: gehashter widerrufbarer Principal, persistierte Tenant-/Actor-/Scope-/Ressourcenbindung, Ablauf; echte HTTP-/PostgreSQL-Negativtests. | Nur synthetische QA-Workspaces und agent/project_sales_member; kein Ownerkonto, keine reale Credential-Ausgabe. |
| G02 | REMEDIATED_AND_VERIFIED | Alle erlaubten Contractpfade laufen über sichere Tenanttransaktionen, nicht privilegierte Runtime-Rolle und Projekt-/Feldgrenzen. Tatsächliche Requests an alle 61 historischen CRM-HTTP-Methoden mit Dienst-Bearer abgewiesen. | Begrenzter Integrationspfad. Isolierte Neon-QA-Datenbank nachgewiesen; keine Anwendungs- oder Produktivaktivierung. |
| G03 | REMEDIATED_AND_VERIFIED | Core-GET/Startseite reparieren keine Pipelines; Foundation-Regression ausgeführt. | Reparatur braucht ausdrücklichen Schreibprozess. |
| G04 | REMEDIATED_AND_VERIFIED | Keine operativen Mockdaten bei fehlgeschlagenen Core-Modulen; Fehler/Herkunft sichtbar, Regression ausgeführt. | Listen bleiben ausdrücklich LIMITED; G23. |
| G05 | REMEDIATED_AND_VERIFIED | Atomare Versionen für Contact/Task/Project/Lead/Deal/Unit/Offer und Sales; Core-CAS, stale und parallele Updates erneut ausgeführt. | Kein universeller CAS-Vertrag sämtlicher historischer Entitäten. |
| G06 | REMEDIATED_AND_VERIFIED | Sechs HTTP-Schreibbereiche, sieben UI-Komponenten, unveränderlicher Digest einschließlich Correlation, dauerhafte Receipts und autorisierter Ergebnisabgleich. Reale Cookie-/CSRF-Requests, Rollback, verlorene Commitantwort, Replay und CAS geprüft. | Client-Pendingzustand nur im geladenen Tab; keine tab-/reloadübergreifende Recovery oder globale Exactly-once-Garantie. DB-Receipts bleiben dauerhaft. |
| G07 | REMEDIATED_AND_VERIFIED | Unit-/Building-Ledger an atomare Commands angeschlossen; Dubletten und konkurrierende Updates erneut geprüft. | Keine Exactly-once-Zusage über Providergrenzen. |
| G08 | BLOCKED_WITH_PROVEN_REASON | Echte Angebotsfreigabe bindet Aktion/Scope/Version/Digest/Empfänger/EUR-netto und wird beim Versandvorbereiten konsumiert. Ed25519-Zweikanalengine, Manipulation, Ablauf, Widerruf und konkurrierender Verbrauch gegen echte lokale DB geprüft. | Zweischrittverbrauch erzeugt ausschließlich SYNTHETIC_APPROVAL_PROBE. Unabhängige authentifizierte Evelyn-Kanäle und sensibler Vertrags-/Zahlungsconsumer fehlen; keine Betriebsfreigabe aus Simulation. |
| G09 | REMEDIATED_AND_VERIFIED | Preis-/Statusbestätigung verlangt dokumentierte Quelle plus ausdrückliche Projektbefugnis; Entzug und Auditrollback geprüft. | Keine externe Wahrheitsprüfung oder Portalsynchronisation. |
| G10 | REMEDIATED_AND_VERIFIED | requested bleibt unverbindlich und Unit verfügbar; autorisiertes Confirm separat; UI, DB und parallele Anfragen geprüft. | Keine automatische Autorisierung alter Reservierungen. |
| G11 | REMEDIATED_AND_VERIFIED | Businessdaten, Receipts, Audit und Events atomar; injizierte Fehler, Reconciliation und parallele Statuswechsel erneut geprüft. | PostgreSQL-Atomarität, kein Mehrsystemcommit. |
| G12 | REMEDIATED_AND_VERIFIED | Kanonische Angebotsakte mit Revision/Freigabe/Versandstatus/Follow-up/Kundenantwort; Annahme und Ablehnung in DB, Annahme in tatsächlicher UI. | Versand nur manuell attestiert; Vertrag/Zahlung gesperrt. |
| G13 | REMEDIATED_AND_VERIFIED | Autorisierter Sale-Beleg bindet Unit/Reservation/Buyer/Projekt; Unit sold atomar; Doppelverkauf und parallele Bestätigung geprüft. | Kein notarieller oder externer Zustellnachweis. |
| G15 | REMEDIATED_AND_VERIFIED | Kanonische Bauträger-/Projekt-/Ansprechpartner-Autorität; Fremd-FKs, Selbstzuweisung, Delegation und Entzug geprüft. | Keine erfundene reale Beauftragung oder Legacyfreigabe. |
| G16 | REMEDIATED_AND_VERIFIED | Positiver Projektgrant vor freigegebenen Contract-Reads/Writes; verborgenes Projekt desselben Tenants und fremder Tenant verweigert. | Dienstboundary; historische APIs für diesen Principal geschlossen. Preview-App-Negativfälle weiterhin NOT VERIFIED; SQL-Negativfälle auf neuer Neon-QA bestanden. |
| G17 | REMEDIATED_AND_VERIFIED | Persistierte Datenbereichs-, Sensitivitäts-, Domain- und Zweckbindung; private/interne/unbekannte oder abweichende Kontexte abgewiesen. Communication nur über engen authentifizierten DB-Helper. | Kein allgemeines Privacy-Audit sämtlicher Bestandsdaten. |
| G24 | REMEDIATED_AND_VERIFIED | Neuer isolierter Neon-Branch, 83/83 Forward-SQL-Dateien einschließlich sicher behandelter unveränderter 061 und 080–085; 46/46 Sicherheitschecks vor und nach tatsächlichem nativen Restore, vollständige Katalog-/Datenhash-Gleichheit, unabhängiger Review PASS. | Frische QA-Datenbanken, kein Production-/Cross-Cluster-DR-/Preview-App-Nachweis; Original-062 nur im geprüften Fresh-build-Pfad vor 060. |
| G25 | REMEDIATED_AND_VERIFIED | Aktuelle reale lokale PostgreSQL-, HTTP-, Recovery-, Parallelitäts- und Browserläufe am geprüften Quellstand. Nachweisdatei mit normalisierten Quellhashes. | Lokaler synthetischer Nachweis plus gesonderter Neon-DB-/Restore-Nachweis; Preview-App bleibt eigenständiges nicht ausgeführtes Gate. |

## Ausgeführte Abschlussgates

Ausgeführt mit Node **24.14.0**, npm **11.9.0**, PostgreSQL **18.4**, nativen Restore-Clients **18.6** und lokalem Chrome. **450/450 PASS, 0 failed, 0 skipped, 0 cancelled.** Die bestehenden 439 Tests liefen erneut; hinzu kommen 11 echte PostgreSQL-Tests für 061. Separat: **46/46 + 46/46 Neon-Sicherheitschecks** vor/nach Restore.

| Prüfung | Ergebnis und disjunkte Zuordnung |
| --- | --- |
| Unit | **236/236 PASS**: 232 bestehende Regressionen + 4 Client-Recovery |
| Integration | **25/25 PASS**: 15 bestehende + 5 HTTP-Receipts + 5 tatsächliche Cookie-/CSRF-Routen |
| Migration/DB | **34/34 PASS**: 8 Core-CAS + 15 Upgrade/Restore + 11 Neon-061-Kompatibilität/Rollengrenzen |
| RBAC/Security | **74/74 PASS**: 29 Foundation + 21 Dienstvertrag + 7 Approval + 17 Protected-Access-Contracttests |
| Workflow | **61/61 PASS**: 23 Offer + 24 Property-Sales + 6 Legacy + 8 zusätzliche Prioritäts-/Tenant-/Statusrennen |
| E2E | **20/20 PASS**: tatsächlicher Passwort-/MFA-Login, Mobile, Logout/Session-Replay und beide Salesflows |
| Typecheck / Lint / Build / Toolchain | **PASS**; Build lokal, kein Deployment |
| Dependency Audit | **PASS**, alle Dependencies: 0 Critical/High/Moderate/Low |
| Secret Scan | **PASS**, vorgeschlagener Dateibaum und origin-/PR-Historie; keine neuen Ausnahmen |
| Security Review | **PASS** für geprüfte Änderungen, keine neuen Critical/High-Codebefunde; G24-DB-/Security-Review PASS, nur G08 bleibt offen |
| Evelyn Contract Compatibility | **PASS im gepinnten Simulationsumfang**, 166 repräsentative Schemafälle ohne Abweichung; keine reale Integration |
| Preview QA / Preview Flow A / Preview Flow B | **BLOCKED / NOT VERIFIED / NOT VERIFIED** |

Der erste Browserabschlussversuch überschritt beim Logout die starre 5-Sekunden-Formularfrist. Die Prüfung wartet nun ausdrücklich auf die tatsächliche Logout-303-Antwort und Login-Navigation; Cookie-/Core-/Replay-Sperren bleiben erhalten. Der finale isolierte Wiederholungslauf bestand 20/20 ohne Browserfehler oder unerwartete lokale 5xx. Frühere Fehlerprotokolle wurden nicht als PASS umetikettiert.

Ein zusätzlicher lokaler HTTP-Nachlauf meldete einmal ECONNRESET ohne HTTP-Status. Die Ursache war nicht deterministisch reproduzierbar. Der Test-Harness verwendet nun ausdrücklich geschlossene Verbindungen, einen Transporttimeout und Diagnose nur mit Methode/Pfad. Keine automatische Wiederholung, keine abgeschwächte Authentifizierungsassertion und keine Änderung des Runtime-Transports. Die Nachläufe unter Node 24.14.0 bestanden 55/55 (Foundation/Service/Receipts) und 26/26 (Service/Receipts); sie werden nicht zusätzlich zur disjunkten Gesamtzahl gezählt. Rohprotokoll: .npm-cache/qa/service-transport-pinned.log.

Zahlen sind disjunkt nach ausgeführten Testsuites zugeordnet. Node zählt test()-Eltern mit Unterfällen mit. Der ursprüngliche Stand 365/365 ist historische Baseline und wird nicht als neuer Nachweis übernommen. Framework-Warnung zu automatisch erkannter ESM-Syntax im lokalen Node-Testharness ist kein fehlgeschlagener Test; keine Runtime-Modulkonfiguration wurde dafür verändert.

## Fachliche und technische Nachweise

**Flow A lokal PASS:** Kontakt → Lead → Deal → Angebot → gebundene Freigabe → nachvollziehbar manuell attestierter Versand → Follow-up → Accepted/Rejected → Kunde/Gewonnen/Verloren. Versand ohne Freigabe, Änderung nach Freigabe, alte Referenz, Dubletten, Reaktion versus Follow-up und atomarer Auditfehler sind negativ geprüft. Kein echter E-Mail-Versand.

**Flow B lokal PASS:** Bauträgerprojekt → Einheit → Käuferanfrage → vollständige Qualifizierung → High/Medium/Low mit Actor/Quelle/Version → auditierbarer Handover → Viewing → unverbindliche Anfrage → autorisierte Reservierung → autorisierter Verkauf. Fehlende Pflichtwerte bleiben unvollständig; fremde Qualification/Handover hinterlassen weder Änderung noch Receipt. Je zwei parallele Reservierungsanfragen, Bestätigungen und Verkäufe committen genau einmal. Ungültige Rückübergänge verkaufter Einheiten bleiben gesperrt.

**G06/Auth:** Wrapper prüft persistierte Session, technische Berechtigung und CSRF genau einmal; frische Session wird im Handler verwendet. Productcapability/Projekt/RLS werden innerhalb der Transaktion erneut geprüft. Idempotenz ist keine Umgehung für widerrufene Sessions oder Rollen. Ergebnislookup prüft dieselbe unveränderliche Wirkung und führt keinen Schreibcallback aus. Die automatische Freigabeprüfung hatte die bereichsübergreifende Integration zunächst abgelehnt; Franz genehmigte den konkret vorbereiteten Patch anschließend ausdrücklich. Keine abgelehnten globalen RLS-/Client-/Recommendation-Änderungen wurden angewendet.

**Evelyn Contract Compatibility PASS im gepinnten Simulationsumfang:** tenantId, actorId, correlationId, idempotencyKey, auditReference, expectedVersion und definierte Fehler werden geprüft; ApprovalReference-Pflicht wird syntaktisch erzwungen und nicht unterstützte sensible Aktionen bleiben geschlossen. Zwölf begrenzte SQL-Leseprojektionen, drei synthetische Metadatenwrites (Contact.name, Project.name, Task.title), CAS/Replay/Reconciliation und Redaktionsregeln sind geprüft. Offer/Sale/ApprovalReference-Leseprojektionen und Prepare/Send/Confirm bleiben entsprechend dem gepinnten Vertrag CRM_SEMANTIC_GAP/UNSUPPORTED. Das schließt G08 fachlich nicht.

## Migrationen 080–085 und Restore

| Migration | Lokaler Nachweis | Neon QA / Production |
| --- | --- | --- |
| 080 | Reihenfolge, realistischer Vorzustand, fremde Legacy-FKs, atomarer Rollback, sichere Rollen/RLS/Receipts/Audit PASS. | Neue isolierte QA PASS; Production unverändert. |
| 081 | Pre-080 verweigert; Legacy/NULL und unveränderliche Revision/FKs/Indizes/Constraints; Rollback PASS. | Neue isolierte QA PASS; Production unverändert. |
| 082 | Legacy/NULL, Authority-/Reservation-/Sale-/Viewing-Constraints, RLS, Rollback PASS. | Neue isolierte QA PASS; Production unverändert. |
| 083 | Inneres BEGIN/COMMIT entfernt: Runner besitzt Transaktion. Injizierter SQL- und Ledgerfehler rollen Schema plus Ledger zurück; monotone Version PASS. | Neue isolierte QA PASS; Production unverändert. |
| 084 | Echte lokale Dienstauthentifizierung, immutable Bindings, beschränkter Communication-Helper, negative SQL-/HTTP-Tests PASS. | Neue isolierte QA PASS; Production unverändert. |
| 085 | Echte lokale synthetische Approval-Persistenz, RLS/FKs, unveränderliche Evidenz, Race/Replay/Scopeprüfung PASS. | Neue isolierte QA PASS; Production unverändert. |

080–083: 15/15 Upgrade-/Rollback-/Restoretests. Direkte Wiederholung scheitert ausdrücklich und atomar; der tatsächliche Migrationsplan überspringt korrekt ledgerierte Dateien und stoppt bei verändertem Checksum. Vollständiger nativer pg_dump/pg_restore-Roundtrip (Client 18.6, Server 18.4) in zweite leere Datenbank desselben isolierten Clusters: Katalog, Ledger, Businessdaten, RLS, Audit-Unveränderlichkeit und CAS erneut geprüft. Kein Cross-Cluster-Rollenrestore, PITR oder Produktions-DR behauptet.

Drei historische NOT VALID-Constraints bleiben zunächst unvalidiert. Eine synthetische Legacybesichtigung mit Endzeit vor Start bleibt beim Upgrade erhalten und blockiert tatsächliches VALIDATE; neue ungültige Daten werden abgewiesen. Der gezielte korrigierte Restorefall verändert nur das Ziel. Kein pauschales PASS für unbekannte Bestandsdaten.

Lokaler Harness: 001 benötigt mangels pgvector eine dokumentierte lokale Vektorersetzung; 062 ist ein manueller Media-Cutover und bleibt aus dem generischen Vorwärtsbootstrap ausgeschlossen. Diese Ausnahmen sind keine Prüfung von pgvector/RAG oder Media-Cutover. 080–085 laufen unverändert. Alle lokalen Daten sind synthetisch; keine Produktionsverbindungszeichenfolge wird übernommen.

## G24 abgeschlossen: Neon 061, vollständiger Neuaufbau und Restore

**G24 CLOSED.** [Technische Begründung und Reproduktion](g24-neon-061-compatibility.md), [vollständiger bereinigter Abschlussnachweis](g24-neon-final-evidence.json). Geprüfter Codecommit: `e9be2a434a323525d9bf77e8088acc1dfd0cf5f3`.

Nach ausdrücklicher Benutzerfreigabe wurde ausschließlich der archivierte QA-Snapshot `br-purple-forest-aliovp71` gelöscht, um das vorhandene Branchlimit freizugeben. Neuer isolierter QA-Branch `br-spring-snow-alupo8u4` im Testprojekt `weathered-term-98273025`; erfolgreiche neue Datenbanken `qa_g24_pr63_20260917_r3` und `qa_g24_restore_20260917_r3`. Keine andere bestehende Branch oder Production-Datenbank verändert.

Ursache: 061 verwirft die automatische PostgreSQL-Creator-Mitgliedschaft als vermeintlichen Runtime-Zugriff. Die historische Datei und ihre Sourcechecksumme bleiben unverändert. Ausschließlich zwei Guard-Prädikate behandeln die nachgewiesene ADMIN-only-Kante des bereits privilegierten Migrationseigentümers gesondert. Reale Runtime-Rollen bleiben unprivilegiert; keine bestehende Provider-Rolle oder Provider-Mitgliedschaft wurde manipuliert. Neue QA-Rollen erzeugen erwartungsgemäß neue automatische Creator-Kanten. Atomare append-only Metadaten unterscheiden Originalsource und tatsächlich ausgeführtes SQL samt Commit, Plan und Ziel.

Alle **83 Forward-SQL-Dateien** wurden tatsächlich ausgeführt, inklusive originalem pgvector, 062 sowie 061 und 080–085. 062 läuft im frischen, vor Anwendungsanbindung geprüften Seedzustand vor 060; Audit-Schutz wird weder deaktiviert noch umgangen. Der finale r3-Lauf benötigte **0 manuelle Datenbankreparaturen**. Zwei vorherige Aufruffehler der nativen CLI-Hülle (Versionsargumentfolge; fehlendes explizites Restore-Ziel) sind korrigiert; ihre Läufe bleiben ausdrücklich FAIL dokumentiert und wurden nicht nachträglich umetikettiert. Jeder Neulauf verwendete neue leere Datenbanken und eine neue Runtime-Rolle.

Native Clients 18.6 auf Neon PostgreSQL 17.11: echter vollständiger pg_dump/pg_restore in zweite neue Datenbank. Verglichen: 143 Relationen, 2238 Spalten, 993 Constraints darunter 559 FKs, 497 Indizes, 102 Policies, 177 Funktionen, 74 Trigger, 42 Ledgerzeilen sowie 141 Datentabellen mit 118 Zeilen. Vollständiger kanonischer Snapshot vor/nach Restore identisch: `46931e215d933d169b011bbcdbaa535ed30b97f52a3d8534b4a288347b63542b`. **46/46 Sicherheitschecks vor und 46/46 nach Restore PASS**, einschließlich Default Deny, Tenant-/Projektgrenzen, CAS, Audit-/Receipt-Unveränderlichkeit, Rollen und RLS. Unabhängiger Ergebnisreview PASS.

Die [frühere Blocker-Evidenz](evelyn-crm-qa-cutover-evidence.json) bleibt als historischer Nachweis erhalten. Vercel-Verbindungswerte und alle Anwendungsumgebungen unverändert; keine authentifizierte Preview-App-QA oder reale Evelyn-Verbindung behauptet. Restore gilt innerhalb derselben isolierten Branch mit bereits vorhandenen globalen Rollen; kein Cross-Cluster-/PITR-/Production-DR-Nachweis und keine allgemeine Legacy-Kundendaten-Upgradefreigabe.

## Unabhängiger Review und verbleibende Risiken

Ein Nichtautor der Dienst-/G06-/Approvalimplementierung prüfte die sieben Restlücken einzeln. Im damaligen Abschluss G01/G02/G06/G16/G17 CLOSED, G08/G24 NOT CLOSED. Der nachfolgende unabhängige G24-DB-/Security-Review bestätigt jetzt G24 CLOSED; G08 unverändert offen. Eigener unabhängiger lokaler Testlauf 28/28 PASS (Dienstvertrag 19, echte Cookie-/CSRF-Routen 5, Client-Recovery 4) vor der letzten ergänzten Contractparitätsprüfung. Keine neuen Critical-/High-Codebefunde. Root prüfte separat die vom Reviewer verfassten Migrations-/Browserharnessänderungen und führte die Abschlussgates aus. Review ist keine authentifizierte Preview-Abnahme.

Offene ursprüngliche Medium-Gaps: **8** — G14 Company-Lifecycle allgemein; G18 externe versionierte Outbox/Consumer; G20 Kalender-/Appointment-Zuordnung; G21 generischer Kommunikations-/Deliveryvertrag; G22 globale Legacyfehlersemantik; G23 globale Cursor-/Vollständigkeit; G26 Provider-/Cron-/Deploymentbetrieb; G27 umfassende historische Geld-/Steuersemantik. G19 ist für Flow B geschlossen. Diese Grenzen dürfen vor späterer realer Automation nicht als pauschal unkritisch oder als Go-live-PASS behandelt werden. Der aktuelle Gesamtstatus bleibt ohnehin BLOCKED.

Weitere konkrete Grenzen: keine tab-/reloadübergreifende Unknown-Recovery; keine echte Mail-/WhatsApp-/Telefonie-/Portal-/Evelyn-Verbindung; keine Vertrags-/Zahlungsautomatisierung; keine tatsächliche Autorisierung realer Bauträger aus synthetischen Fixtures; keine Produktions-/Providerzustellungsprüfung. Keine offene neue Critical-Schwachstelle behauptet; eine ursprüngliche High-Voraussetzung offen: G08.

## Secretprüfung, Dateien und externe Änderungen

Gitleaks prüft den vorgeschlagenen vollständigen Dateibaum einschließlich neuer Dateien und die eigene/origin-Historie. Ignorierte QA-Credentials, Cookies, .env und lokale Datenbanken sind nicht Bestandteil des PR. Bestehende exakte historische False-Positive-Fingerprints bleiben unverändert; keine neue breite Ausnahme. [Aktueller G24-Nachweis](g24-neon-final-evidence.json) enthält 450 lokale Tests, reale Neon-/Restore-Ergebnisse und 497 geprüfte Quellhashes. Der [frühere lokale Nachweis](evelyn-crm-local-evidence.json) bleibt historischer Stand von f64337e. Aktuelle Rohlogs liegen ignoriert unter .npm-cache/qa/g24-*; frühere closure-Logs bleiben erhalten.

Geänderte/neue Dateien im gesamten PR gegenüber origin/main (**100**). G24 ergänzt ausschließlich QA-Migrationsbehandlung, Verifikations-/Restore-Harness, Tests, CI und Dokumentation; keine neuen Anwendungsfunktionen.

- `.github/workflows/livegang-e2e.yml`
- `.gitleaksignore`
- `docs/qa/crm-v1-service-boundary.md`
- `docs/qa/evelyn-crm-gap-remediation.md`
- `docs/qa/evelyn-crm-local-evidence.json`
- `docs/qa/evelyn-crm-qa-cutover-evidence.json`
- `docs/qa/g24-neon-061-compatibility.md`
- `docs/qa/g24-neon-final-evidence.json`
- `eslint.config.mjs`
- `migrations/080_crm_command_safety.sql`
- `migrations/081_crm_offer_workflow.sql`
- `migrations/082_crm_property_sales_workflow.sql`
- `migrations/083_crm_core_cas.sql`
- `migrations/084_crm_contract_service_boundary.sql`
- `migrations/085_crm_approval_evidence.sql`
- `next.config.ts`
- `package-lock.json`
- `package.json`
- `scripts/approval-reference-tests.ts`
- `scripts/contact-access-rbac-smoke-tests.mjs`
- `scripts/core-cas-tests.ts`
- `scripts/crm-command-tests.ts`
- `scripts/crm-service-contract-tests.ts`
- `scripts/fixtures/crm-v1-request-parity.json`
- `scripts/legacy-sales-tests.ts`
- `scripts/lib/g24-qa-verification.mjs`
- `scripts/lib/local-sales-db.mjs`
- `scripts/lib/neon-061-compat.mjs`
- `scripts/lib/sales-browser-fixture.mjs`
- `scripts/neon-061-compat-tests.mjs`
- `scripts/offer-workflow-tests.ts`
- `scripts/phase0-smoke-tests.mjs`
- `scripts/phase3-rbac-smoke-tests.mjs`
- `scripts/phase4-validation-smoke-tests.mjs`
- `scripts/property-department-smoke-tests.mjs`
- `scripts/property-sales-tests.ts`
- `scripts/qa-crm-contract-parity.mjs`
- `scripts/qa-neon-g24.mjs`
- `scripts/qa-sales-browser-server.mjs`
- `scripts/qa-sales-browser.mjs`
- `scripts/qa-sales-e2e.mjs`
- `scripts/sales-client-recovery-tests.ts`
- `scripts/sales-final-negative-tests.ts`
- `scripts/sales-http-receipt-tests.ts`
- `scripts/sales-migration-upgrade-tests.ts`
- `scripts/sales-route-integration-tests.ts`
- `scripts/tenant-hardening-smoke-tests.mjs`
- `src/app/api/crm/broker/mandates/route.ts`
- `src/app/api/crm/broker/search-profiles/route.ts`
- `src/app/api/crm/commands/reconcile/route.ts`
- `src/app/api/crm/contacts/route.ts`
- `src/app/api/crm/contract/v1/route.ts`
- `src/app/api/crm/core/route.ts`
- `src/app/api/crm/dashboard-views/route.ts`
- `src/app/api/crm/deals/[dealId]/stage/route.ts`
- `src/app/api/crm/deals/route.ts`
- `src/app/api/crm/leads/route.ts`
- `src/app/api/crm/offers/route.ts`
- `src/app/api/crm/projects/route.ts`
- `src/app/api/crm/properties/route.ts`
- `src/app/api/crm/property-sales/route.ts`
- `src/app/api/crm/tasks/route.ts`
- `src/app/api/crm/units/route.ts`
- `src/app/page.tsx`
- `src/components/contact-command-center.tsx`
- `src/components/crm-workspace.tsx`
- `src/components/deal-pipeline-workspace.tsx`
- `src/components/lead-inbox.tsx`
- `src/components/mobile-daily-work.tsx`
- `src/components/offer-workflow.tsx`
- `src/components/property-sales-workflow.tsx`
- `src/components/reservation-board.tsx`
- `src/components/task-command-center.tsx`
- `src/components/unit-board.tsx`
- `src/instrumentation.ts`
- `src/lib/approval-reference.ts`
- `src/lib/auth/session.ts`
- `src/lib/crm-command.ts`
- `src/lib/crm-sales-http.ts`
- `src/lib/crm-service-contract.ts`
- `src/lib/crm-types.ts`
- `src/lib/db/approval-reference-repositories.ts`
- `src/lib/db/broker-entity-repositories.ts`
- `src/lib/db/client.ts`
- `src/lib/db/crm-loaders.ts`
- `src/lib/db/crm-write-repositories.ts`
- `src/lib/db/local-test-transport.ts`
- `src/lib/db/offer-repositories.ts`
- `src/lib/db/property-department-repositories.ts`
- `src/lib/db/property-inventory-repositories.ts`
- `src/lib/db/property-sales-repositories.ts`
- `src/lib/db/recommendation-runtime-repositories.ts`
- `src/lib/db/reservation-repositories.ts`
- `src/lib/db/tenant-client.ts`
- `src/lib/db/transaction-context.ts`
- `src/lib/i18n.ts`
- `src/lib/offer-workflow.ts`
- `src/lib/property-sales.ts`
- `src/lib/security/crm-safe-client.ts`
- `src/lib/security/crm-sales-client.ts`

Änderungen ausschließlich im bestehenden CRM-PR. Evelyn und novalure-website unverändert; ursprünglicher separater CRM-Checkout mit Benutzeränderungen nicht angefasst. Keine Produktionsdatenbank verändert, kein Production Deployment, keine Promotion, kein Merge. Neuer isolierter QA-Branch mit dokumentierten synthetischen Datenbanken und Runtime-Rollen; genau ein alter QA-Snapshot nach ausdrücklicher Benutzerfreigabe gelöscht. Keine kostenpflichtigen Dienste aktiviert, keine externen Provider verbunden.

**Nächster empfohlener Schritt, nicht ausgeführt:** G08 Zwei-Schritt-Approval-Bridge zwischen Evelyn und CRM in einem separaten Auftrag vorbereiten. PR #63 bleibt Draft, kein Merge.

---

## Final High-Gap Closure — verbindlicher Startstand

Neuer Auftrag vom 2026-09-17, Ausgangscommit 61a3d65d86834b55e5e09e7fc39c307911035cb0, weiterhin PR #63. Diese sieben Positionen sind direkt aus dem obigen Remediation-Register und der ursprünglichen Evelyn-Gap-Analysis am Tag phase-2a-crm-contract-v1 extrahiert. Die frühere lokale Abnahme wird nicht als neuer Abschlussnachweis übernommen.

| Gap-ID | Beschreibung | Aktueller Status | Ursache | Betroffener Flow | Dateien / Module | Notwendige Maßnahme | Notwendiger Nachweis |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G01 | Enger Dienstprincipal und getrennte Scopes fehlen | PARTIALLY_FIXED | Scopevokabular existiert, Dienstidentität endet mit SERVICE_INTEGRATION_DISABLED; Benutzerrollen ersetzen keine Dienstauthentifizierung | A und B / zukünftiger Evelyn-Contract | src/lib/crm-command.ts; src/lib/auth; Tenant-Client; Contract-API | Vertrauenswürdigen eingeschränkten CRM-Dienstkontext mit Widerruf, Projekt-/Feldallowlist und eindeutiger Principal-/Actorbindung implementieren, ohne reale Evelyn-Verbindung zu aktivieren | Echte lokale/QA-DB- und API-Negativtests für Scope, Token/Identität, falschen Tenant/Actor, Ablauf und Widerruf; enger positiver Contract-Fall |
| G02 | Vollständiger RLS-/Application-Cutover nicht belegt | PARTIALLY_FIXED | Core/Sales umgestellt; historische Finance-/Bot-/Media-/Providerpfade nicht vollständig inventarisiert oder eingegrenzt | A und B; gemeinsame Zugriffsschicht | migrations/080_crm_command_safety.sql; src/lib/db/client.ts; tenant-client.ts; Repositories/API-Routen | Zugriffspfade und Tabellen vollständig inventarisieren; erlaubte CRM-Vertragspfade über sichere Tenanttransaktionen führen, unzulässige/unsichere Pfade wirksam verweigern | Nicht privilegierte reale QA-Rolle; RLS-/Grants-/Poolreuse-/Cross-Tenant-Tests und tatsächliche API-Ausführung; keine rein statische Schließung |
| G06 | Kein vollständiger allgemeiner Idempotenz-/Resultatvertrag | PARTIALLY_FIXED | Neue Commands sowie Lead/Deal geschützt; ältere Updates und autorisierte Reconciliation nicht durchgängig | A und B / Contact, Project, Task und Fachcommands | crm-command.ts; crm-write-repositories.ts; betroffene APIs; Receipt-Ledger | Stabilen Wirkungsdigest und atomare Receipts auf alle erlaubten Writes des Vertrags ausdehnen; autorisierten Ergebnislookup und sichere Behandlung unbekannter Antworten ergänzen | Gleicher Key/anderer Payload, parallele Duplikate, Commit mit verlorener Antwort, erneuter Versuch und Reconciliation ohne zweite Wirkung |
| G08 | Gebundene ApprovalReference und unabhängige Zweischrittfreigabe unvollständig | PARTIALLY_FIXED | Offerrevision gebunden; sensible Vorgänge mangels zweier vertrauenswürdiger Kanäle deaktiviert | A; sensible Reservierungs-/Verkaufsnachweise bleiben getrennt | offer-workflow.ts; offer-repositories.ts; Approval-/Commandmodelle; migrations/081_crm_offer_workflow.sql | Aktionen/Version/Digest/Scope an aktuelle authentifizierte Freigabebelege binden; unabhängige Zweischritte lokal/QA prüfbar machen, ohne echte Provider oder Evelyn anzuschließen | Manipulation, alte Freigabe, gleiche statt unabhängige Schritte, Ablauf/Widerruf, Race und tatsächlich gesperrter bzw. freigegebener synthetischer Effekt |
| G16 | Positive Projektlesegrants nicht auf allen relevanten Pfaden nachgewiesen | PARTIALLY_FIXED | Einzelne alte Endpunkte haben nur Workspace-/optionale Projektfilter | A und B | Core-/CRM-API-Routen; Loader/Repositories; project_pipeline_permissions; RLS | Positiven Projektgrant an jeder freigegebenen Vertrags-/Salesgrenze erzwingen; fehlende und fremde Projektbezüge ausdrücklich ablehnen | Mehrere Projekte im selben Tenant und zweiter Tenant, Rollenmatrix, Reads/Writes sowie echte Preview-Negativfälle |
| G17 | Datenklasse und Zweck nicht durchgängig nachgewiesen | PARTIALLY_FIXED | Core/Sales klassifiziert; historische private/interne/Kommunikationspfade nicht vollständig abgedeckt | A und B / Contractdaten | crm-command.ts; Migration 080; Workspace-/Projekt-/Ressourcenkontext; Serialisierung | Datenklassen-/Zweckgrenze durch alle erlaubten Contractpfade tragen; PRIVATE_FRANZ und unklassifizierte Inhalte ohne explizite Berechtigung verweigern | Echte DB-/API-Tests für interne, Kunden-, private und unbekannte Klassen, Feldprojektion und falschen Zweck; kein implizites Owner-Bypass |
| G24 | Tatsächliche Migrationen, Constraints, DB-Rolle und RLS-Cutover nicht erhoben | NOT_VERIFIED | Bisher nur lokale frische Fixture; produktiver Bestandsstand unverifiziert und weiterhin tabu | A und B / Datenbankbetrieb | Migrationen 080–083; Schemaledger; QA-Migrations-/Diagnosewerkzeuge | Realistischen Vorzustand, Upgrade/Re-run/Legacy/Restore lokal nachweisen; autorisierte isolierte Preview-QA-Datenbank identifizieren und deren Schema/Rollen/Constraints verifizieren; Produktionsgrenze ausdrücklich erhalten | Tatsächliche DB-Katalog-/Ledger-/Constraint-/RLS-Ergebnisse in isolierter QA, Upgrade-/Restoretests und authentifizierte Previewausführung; fehlender sicherer QA-Cutover bleibt BLOCKED_WITH_PROVEN_REASON; Production bleibt außerhalb dieses Auftrags |

Zielstatus pro Restposition: ausschließlich REMEDIATED_AND_VERIFIED oder BLOCKED_WITH_PROVEN_REASON. Änderungen an main, Production, produktiven Kundendaten und Evelyn bleiben ausgeschlossen.