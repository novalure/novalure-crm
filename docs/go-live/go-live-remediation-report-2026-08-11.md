# Novalure CRM Go-live-Remediation – Abschlussbericht

Stand: 2026-08-11 (lokaler Umsetzungs- und Reteststand; Releaseentscheidung NO-GO)

## 1. Executive Summary und Entscheidung

**Entscheidung: NO-GO.**

Der getestete Arbeitsstand schließt bereits mehrere kritische Ursachen auf Code- und isolierter QA-Datenbankebene. Eine Produktionspromotion ist dennoch ausdrücklich gesperrt. Mindestens folgende GO-Gates fehlen noch:

- freigegebener RPO/RTO-Wert und erfolgreicher isolierter Restore-Nachweis;
- physische Migration logisch privater Legacy-Blobs in einen privaten Store einschließlich Hash-/Größenprüfung und Löschung alter öffentlicher Objekte;
- vollständige Tenant-Isolation mit RLS/Grants sowie Zwei-Workspace-Negativtests über UI, API und DB;
- bytegenaue Aufklärung der abweichenden lokalen/QA-Ledger-Checksum für Migration 049; bis dahin keine weitere automatische Migration;
- QA-Bestandsprüfung und Anwendung des zentralen Auth-/MFA-/Session-Schemas sowie freigegebene MFA-Recovery-/Secret-Rotation-Runbooks;
- dokumentierte Produkt-/Privacy-Entscheidung für risikobasierten Bot-Schutz und Double-opt-in der öffentlichen Flows;
- tatsächliche Preview-Abnahme des exakt zu promotenden Artefakts;
- vollständige Browser-, Mobile-, 200-/400-%-Zoom-, DE/EN- und Screenreader-Matrix;
- beide Kernabläufe mit synthetischen Daten und belegtem Cleanup;
- reale Zwei-Worker-/Crash-/Retry-/External-Effect-Chaostests auf einer disposable QA-Datenbank mit sicherem Provider-Sink;
- siebentägiges Cron-/Queue-SLO-Beobachtungsfenster;
- produktive Verifikation von Headern/CSP sowie genehmigtes HSTS-Subdomain-/Preload-Konzept;
- erzwungene Required Checks und vollständiger Secret-History-Scan.

„Build erfolgreich“ wird in diesem Bericht nicht als Nachweis eines funktionsfähigen Produktionssystems gewertet. Produktion blieb während der Umsetzung unverändert.

## 2. Ausgangs- und Zielstand

| Feld | Nachweisbarer Stand |
|---|---|
| Ausgangs-Commit | `680ee43cb803a92040ac62b5f759f1e457d731dc` |
| Ausgangsdeployment | Vercel Production, Status `READY`, Commit entspricht Ausgangs-Commit |
| Arbeitsbranch | `codex/go-live-remediation-2026-08-11` |
| Ziel-Commit/Tree | noch nicht erstellt; Worktree enthält bewusst uncommittete Remediation-Blöcke |
| Preview-/Build-ID | noch nicht erstellt |
| Baseline-Tree | `9bcabfc9b2065df4a75257fe4cec86cbbef65476` |
| Lockfile-Hash | SHA-256 `4396edb2d062e46893d06e4a11161d60a0c093f96df29bade2a8fa3a81ca2222` |
| Toolchain | lokal verifiziert: Node `v24.14.0`, npm `11.9.0`; Repository-Pin Node 24/npm `11.9.0` |
| Produktionsmigrationen | keine |
| QA-Migrationsstand | 048–055 und 064 im dynamischen Ledger erfasst; lokale Migration 049 (`ffd4be…`) stimmt nicht mit dem QA-Ledger (`174f9f…`) überein. 056 ausstehend, 060/061 gesperrt |
| QA-Katalog-Snapshot | read-only `2026-08-11T12:59:48.815Z`: 111 Public-Tabellen, 325 Public-Indizes, 1.829 Constraints, 16 Ledgerzeilen |
| QA-Medien-Snapshot | ein logisch privates `legacy-public`-Blob, 362.780 Byte; 0 aktive Share-Tokens; physische Migration weiterhin BLOCKED |

