# QA-REPORT novalure-crm — Go-Live-Remediation

Stand: 22.08.2026<br>
Zielsystem: <https://www.novalure-crm.app><br>
Baseline-/Live-SHA: `77b751d6568487193e9151c7b16545649cfacde7`<br>
Arbeitsbranch: `codex/go-live-remediation-20260822`<br>
Remediation-Kandidat: lokaler Worktree; nicht deployt

## 1. Go-Live-Entscheidung

**Entscheidung: NO-GO**

Die Remediation schließt mehrere zuvor reproduzierte Codefehler: Forms, Knowledge und Funnels verwenden im Produktionspfad persistierte Daten; Public Resolver und 404-Grenzen sind fail-closed; öffentliche Form- und Funnel-Grenzen liefern nur explizite DTOs und minimale Responses; Form- und Funnel-Submits verwenden atomare, lease-gefencete Replay-Contracts und shared Email-/Phone-Identity-Locks. Funnel-Webhooks, Import, Newsletter-Versand sowie öffentliche Booking-Erstellung, -Stornierung und -Umbuchung sind explizit Launch-off. Nicht tragfähig implementierte Public-Form-Modi (File, RoundRobin, Custom Pattern und unsichere Consent-Konfiguration) sind durchgängig fail-closed. Newsletter-Unsubscribe ist nicht mehr über einen mutierenden GET/PII-Link möglich; Inventory-, Knowledge-, E-Mail-, Validierungs-, Navigation-, CSP-, Consent-, Governance- und Release-Contracts wurden zusätzlich gehärtet.

Ein GO ist trotzdem ausgeschlossen. Preview und Production teilen denselben privaten Blob-Fingerprint; Queue- und Providertrennung sind nicht eindeutig belegt. Das Produktionsschema ist nicht auf dem erwarteten Stand, zwei isolierte QA-Tenants fehlen, Resend und Kalenderprovider wurden nicht mit freigegebenen QA-Zielen abgenommen, Legal-/Unternehmens- und Product-Inputs fehlen, und es existiert weder ein SHA-identischer Preview-Kandidat noch eine vollständige Zwei-Tenant-, CRUD-, Datei-, Provider-, Accessibility-, Performance-, Cleanup- und Production-Matrix.

Es wurden keine produktiven Datensätze, Env-Werte, Providerobjekte, Deployments, Aliasse oder Migrationen verändert. Es gab keinen echten Versand, keinen Kalendereintrag und keinen Production-Reset.

## 2. Verbindliche Gate-Tabelle

Status: **2 BESTANDEN, 6 FEHLER, 38 NICHT AUSGEFÜHRT**. Gemäß Master-Prompt zählt jedes nicht ausgeführte Pflichtgate als Fehler.

