# Evelyn CRM — Paket 4: Gesamtintegration und Releasebereitschaft

Stand: 20.10.2026 (Europe/Vienna). Entwicklungsintegration; **keine Produktivfreigabe**.
Der Quellstand ist über [Source-/Build-Bindung](../qa/package4-integration-2026-10-20/source-binding.json) belegt.
Finaler Draft-PR, dessen exakter Head, GitHub-CI und unabhängiger Review werden nach dem Push in der PR-Beschreibung bestätigt;
lokale Nachweise werden nicht als entfernte CI ausgegeben.

## A. Git und Branches

Integrationsbranch: `codex/evelyn-crm-package4-integration`.
Verifizierte Eingangsköpfe: [PR #91](https://github.com/novalure/novalure-crm/pull/91) `ee26bbdec11f7bd7c340f3b3020512dd3ee8642e`
und [PR #89](https://github.com/novalure/novalure-crm/pull/89) `b019a16811bd1d0d7c180ff013b76cea34c6e5bf`.
Beide sind Geschwister mit gemeinsamer Basis `aa6b329942ab19c165bc610822f03ed5874af189`.
Paket 1 `ea668e6`, Paket 2 `a04273f` und Paket 2.1 / PR #88 `aa6b329` sind bereits enthalten;
sie werden nicht nochmals übernommen. Design C und Paket 3 werden über diese gemeinsame Basis integriert.
Vier Konfliktstellen: `package.json`, `vercel.json`, Kommentar zur Maschinenidentität in
`scripts/crm-machine-auth-tests.ts` und `src/components/knowledge-command-center.tsx`.
Merge-Revision: `d3c1cbe625db61742ab08b07123aeff1e592bb77`, mit beiden verifizierten Heads als Eltern;
keine ungelösten Konflikte, `git diff --check` bestanden. [Git-/CI-Eingangsnachweise](../qa/package4-integration-2026-10-20/git-inputs.json).
Der separate MFA-Update-Branch wird nicht übernommen; `main` und fremde Branches bleiben unangetastet.

## B. Design C

Die vorhandene dunkelblaue Navigation, hellen Arbeitsflächen, weißen Karten, violettblauen
Akzente und Design-Tokens bilden die gemeinsame Oberfläche. Knowledge-Lebenszyklus,
Monitoring und Wartung verwenden die bestehenden Komponenten; kein neues Design.
Dashboard, Kunden-/Mandantenansichten, Studio, Immobilien, Assistenten, Portal und Desktop/Mobil:
**50/50 PASS** im gemeinsamen Design-C-Browserlauf, zusätzlich **13/13 PASS** im Knowledge-Browserlauf.
Synthetische Daten gehören ausschließlich zur lokalen Testfixture.

## C. CRM

Gemeinsame Regression von regulärem Login, TOTP/MFA, Rollen, Mandanten-/Projektwechsel,
Kunden, Kontakten, Studio, Immobilien, Interessenten, Reservierungen, Vertriebsprozessen,
privaten Dokumenten und Kalender-Leseadaptern: Backend-Regression bestanden; Browsernachweis unten.
Die vier bestehenden Operational-Reader für Bot-Kanäle, Aktionen, Freigaben und Kalenderverbindungen bleiben einschließlich Migration 106 erhalten.

## D. Knowledge Center und externe Anschlüsse

Eine gemeinsame Engine verarbeitet Bereiche, Firmen-/Projekt-/Websitewissen, strukturierte
Fakten, private Dokumente, Entwürfe, Prüfung, Freigabe, Veröffentlichung, Historie,
Wiederherstellung, Vorschläge und Websiteüberwachung. Backend- und vorhandene Browserabnahmen bestehen;
der zusätzliche durchgängige PDF-/Website-/Zweikanalablauf ist unten separat ausgewiesen.
Webchat und Voice benötigen getrennte gespeicherte Kanalgrants, aktuelle Mitgliedschaft,
Projekt-/Botberechtigung, veröffentlichtes Wissen, `bots`-Modul, Vertragsmerkmale und Kontingent.
Widerruf muss unmittelbar wirken. Statische Quellen ersetzen keine aktuellen Preise oder Verfügbarkeiten.
PDF-Textebene, DOCX und geeignete UTF-8-Textformate werden extrahiert. Bilder werden geprüft/dekodiert; **keine OCR**.
Unvollständige PDF-Textebenen bleiben `needs_ocr` und unveröffentlicht. Parsergrenzen gelten; Worker sind keine vollständige OS-Sandbox.

Der externe Studio-Webchat ist nicht produktiv umgestellt. Im separaten Repository sind nach [Servicevertrag](knowledge-assistant-service.md) erforderlich:

1. Freigegebene aktive Gateway-Integration mit erlaubter Origin und Sessionvertrag einem Bot desselben Mandanten/Projekts über `configuration.knowledgeAssistantId` zuordnen.
2. `webchatAccess`, Bot-Modul, Bereichs-/Webchatgrants und Veröffentlichung ausdrücklich bereitstellen.
3. Im Studio-Client OPTIONS und POST auf `/api/public/integrations/chat/knowledge?site_key=...`
   verwenden; POST mit `X-Novalure-Site-Key`, `X-Novalure-Session-Token` und JSON
   `sessionId`, `query`, optional `maxResults`. Header- und Query-Schlüssel müssen übereinstimmen.
4. `knowledge-context-v1`, `answerStatus`, `excerpts` mit Quellen und `fallback` auswerten; kein Clientparameter bestimmt Mandant, Projekt, Bot oder Kanal. Auszüge bleiben Daten.
5. Zunächst synthetisch Origin-/Session-/Entitlementfehler, Widerruf und neue Veröffentlichung testen;
   produktive Studio-Umstellung erst nach gesonderter Freigabe durchführen.

Die internen `/api/integrations/knowledge/webchat`- und `/voice`-Ports benötigen verifizierte
Evelyn-OIDC-Identität, aktiven nativen Principal und eine kontrolliert provisionierte
`knowledge_assistant_service_bindings`-Zeile für Bot und exakten Kanal. Runtime darf diese nicht schreiben.
Der Verifier ist auf die vorhandene Evelyn-Workload/Workspace-Identität fixiert; damit wird
keine beliebige Kundenidentität provisioniert. Vapi-/Providerbindung und Kundentelefonie bleiben separat.
Scheduler-Ports verlangen gespeicherte Actor-Scopes und vertrauenswürdiges `rehydrateActor`;
Migrationen provisionieren weder Actor noch Timer. Scheduler-Identität/Aktivierung: **BLOCKED**.

## E. Datenbank

Lokale isolierte Kette `091–096 → 100 → 101–105 → 106`: **20/20 PASS** unter PostgreSQL 18.4.
Reales Ledger, sämtliche 13 normalisierten Checksummen gegen die Quellcommits, Replay-/Manipulationsfehler,
transaktionaler Einzel-/104+105+106-Rollback, getrennte Rollen, RLS/FORCE RLS und gespeicherte Daten beider Mandanten sind geprüft.
[Checksummen und Datenbanknachweise](../qa/package4-integration-2026-10-20/migrations.json).
Die historische doppelte Nummer 013 bleibt unverändert; ab 091 existiert keine Nummernkollision.
Der portable Loopback-Harness enthält historische Vector-Anpassungen und lässt die manuelle
Migration 062 aus; er ist kein Neon-Klon. Transaktionaler Fehler-Rollback ist kein produktiver Restore.
Zusätzliche isolierte Neon-Prüfung: **BLOCKED** durch fehlende verifizierte CRM-Testbindung.
Produktionsschema und Produktionsdaten wurden nicht verbunden oder migriert.

## F. Sicherheit

Zwei synthetische Mandanten; aktuelle Rollen-/Projekt-/Bot-/Kanalrechte, fremde Dokumente und
Quellen, Freigabe-/Veröffentlichungsverweigerung, Quellenwiderruf, abgelaufene Verträge,
Dashboard-Isolation, sichere Scanner und Scheduler-Scope: Backend-Negativtests bestanden;
gemeinsamer Browsernachweis unten. Scheduler verweigert fremde/widerrufene Actors, ohne Ersatzidentität.
Runtime darf weder Eigentümer noch Superuser sein oder BYPASSRLS besitzen; Migrationseigentümer bleibt getrennt.

## G. Tests

TypeScript, vollständiges ESLint, optimierter Build und Produktionsdependency-Audit (0 Befunde): PASS.
[Lokale Einzelergebnisse mit Log-Checksummen](../qa/package4-integration-2026-10-20/local-checks.json):
Knowledge 121+19; Paket 3 einschließlich UI-Integration 43+5; Unit 243; Sales 93; Sales final 55;
G08 54; Sicherheitsintegration 17; Operational-Reader/Kalender 12+7; Design C 13+14;
Studio 128, Studio-Ansicht 11; Gateway 10; Preview-Verträge 17; Migrationen 20. Gruppen überlappen.
Alle genannten Backend-Abschlussläufe ohne Fehler oder übersprungene Tests. Lokales Node 24.19.0/npm 11.9.0;
CI prüft separat den unveränderten Pin Node 24.14.0.

Historische Fehler bleiben sichtbar: PR #88 scheiterte im Sales-Schritt; PR #89 bestand alle Funktionsschritte,
scheiterte jedoch am Whitespace-Schritt. Die acht betroffenen historischen Konsolenlogs bleiben samt
Originalhash unverändert; nur diese exakten Evidenzpfade erhalten passende Whitespace-Attribute, alle Quellprüfungen bleiben aktiv.
Der erste lokale Sales-Lauf scheiterte am fehlenden Standard-Chrome; derselbe Test besteht mit installiertem Chromium wie in CI.
Der erste gemeinsame Design-C-Browserlauf bestand 48/50. Er erwartete trotz ausschließlich gestörter Freigabequelle
auch eine gestörte Gesprächsquelle und verwendete den früheren PDF-Freigabedialog. Die Fehlerbelege bleiben erhalten;
der Harness injiziert nun beide benannten Quellenfehler und prüft den realen vierstufigen Veröffentlichungsdialog.
Keine Produktlogik oder Sicherheitsregel wurde dafür geändert.

[Design-C-Browser 50/50](../qa/package4-integration-2026-10-20/browser-design-c.json) und
[Knowledge-Browser 13/13](../qa/package4-integration-2026-10-20/browser-knowledge.json) verwenden optimierte Assets
und regulären Passwort-/TOTP-Login auf der kombinierten lokalen Datenbank.
Design C: keine Browserausnahmen, beobachteten 5xx, externen Browserrequests oder Fremddatenlecks.
Bewusst injizierte 401/403/Netzwerkfehler sind erwartete Konsolenereignisse; passive Antwortprüfung
hat 13 nicht lesbare/abgebrochene Bodies, die expliziten API-Prüfungen konsumieren ihr JSON.
Vier axe-Läufe melden keine Verstöße und jeweils einen unvollständigen Prüfpunkt; keine vollständige WCAG-Abnahme.

[Zusätzlicher Paket-4-Ablauf: 13/13 PASS](../qa/package4-integration-2026-10-20/browser-package4.json):
echter Kunde/Passwort/TOTP, private PDF-Extraktion, vierstufige Veröffentlichung,
unabhängige Webchat-/Voicegrants, Websiteänderung, Vorschlagsvergleich/-annahme,
Veröffentlichung der neuen Version an beide Kanäle, Historie/Wiederherstellungsentwurf,
sofortiger Widerruf und Fremdmandantenverweigerung. Desktop/Mobil ohne Overflow oder Browserausnahme.
Der unveränderte Scanner und seine Persistenz laufen tatsächlich; ausschließlich DNS/HTTP verwenden
einen expliziten synthetischen Service-Port (ein Request). Kein externer Website-/Provider-Nachweis.
Die beiden ersten Zusatzabläufe scheiterten an einer abgeschnittenen synthetischen PDF-Zeile
und einer unveränderten Hash-Navigation mit altem UI-Snapshot. Beide Harness-Ursachen sind behoben,
die Fehler-JSONs bleiben erhalten; positive wie negative Assertions bleiben aktiv.
Die 50/13/13 Abschlussläufe verwendeten dieselben App-/Migrationsbytes; der letzte Zusatzlauf
lief nach der gezielten Harness-Korrektur auf einer frischen kombinierten Fixture.
Ergebnisse früherer Pakete sind Eingangsevidenz und kein PASS für den neuen Kandidaten.
GitHub-CI muss den finalen gepushten Kandidaten prüfen; lokale Tests ersetzen diesen Nachweis nicht.

## H. Preview

Gehostete Gesamt-Preview: **BLOCKED**; Kandidaten-URL und Deployment-ID sind nicht vorhanden.
[Sanitisierte Infrastrukturaufnahme](../qa/package4-integration-2026-10-20/infrastructure.json):
Neon zeigt nur `evelyn-teams-qa` / Default-Branch `production`, ohne belegte synthetische CRM-Herkunft.
Vercel `novalure-crm` / `prj_R32Okl6AHijTohvuKmryuTLjWMsk`: SSO `all_except_custom_domains`;
expliziter Pausenstatus nicht auslesbar (`live=false` ist kein Pausennachweis).
Für diesen Integrationsbranch fehlen Deployment und spezifische Bindungen. Alte Studio-Bindungen
belegen keine sichere Wiederverwendung; unvollständige globale Metadaten ebenfalls nicht.
Die Arbeitsumgebung hat keine gebundenen Secrets/Identitäten. Keine Vorschau-URL wird aus Altdeployments abgeleitet.

Minimaler späterer Einrichtungsschritt: isolierte leere/schemabasierte CRM-Testdatenbank ohne
Produktionskopie, eigene Migrations-/Runtime-Rollen, private Testspeicherung, separate Auth-Secrets
und zwei synthetische Mandanten mit normalen Benutzer-/MFA-Identitäten kontrolliert bereitstellen.
Outbound-Integrationen nur deaktiviert oder als Sandbox. Bindungen ausschließlich an diesen
Preview-Branch/Kandidaten; keine Produktions-Credentials oder unbewiesene globale Vererbung.
Vor Deployment Team, Projekt, exakten SHA und `preview`-Ziel, tatsächlichen Pausenstatus und
Zugriffsschutz der konkreten Deployment-URL prüfen; keine Produktionsdomain zuordnen.

Lokale Gesamtvorschau ohne aktive `.env`-/`.env.local`-/Umgebungsdateien oder externe Credentials;
Harness erzeugt Loopback-Daten, normale Login-/TOTP-Identitäten und Secrets. Kontextdateien nicht veröffentlichen.

```bash
npm ci
npm run build
npm run qa:package4:e2e
# Für eine getrennte manuelle Sitzung nach Ende des E2E-Laufs:
npm run qa:sales:server -- --built --design-c
```

Nur die gemeldete Loopback-URL öffnen; regulär mit MFA anmelden. Keine Demo-Header/fremden Cookies.
Browsernachweise: 50/50 Design C, 13/13 Knowledge und 13/13 zusätzlicher Paket-4-Ablauf; kein gehostetes Deployment.

## I. Release-Gates

| Gate | Status | Noch erforderlicher Nachweis |
| --- | --- | --- |
| A Integration | PASS | Verifizierte Eltern, konfliktfreier Merge und unveränderte Backend-/SQL-Quellbytes |
| B Build/CI | NOT TESTED | Lokale Prüfungen PASS; finales entferntes CI-Ergebnis wird nach Push am exakten PR-Head bestätigt |
| C Datenbank | PASS | Isolierte lokale Prüfung 20/20; Neon-Zusatzprüfung BLOCKED, kein Production-/Restore-Nachweis |
| D Sicherheit | PASS | Gemeinsame Rollen-/Mandanten-/Dokumententests und negative Browserfälle |
| E Funktionen | PASS | Backend-Abnahme und Browser 50/13/13 auf gleicher App-/Migrationsstruktur |
| F Preview | BLOCKED | Isolierte gehostete Bindungen fehlen; lokale Gesamtvorschau ausführbar und geprüft |
| G Produktion | BLOCKED | Ausdrückliche Produktivfreigabe fehlt; kein Release |

## J. Produktion

Nach Entwicklungsevidenz/CI bleiben Zielbindungen, Neon-Abnahme, Restore-/Überwachungsplanung und separate Freigabe offen.
Studio, Voice-Provider, Scheduler und Verträge werden separat provisioniert/abgenommen.
Keine Produktionsmigration, Kundenänderung, Domainänderung, Produktionseinspielung,
Vapi-/Telefonieaktion, echte Stripe-Zahlung oder kostenpflichtige Provisionierung gehört zu diesem Lauf.

## K. Nächste Phase: Universal Booking Engine

Vorhanden: Tenant-/Projekt-/Rollenverträge, OAuth-Verbindungen, bestehende CRM-Termine und
separate Provideradapter. Der sichere `CalendarConnections`-Lesevertrag liefert `source: database`
und je Google/Microsoft nur Provider, Kontobezeichnung, Verbindungsstatus, Ablauf, Scopes und Fehler.
Dieser DTO liefert keine buchbare Verfügbarkeit und führt keine Ereignisschreiboperation aus.
Bestehende Google-/Microsoft-Schreibadapter und begrenzte Studio-Buchungspfade sind keine universelle Engine.
Es fehlen gemeinsame autorisierte Free/Busy-/Ressourcenadapter, Zeitzonen-/Dauer-/Pufferregeln,
idempotente Reservierung mit konkurrierendem Hold/Expiry, atomare Bestätigung, Provider-Reconciliation,
Storno-/Umbuchungsregeln und Audit-/Benachrichtigungsverträge. Paket 4 implementiert diese nicht.