## 3. Geänderte Dateien nach Arbeitsblock

Der lokale Worktree umfasst 239 geänderte, neue oder gelöschte Einträge. Die vollständige Statusliste mit Legende und Zuordnung zu sieben Arbeitsblöcken steht im [Änderungsanhang](./changed-files-2026-08-11.md). Zusammenfassung:

- Webhook-Integrität: Webhook-Route, Omnichannel-/Runtime-Repositories, Security-Core, Migration 048, Security-Smokes.
- Property-/Tenant-Grenzen: Session-/Workspace-Auflösung, Property-/Unit-/Reservation-Repositories und -Routen, Migrationen 049/052, RBAC-/Property-Smokes.
- Durable Jobs: Cron-Routen, Queue-Core, Provider-Repositories, Migration 050, Queue-/Cron-Smokes.
- Private Medien: Media-Store/-Security, private/öffentliche Asset-Routen, sichere Serializer, Migration 051, Media-Smokes.
- OAuth/CSRF/Public Abuse: zentrale Security-Cores, Client-Wrapper, Route-Inventar, Migrationen 053–055, Migrations- und Concurrency-Tests.
- Scope/RBAC: CRM-Scope-Core, Workspace-Client, fünf Kerndrafts, Admin-Capabilities und Membership-Projektion.
- Admin/UX: getrennte Admin-Panels und Audit-API, Design-Tokens/Figtree/UI-Primitives, Unit-States, Kalender-A11y, lokalisierte Public Metadata.
- Toolchain/CI/Hygiene: gepinnte Runtime, Dependency-Updates, QA-Zielguard, Secret-Scan-Workflow, entfernte Log-Artefakte.

## 4. Datenbankmigrationen

| Migration | Zweck | QA | Produktion | Evidenz/Anmerkung |
|---|---|---:|---:|---|
| 048 | Bot-Webhook-Integrität | angewandt/ledgered | nein | SHA-256 `62e71151710c6fc3e1193354efd393d4bb912d12290c79c1f2f0bccad58662ef`; Ledger `2026-08-11T11:33:12.228Z` |
| 049 | Property-Tenant-Guards | **Checksum-Konflikt** | nein | Ledger `2026-08-11T11:33:12.228Z`; QA-Katalog entspricht semantisch den erwarteten Keys/FKs, aber lokale SHA-256 `ffd4be362a4a25a324067c0621a3de8438d0da97d02acf41159b6e8f7eed942b` weicht vom QA-Ledger `174f9fa7a82faec8d92eab581c0ca87a3cce7042198279bcf5628f93dd9987eb` ab; kein Ledger-Überschreiben, weiterer Runner-Lauf gesperrt |
| 050 | Durable Job Leasing | angewandt/ledgered | nein | SHA-256 `62dc4b16f770aadeb5e4557a90fe34d93d62e859494aed806d8e7a9d742f4439`; Ledger `2026-08-11T11:33:12.228Z` |
| 051 | Private Media Access | angewandt; Ledger-Legacyalias `051` | nein | SHA-256 `77899955ebf0cac1a0455c21736ddc5e4580072e7150c23fc1121b3cbef4be1a`; Ledger `2026-08-11T11:53:33.597Z`; physische Blob-Migration weiterhin offen |
| 052 | Property-Constraint-Validierung | angewandt; Ledger-Legacyalias `052` | nein | SHA-256 `a8f10a4f62e10da8e4c099383decc3805520a1d755e1c8c2a2994f297aeb0233`; Ledger `2026-08-11T11:52:39.189Z`; QA-Constraints validiert |
| 053 | OAuth-State-Integrität | angewandt; Ledger-Legacyalias `053` | nein | SHA-256 `c78f509d09ddb6ff8f6d445e60c2d06e0620c578f1e7a1995c5f8b189d881b28`; Ledger `2026-08-11T11:52:39.189Z` |
| 054 | CSRF-Token-Integrität | angewandt/ledgered | nein | SHA-256 `d6cba6c9cd616c4b4a52ecc3b251f412150d479cefcd2fc71abd90de99ae5504`; Ledger `2026-08-11T12:01:53.000Z`; paralleler Consume: exakt ein Erfolg, Testdaten entfernt |
| 055 | Public-Submission-Abuse | angewandt/ledgered | nein | SHA-256 `f0ddb2b3103ba7d6d70b5a41883f768831b1cffc3fc8d689254aa408ca0ac358`; Ledger `2026-08-11T12:12:47.968Z`; atomare Rate-/Idempotency-Claims, Testdaten entfernt |
| 056 | Zentrale Auth-Identität/Session/MFA | code-seitig fertig/ausstehend | nein | SHA-256 `c800138de381b48cee87b2df2a4f96b69e4e35446ed364cc622dc31544d5efdf`; wegen 049-Gate nicht angewandt |
| 060 | Tenant-RLS-Pilot vorbereiten | nicht angewandt | nein | SHA-256 `7731bf4929b0b7cd907b658601f12a7a820203b95a5d6fd193704ec836ec4d0e`; QA-Bestand 0 Nullwerte/0 Mismatches, Rollen-/Repository-Cutover fehlt |
| 061 | Tenant-RLS-Pilot validieren/aktivieren | nicht angewandt | nein | SHA-256 `6f4a8735b3ef7505b8178addd93a3f6bf1b63ae3b560eac8e4151778f299a3f3`; Cutover ausdrücklich gesperrt |
| 064 | Provider-Job-/Assignee-Integrität | angewandt/ledgered | nein | SHA-256 `7a3ef7adaf8318003a75ac0ef6c7960846ba3d30484a098991feaf2a62907f67`; Ledger `2026-08-11T12:42:44.513Z`; 8 Google + 10 Teams sicher `pending_config`, 0 queued/retry/locked; drei Negativtrigger grün, operative Zuordnung offen |