| Test-ID | Status | Nachweis oder verbleibende Lücke |
|---|---|---|
| REL-01 | FEHLER | Finaler Codezustand: ESLint, Typecheck, Unit 358/358, gezielte Kernpfade, Security Audit und Next-Production-Build grün. Lokales Node 24.18.0 weicht vom exakten Pin 24.14.0 ab; die lokale Abschluss-SHA wird nach dem Dokument-Freeze im Handoff ausgewiesen, ein deployter SHA-identischer Kandidat fehlt |
| REL-02 | FEHLER | Historisches Produktionsaudit: `ok:false`, 112 von damals erwarteten 115 Tabellen, Ledger bei 067. Der nicht deployte Kandidat erwartet 117 Tabellen und Migrationen 068–072; keine davon wurde auf Production angewendet |
| REL-03 | NICHT AUSGEFÜHRT | Kein Restore-Drill, kein Blob-E2E, kein Cron-/Queue-SLO und keine signierte Ops-Evidenz |
| REL-04 | NICHT AUSGEFÜHRT | Unternehmensprofil, Legal- und Ops-Freigabe fehlen |
| SCOPE-01 | FEHLER | Inventar und einzelne Launch-off-Grenzen vorhanden; signierte Gesamtmatrix und zentraler serverseitiger Scope-Guard fehlen |
| ENV-01 | FEHLER | DB getrennt, privater Blob identisch, Queue-/Providerziele unklar |
| DATA-01 | BESTANDEN | Forms, Knowledge und Funnel verwenden DB-only-Wahrheit; Fixture-/Fallback-Negativtests grün |
| DATA-02 | NICHT AUSGEFÜHRT | Kein vollständiger UI/API/DB-Drei-Wege-Abgleich für alle Launch-KPIs |
| CRUD-01 | FEHLER | Keine zwei QA-Tenants; Migration 068/Reset-Tabellen fehlen in Production; kein Reset-E2E |
| CRUD-02 | NICHT AUSGEFÜHRT | CRM-Kernkette nicht in isolierter QA-Umgebung ausgeführt |
| CRUD-03 | NICHT AUSGEFÜHRT | Einzelne Idempotenzguards grün; vollständige Zwei-Tab-/Offline-/Retry-Matrix fehlt |
| FORM-01 | NICHT AUSGEFÜHRT | Resolver/Versionierung/404 gehärtet; kein Kandidaten-E2E Admin↔DB↔Canonical↔Embed |
| FORM-02 | NICHT AUSGEFÜHRT | Atomarer CTE-/Idempotenz-/Public-DTO-/Consent-/Identity-Contract lokal 12/12, Migration-Guards 20/20; echter allowlisteter QA-Submit und Cleanup fehlen |
| BOOK-01 | NICHT AUSGEFÜHRT | Öffentliche Create-/Cancel-/Reschedule-Pfade sind einschließlich Repository und UI fail-closed Launch-off; Kalenderprovider-, CRM- und Cleanup-E2E fehlen |
| MAIL-01 | FEHLER | Resend nicht provisioniert; Domain/From/Key/QA-Mailbox nicht real validiert |
| MAIL-02 | NICHT AUSGEFÜHRT | Redigierte Fehlergrenze im Code; kein kontrollierter echter Providerfehler |
| AUTH-01 | NICHT AUSGEFÜHRT | Baseline-Login/MFA/Reload/Logout bestanden; vollständige Kandidatenmatrix inkl. Ablauf/Rate Limit fehlt |
| RBAC-01 | NICHT AUSGEFÜHRT | Keine vollständige Owner/Admin/Agent/Assistant/Viewer-Endpoint- und UI-Matrix |
| TENANT-01 | NICHT AUSGEFÜHRT | Kein Zwei-Tenant-IDOR-Lauf |
| TENANT-02 | NICHT AUSGEFÜHRT | Keine vollständigen URL/API/Export/Relationship-Negativtests |
| I18N-01 | NICHT AUSGEFÜHRT | Lokale Tests grün; Route×Locale×Navigation×Reload nicht vollständig |
| I18N-02 | NICHT AUSGEFÜHRT | DE/EN-Startseite und dynamische 404 lokal geprüft; Pflicht-Routen-Matrix fehlt |
| I18N-03 | NICHT AUSGEFÜHRT | CRM-/Template-/Toast-/Mail-E2E DE/EN fehlt |
| LEGAL-01 | NICHT AUSGEFÜHRT | Final freigegebene DE-/EN-Rechtstexte und Sign-off fehlen |
| FALLBACK-01 | NICHT AUSGEFÜHRT | Product-Entscheidung und vollständiger ES-Nachweis fehlen |
| UX-01 | NICHT AUSGEFÜHRT | Deal/Inventory-Validierung grün; vollständige Browser-/Network-Matrix fehlt |
| UX-02 | BESTANDEN | Automatisierter Hash/Titel/Menü/Content-Invariant inklusive `#analysis` grün |
| A11Y-01 | NICHT AUSGEFÜHRT | Kein vollständiger Axe-, Screenreader- und Booking-/Form-Test |
| A11Y-02 | NICHT AUSGEFÜHRT | Cookie-Fokus und 320/375/390/430 ohne Overflow lokal grün; vollständige Drawer-/inert-/Touchmatrix auf Kandidat fehlt |
| SEC-02 | NICHT AUSGEFÜHRT | CSP, Consent, Unsubscribe, Token und 404 gehärtet; vollständige CORS/Cookie/private-Media/Kandidatenmatrix fehlt |
| FILE-01 | NICHT AUSGEFÜHRT | Kein Datei-Lifecycle für PDF/JPG/PNG/DOCX, MIME, Größe, Rechte und Cleanup |
| ADV-01 | NICHT AUSGEFÜHRT | Funnel DB-only, Deep-DTO, minimale Live-Response und atomare/fresh-snapshot Persistenz lokal gehärtet; Publish-/Analytics-/KPI-E2E und Rotation des bislang verwendeten Public Tokens fehlen |
| ADV-02 | NICHT AUSGEFÜHRT | Knowledge atomar und DB-only; freigegebene Imports und semantische Suche schlagen ohne externen Embedding-Provider fail-closed fehl; UI/API/DB-/Bot-E2E fehlt |
| ADV-03 | NICHT AUSGEFÜHRT | Communication-Scope nicht fachlich und technisch vollständig abgenommen |
| ADV-04 | NICHT AUSGEFÜHRT | Customer/User/Grant-Semantik nicht Ende-zu-Ende belegt |
| ADV-05 | NICHT AUSGEFÜHRT | Consent/Suppression/Unsubscribe-Code gehärtet; Newsletter-Send ist explizit Launch-off; genau ein später freigegebener QA-Versand und Cleanup fehlen |
| ADV-06 | NICHT AUSGEFÜHRT | Kein Data-Hygiene Detect/Resolve/Ignore/Merge-E2E auf QA-Daten |
| ADV-07 | NICHT AUSGEFÜHRT | Keine Bot-/Automation-QA-Sandbox- und Side-Effect-Matrix |
| ADV-08 | NICHT AUSGEFÜHRT | Import/Webhook Launch-off; übrige OAuth-/Sync-/Notification-/Reservation-Flächen nicht vollständig klassifiziert/abgenommen |
| SEARCH-01 | NICHT AUSGEFÜHRT | Kein kompletter Suche/Umlaut/Filter/Sortierung/Pagination/Export-Abgleich |
| PROP-01 | NICHT AUSGEFÜHRT | 18/18 Property-Tests grün; fachliche Inhalte/Dokumente/Publish-Readiness nicht freigegeben |
| OBS-01 | NICHT AUSGEFÜHRT | Baseline 24 h ohne Error/5xx; kein kontrollierter Fehlertrace für Kandidat/Provider |
| OBS-02 | NICHT AUSGEFÜHRT | Keine getesteten Alarme und kein Kandidaten-SLO-Fenster |
| PERF-01 | NICHT AUSGEFÜHRT | Kein Lighthouse und keine p75-LCP/INP/CLS-Evidenz |
| PROD-01 | NICHT AUSGEFÜHRT | Remediation nicht deployt; kein Production-Smoke auf gleicher SHA |
| CLEAN-01 | NICHT AUSGEFÜHRT | Keine Writes und daher kein aktueller Rückstand; verbindlicher Batch-/Reconciliation-Lauf fehlt |

Die vollständige Workstream- und Evidenzzuordnung steht in `docs/audit/2026-08-22/go-live-remediation-ledger.md`.

## 3. Management Summary

### Codeänderungen