Der bestehende Ledger enthält keine belastbaren Laufzeit-/Lockmetriken; die identischen Zeitstempel mehrerer Zeilen belegen nur den Ledger-Commit, nicht die Dauer einzelner DDLs. Diese Werte werden deshalb als nicht erhoben statt geschätzt ausgewiesen. Die numerischen 051–053-Legacyeinträge besitzen exakt passende Checksums; der Runner akzeptiert solche Aliase nur bei eindeutiger Nummer und bytegleicher Checksum. Der 049-Konflikt wird nicht durch Umschreiben des Ledgers kaschiert: 40.960 plausible Varianten sowie Git-/Workspace-/Temp-Artefakte lieferten keinen bytegenauen Treffer. Erforderlich ist die Wiederbeschaffung der tatsächlich angewandten Datei aus einem ursprünglichen CI-/Deploymentartefakt oder Backup. Keine Datenmigration wird für Produktion freigegeben, solange dieser Konflikt und der Restore-Nachweis offen sind.

## 5. Recovery

| Gate | Status |
|---|---|
| freigegebenes RPO/RTO | BLOCKED |
| Backup-/PITR-Inventar | teilweise read-only inventarisiert |
| isolierter Restorepunkt und -zeitpunkt | BLOCKED |
| gemessene Restoredauer | BLOCKED |
| Integritätsprüfung nach Restore | BLOCKED |
| nächster Test | nach Infrastrukturfreigabe auf disposable Branch; vor jeder riskanten Produktionsmigration |

## 6. Defect-Matrix (Arbeitsstand)

`PASS/RETESTED` wird nur verwendet, wenn die für den jeweiligen Befund bereits vorliegende Evidenz den Abschlussnachweis trägt. Übergreifende GO-Gates bleiben unabhängig davon NO-GO.

| Defect | Ursache/Umsetzung | Test/Evidenz | Status |
|---|---|---|---|
| P1-01 | Durable Queue statt request-gekoppelter Cron-Verarbeitung | Lease/Fence/Retry/DLQ-Smokes; 7-Tage-SLO fehlt | BLOCKED |
| P1-02 | Recovery-Ausgangslage ohne Restore-Beleg | kein zulässiger Restore-Nachweis vorhanden | BLOCKED |
| P1-03 | Drafts verwendeten erstes Projekt bzw. unklaren Scope; aktive Scopebindung ergänzt | Scope-Smokes grün; vollständiger QA-Kernflow offen | BLOCKED |
| P1-04 | Scope war nur lokaler State; URL-/Preference-/History-Persistenz ergänzt | Source-/State-Smokes grün; Browsermatrix offen | BLOCKED |
| P1-05 | fehlende Capabilities und falsche Zielsession; Membership-Reprojektion, exakte Capability-Matrix und atomarer Session-Revoke bei aktiver Rollen-/Statusänderung ergänzt | RBAC-/Auth-Smokes grün; vollständige UI/API-Rollen- und Zielworkspace-Negativmatrix offen | BLOCKED |
| P1-06 | unsichere Webhook-Probe/Mapping/Replay-Pfade; Raw-HMAC und atomare Claims | Helper-/Source-/Integration-Smokes grün; reale Route-/QA-DB-Matrix für falsch signiert, unbekannt, gültig genau einmal und Replay ohne Nebenwirkungen fehlt | BLOCKED |
| P1-07 | private Assets lagen im öffentlichen Store; interne Streaming-Routen und Share-Tokens ergänzt. Bot-Versand nutzt stabile Idempotenz, 5-Minuten-Attempt-Share, versuchsgenauen Revoke und verlängert dieselbe Share-ID erst nach `sent` auf 24 Stunden | 6 Lifecycle- + Media-Smokes grün; ein 362.780-Byte-Legacy-Raw-Blob bleibt physisch öffentlich, Private-Store-/Bestandsmigration nicht ausgeführt | BLOCKED |
| P2-01 | Tenant-Grenzen nicht durchgängig DB-seitig erzwungen; sicherer Tenant-TX-Core und 5-Tabellen-RLS-Pilot vorbereitet | 9/9 Core-/Schema-Smokes; 060/061 bewusst nicht angewandt, breite Negativmatrix offen | BLOCKED |
| P2-02 | Property-/Unit-Schreibpfade validierten Eltern nicht atomar im Zielworkspace; Kontakt-Nullzustand zeigte zusätzlich einen synthetischen Datensatz | QA-Constraints/Property-Smokes und 4 Kontakt-Nullzustandsregressionen grün; zusammenhängender Browserflow fehlt | BLOCKED |
| P2-03 | öffentliche Submissions ohne verteilte Abuse-/Idempotency-Gates; Proof/Honeypot/Rate/Idempotenz ergänzt | technische QA-Concurrency und Parser-Smokes grün; Bot-Risiko-/CAPTCHA-Äquivalent, Double-opt-in und Provider-Fehlerflows ungeklärt | BLOCKED |
| P2-04 | fragmentierte Identität, Session und Limiter; zentraler Auth-/MFA-/Hash-only-Session-Core, progressive DB-Limiter und atomarer Session-Revoke ergänzt; Reset-Token läuft als URL-Fragment und wird vor Folgerequests aus der History entfernt | 18 Auth-Securitytests grün; 056 nicht angewandt, MFA-Recovery/Secret-Rotation und Safe-Link-Kompatibilität im Staging offen | BLOCKED |
| P2-05 | Cookie-Mutationen ohne zentralen CSRF-/Origin-Guard; zentraler Token-/Origin-Core und Client-Wrapper ergänzt | QA one-time concurrency grün; Logout und Session-GET gehärtet. Vier dokumentierte mutierende Cron-GET-Ausnahmen, alte manuelle QA-Clients und vollständige Laufzeit-Negativmatrix bleiben offen | BLOCKED |
| P2-06 | OAuth-State ohne dedizierten, einmaligen DB-State/PKCE; State-/PKCE-Core und 053 ergänzt | Helper-/Source-Smokes grün; echter atomarer DB-Replay/paralleler Callback mit genau einem Tokenaustausch fehlt | BLOCKED |
| P2-07 | uneinheitliche Return-/Redirect-Prüfung; zentraler Validator/fail-closed Allowlist | 8 Redirect-Angriffsvektoren grün | PASS/RETESTED |
| P2-08 | veraltete Laufzeit-/Produktionsabhängigkeiten; Runtime/Lockfile aktualisiert und gepinnt | erfolgreicher Lockfile-Install, Production Audit 0 Vulnerabilities, Lint/Typecheck, 211 Unit, 12 Integration, Next-16.3.0-Production-Build mit 79/79 Seiten und CycloneDX-SBOM | PASS/RETESTED |
| P2-09 | Header/CSP/Frame-Regeln unvollständig | Source-Smokes; produktive/Browser-Verifikation offen | BLOCKED |
| P2-10 | Infrastruktur-MFA/Netz/Pool/Compute/Credentials nicht vollständig freigegeben | Owner-/Providerentscheidung fehlt | BLOCKED |
| P2-11 | Provider-Ziele waren nicht vollständig gebunden und Qualifizieren erlaubte unklare Assignees; zentraler Readiness-/Reconcile-Core und Server-/UI-Gates ergänzt | 6/6 neue + 23 bestehende Smokes; 8 Google-, 10 Teams-Jobs und 1 Lead operativ unzugeordnet | BLOCKED |
| P2-12 | CI-/Runtime-Gleichheit nicht vollständig erzwungen | QA-Zielguard und read-only Dry-run ergänzt; Secrets nun erst nach `npm ci` schrittbezogen, Actions SHA-gepinnt und `novalure-qa` referenziert. Geschütztes Environment/Required Checks, zwei Kernflows, Browser/A11y und Preview fehlen | BLOCKED |
| P2-13 | Tenant-Indizes/Audit/Ledger lückenhaft; Pilot-FKs/-Indizes, append-only Audit-Guard und dynamisches Inventar ergänzt | QA-Katalog/Null-/Mismatch-Inventar liegt vor; 288 FK-/26 Index-Kandidaten und 0 Tenant-TX-Callsites verhindern Cutover | BLOCKED |
| P2-14 | fehlendes verteiltes Leasing/Retry/DLQ; Lease/Fence/Backoff/DLQ-Code ergänzt | Source-/Pure-Smokes grün; echte Zwei-Worker-/Crash-/429-/500-/External-Effect-Chaostests fehlen | BLOCKED |
| P3-01 | drei Admin-Entries kollabierten auf generische Views/Hashes; getrennte Panels/Hashes/Rollengates sowie bereichsspezifischer Title/semantischer Breadcrumb ergänzt | 5 Source-Smokes grün; echter Direktlink-/Reload-/Back-/Forward-Browserlauf fehlt | BLOCKED |
| P3-02 | statischer Betrag und vergangenes Abschlussdatum entfernt; Wert-/Datumsvalidierung ergänzt | Grenzwert-/Datums-Smokes grün; ausführende Negativmatrix für fehlenden Kontakt, Projekt/Scope, Pipeline und historische Importautorisierung fehlt | BLOCKED |
| P3-03 | rohe Projektarten und gemischte Darstellungstexte | Key-Parität/Projektart-Smokes; vollständiger Browserlauf offen | BLOCKED |
| P3-04 | Locale/Timezone nicht aus tatsächlicher Workspacekonfiguration | Produkt-/Schemaquelle fehlt; nicht geraten | BLOCKED |
| P3-05 | namenloses Booking-Output, fünf implizite Selects, leere Heading-/Dialogrisiken | 5 Source-Smokes + Lint; Screenreader-/Keyboard-Browserlauf offen | BLOCKED |
| P3-06 | kleine Ziele/globales Clipping | Unit-Aktionen/Primitives verbessert; vollständige Zoommatrix offen | BLOCKED |
| P3-07 | Unit-Empty-State vermischte Loading/Error/Filter/Forbidden | Unit-Smokes grün; übrige Tabellen noch nicht vollständig | BLOCKED |
| P3-08 | Auth-Autocomplete/Titles/Keyboard inkonsistent; Autocomplete, SubmitOnce, persistierte Body-/Metadata-Sprache und sichere Response-Header ergänzt | Source-/Auth-Smokes grün; Passwortmanager-, Tab/Back-, Keyboard- und DE/EN-Browserabnahme offen | BLOCKED |
| P4-01 | HSTS/Domainumfang nicht freigegeben | `x-powered-by` entfernt; Subdomain-/Preload-Gate offen | BLOCKED |
| P4-02 | getrackte Logs/hartcodierte Infra-Ziele/fehlender History-Scan | Logs entfernt, 19 Skripte fail-closed, Workflow/Secret-Scan ergänzt, Actions SHA-gepinnt und QA-Secrets schrittbezogen; geschütztes Environment, Gitleaks-Lizenz/Historylauf und Required Check extern offen | BLOCKED |