- Produktionswahrheit für Forms, Knowledge und Funnel ohne sichtbare Fixtures/Fallback-KPIs.
- Persistente Public-Form-Auflösung, optimistische Versionierung und Owner-Tenant-Guards. Der Submission-Kern schreibt Domainobjekte und die minimale `{persisted:true}`-Replay-Response in einem lease-gefenceten atomaren CTE, verwendet einen semantischen Multipart-Fingerprint und shared Email-/Phone-Identity-Locks mit Funnel. Die öffentliche DTO gibt nur explizit allowlistete Felder/`field.id` aus; Hidden-Defaults bleiben serverautoritativ.
- File-Formulare, RoundRobin-Owner, tenantdefinierte Custom-RegEx-Patterns sowie vorselektierte, bedingte oder nicht eindeutig als Privacy/Marketing klassifizierbare Consent-Konfigurationen sind in Admin-Save/UI, Public Page, Embed und Submission-API fail-closed. Public Submits akzeptieren 0 Dateien und höchstens 256 KiB Body.
- Echte Missing-Form-Pfade liefern 404/noindex; Datenbankfehler propagieren als Infrastrukturfehler und werden nicht als 404 maskiert.
- Funnel-Livezugriff verlangt aktiven persistierten Blueprint und exaktes Token; Testpreview bleibt authentifiziert und tenantgebunden. Öffentlich serialisiert wird ausschließlich eine tief allowlistete Renderer-DTO; Live-Submits antworten minimal ohne Publish-Token, interne CRM-IDs oder Handoverdetails.
- Funnel-Submits canonicalisieren Felder, Identity-Aliasse, Consent und Scores und persistieren Contact/Lead/Submission/Deal/Consent/Task/Timeline/KPI/Audit/Analytics atomar. Vorgelagerte, mit Forms geteilte Email-/Phone-Identity-Advisory-Locks in derselben Tenant-Transaktion erzwingen kanalübergreifend einen frischen Read-Committed-Snapshot. Publish, Restore und Runtime verwenden denselben Preflight; nicht submitbare aktive Blueprints werden bereits vor der Veröffentlichung abgelehnt.
- Funnel-Outbound-Webhooks und Import sind explizit Launch-off.
- Opaque, zeitgebundener Unsubscribe-Token im Fragment; expliziter Same-Origin-POST; atomare workspacegebundene Suppression/Consent-Aktualisierung.
- Newsletter-Send ist im API- und UI-Pfad explizit Launch-off; kein Provideraufruf kann aus dieser Oberfläche erfolgen.
- Öffentliche Booking-Erstellung, -Stornierung und -Umbuchung sind vor Request-Body, DB und Provider hart Launch-off; auch Repository-Erstellung und UI sind fail-closed. Die gehärtete, aber noch nicht freigegebene Lifecycle-Implementierung bleibt im Code inaktiv.
- Unit-/Building-Erstellung verwendet semantische Idempotenz-Ledger, tenantqualifizierte FKs und eine Tenant-Transaktion mit vorgelagertem Advisory Lock/Fresh Snapshot; Migration 069 ist unangewendet.
- Knowledge schreibt Source und Chunks atomar und prüft den Projekt-Tenant vor und während des Writes. Freigegebene Imports und semantische Suche benötigen einen konfigurierten externen Embedding-Provider und liefern bei Fallback/Timeout 503 ohne Persistenz bzw. Suche.
- Resend ohne Mock-/Testsender-Fallback, mit exakter Readiness, QA-Allowlist, Timeout, Bounds und redigierten Fehlern.
- Release-/Governance-UI zeigt reale Evidenzlücken statt statischer grüner Aussagen.
- QA-Reset ist im Code allowlist-, batch-, CSRF-, audit- und FK-gebunden; Legacy-Reset ist deaktiviert. Migration 068 bleibt manuell und unangewendet.
- Validierung, Doppelklickschutz, Profilnavigation, CSP, Consent-Fokus, Locale- und Public-404-Grenzen wurden gehärtet.

### Nicht geänderte externe Zustände

- Datenbank/Daten: keine Writes, keine Migration, keine QA-Tenants, kein Reset.
- Vercel: kein Env-Change, kein Deploy, keine Promotion, kein Aliaswechsel.
- Provider: keine Domain-/Key-/From-Änderung, keine Mail, kein Kalendereintrag, keine OAuth-/Retry-Aktion.
- Legal/Business: keine Angaben erfunden oder als freigegeben markiert.

## 4. DE/EN- und Sprachmatrix

| Bereich | DE | EN | Ergebnis/Grenze |
|---|---|---|---|
| Lokale Homepage | bestanden | bestanden | korrektes `html lang`, lokalisierter Titel/H1, kein Overflow |
| Öffentliche Form Missing | bestanden | nicht separat manuell | HTTP 404, DE-404, `noindex,nofollow` |
| Booking Missing | nicht separat manuell | bestanden | lokalisierte 404, `noindex,nofollow` |
| Funnel ungültiges Token | nicht separat manuell | bestanden | fail-closed 404 |
| Unsubscribe ungültiger Alt-/PII-Link | nicht separat manuell | bestanden | neutraler Fehler, keine E-Mail im DOM, keine Form/Mutation |
| CRM i18n Unit-Suite | bestanden | bestanden | 10/10 |
| CRM-/Template-/Mail-E2E | nicht ausgeführt | nicht ausgeführt | benötigt isolierte QA-Rollen und Provider |
| Legal DE/EN | nicht freigegeben | nicht freigegeben | Legal-Owner, Version und Datum fehlen |
| ES | offen | Fallback offen | Product muss vollständig ES, deaktiviert oder korrekten EN-Fallback signieren |

## 5. Desktop-/Mobile-Matrix