Damit sind im aktuellen Evidenzstand P2-07 und P2-08 `PASS/RETESTED`; 29 von 31 Defects bleiben `BLOCKED`. Diese Zählung ist bewusst strenger als ein reiner Code-Fertigstellungsstand und folgt den ausführenden Akzeptanzkriterien des Umsetzungsprompts.

## 7. Rollen-/Capability-Matrix

Legende: `AR` analytics:read, `BP` bots:publish, `CM` calendar:manage, `CAM` customer-access:manage, `CAR` customer-access:read, `FP` funnels:publish, `GW` growth-workspace:operate, `KW` knowledge:write, `MS` managed-service:operate, `NS` newsletter:send, `NI` novalure:internal, `PW` pipeline:write, `RW` reservations:write, `SM` settings:manage, `WA` workspace:admin, `WO` workspace:operate, `WR` workspace:read.

| Productrolle | technische Rolle | Soll = Ist im zentralen Produktmodell |
|---|---|---|
| `platform_admin` | owner | AR, BP, CM, CAM, CAR, FP, KW, MS, NS, NI, PW, RW, SM, WA, WO, WR |
| `novalureGrowth` | agent | AR, CM, FP, GW, KW, NS, PW, WO, WR |
| `novalureServiceOps` | admin | AR, CM, CAR, KW, MS, NI, WO, WR |
| `novalureAdmin` | owner | AR, BP, CM, CAM, CAR, FP, KW, MS, NS, NI, PW, RW, SM, WA, WO, WR |
| `novalure_sales` | agent | AR, CM, CAR, FP, MS, NI, PW, WO, WR |
| `novalure_onboarding` | admin | AR, BP, CM, CAM, CAR, FP, KW, MS, NI, PW, SM, WA, WO, WR |
| `novalure_customer_success` | admin | AR, CM, CAM, CAR, MS, NI, PW, SM, WO, WR |
| `novalure_operator` | agent | AR, CM, MS, NI, PW, RW, WO, WR |
| `customer_owner` | owner | AR, BP, CM, FP, KW, NS, PW, RW, SM, WA, WO, WR |
| `workspace_admin` | admin | AR, BP, CM, FP, KW, NS, PW, RW, SM, WA, WO, WR |
| `team_member` | agent | AR, CM, FP, PW, WO, WR |
| `broker_agent` | agent | AR, CM, FP, NS, PW, WO, WR |
| `developer_sales` | agent | AR, CM, PW, RW, WO, WR |
| `project_sales_member` | agent | AR, CM, PW, RW, WO, WR |
| `assistant_backoffice` | assistant | AR, CM, PW, WO, WR |
| `external_partner` | assistant | AR, WR |
| `viewer` | assistant | AR, WR |