| Prüfung | Ergebnis | Evidenz |
|---|---|---|
| Desktop DE/EN Public | bestanden | lokaler Production-Build; korrekter Titel, H1 und `html lang`; keine Console-Errors |
| 320 px | Teilprüfung bestanden | `scrollWidth == clientWidth`; Cookie-Dialog horizontal vollständig im Viewport |
| 375 px | Teilprüfung bestanden | kein horizontaler Overflow |
| 390 px | Teilprüfung bestanden | kein horizontaler Overflow |
| 430 px | Teilprüfung bestanden | kein horizontaler Overflow |
| Cookie-Tastatur | bestanden | Dialog öffnet fokussiert; Escape schließt und fokussiert wieder „Cookies“ |
| Authentifizierter Mobile Drawer auf Kandidat | nicht ausgeführt | Remediation nicht deployt; keine lokale Kandidaten-DB/Rollen |
| Axe/Screenreader | nicht ausgeführt | kein vollständiger Tool-/manueller Lauf |

Diese lokale Teilprüfung schließt A11Y-02 nicht, weil Drawer, Hintergrund-`inert`, alle Touchziele und echte Form-/Booking-Flows auf dem deployten Kandidaten fehlen.

## 6. Befunde nach Schweregrad

### Releaseblocker/P0

1. **ENV-01:** Private Blob ist zwischen Preview und Production identisch; Queue/Provider sind unklar.
2. **SCOPE-01:** Keine signierte Gesamtmatrix und kein zentraler serverseitiger Launch-Scope-Guard.
3. **DB/Restore:** Produktionsschema/Ledger rot; manuelle Migrationen und QA-Reset-Tabellen fehlen; kein Restore-Drill.
4. **QA-Isolation:** Zwei QA-Tenants, Rollenaccounts, Batch-Reset-E2E und Null-Rückstands-Abgleich fehlen.
5. **Provider:** Resend/Domain/From/QA-Mailbox und QA-Kalender nicht real abgenommen.
6. **Legal/Product:** Unternehmensprofil, DE/EN Legal, ES und KPI-Semantik nicht signiert.
7. **Releasekandidat:** Kein gepinnter SHA-identischer Preview-/Production-Kandidat, kein vollständiges E2E und kein Beobachtungsfenster.

### Hohe Restpunkte/P1

- Vollständige Customer-RBAC-/Zwei-Tenant-IDOR-Matrix fehlt.
- Dateien, Newsletter, Data Hygiene, Bots, Communication, OAuth, Notifications, Reservation-Side-Effects und Exporte sind nicht E2E abgenommen oder global klassifiziert.
- KPI-Parität ist nur für gezielt remediierte Teilbereiche im Code belegt.
- Vollständige Accessibility-/Performance-/Observability-Evidenz fehlt.

### Im Code geschlossen

Der unabhängige Abschlussreview meldet für den Kandidatencode **0 offene P0 und 0 offene P1**. Die folgenden Punkte sind im lokalen Contract geschlossen; die übergeordneten Releasegates bleiben wegen fehlender externer/E2E-Evidenz NO-GO.

- Fixture-/Fallback-Wahrheit bei Forms/Knowledge/Funnel.
- Public-Form Missing-404/noindex und Trennung zu 5xx-DB-Fehlern.
- Public-Form Deep-Allowlist-DTO/minimale Response, atomarer lease-gefenceter Domain-/Replay-CTE, shared Identity-Locks, Identity-Conflict/Hijack-Schutz, semantische Custom-Feldauflösung und strikte Consent-Wahrheit über Positiv-Allowlist; Privacy/Marketing getrennt und niemals vorselektiert.
- File-, RoundRobin-, Custom-Pattern- und nicht unterstützte Consent-Konfigurationen über Admin-Save/UI, Public Page, Embed und API Launch-off.
- Authentifiziertes Forms-Admin-JSON ist auf 256 KiB streamingbegrenzt; der Legacy-Booking-Resolver propagiert DB-Ausfälle statt sie als 404 zu maskieren; Knowledge-Logs schreiben keine rohe `error.message` mehr.
- Der Windows-Entrypoint des QA-Target-Guards ist fail-closed; ohne freigegebenen QA-Fingerprint beendet er mit Exit 1.
- Public-Funnel Deep-Allowlist-DTO, minimale Live-Response und DB-Fehler-zu-5xx-Grenze; der bisherige Live-Publish-Token muss extern vor GO rotiert werden.
- Funnel-Submit-Atomizität, Lease-Fencing, shared Email-/Phone-Identity-Fresh-Snapshot-Serialisierung über Form und Funnel, kanonische Consent-/Identity-Alias-Semantik und gemeinsamer Publish-/Restore-/Runtime-Preflight.
- Unit-/Building-Idempotenz in einer tenantgebundenen Transaktion mit Fresh Snapshot.
- Knowledge-External-Provider-Grenze für freigegebene Imports und semantische Suche.
- Unsicherer Unsubscribe-GET/PII-Link.
- Funnel-Webhook, Import, Newsletter-Send und öffentliche Booking-Create-/Cancel-/Reschedule-Pfade im vorliegenden Kandidaten Launch-off.
- Statisch grünes Governance-/Release-Cockpit.
- Zu breite Systemdiagnostikrolle.
- Deal-/Inventory-Silent-No-op und Doppelklickrisiken im gehärteten Teilpfad.
- Profil-`#analysis`, CSP, Cookie-Fokus und ausgewählte Public-i18n-Grenzen.

### P2-/P3- und Formalgate-Hinweise aus dem Abschlussreview

- Public-Submission-Proofs laufen nach 15 Minuten ab; ein Refreshflow für lange Formular-/Funnel-Sessions fehlt.
- Die fachliche Kopplung von Unit-Status zu Buyer-/Deal-Beziehungen ist nicht vollständig serverseitig erzwungen.

Diese P2-Punkte sind nicht als akzeptierter Nach-Go-Live-Backlog freigegeben; Owner, Termin und Risikoakzeptanz fehlen.

Zusätzlicher P3-Härtungshinweis: Der gemeinsam genutzte bounded-JSON-Reader berechnet für den Forms-Editor einen dort ungenutzten HMAC-Fingerprint und koppelt diesen Adminpfad dadurch unnötig an das für den Go-Live ohnehin korrekt zu setzende `NOVALURE_ABUSE_SECRET`. Bei korrekter Go-Live-ENV entsteht kein Sicherheits- oder Releaseblocker; die Verantwortlichkeiten sollten später entkoppelt werden.

## 7. Befund → Fix → Test → Reststatus

| Befund | Fix | Test/Evidenz | Reststatus |
|---|---|---|---|
| Demo-/Fallback-Daten wirken produktiv | DB-only und fail-closed Resolver/KPIs | Forms/Knowledge/Funnel-Suites | Code geschlossen; deploytes E2E offen |
| Public Form unavailable/Soft-404 | Persistenter Resolver; Missing 404/noindex; DB-Fehler nicht maskiert | Contract-Test + lokaler Browser + HTTP 404 | Kandidaten-Form-E2E offen |
| Form-Submit konnte teilpersistieren/retry-inkonsistent werden oder interne IDs/CRM-Felder leaken | lease-gefenceter atomarer Domain-/Minimalresponse-CTE, semantischer Multipart-Fingerprint, Deep-Allowlist-DTO, Owner-Tenant-Guard, shared Identity-Locks und Collision/Hijack-Schutz | Forms 12/12; Reviewer-Zielbündel 39/39; Migration 20/20; Remediation 120/120 | Kandidatencode geschlossen; echter QA-Submit, DB-/UI-Abgleich und Cleanup offen |
| Nicht tragfähige Public-Form-Modi wirkten aktiv | File, RoundRobin, Custom Pattern und unsichere Consent-Konfiguration in Admin-Save/UI, Public Page, Embed und API fail-closed; 0 Dateien/256 KiB Body; feste Consent-Truthy-Allowlist, Privacy/Marketing getrennt und unchecked | Forms-/Reviewer-Zielsuites grün | spätere Aktivierung benötigt eigenständige sichere Implementierung und E2E-Abnahme |
| Funnel ohne belastbare Public-Grenze | Token+active+persisted Blueprint; Tenant-Testpreview; Deep-Allowlist-DTO; minimale Live-Response | Funnel-Public-Access-/DTO-Suites | externer Publish-Token-Rotation, echter Publish/Submit/Cleanup offen |
| Funnel-Submit konnte Teilzustände/Kontaktduplikate bzw. Consent-/Alias-Drift erzeugen | atomarer Domain-CTE; lease-gefencete Replayresponse; shared Form/Funnel-Email-/Phone-Identity-Advisory-Locks in Tenant-TX; kanonische Consent-/Identity-Aliasse; gemeinsamer Publish-/Restore-/Runtime-Preflight | Funnel-Abuse-/DTO-/Boundary-/Preflight-Suites, finaler Freeze 29/29 | Kandidatencode geschlossen; deployed DB-Concurrency-/Zwei-Tenant-E2E offen |
| Ungeprüfter Webhook | Konfiguration/API/Persistenz/Adapter Launch-off | Launch-Scope-Suite | SCOPE-01 insgesamt offen |
| Ungeprüfter Import | Entry Points verborgen; kein Import-Endpoint vorhanden | Launch-Scope-Suite | zentrale Policy fehlt |
| Unsubscribe mutiert/enthält PII | Fragment-Capability, Confirm-POST, atomare Suppression | 7/7 Tests + lokaler neutraler Fehler | echter QA-Mailflow offen |
| Newsletter-Send ohne freigegebene Providerabnahme | API liefert vor Providerzugriff 503 Launch-off; Send-Aktionen in der UI verborgen | Newsletter-/E-Mail-/Launch-Scope-Suites | Product-/Providerfreigabe und genau ein QA-Send offen |
| Öffentliche Booking-Writes ohne abgeschlossene Provider-/Recovery-Abnahme | Create, Cancel und Reschedule in Route, Repository und UI vor Body/DB/Provider Launch-off | Booking-/i18n-/Launch-Scope-Suites | fachliche Freigabe, QA-Kalender und vollständiges E2E vor späterem Launch-on |
| Unit-/Building-Doppelklick/Parallelität | semantische Idempotenz-Ledger; tenantgebundene TX mit vorgelagertem Advisory Lock; atomarer Domain-/Auditwrite | Inventory-/Migration-/Reset-Zielsuites | Migration 069 und echtes DB-Concurrency-E2E offen |
| Knowledge-Fallback konnte als semantischer Providerpfad wirken | externer Provider für approved/search obligatorisch; Timeout/Fallback 503; Source+Chunks atomar | Forms/Knowledge-Zielsuite | Provider-/UI/API/DB-E2E offen |
| Resend-Fallback/Leak | exakter Providercontract, Allowlist, redigierte Fehler | E-Mail-Contract-Suite | Live-Readiness/QA-Mail fehlt |
| Releasecockpit falsch grün/unklar | exakter API/UI-Contract, Issues aus Ergebnissen | System-Releases-Suite | Produktionsschema bleibt rot |
| Gefährlicher Reset | Allowlist, Dry-run, Audit, CSRF, Batch/FK-Closure | QA-Reset-Suite | Migration/QA-Tenants/E2E offen |
| Silent No-op/Duplikate | gemeinsame Validierung und synchrone Guards | Deal-/Inventory-Suites | vollständige Browser-Concurrency offen |
| Schwache CSP/Consent | Nonce+`strict-dynamic`; Fokus/Storage-Sync | CSP-/Consent-Suites + Header-/Browserprobe | vollständige SEC/A11Y-Matrix offen |