Die fünf explizit geforderten `novalureAdmin`-Capabilities `PW`, `RW`, `CM`, `NS` und `FP` sind enthalten. Der Session-Core leitet technische Rolle, Permissions und Product-Capabilities nach jedem Zielworkspace-Wechsel neu aus der aktiven Zielmembership ab; aktive Rollen-/Produktrollen-/Statusänderungen widerrufen Sessions atomar. Die statische Matrix und gezielte RBAC-Smokes sind grün, die vollständige ausführende Soll-/Ist-Matrix über UI und API für jede Rolle bleibt jedoch ein Release-Gate.

## 8. Tenant-Isolation

- Property-/Unit-/Reservation-Pilot: Zielworkspace-Session, atomare Parent-Prüfung, tenant-qualifizierter Upsert und validierte Composite-FKs in QA.
- Managed Workspace: aktive Zielmembership erforderlich; Zielidentität/-rolle/-capabilities werden neu projiziert; Auditfehler blockieren.
- Der read-only QA-Katalognachweis zeigt für `projects`, `contacts`, `leads`, `deals` und `audit_logs` jeweils 0 Zeilen mit leerem Workspace; alle 15 für 060 vorgesehenen Tenant-Beziehungen haben 0 Workspace-Mismatches.
- Auf allen fünf Pilot-Tabellen sind RLS und FORCE RLS aus; `novalure_tenant_app` existiert nicht. Der neue Tenant-TX-Helfer hat noch keine Repository-Callsites. 060/061 bleiben deshalb bis zu Rollen-, Ownership- und vollständigen Repository-Cutover-Nachweisen unapplied.
- Das statische Inventar klassifiziert 288 tenantrelevante FK- und 26 workspace-leading Index-Kandidaten zur Review; dies sind keine ohne Liveprüfung behaupteten Datenlecks.
- Vollständige UI/API/DB-Zwei-Workspace-Matrix und breiter RLS-/Grant-Rollout: **BLOCKED**.