## 8. Datenintegrität und Umgebungsisolation

### Read-only Fingerprints

| Ziel | Production | Preview | Ergebnis |
|---|---|---|---|
| DB | `sha256:36e38778071baa281fe6` | `sha256:b8d9af25b0eeccdf276e` | getrennt |
| Private Blob | `sha256:7c024de0f594165110e9` | `sha256:7c024de0f594165110e9` | identisch — Stop-Gate |
| Queue | unklar | unklar | Stop-Gate |
| Provider | Scope unklar | Scope unklar | Stop-Gate |

Wegen ENV-01 wurden Preview-Seed, CRUD, Upload, Reset und Provider-Smoke nicht ausgeführt.

### Historischer Produktionsaudit, read-only

- Auditzeitpunkt/Codebasis: vor den Kandidatenmigrationen 069–072.
- Damals erwartete Tabellen: 115; in Production tatsächlich vorhanden: 112.
- Aktuelle Production-Ledger-Migration im Audit: `067_app_role_runtime_grants`.
- Checksummierte Ledger-Zeilen: 19.
- Damals manuell bzw. als Kandidat offen: 057, 060, 061, 062, 065 und 068.
- In Production fehlend: `qa_batches`, `qa_batch_objects`, `qa_reset_audit_events`.
- Auditresultat: `ok:false`.

### Aktueller nicht deployter Kandidat

- Erwartete Tabellen laut `src/lib/db/schema.ts`: 117.
- Neue, nicht angewendete Kandidatenmigrationen: 068 QA-Reset, 069 Unit-/Building-Idempotenz, 070 Funnel-Recovery, 071 Forms-Owner-Tenant-Guard und 072 Form-Submission-Atomizität.
- Migrationen 070–072 erweitern bestehende Tabellen/Constraints; die zwei zusätzlichen Kandidatentabellen gegenüber dem 115er Auditstand stammen aus Migration 069.
- Für Production wurde weder ein aktueller 117-Tabellen-Audit noch eine dieser Migrationen ausgeführt. Der Kandidatenstand darf nicht mit der historischen Live-Evidenz vermischt werden.

### Schreib-/Cleanup-Bilanz

| Kategorie | Anzahl |
|---|---:|
| Produktive Datensätze erstellt/geändert/gelöscht | 0 |
| Preview-Datensätze erstellt/geändert/gelöscht | 0 |
| Blobs/Queue-/Providerobjekte erzeugt | 0 |
| E-Mails/Kalendereinträge/Benachrichtigungen | 0 |
| QA-Batch-ID | keine |
| Erforderlicher Cleanup | keiner |

## 9. Sicherheit und Datenschutz

- Production-CSP im lokalen Build: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `script-src-attr 'none'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` auf normalen Seiten.
- Der absichtliche Formular-Embedpfad lässt Framing gezielt zu und bleibt sonst durch die CSP begrenzt.
- HSTS, `nosniff`, Referrer- und Permissions-Policy wurden lokal bestätigt.
- Dynamische Form-/Booking-/Funnel-Missing-Pfade sind fail-closed; Form-DB-Fehler werden nicht als 404 verschluckt.
- Die öffentliche Funnel-RSC-/Client-Grenze verwendet eine explizite Deep-Allowlist. Publish-Token, Workspace-/Projekt-/CRM-Handover-Daten, Empfänger, Providersecrets und interne Trackingwerte werden nicht an den Browser serialisiert; die Live-Submit-Response enthält keine internen IDs oder Diagnostik.
- Unsubscribe-GET ist read-only; die PII-Synthetic-Probe erschien nicht im DOM und bot keine Mutationsform.
- Systemdiagnostik bleibt auf `platform_admin` bzw. `novalureAdmin` begrenzt.
- QA-Reset ist default Dry-run, CSRF-/Capability-/Allowlist-/Batch-gebunden und verweigert externe Assets ohne Adapter.
- `npm run security:production` bestand mit System-CA und meldete 0 Vulnerabilities.

Nicht bewiesen sind echte Zwei-Tenant-IDOR-, Customer-RBAC-, Datei-, private-Media-, Mass-Assignment-, gespeicherte Feldpayload-, Rate-Limit- und Sessionablauf-E2Es auf dem Kandidaten. Außerdem muss der bislang im Live-Frontend verwendete Funnel-Publish-Token vor GO außerhalb des Codes rotiert und die alte Capability widerrufen werden; diese Rotation wurde bewusst nicht vorgenommen.

## 10. Performance, Betrieb und Observability

- Lokaler Next.js-Production-Build: Exit 0; 82 statische Seiten sowie alle dynamischen Routen erzeugt.
- Lokaler Browser-Smoke: keine Console-Errors und kein horizontaler Overflow bei 320–430 px.
- Baseline-Production: 24 Stunden ohne Vercel-Error-Logs oder 5xx im geprüften Fenster.
- Aktuelles Baseline-Deployment: `dpl_4r6tWnAMRAPMpeBbhGegYzu5tu1C`, READY/Production, SHA `77b751d…`.

Diese Baseline-Evidenz gilt nicht für den nicht deployten Remediation-Kandidaten. Lighthouse, Core Web Vitals, Last/Concurrency, kontrollierter Fehlertrace, Alarmtest, 60-Minuten-/24-Stunden-Kandidatenbeobachtung und 7-Tage-Cron-/Queue-SLO fehlen.

## 11. Nicht getestet