## 9. Queue/Cron und SLO

Read-only QA-Snapshot vom 11.08.2026:

| Queue | Status | Anzahl | ältester Datensatz | max. Versuche |
|---|---:|---:|---|---:|
| Google Notifications | `pending_config` | 8 | `2026-05-21T13:45:03.386Z` | 0 |
| Teams Notifications | `pending_config` | 10 | `2026-05-21T13:30:20.508Z` | 0 |
| Meeting Notifications | `sent` | 19 | `2026-05-14T11:37:35.248Z` | 1 |
| Meeting Notifications | `failed` | 3 | `2026-05-15T17:49:43.347Z` | 1 |
| Meeting Notifications | `cancelled` | 10 | `2026-05-15T17:49:43.448Z` | 0 |

Google/Teams sind bewusst non-retrying `pending_config`; es wurde kein Providerziel geraten oder ausgelöst. Leasing, Fence Token, Retry, Backoff, DLQ und Idempotenz sind in Code/Schema sowie Source-/Pure-Smokes umgesetzt. Echte Zwei-Worker-, Lease-Ablauf-, Crash-vor/nach-Send-, 429-/500- und idempotente External-Effect-Tests fehlen ebenso wie das verbindliche siebentägige Beobachtungsfenster; P1-01/P2-14 bleiben BLOCKED.

## 10. Securitytests

Bereits mit gezielten Helper-/Source-/Pure-Tests abgedeckt: Webhook-HMAC/Mapping/Replay, private Media-Serializer und Bot-Share-Lifecycle, CSRF/Origin/one-time consume, OAuth State/PKCE, Redirect-Angriffsvektoren, Auth/MFA-Core, technische Public-Submission-Rate-/Idempotency-Gates, Production Dependency Audit und grundlegende Header-Regeln. Diese Tests werden nicht als Ersatz für die geforderten Route-/DB-/Provider-Negativmatrizen gewertet. Risikobasierter Bot-Schutz/Double-opt-in, physische Blob-Migration, produktive Header-Verifikation und vollständige Tenant-Isolation bleiben offen.

## 11. Designsystem

Zentrale Figtree-Variable, Novalure-Tokens und native React-19-Primitives für Buttons/Felder/Surfaces/States sind additiv eingeführt. Legacy-Palette, globale Utility-Overrides und alle Module sind noch nicht vollständig migriert; visuelle Regression und Design-Baseline E fehlen.

## 12. DE/EN, Responsive und Accessibility

Projektarten werden an der Anzeigegrenze lokalisiert. Öffentliche Rechts-/Statusseiten erzeugen serverseitig lokalisierte Metadata. Die fünf sichtbaren Kalender-Selects und das Booking-Output besitzen stabile sichtbare Labels; Statusmeldungen sind Live-Regions; Dialoge sind benannt, per Escape verlassbar, fokusbegrenzt und geben Fokus zurück. Die vollständige Browser-/Screenreader-/Zoommatrix steht aus.