- Vollständige Auth-Matrix auf der Remediation-SHA inklusive MFA, Ablauf, Recovery, Rate Limit und Token-Lifecycle.
- Echte Owner/Admin/Agent/Assistant/Viewer-Rollen und zwei legitime QA-Tenants.
- Create→Reload→Update→Relation→Filter→Cleanup für alle CRM-Kernobjekte.
- Form-Submit sowie später freigegebene Booking-, E-Mail-, Newsletter-, Kalender- und externe Providerpfade mit genau einer QA-Mailbox/einem QA-Kalender. Die aktuell Launch-off gesetzten Write-Flächen wurden nicht umgangen.
- PDF/JPG/PNG/DOCX, MIME-Mismatch, Übergröße, Rechte, Download, Delete und Blob-Cleanup.
- Data Hygiene, Bots, Approval, Communication, OAuth, Sync, Notifications, Retry, Reservation-Side-Effects.
- Vollständige Suche/Umlaut/Filter/Sortierung/Pagination/Export-Matrix.
- Vollständiger UI/API/DB-KPI-Abgleich.
- Axe, Screenreader, alle mobilen Dialoge/Drawer und Touchziele.
- Lighthouse/Web Vitals/Lasttest, Restore-Drill, Alarmtest, RPO/RTO, SLO.
- Preview- und Production-E2E, Cleanup-Reconciliation und Beobachtungsfenster.

## 12. Vor-Go-Live-To-dos

| Prio | Owner | Maßnahme | Akzeptanzkriterium |
|---|---|---|---|
| P0 | Product + Engineering + Security + Ops | Signierte Launch-Scope-Matrix und zentrale serverseitige ON/OFF/INTERNAL-Policy | Jede sichtbare Route/API/Action eindeutig klassifiziert; Direktaufrufe fail-closed |
| P0 | Platform/Ops | Getrennte Preview-Blob-, Queue- und Providerziele bereitstellen | ENV-01 zeigt vier eindeutig getrennte Fingerprints/Ziele |
| P0 | DBA + Release | Backup, Restore-Drill, Dry-run, Rollback und kontrollierte Migrationen bis einschließlich Kandidatenstand 072 | 117-Tabellen-Schema/Ledger/Checksums grün; Restore/RPO/RTO signiert |
| P0 | QA + Identity + CRM | Zwei QA-Tenants, Rollen, Batch-Ledger und Reset-E2E | Negative Resettests und Null-Rückstands-Abgleich in DB/Blob/Queue/Provider |
| P0 | Messaging/Ops | Resend, Domain, From, Key, QA-Mailbox und QA-Kalender freigeben | genau eine QA-Mail und ein QA-Termin; Fehlerpfad/Cleanup belegt |
| P0 | Security + Ops | Den bislang veröffentlichten Funnel-Publish-Token rotieren, alte Capability widerrufen und neue URL kontrolliert verteilen | alte URL/Capability 404/403; neue Capability nur in freigegebenem Ziel; Rotation und Audit dokumentiert |
| P0 | Legal/Management/Product | Unternehmensprofil, DE/EN Legal, ES und KPI-Definitionen signieren | Version, Owner und Datum dokumentiert; keine sichtbaren Blocker |
| P0 | Release/QA | Exakten Node-24.14.0-Kandidaten als getrennte Preview deployen und vollständige Matrix ausführen | SHA/Lockfile/Deployment identisch; alle 46 Gates bestanden |
| P0 | Release/Ops | Geschützten Production-Kandidaten, Rollback, Smokes, Cleanup und Beobachtung durchführen | 60 min/24 h/7 d Evidenz; erst danach separate Aliasfreigabe |

Jede DB-, Env-, Provider-, Deploy-, echte Send-, Production-Write- oder Resetaktion benötigt vorher die im Master-Prompt geforderte ausdrückliche Freigabe.

## 13. Nach-Go-Live-Backlog

Aktuell ist kein offener Punkt als zulässiger Nach-Go-Live-Restpunkt akzeptiert: Owner, Termin, Ablaufdatum und schriftliche Risikoakzeptanz liegen nicht vor. Erst nach Schließen aller P0/P1-Gates können rein nicht-sicherheits-, daten-, rechts-, auth-, tenant-, versand-, sprach- oder kernflowrelevante Punkte als P2/P3 eingeordnet werden.

Mögliche spätere Komfortpunkte:

- globale Vercel CLI stark empfohlen mit `npm i -g vercel` installieren, um `vercel env pull`, `vercel deploy` und `vercel logs` direkt nutzen zu können; aktuell funktionierte `npx --yes vercel@latest` 59.4.0, daher ist die fehlende globale Installation selbst kein Releaseblocker;
- dauerhafte Lighthouse/Web-Vitals-Trends und weiterführende Content-/Terminologiepflege;
- zusätzliche visuelle Regressionen nach bestehender Axe-/Browser-Abnahme.

## 14. Verifikation und Evidenz

### Repository und Toolchain

- Sauberer separater Worktree und Branch; vorhandene Nutzeränderungen im ursprünglichen Arbeitsbereich blieben unangetastet.
- Baseline-/Live-SHA beim Prüfstart: `77b751d6568487193e9151c7b16545649cfacde7`.
- Lokal: Node 24.18.0, npm 11.16.0; exakter Projektpin Node 24.14.0 deshalb nicht als Releaseevidenz anerkannt.
- Next.js 16.3.0; vor Next.js-Änderungen wurden die versionsgebundenen Dokumente unter `node_modules/next/dist/docs` verwendet.

### Lokale automatisierte Ergebnisse

Die folgenden Ergebnisse gelten für den final revalidierten lokalen Kandidatenstand beim Dokument-Freeze; die Abschluss-SHA wird im Handoff ausgewiesen. Alte Werte wie 314/314, 315/315 oder Booking 5/5 sind supersediert.