## 13. Kernabläufe

Der vorhandene QA-Job prüft eine CRM-API-Regression (Kontakte/Deals/Pipeline plus Workspace-Negativfälle), aber nicht die zwei vorgeschriebenen vollständigen Abläufe. Weder Lead→aktive Zuweisung→Aufgabe→Termin→Abschluss noch Objekt→Gebäude/Einheit→Reservierung→Freigabe sind als zusammenhängender Browser→API→DB→Response-Nachweis mit maskierten IDs und Cleanup abgeschlossen. Ein Browser-/A11y-Job fehlt ebenfalls. **BLOCKED**.

## 14. CI-/Buildresultate

| Befehl | Exit | Passed | Failed | Skipped | Ergebnis/Anmerkung |
|---|---:|---:|---:|---:|---|
| `npm ci` | 254 | – | 1 | 0 | erster Sandboxlauf scheiterte ausschließlich am nicht beschreibbaren Defaultcache `/root/.npm`; kein Lockfile-/Quellcodefehler |
| `npm ci --cache /tmp/novalure-npm-cache-20260811` | 0 | 418 Pakete installiert | 0 | 0 | sauberer Lockfile-Install mit frischem beschreibbarem Cache |
| `npm run ci:toolchain` | 0 | 1 | 0 | 0 | Node 24.14.0, npm 11.9.0 |
| `npm run lint` | 0 | 1 | 0 | 0 | ESLint mit `--max-warnings=0` |
| `npm run typecheck` | 0 | 1 | 0 | 0 | `tsc --noEmit` |
| `npm run test:unit` | 0 | 211 | 0 | 0 | alle 37 Unit-/Smoke-Dateien inklusive Auth, CSRF, Alias- und Bot-Lifecycle-Gates |
| `npm run test:integration` | 0 | 12 | 0 | 0 | registrierter Security-/Scope-Integrationsblock |
| `npm run build` | 0 | 79 Seiten | 0 | 0 | Next.js 16.3.0 Production-Build, TypeScript eingeschlossen |
| `npm run security:production` | 0 | 0 Vulnerabilities | 0 | 0 | Production-Audit ab `moderate` |
| `npm sbom --omit=dev --sbom-format=cyclonedx` | 0 | 75 Komponenten | 0 | 0 | CycloneDX 1.5; lokale Artefakt-SHA-256 `be9118ae3f31df60ddf68d3ed93846b1ef498400318da25473d39eb14d37a140` |
| `git diff --check` | 0 | 1 | 0 | 0 | keine Whitespace-Fehler |
| lokaler `agent-browser`-Direktlink-/Historylauf | 1 | 0 | 1 | 0 | Browser-CLI verfügbar, aber kein Chromium-Binary; Download im erlaubten Netzwerkraum nicht möglich. Keine Ersetzung durch Source-Smoke, Browser-Gates bleiben BLOCKED |

Alle 38 vorhandenen `node:test`-Dateien sind in `test:unit` oder `test:integration` registriert. Der erfolgreiche Build und die grünen Codegates ändern die NO-GO-Entscheidung nicht: QA-Migrationschecksum, Restore, echte Route-/DB-/Provider-Negativtests, Kernflows, Browser/A11y und SLO fehlen weiterhin.

## 15. Produktion, Monitoring und Restrisiken

Keine Produktionsmigration, kein Provider-Live-Test, keine Produktionspromotion und keine Massenmutation wurden durchgeführt. Offene P1-/GO-Gates sind oben aufgeführt. Ein Preview darf erst nach vollständigem Gate-Lauf erzeugt und nur exakt dieses Artefakt nach Freigabe promotet werden.

## 16. Rollback und Recovery

Vorgesehene kompatible Baselines: A Webhook/Security, B private Media, C Scope/RBAC, D Queue-Schema, E Design/P3. Nach einer Media- oder Queue-Bestandsmigration darf nicht auf Code vor der jeweiligen kompatiblen Baseline zurückgerollt werden. Konkrete Recovery-Anweisung bleibt bis zum isolierten Restore-Test **BLOCKED**.