| Command/Suite | Ergebnis |
|---|---|
| `npm ci` | Exit 0 |
| `npm run ci:toolchain` | Exit 1, erwartete Pin-Abweichung 24.18.0 vs. 24.14.0 |
| `npm run lint` | Exit 0 auf final revalidiertem Codezustand |
| `npm run typecheck` | Exit 0 auf final revalidiertem Codezustand |
| `npm run test:unit` | 238/238 Basissuite + 120/120 Go-Live-Remediation = 358/358 bestanden (zwei Runner) |
| Funnel P1-Zielsuites | Deep-DTO 4/4; finaler Consent-/Alias-/Publish-Preflight-Zielstand 29/29; früherer breiter Remediation-Handoff 99/99; zusätzliche Migration-Guards im Handoff grün |
| Unit/Building-Zielsuites | 44/44 nach Fresh-Snapshot-Tenant-Transaction-Fix |
| Knowledge-Zielsuite | 6/6 nach External-Provider-Fail-Closed-Fix |
| Form-Zielsuite | 12/12; unabhängiges zielgerichtetes Reviewer-Bündel 39/39; Migration-Guards 20/20 nach letzter Consent-Nachschärfung |
| Forms + Knowledge + Public Abuse | 26/26 im finalen Freeze nach bounded Admin-JSON, Knowledge-Log-Redaction und Public-Abuse-Nachschärfungen |
| `npm run test:go-live-remediation` | 120/120 nach letzter Forms-Consent-Nachschärfung |
| gezielte finale Kernpfade | 40/40; zusätzlich 39/39 Migration/Unit/Newsletter im unabhängigen Review |
| Booking-Zielsuites | Create/Cancel/Reschedule Launch-off in API, Repository und UI gezielt grün und im 120/120-Remediation-Lauf enthalten |
| `npm run test:integration` | 15/15 bestanden |
| `npm run test:i18n` | 10/10 bestanden |
| `npm run test:company-profile-settings` | 7/7 bestanden |
| `npm run test:contact-access` | 4/4 bestanden |
| `npm run test:property-department` | 18/18 bestanden |
| `npm run security:production` | Exit 0 mit System-CA; 0 Vulnerabilities |
| `npm run build` | Exit 0 auf final revalidiertem Codezustand; 82 Seiten plus dynamische Routen |
| `git diff --check` | Exit 0 |
| `npm run release:verify-vercel-env` | lokal nicht ausführbar ohne `VERCEL_TOKEN`; separate read-only Vercel-Prüfung erfolgt |

### Lokaler Browser-/HTTP-Smoke

- DE/EN Homepage: korrekter Titel, H1 und `html lang`.
- Cookie-Dialog: Escape schließt; Fokus kehrt zum Trigger zurück.
- 320/375/390/430 px: kein horizontaler Überlauf; Dialog bei 320 px horizontal vollständig sichtbar.
- Missing Form: HTTP 404 und `noindex,nofollow`.
- Missing Booking und ungültiges Funnel-Token: lokalisierte/fail-closed 404.
- Unsicherer alter Unsubscribe-Link mit synthetischen Daten: neutraler Fehler, keine PII im DOM, keine Mutationsform.
- Browserkonsole: 0 Errors.
- Normalroute: nonce-basierte CSP mit `strict-dynamic` und `frame-ancestors 'none'`; Embedroute besitzt die beabsichtigte Framing-Ausnahme.

### Live/Vercel read-only

- Projekt: `novalure/novalure-crm`.
- Deployment: `dpl_4r6tWnAMRAPMpeBbhGegYzu5tu1C`, READY/Production.
- Baseline-SHA entsprach beim Prüfstart dem damaligen Main-/Live-Stand.
- 24-h-Baseline ohne Vercel-Error-Logs/5xx.
- Neon vorhanden; Resend nicht installiert.
- Keine produktive Änderung durchgeführt.

### Evidenzartefakte

- `docs/audit/2026-08-22/go-live-remediation-ledger.md`
- `docs/audit/2026-08-22/launch-scope-inventory.md`
- `docs/audit/2026-08-22/db-01-qa-reset-inventory.md`
- `scripts/schema-ledger-readonly-audit.mjs`
- `scripts/env-target-fingerprint-readonly.mjs`
- 20 neue, über `test:go-live-remediation` in `test:unit` eingebundene Suites; der finale aggregierte Lauf steht noch aus.

Kandidaten-Screenshots für Admin, echte Customer-Rolle und Mobile wurden nicht als Releaseevidenz erzeugt, weil kein getrenntes Preview und keine echten QA-Rollen existieren. Baseline-Screenshots aus dem ursprünglichen Live-QA bleiben historische Evidenz für SHA `77b751d…`, nicht für diesen Kandidaten.

**Entscheidung: NO-GO**

**Wichtigste 5 verbleibende Maßnahmen:**

1. Preview vollständig von Production bei Blob, Queue und Provider trennen und ENV-01 erneut bestehen.
2. Launch-Scope, Unternehmensprofil, Legal DE/EN, ES und KPI-Definitionen verbindlich signieren.
3. Backup/Restore/Rollback abschließen und Produktionsschema/Ledger kontrolliert auf den freigegebenen Stand bringen.
4. Zwei QA-Tenants samt Rollen, Batch-Reset, QA-Mailbox und QA-Kalender bereitstellen und die vollständige Matrix inklusive Cleanup ausführen.
5. Einen exakt gepinnten SHA-identischen Preview-/Production-Kandidaten deployen, vollständig abnehmen und 60 Minuten/24 Stunden/7 Tage beobachten, bevor eine separate Aliasfreigabe erfolgt.
