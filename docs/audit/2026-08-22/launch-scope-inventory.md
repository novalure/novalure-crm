# LB-04 — Launch-Scope-Inventur

Stand: 22.08.2026<br>
Inventur-Basis-SHA: `77b751d6568487193e9151c7b16545649cfacde7`; lokale Remediation-Abschluss-SHA wird nach dem Dokument-Freeze im Handoff ausgewiesen<br>
Branch: `codex/go-live-remediation-20260822`
Artefaktstatus: **Evidenzbasierte Inventur; keine freigegebene Launch-Scope-Matrix**

## 1. Ergebnis und Entscheidungsgrenze

Im Repository liegt keine von Product, Engineering, Security und Operations freigegebene, versionierte Entscheidung vor, die eine Funktion verbindlich als `LAUNCH-ON`, `LAUNCH-OFF` oder `INTERNAL-ONLY` einstuft. Deshalb erhält jede inventarisierte Produktfläche den Status:

`PENDING PRODUCT DECISION`

Dieser Status ist ausdrücklich **kein vierter zulässiger Launchzustand**. Er bezeichnet einen offenen Releaseblocker. Die Inventur nimmt keine Produktentscheidung vor. Die im Kandidaten aus Sicherheitsgründen technisch fail-closed gesetzten Flächen – Funnel-Webhook, Import, Newsletter-Send, öffentliche Booking-Erstellung/-Stornierung/-Umbuchung sowie Public-Form-File/RoundRobin/Custom-Pattern/unsichere-Consent-Modi – werden als belegte Engineering-Grenzen dokumentiert, ersetzen aber keine signierte Product-Entscheidung.

Die heute vorhandene technische Ebene besteht aus:

- technischen Rollen und Permissions in `src/lib/auth/permissions.ts`;
- Produktrollen und Capabilities in `src/lib/product-model.ts`;
- workspacegebundenen Sessions in `src/lib/auth/session.ts`;
- clientseitiger Navigation und Modulsichtbarkeit in `src/components/crm-workspace.tsx`;
- funktionsspezifischen Public-Resolvern, Tokens, Signaturen, Provider-Readiness- und Kill-Switch-Prüfungen.

Es existiert jedoch keine einheitliche serverseitige Launch-Scope-Policy, die UI, Direkt-URL, API, Cron und Provider-Side-Effect gemeinsam erzwingt.

## 2. Owner der noch ausstehenden Matrix

| Verantwortung | Verbindlicher Beitrag |
|---|---|
| Product | pro Zeile genau `LAUNCH-ON`, `LAUNCH-OFF` oder `INTERNAL-ONLY`; Launchsprachen; sichtbare Bezeichnung; zulässige Fallback-Semantik |
| Engineering | denselben Zustand in Navigation, Quick Actions, Direkt-URL, API, Cron, Queue und Provideradapter serverseitig erzwingen |
| Security | Rollen-/Tenant-Negativtests, Direct-URL/API-Negativtests, Public-Token-/Webhook-/CSRF-Prüfung |
| Operations | Env-/Providerziele, Kill Switches, QA-Sinks, Queue-/Cron-Betrieb, Rollback und Monitoring freigeben |

## 3. Inventurmethodik

Die Inventur war rein read-only gegenüber Live-System, Datenbank und Providern. Es wurden keine Live-Requests, DB-Writes, Provideraktionen, Env-Änderungen oder Deployments ausgeführt.

Statisch geprüft wurden:

1. alle 16 Navigationsprofile, 51 Navigationseinträge und 15 Quick Actions aus `src/components/crm-workspace.tsx`;
2. die Rollen-/Capability-Matrix und Workspace-Modulkonfiguration aus `src/lib/auth/permissions.ts` und `src/lib/product-model.ts`;
3. alle 19 echten App-Page-Routen und vier Route Handler außerhalb `/api` unter `src/app` (einschließlich des neuen read-only-GET/confirm-POST-Unsubscribe-Flows);
4. alle 83 API-Route-Dateien unter `src/app/api` einschließlich Auth-, Public-, Cron-, Admin- und Providerpfaden;
5. Provideradapter und Side-Effect-Code unter `src/lib/integrations`, `src/lib/bots`, `src/lib/db/*notification*`, `src/lib/media-store.ts` und `src/lib/notifications`;
6. relevante statische Regressionsevidenz in `scripts/navigation-profile-invariant-tests.mjs`, `scripts/admin-navigation-smoke-tests.mjs`, `scripts/phase3-rbac-smoke-tests.mjs`, `scripts/tenant-hardening-smoke-tests.mjs`, `scripts/security-headers-smoke-tests.mjs`, `scripts/forms-knowledge-production-truth-tests.mjs`, `scripts/funnel-production-boundary-tests.mjs` und `scripts/email-production-boundary-tests.mjs`.

Verwendete read-only Suchmuster:

```text
rg --files src/app src/components src/lib
rg -n "navigation|quickAction|enabledModules|requirePermission|resolveWorkspaceScopedSession|hasProductCapability"
rg -n "RESEND|MICROSOFT|GOOGLE|META_|AI_GATEWAY|OPENAI|webhook|BLOB|fetch\("
```

Wichtig: Vorhandene Unit-/Static-Tests sind Prüfevidenz für einzelne Contracts, aber kein Ersatz für die noch fehlende Scope-Entscheidung und die Direct-URL/API-Negativmatrix.

## 4. Systemische harte Restlücken

| ID | Harte Restlücke | Evidenz | Erforderlicher Abschluss |
|---|---|---|---|
| LS-01 | Kein zentraler serverseitiger Launch-Scope-Guard | Kein gemeinsamer Launch-State in `src/lib`; keine API-Route prüft einen solchen State | versionierte Policy plus serverseitiger Guard für Page/API/Cron/Queue/Provider |
| LS-02 | `enabledModules` ist primär UI-Sichtbarkeit | `getWorkspaceEnabledModules()` liefert standardmäßig alle Module `true`; `crm-workspace.tsx` filtert Navigation; API-Routen prüfen diese Konfiguration nicht | API-/Page-Guard aus derselben Policy; Negativtests |
| LS-03 | Properties/Objects/Units/Reservations/Project Overview lassen sich über die vorhandene Modulkonfiguration nicht abschalten | `alwaysVisiblePropertyModuleKeys` setzt fünf Module immer auf `true` | expliziter Launch-State außerhalb der Workspace-Komfortkonfiguration |
| LS-04 | Forms und Funnels sind nicht separat steuerbar | `moduleBySection.forms = "funnels"` | eigenständiger serverseitiger Forms-State |
| LS-05 | **Im Kandidaten geschlossen:** System-&-Releases-UI und Diagnose-API hatten unterschiedliche Rollenregeln | `/api/system/database` akzeptiert nun nur `platform_admin`/`novalureAdmin`; Negativcontract vorhanden | Product muss die Surface noch formal `INTERNAL-ONLY` klassifizieren; Gesamt-Scope-Guard fehlt |
| LS-06 | **Im Kandidaten geschlossen:** Persistierte Funnel-Blueprints waren öffentlich überreich/ungeschützt | Testpreview ist authentifiziert/tenantgebunden; Live verlangt active+persisted+Token. Browser erhält nur Deep-Allowlist-DTO und Public Proof, Live-Response keine internen IDs | bislang veröffentlichten Publish-Token extern rotieren; Product-Einstufung und deploytes E2E fehlen |
| LS-07 | **Im Kandidaten geschlossen:** Newsletter-Abmeldung mutierte über öffentlichen GET mit PII-Parametern | GET read-only; opaker AES-GCM-Fragmenttoken; expliziter Same-Origin-POST; atomare Suppression/Consent-Aktualisierung | Product-/Ops-Freigabe und echter QA-Mailflow fehlen |
| LS-08 | **Technisch im Kandidaten Launch-off:** sichtbare Importaktion ohne Importvertrag | Desktop/Mobile/Quick Action verborgen, Handler fail-closed; kein Server-Importendpunkt vorhanden | signierte Product-Entscheidung und zentraler Scope-State fehlen |
| LS-09 | **Technisch im Kandidaten Launch-off:** Funnel-Webhook ohne Zustellung | UI/API/Persistenz/Adapter entfernen bzw. verweigern Webhookkonfiguration; Submission meldet fest `launch_off`; keine Zustellung | Product-Entscheidung; vor späterem ON durable Queue, SSRF-/Allowlist-Schutz, Retry/Audit/Monitoring/E2E |
| LS-10 | **Im Kandidaten geschlossen:** Governance zeigte statische Evidenzaussagen | statische „QA-verifiziert“-Aussagen entfernt; offene Evidenz amber | evidenzgebundene Runtimequelle und Product-Einstufung fehlen |
| LS-11 | Globale Headeraktionen „Import“ und „Neues Projekt“ sind rollen-/modulunabhängig sichtbar | beide Buttons werden in Desktop und Mobile stets gerendert; Projekt-API verweigert später serverseitig | UI aus derselben Capability-/Scope-Policy ableiten; negative Direktaufrufe behalten |
| LS-12 | Kein zentraler Abschalter für alle Flächen; **Kandidaten-Teilschluss** für Webhook, Import, Newsletter-Send, öffentliche Booking-Writes und nicht tragfähige Public-Form-Modi | funktionslokale Launch-off-Grenzen greifen in UI/API/Page/Embed, bei Booking und Forms zusätzlich im Repository/Admin-Save; übrige Flächen und gemeinsamer State fehlen | zentrale versionierte Enforcement-Policy für alle OFF-/INTERNAL-Surfaces |
| LS-13 | KI-Chat darf weiterhin grounded fallbacken; **Knowledge-Teil im Kandidaten geschlossen** | approved Knowledge-Import und semantische Suche verlangen externen Provider und liefern bei Fallback/Timeout 503; Chat-Semantik bleibt separat | Product-Semantik für Bot-Chat/Fallback und Providerziel festlegen |
| LS-14 | Visual-QA-Guard ist auf einen alten Branchnamen fest codiert | `visual-qa/crm/preview-guard.ts` nennt `codex/go-live-remediation-2026-08-11` | internes, authentisiertes und versionsgebundenes QA-Gate oder Route entfernen |

Solange LS-01 nicht geschlossen ist, ist `SCOPE-01` nicht bestanden.

## 5. Verbindlich zu entscheidende Produktflächen

Für alle folgenden Zeilen gilt aktuell `PENDING PRODUCT DECISION`.

| Produktfläche | Sichtbare UI / URL | Relevante APIs | Aktueller serverseitiger Schutz | Prüfevidenz | Harte Restlücke |
|---|---|---|---|---|---|
| Dashboard und Daily Queue | `#dashboard`, `#daily-queue` | `/api/crm/core`, `/api/crm/dashboard-views`, `/api/crm/analytics-events` | Session, Workspace-Scope bzw. `crm:read`/`crm:write` | `crm-workspace.tsx`, Phase-3-/Tenant-Tests | kein Launch-Gate; KPIs/Queue müssen vollständig abgenommen werden |
| Analytics und Analysis/Jarvis | `#analytics`, `#analysis` | `/api/crm/analytics-events`, `/api/crm/recommendation-runtime` | `crm:read`; Writes `crm:write`; UI teils Capability-/Preset-basiert | Analytics-/Recommendation-Repositories | kein Launch-Gate; Analysis ist in mehreren Profilen sichtbar |
| Lead Inbox | `#lead-inbox`, `#seller-leads`, `#buyer-leads`, `#leads`, `#sla-cockpit` | `/api/crm/leads`, `/api/crm/core` | Workspace-Scope + `crm:write` + `pipeline:write` für Writes | Lead-/Tenant-/Idempotenztests | kein Launch-Gate; Aliasse teilen dieselbe Section |
| Kontakte | `#contacts` | `/api/crm/contacts`, `/api/crm/core` | Workspace-Session; Repository-Rollen-/Owner-/Projekt-Scope | Contact-RBAC-Tests | kein Launch-Gate; Header-Import bewirbt noch nicht implementierte Quellen |
| Deals / Pipeline | `#pipelines`, Entry `deals`, `projectPipeline` | `/api/crm/deals`, `/api/crm/deals/[dealId]/stage`, `/stage-history` | Workspace-Scope + `pipeline:write`; Reads `crm:read` | Deal-UX-/Idempotenz-/RBAC-Tests | kein Launch-Gate |
| Projekte | `#projects`, `projectOverview` | `/api/crm/projects`, `/api/crm/core` | Writes `crm:write` + `settings:manage` | Project-Wizard/API | global sichtbarer Projekt-Button, kein Launch-Gate |
| Properties / Immobilien | `#properties` | `/api/crm/properties`, `/api/media*` | Read `crm:read`; Writes Session+CSRF+Property-Rollenprüfung | Property-Tests | per Modulkonfiguration immer sichtbar; kein Launch-Gate |
| Gebäude und Einheiten | Entry `units`, Hash `#units` | `/api/crm/units` | Read `crm:read`; Write `crm:write` + `reservations:write`; Kandidat mit semantischem Idempotenz-Ledger und tenantgebundener Fresh-Snapshot-Transaktion | Inventory-/Migration-/Reset-Zielsuites | per Modulkonfiguration immer sichtbar; Migration 069 und deploytes DB-Concurrency-E2E fehlen |
| Reservierungen | `#reservations` | `/api/crm/reservations`, Teams-Side-Effects | `crm:write` + `reservations:write` | Reservation-Resolver-Tests | kein Launch-Gate; `notifyTeams`/`createTask` benötigt Scopeentscheidung |
| Objekte / Mandate / Suchprofile | `#objects-mandates`, Entry `buyerProfiles` | `/api/crm/broker/mandates`, `/api/crm/broker/search-profiles` | Read `crm:read`; Write `crm:write` + `pipeline:write` | Broker-Repositories | per Modulkonfiguration immer sichtbar; kein Launch-Gate |
| Aufgaben und Follow-up Queue | `#tasks`, Entry `followUpQueue` | `/api/crm/tasks` | `crm:write` + `workspace:operate` | Task-/Tenant-Tests | kein Launch-Gate; Follow-up-Semantik offen |
| Termine / Booking | `#meetings`, Entries `appointments`, `consultations`; `/book/...`, `/m/...` | `/api/crm/calendar-events`, `/api/meetings/*`, `/api/calendar/*` | CRM-RBAC/OAuth Capability; öffentliche Create-/Cancel-/Reschedule-Writes im Kandidaten vor Body/DB/Provider hart Launch-off, Repository/UI ebenfalls fail-closed | Booking-/i18n-/Launch-Scope-Zielsuites | Product-Einstufung, Provider-Smoke/QA-Kalender und vollständiges E2E vor späterem Launch-on offen |
| Notizen | innerhalb Kontakte/Communication | `/api/crm/notes` | Read `crm:read`; Write `crm:write` + `workspace:operate` | API-/Tenant-Scope | keine eigene Scopeentscheidung oder Navigation; kein Launch-Gate |
| Dateien und Medien | innerhalb Properties/Bots/Communication | `/api/media`, `/api/media/[assetId]`, `/api/media/files/[assetId]`, `/api/media/public/[token]` | private Pfade RBAC; Public Share Token | Bot-Document-/Security-Tests | kein Launch-Gate; Blob-ENV-Isolation/Private-Migration offen |
| Communication | `#communication` | Bots, Notes, Calendar, Provider-/Notification-APIs | je Endpoint RBAC/Signatur | Communication-UI + Bot-Webhook-Security | Gesprächs-/Kanal-Semantik und Scopeentscheidung offen |
| Forms | `#forms` | `/api/forms`, `/api/forms/resolve` | `crm:read`/`crm:write`; Admin-JSON maximal 256 KiB; persistierter DB-Resolver, Owner-Tenant-Guard; Admin-Save/UI verweigert RoundRobin, File, Custom Pattern und unsichere Consent-Konfiguration für Public-Status | Forms 12/12; Reviewer-Zielbündel 39/39; Migration 20/20 | globaler Launch-Gate und deploytes E2E fehlen |
| Public Forms / Embed | `/forms/[workspacePublicKey]/[formSlug]`, Legacy `/forms/[slug]`, `/forms/embed` | `/api/forms/submissions` | aktive/eingebaute persistierte Form + Workspace Public Key; Abuse-/Idempotency-Controls; Deep-Allowlist-DTO, minimale Response, atomarer Domain-/Replay-CTE, shared Identity-Locks; File/RoundRobin/Custom Pattern/unsicheres Consent fail-closed | Forms 12/12; Reviewer-Zielbündel 39/39; Migration 20/20 | deploytes Submit-/Cleanup-E2E und globaler Launch-Gate fehlen |
| Funnels | `#funnels`, `/preview/[funnelId]` | `/api/crm/funnels`, `/api/funnels/[funnelId]/blueprint`, `/submissions` | Adminpfade RBAC; Testpreview tenant/auth; Live active+persisted+Token; Deep-Allowlist-DTO/Public Proof; atomarer Submit mit shared Form/Funnel-Email-/Phone-Identity-Fresh-Snapshot-Locks; gemeinsamer Publish-/Restore-/Runtime-Preflight mit kanonischen Consent-/Identity-Aliassen | Funnel-Public-/DTO-/Abuse-/Boundary-/Preflight-Zielsuites | Publish-Token-Rotation, Product-Einstufung und deploytes Publish/Submit/Cleanup-E2E fehlen; Webhook technisch OFF |
| Newsletter | `#newsletter`, `/unsubscribe` | `/api/newsletter/send`, `/unsubscribe/confirm` | Send im Kandidaten API/UI vor Providerzugriff Launch-off; Unsubscribe read-only GET + opaker Fragmenttoken + Same-Origin-POST | Email-/Unsubscribe-/Launch-Scope-Zielsuites | Product-Einstufung, QA-Mailbox/Domain und genau ein später freigegebener QA-Send offen |
| Bots | `#bots`, `botGovernance` | `/api/bots/*`, `/api/crm/bots` | Permissions/Capabilities; Runtime-Kill-Switch; signierter Webhook | Bot-Grounding-/Webhook-Tests | Bot-UI/API nicht durch einheitlichen Launch-State gesperrt; Provider-Smoke offen |
| Knowledge | `#knowledge` | `/api/bots/knowledge` | `knowledge:write`; DB-only; approved/search nur mit externem Embedding-Provider, Timeout/Fallback 503; Source+Chunks atomar | Forms/Knowledge-Truth-Zielsuite | kein globaler Launch-Gate; Provider-/UI/API/DB-E2E offen |
| Data Hygiene | `#data-hygiene` | `/api/crm/data-quality` | `crm:read`/`crm:write` | Data-Hygiene-Repositories | kein Launch-Gate; Merge/Notify/Cleanup-E2E offen |
| Customer Access und Users/Roles | `#customer-access`, Entries `customerWorkspaces`, `usersRoles` | `/api/crm/customer-access`, `/api/settings/access/users`, `/password` | Customer-Access Capabilities; Settings-Manage; Session+CSRF | Access-/Role-Tests | kein Launch-Gate; Einladung ist echter Resend-Side-Effect |
| Onboarding / Demos & Trials | `#onboarding`, Entry `demosTrials` | `/api/auth/onboarding`, Access-/Workspace-APIs | Session; POST CSRF; Step-Policy | Auth-Onboarding-Code | Oberfläche nur clientseitig durch Preset getrennt; kein Launch-Gate |
| Managed Service | `#managed-service`, Entries `customerSwitch`, `managedService`, `approvals`, `customerReport` | `/api/approvals`, `/api/workspaces`, Core/Customer-Access | je Endpoint RBAC; UI nur Preset | InternalWorkspaceView | keine einheitliche serverseitige INTERNAL-ONLY-Erzwingung |
| Service Ops / Customer Success | `#customer-success`, Entries `serviceCockpit`, `ticketsSupport`, `customerWorkspaces` | Core, Customer-Access, Knowledge, Meetings | je Endpoint RBAC; UI über Produktrolle/Preset | InternalWorkspaceView | keine einheitliche serverseitige INTERNAL-ONLY-Erzwingung |
| Audit | `#audit-log` | `/api/admin/audit-logs` | `platform_admin`/`novalureAdmin`/`novalureServiceOps`; Export enger | Admin-Navigation-/Audit-Code | kein expliziter Launch-State; bei INTERNAL Entscheidung Direct-URL-Negativmatrix nötig |
| Governance & Compliance | `#governance-compliance` | keine dedizierte Daten-API | nur clientseitige Nav-Rollenprüfung | Panelcode + System-Releases-/Admin-Navigation-Contracts | unbelegte „QA-verifiziert“-Aussage im Kandidaten entfernt; offene Evidenz amber; serverseitiger Surface-Guard/Product-Einstufung fehlen |
| System & Releases | `#system-releases` | `/api/system/database` | UI nur Admin; API alle `novalure:internal` | System-Contract-Tests | Rolleninkonsistenz LS-05; kein Launch-Gate |
| Settings / Company Profile / Workspace Setup | `#settings`, dauerhaft gerenderte Workspace-Setup-Details | `/api/settings/company-profile`, `/api/workspaces`, Access-/Meeting-Settings | Settings-/Workspace-Capabilities | Company-Profile-/Settings-Tests | kein Launch-Gate; Legal/Business-Inputs offen |
| QA Reset (nicht sichtbare Adminfunktion) | kein produktiver Nav-Eintrag | `/api/admin/qa-reset` | Cookie-Session, Owner+`platform_admin`, CSRF, QA-Allowlist, Dry-run, Execute-Env+Bestätigung | QA-Reset-Safety-Tests | Kandidat für INTERNAL-ONLY; Product/Ops/Security-Freigabe und Migration fehlen |

## 6. Vollständiges Navigationsinventar

### 6.1 Profile

Inventarisiert: `completeBrokerage`, `realEstateBroker`, `propertyDeveloper`, `hybridRealEstate`, `managedService`, `sales`, `salesLead`, `management`, `marketing`, `assistant`, `newUser`, `admin`, `novalureInternal`, `novalureGrowth`, `novalureServiceOps`, `novalureAdmin`.

Die erlaubten Profile werden clientseitig aus Produktrolle, Operating Model und Customer Type abgeleitet. Das ist eine UI-/Produktsicht, kein serverseitiger Launch-State.

### 6.2 Alle 51 Navigationseinträge

Alle Zeilen: `PENDING PRODUCT DECISION`.

| Entry-ID(s) | Ziel-Section / Hash | Aktuelle Sichtbarkeitsregel | Servergegenstück / Restlücke |
|---|---|---|---|
| `dashboard` | Dashboard / `#dashboard` | Preset + Modul `dashboard` | Core/Dashboard-APIs; kein Launch-Gate |
| `dailyQueue` | Daily Queue / `#daily-queue` | Preset + Modul `dashboard` | Core; kein eigener Serverguard |
| `analysis` | Analysis / `#analysis` | Preset; kein `moduleBySection`-Eintrag | Recommendation/Core; kein Launch-Gate |
| `analytics`, `projectAnalytics` | Analytics / `#analytics` | Preset + Modul `analytics` | Analytics/Core; kein Launch-Gate |
| `leadInbox`, `sellerLeads`, `buyerLeads`, `developerLeads`, `slaCockpit` | Lead Inbox / Alias-Hashes | Preset + Modul `leadInbox`; Leadtype nur Clientfilter | Leads/Core; kein Launch-Gate |
| `contacts` | Kontakte / `#contacts` | Preset + Modul `contacts` | Contacts/Core; kein Launch-Gate |
| `deals`, `pipelines`, `projectPipeline` | Pipeline / `#pipelines` | Preset + Modul `pipeline` | Deals; kein Launch-Gate |
| `projects`, `projectOverview` | Projekte / `#projects` | Preset + Modul `projectOverview` | Projects/Core; kein Launch-Gate |
| `properties` | Properties / `#properties` | Preset; Modul wird zwangsweise aktiviert | Properties/Media; kein Launch-Gate |
| `units` | Units / `#units` | Preset; Modul wird zwangsweise aktiviert | Units; kein Launch-Gate |
| `reservations` | Reservations / `#reservations` | Preset; Modul wird zwangsweise aktiviert | Reservations; kein Launch-Gate |
| `objectsMandates`, `buyerProfiles` | Objects/Mandates / `#objects-mandates` | Preset; Modul wird zwangsweise aktiviert | Mandates/Search Profiles; kein Launch-Gate |
| `tasks`, `followUpQueue` | Tasks / `#tasks` | Preset + Modul `tasks` | Tasks; kein Launch-Gate |
| `calendar`, `appointments`, `consultations` | Calendar / `#meetings` | Preset + Modul `calendar` | Calendar/Meetings/OAuth; kein Launch-Gate |
| `communication` | Communication / `#communication` | Preset + Modul `communication` | mehrere APIs; kein Launch-Gate |
| `forms` | Forms / `#forms` | Preset, aber Modul **`funnels`** | Forms-APIs; nicht separat steuerbar |
| `funnels` | Funnels / `#funnels` | Preset + Modul `funnels` | Funnel-APIs; Preview-Gap |
| `newsletter` | Newsletter / `#newsletter` | Preset + Modul `newsletter` | Send/Unsubscribe; kein Launch-Gate |
| `bots`, `botGovernance` | Bots / `#bots` | Preset + Modul `bots`; `botGovernance` nicht admin-restricted | Bot-APIs/Kill-Switch; kein einheitlicher Launch-Gate |
| `knowledge` | Knowledge / `#knowledge` | Preset + Modul `knowledge` | Knowledge API; kein Launch-Gate |
| `dataHygiene` | Data Hygiene / `#data-hygiene` | Preset; kein Modulmapping | Data Quality; kein Launch-Gate |
| `customerAccess`, `customerWorkspaces`, `usersRoles` | Customer Access / `#customer-access` | Preset; kein Modulmapping | Customer-/Settings-Access; kein Launch-Gate |
| `onboarding`, `demosTrials` | Onboarding / `#onboarding` | Preset; kein Modulmapping | Auth Onboarding; kein INTERNAL-Gate |
| `managedService`, `customerSwitch`, `approvals`, `customerReport`, `workspaces` | Managed Service / `#managed-service` bzw. `#workspaces` | Preset; kein Modulmapping | Core/Approvals/Workspaces; kein gemeinsamer INTERNAL-Gate |
| `customerSuccess`, `serviceCockpit`, `ticketsSupport` | Customer Success / `#customer-success` | Preset; kein Modulmapping | Core/Access; kein gemeinsamer INTERNAL-Gate |
| `auditLog` | Audit / `#audit-log` | Client: `platform_admin`, `novalureAdmin`, `novalureServiceOps` | API mit gleicher Leserollenmenge; kein Launch-State |
| `governanceCompliance` | Governance / `#governance-compliance` | Client: `platform_admin`, `novalureAdmin` | keine API; statische unbelegte Grün-/„QA-verifiziert“-Aussagen entfernt, Evidenzstatus amber/offen; kein Server-Surface-Guard |
| `systemReleases` | Releases / `#system-releases` | Client: `platform_admin`, `novalureAdmin` | API erlaubt breiter `novalure:internal`; Inkonsistenz |
| `settings` | Settings / `#settings` | Preset + Modul `settings` | Settings-/Workspace-APIs; kein Launch-Gate |

### 6.3 Alle 15 Quick Actions und globale Headeraktionen

Alle Zeilen: `PENDING PRODUCT DECISION`.

| Action-ID | Verhalten | Aktueller Guard | Restlücke |
|---|---|---|---|
| `dashboard` | Clientnavigation Dashboard | Ziel muss in gefilterter Navigation liegen | kein Server-Launch-Gate |
| `leadInbox` | Clientnavigation Lead Inbox | wie oben | kein Server-Launch-Gate |
| `pipeline` | Clientnavigation Pipeline | wie oben | kein Server-Launch-Gate |
| `tasks` | Clientnavigation Tasks | wie oben | kein Server-Launch-Gate |
| `meetings` | Clientnavigation Calendar | wie oben | kein Server-Launch-Gate |
| `customerAccess` | Clientnavigation Customer Access | wie oben | kein Server-Launch-Gate |
| `dataHygiene` | Clientnavigation Data Hygiene | wie oben | kein Server-Launch-Gate |
| `units` | Clientnavigation Units | wie oben | Modul zwangsweise aktiv; kein Server-Launch-Gate |
| `analysis` | Clientnavigation Analysis | wie oben | kein Server-Launch-Gate |
| `newsletter` | Clientnavigation Newsletter | wie oben | kein Server-Launch-Gate |
| `bots` | Clientnavigation Bots | wie oben | Bot-Kill-Switch ersetzt kein vollständiges Scope-Gate |
| `funnels` | Clientnavigation Funnels | wie oben | kein Server-Launch-Gate |
| `forms` | Clientnavigation Forms | wie oben, teilt Funnel-Modul | nicht separat steuerbar |
| `newProject` | öffnet Projektwizard; zusätzlich globaler Headerbutton | ausdrücklich nicht an gefilterte Navigation gebunden; API prüft später `settings:manage` | für nicht berechtigte Rollen sichtbar; kein Scope-Gate |
| `reviewImport` | öffnet lokalen Readiness-Dialog; zusätzlich globaler Headerbutton | ausdrücklich nicht an gefilterte Navigation gebunden; kein Import-API-Write | sichtbare Schein-/Vorbereitungsfunktion |

## 7. Öffentliche und direkt erreichbare Routen

Alle Zeilen: `PENDING PRODUCT DECISION`.

| Route | Funktion | Aktueller serverseitiger Guard | Restlücke / Evidenz |
|---|---|---|---|
| `/` | Landing ohne Session; CRM mit Session | Session entscheidet Renderpfad | kein Launch-State für Landing/CRM; CRM-APIs separat geschützt |
| `/login` | Login/MFA-Einstieg | authentifizierte Session wird weitergeleitet; Login-API schützt Flow | Teil des Auth-Lifecycles, noch keine Scopeentscheidung |
| `/login/forgot-password` | Reset anfordern | Session-Redirect; Auth-Request-Controls | Provider-Mail/QA-Scope offen |
| `/login/reset-password` | Reset abschließen | Reset-Exchange-/Tokenflow | Provider-/Lifecycle-E2E offen |
| `/imprint` | Impressum | öffentlich | Legal-Sign-off offen; kein Launch-Gate |
| `/privacy` | Datenschutz | öffentlich | Legal-Sign-off offen; kein Launch-Gate |
| `/terms` | AGB/Nutzungsbedingungen | öffentlich | Legal-Sign-off offen; kein Launch-Gate |
| `/cookies` | Cookie-Hinweis | öffentlich | Legal-Sign-off offen; kein Launch-Gate |
| `/data-deletion`, `/datadeletion` | Datenlöschungsinformation + Alias | öffentlich | Legal-Sign-off offen; kein Launch-Gate |
| `/meta` | Meta Developer Disclosures | öffentlich | Provider-/Legal-Scope offen; kein Launch-Gate |
| `/unsubscribe` und `/unsubscribe/confirm` | Newsletter-Abmeldung | GET read-only; opaker AES-GCM-Token im Fragment; expliziter Same-Origin-POST; workspacegebundene atomare Suppression/Consent-Aktualisierung | LS-07 im Kandidaten geschlossen; alter PII-Link absichtlich ungültig; QA-Mailflow/Product-Freigabe offen |
| `/forms/[workspacePublicKey]/[formSlug]` (Codepfad `/forms/[slug]/[formSlug]`) | kanonisches Public Form | DB-Resolver: persistiert, Status `aktiv`/`eingebaut`, Workspace Public Key | guter Funktionsguard, aber kein globaler Launch-State |
| `/forms/[slug]` | Legacy Form | nur bei eindeutigem Slug Redirect; sonst unavailable | kein globaler Launch-State |
| `/forms/embed` | Embed HTML | DB-Resolver wie Public Form | kein globaler Launch-State |
| `/book/[workspacePublicKey]/[meetingSlug]` (Codepfad `/book/[slug]/[meetingSlug]`) | kanonisches Booking | persistierte aktive Meeting Page + Workspace Public Key; fehlend 404; Kandidat zeigt für Create/Cancel/Reschedule lokalisierten Launch-off-Status statt Write-Form | technische OFF-Grenze belegt; Product-Einstufung/Provider-E2E offen |
| `/book/[slug]` | Legacy Booking | nur eindeutiger Slug Redirect; sonst 404/noindex; DB-Ausfälle werden nicht als 404 maskiert; Zielroute erzwingt dieselbe Booking-Launch-off-Grenze | kein globaler Launch-State |
| `/m/[slug]`, `/m/[slug]/[meetingSlug]` | Kurzlink-Redirects | Redirect auf Booking; canonical Resolver entscheidet danach | kein globaler Launch-State |
| `/preview/[funnelId]` | Funnel Renderer/Preview | Test: Session+Tenant; Live: persistiert+aktiv+Public Token. An den Client gehen nur Deep-Allowlist-DTO und kurzlebiger Public Proof, nicht der Publish-Token | LS-06 im Kandidaten geschlossen; Publish-Token-Rotation, Product-Einstufung und deploytes E2E offen |
| `/visual-qa/crm`, `/visual-qa/crm/content` | Fixture-basierte Visual-QA | nur Preview + exakt fest codierter Branch, sonst 404 | **LS-14**; bei INTERNAL-ONLY besser auth-/deploymentgebunden |

## 8. Vollständiges API-Inventar

In allen Tabellen ist der Entscheidungsstatus `PENDING PRODUCT DECISION`. „Guard“ beschreibt nur den vorhandenen Funktions-/RBAC-Schutz. **Keine** dieser Zeilen prüft derzeit einen gemeinsamen Launch-State.

### 8.1 Admin, Approval und Auth

| API | Methoden | Vorhandener Guard |
|---|---|---|
| `/api/admin/audit-logs` | GET | Session; Leserollen `platform_admin`/`novalureAdmin`/`novalureServiceOps` + interne Capability; CSV enger |
| `/api/admin/qa-reset` | POST | Cookie-Session, Owner+`platform_admin`, CSRF, Capabilities, QA-Allowlist; Execute zusätzlich Env+exakte Bestätigung |
| `/api/approvals` | GET, POST | `bots:approve` |
| `/api/auth/csrf` | GET | bestehende Session, Ausgabe eines CSRF-Tokens |
| `/api/auth/login` | POST | Trusted-Origin/CSRF-Request-Context, Credential-, MFA- und Sessionflow |
| `/api/auth/logout` | POST | Session + CSRF + Trusted Origin |
| `/api/auth/onboarding` | GET, POST | Session; POST CSRF und Step-Policy |
| `/api/auth/password-reset/request` | POST | Trusted-Origin/Abuse-Controls im Authflow; Resend Side Effect möglich |
| `/api/auth/password-reset/exchange` | GET, POST | Reset-E-Mail-Token, Exchange-Formtoken und Request-Context |
| `/api/auth/password-reset/confirm` | POST | Reset-Exchange-Cookie/Formtoken |
| `/api/auth/session` | GET, POST | Session; POST CSRF und Rotation |

### 8.2 Bots und Knowledge

| API | Methoden | Vorhandener Guard |
|---|---|---|
| `/api/bots/actions` | GET, POST | `bots:run`; Bot-Policy/Approval je Operation |
| `/api/bots/agent` | GET, POST | `bots:run`; Runtime-Policy/Kill-Switch |
| `/api/bots/calls` | POST | `bots:run` |
| `/api/bots/channels` | GET, POST | GET `bots:run`; POST `crm:write`; Connector-Readiness |
| `/api/bots/channels/webhook` | GET, POST | GET Verify-Token; POST Meta-Signatur oder Custom Secret; Prod verbietet unsigned; Webhook-/Bot-Kill-Switch |
| `/api/bots/chat` | GET, POST | `bots:run`; Runtime-Policy/Kill-Switch |
| `/api/bots/documents` | GET, POST | GET `crm:read`; POST `bots:run`; Media-Share-Policy |
| `/api/bots/evaluations` | GET, POST | GET `bots:run`; POST `bots:approve` |
| `/api/bots/knowledge` | GET, POST | Permission+Capability `knowledge:write`; DB-only; approved/search verlangt externen Embedding-Provider und schlägt bei Timeout/Fallback fail-closed fehl; Projekt-Tenant vor und im atomaren Write geprüft; Logs mit festen redigierten Gründen |
| `/api/bots/leads` | GET, POST | `workflows:run` |
| `/api/bots/meetings` | GET, POST | GET `crm:read`; POST `bots:run` |

### 8.3 Calendar und CRM

| API | Methoden | Vorhandener Guard |
|---|---|---|
| `/api/calendar/google` | POST | `calendar:sync` + `calendar:manage` |
| `/api/calendar/microsoft` | GET, POST | `calendar:sync` + `calendar:manage` |
| `/api/crm/analytics-events` | GET | Workspace-Scope + `crm:read` |
| `/api/crm/bots` | POST | `crm:write` + `bots:publish` |
| `/api/crm/broker/mandates` | GET, POST, PATCH | GET `crm:read`; Writes `crm:write` + `pipeline:write` |
| `/api/crm/broker/search-profiles` | GET, POST, PATCH | GET `crm:read`; Writes `crm:write` + `pipeline:write` |
| `/api/crm/calendar-events` | GET, POST, PATCH | Read Workspace-Scope+`crm:read`; Write Workspace-Scope+`crm:write`+`workspace:operate` |
| `/api/crm/contacts` | POST, PATCH, DELETE | POST/PATCH Workspace-Scope+`crm:read`, danach Repository-Rollen-/Owner-/Projektprüfung; DELETE `crm:write`+`settings:manage` |
| `/api/crm/core` | GET | Workspace-Scope + `crm:read` |
| `/api/crm/customer-access` | GET, PATCH, POST | `customer-access:read` bzw. `customer-access:manage` |
| `/api/crm/dashboard-views` | GET, POST | `crm:read` bzw. `crm:write` |
| `/api/crm/data-quality` | GET, POST | `crm:read` bzw. `crm:write` |
| `/api/crm/deals` | POST, PATCH | Workspace-Scope + `crm:write` + `pipeline:write` |
| `/api/crm/deals/[dealId]/stage` | POST, PATCH | Workspace-Scope + `crm:write` + `pipeline:write` |
| `/api/crm/deals/[dealId]/stage-history` | GET | Workspace-Scope + `crm:read` |
| `/api/crm/editor-preflight` | POST | `crm:read`; Operation validiert Inhalt/Provider-Readiness |
| `/api/crm/funnels` | POST | `crm:write` + `funnels:publish` |
| `/api/crm/google-notifications` | GET, POST, PATCH | Read Workspace-Scope+`crm:read`; Write Workspace-Scope+`crm:write`; operationale Zusatzprüfungen |
| `/api/crm/google-notifications/[notificationId]/retry` | POST, PATCH | Workspace-Scope + `crm:write` + `settings:manage` |
| `/api/crm/leads` | POST, PATCH | Workspace-Scope + `crm:write` + `pipeline:write` |
| `/api/crm/notes` | GET, POST, PATCH | Read Workspace-Scope+`crm:read`; Write `crm:write`+`workspace:operate` |
| `/api/crm/projects` | POST, PATCH | Workspace-Scope + `crm:write` + `settings:manage` |
| `/api/crm/properties` | GET, POST | GET Workspace-Scope+`crm:read`; POST Session+CSRF+Property-Rollenprüfung |
| `/api/crm/recommendation-runtime` | GET, POST | `crm:read` bzw. `crm:write` |
| `/api/crm/reservations` | POST, PATCH | Workspace-Scope + `crm:write` + `reservations:write` |
| `/api/crm/tasks` | POST, PATCH | Workspace-Scope + `crm:write` + `workspace:operate` |
| `/api/crm/teams-notifications` | GET, POST, PATCH | Read Workspace-Scope+`crm:read`; Write Workspace-Scope+`crm:write`; operationale Zusatzprüfungen |
| `/api/crm/teams-notifications/[notificationId]/retry` | POST, PATCH | Workspace-Scope + `crm:write` + `settings:manage` |
| `/api/crm/units` | GET, POST | Read Workspace-Scope+`crm:read`; Write `crm:write`+`reservations:write`; Kandidat mit semantischem Unit-/Building-Idempotenz-Ledger und tenantgebundener Fresh-Snapshot-Transaktion |

### 8.4 Cron, Forms, Funnels, Health und Media

| API | Methoden | Vorhandener Guard |
|---|---|---|
| `/api/cron/google-alerts` | GET | `CRON_SECRET`; lokal nur explizites Dev-Override; Worker-Pause |
| `/api/cron/meeting-reminders` | GET | `CRON_SECRET`; lokal nur explizites Dev-Override; Worker-Pause |
| `/api/cron/property-reservations` | GET | `CRON_SECRET`; lokal nur explizites Dev-Override; Worker-Pause |
| `/api/cron/teams-alerts` | GET | `CRON_SECRET`; lokal nur explizites Dev-Override; Worker-Pause |
| `/api/forms` | GET, POST | `crm:read` bzw. `crm:write`; POST-JSON streamingbegrenzt auf 256 KiB; DB-only Remediation und Public-Status-Launchguards |
| `/api/forms/resolve` | GET | `crm:read`; prüft persistierten Public Resolver |
| `/api/forms/submissions` | POST | Public-Key/Form-Resolver, Honeypot/Proof, Rate Limit; höchstens 256 KiB/0 Dateien; semantischer Multipart-Fingerprint, lease-gefenceter atomarer Domain-/Minimalresponse-CTE, shared Email-/Phone-Identity-Locks; File/RoundRobin/Custom Pattern/unsicheres Consent fail-closed |
| `/api/funnels/[funnelId]/blueprint` | GET, PUT | `funnels:write` + `funnels:publish`, Workspacebindung |
| `/api/funnels/[funnelId]/submissions` | POST | Test: `funnels:write`; Live: persistierter aktiver Funnel + kurzlebiger Public Proof, Canonical-Field-Validation, Rate Limit/Honeypot; atomarer Domain-/Claim-CTE und shared Form/Funnel-Email-/Phone-Identity-Fresh-Snapshot-Serialisierung; minimale Live-Response |
| `/api/health` | GET | öffentlich, nur `{ok:true}`, no-store |
| `/api/media` | GET, POST | `crm:read` bzw. `crm:write`; Workspacebindung/Storagevalidierung |
| `/api/media/[assetId]` | DELETE | `crm:write`; Workspacebindung |
| `/api/media/files/[assetId]` | GET | `crm:read`; Workspacebindung |
| `/api/media/public/[token]` | GET | opaker aktiver Public-Share-Token; 404/503 fail-closed |

### 8.5 Meetings, Newsletter, Settings und System

| API | Methoden | Vorhandener Guard |
|---|---|---|
| `/api/meetings/availability` | GET | Public Workspace-Key/Slug-Resolver bzw. eindeutiger Legacy-Resolver |
| `/api/meetings/bookings` | GET, POST | GET intern `crm:read`; POST im Kandidaten vor Body/DB/Provider 503/no-store Launch-off; Repository-Erstellung ebenfalls vor DB/Provider fail-closed |
| `/api/meetings/bookings/[bookingId]/cancel` | POST | im Kandidaten vor Body/DB/Provider 503/no-store Launch-off; inaktive Implementierung besitzt Lifecycle-Token/Workspacebindung |
| `/api/meetings/bookings/[bookingId]/confirm` | POST | `calendar:sync` + `calendar:manage` |
| `/api/meetings/bookings/[bookingId]/reschedule` | POST | im Kandidaten vor Body/DB/Provider 503/no-store Launch-off; inaktive Implementierung besitzt Lifecycle-Token/Workspacebindung |
| `/api/meetings/notifications` | POST | `newsletter:send`; expliziter Empfänger/Bestätigung und Provider-Readiness |
| `/api/meetings/notifications/[notificationId]/retry` | POST | `calendar:sync` + `calendar:manage` |
| `/api/meetings/oauth/[provider]/start` | GET | `calendar:sync` + `calendar:manage`; OAuth State/PKCE |
| `/api/meetings/oauth/[provider]/callback` | GET | Session/Capability + OAuth State/PKCE |
| `/api/meetings/oauth/[provider]/disconnect` | POST | `calendar:sync` + `calendar:manage` |
| `/api/meetings/oauth/status` | GET | `calendar:sync` + `calendar:manage` |
| `/api/meetings/settings` | GET, POST | GET `crm:read`; POST `crm:write` + `calendar:manage` |
| `/api/newsletter/send` | GET, POST | Permission+Capability `newsletter:send`; GET bleibt read-only, POST antwortet im Kandidaten vor Send-/Providerlogik 503/no-store `NEWSLETTER_DELIVERY_LAUNCH_OFF`; UI-Sendaktionen verborgen |
| `/api/settings/access/password` | PATCH | Session + CSRF + Password-/Sessionrotation |
| `/api/settings/access/users` | GET, PATCH, POST | Workspace-Scope + `crm:write` + `settings:manage`; Einladung kann Resend auslösen |
| `/api/settings/company-profile` | GET, PATCH | Session; Operator-Scope Admin; PATCH `crm:write`+`settings:manage` |
| `/api/system/database` | GET | nur `platform_admin` oder `novalureAdmin`; 404 sonst |
| `/api/workspaces` | GET, PATCH | GET `crm:read`; PATCH Workspace-Scope+`crm:write`+`settings:manage` |

## 9. Provider- und Integrationsinventar

Alle Zeilen: `PENDING PRODUCT DECISION`.

| Integration | Auslöser / APIs | Aktueller Guard / Fail-Closed-Verhalten | Harte Restlücke |
|---|---|---|---|
| Neon/Postgres | nahezu alle persistierenden APIs | Session-/Workspace-Scope und Repositorychecks; fehlende DB meist 503/leer fail-closed | ENV-/Schema-/Restore-Gates außerhalb LB-04 offen |
| Vercel Blob, private/public | `/api/media*`, Bot-Dokumente, Property-Medien | private RBAC; Public Share Token; fehlender Token/Store schlägt fehl | Preview/Prod teilen laut separater ENV-Prüfung dasselbe Blobziel; kein Scope-Gate |
| Resend E-Mail | Newsletter, Meeting Notifications, Einladungen, Passwortreset, Customer Access | Newsletter-Send im Kandidaten API/UI Launch-off; übrige Pfade funktionsspezifisch Permission/Capability; produktiver Key + exakter From; Providerfehler redigiert | Domain/From/QA-Mailbox/ENV-Ziel nicht freigegeben; übrige Resend-Side-Effects benötigen Gesamtklassifizierung |
| Microsoft 365 / Graph / Teams Meetings | Calendar Sync, Booking, OAuth | `calendar:sync`+`calendar:manage`; verschlüsselte Tokens; OAuth State/PKCE; Provider-Readiness | QA-Kalender, Zieltrennung und echter Lifecycle-Smoke offen |
| Google Calendar / Google Meet | Calendar Sync, Booking, OAuth | wie Microsoft; Google OAuth/API-Readiness | QA-Kalender, Zieltrennung und echter Lifecycle-Smoke offen |
| Teams Notification Webhooks / Logic Apps / Power Automate | Teams Notification APIs und Cron | Workspace/Projekt/Alert-Scope, Zieltyp, HTTPS/Providerhost, durable Queue, Retry; Worker-Pause | Product-Scope und kontrollierter Sink offen |
| Google Chat Webhook Notifications | Google Notification APIs und Cron | wie Teams; nur validierte Google-Chat-Webhooks | Product-Scope und kontrollierter Sink offen |
| Meta WhatsApp Cloud | Bot Channel Webhook und Provider Actions | Meta-Signatur, gemappter Channel Account, Bot-Kill-Switch, Credentials | QA-Sandbox/Provider-Smoke/Scope offen |
| Meta Instagram / Messenger | Bot Channel Webhook und Provider Actions | Meta-Signatur, gemappter Channel Account, Bot-Kill-Switch, Credentials | QA-Sandbox/Provider-Smoke/Scope offen |
| Custom Bot Webhook | `/api/bots/channels/webhook` | Production nur Secret; optional unsigned ausschließlich Non-Prod; Webhook-Kill-Switch | Product-Scope/Rotation/QA-E2E offen |
| Vercel AI Gateway bzw. OpenAI-kompatibler Chat | Bot Chat/Agent Runtime | nur bei Key; sonst deterministischer grounded Fallback; Bot-Policy/Kill-Switch | **LS-13**: Fallback-/Readiness-Semantik und Providerziel offen |
| OpenAI bzw. kompatible Embeddings | Knowledge Import/RAG | approved Import und semantische Suche nur bei konfiguriertem externen Provider; Timeout/Fallback 503 ohne Persistenz/Suche | Knowledge-Teil von LS-13 im Kandidaten geschlossen; Providerziel/QA-E2E und Bot-Chat-Semantik offen |
| Funnel Outbound Webhook | Funnel-Designer/Submission | technisch Launch-off: UI/API/Persistenz/Adapter entfernen Konfiguration; Submission meldet fest `launch_off`; keine Zustellung | Product-Entscheidung; vor späterem ON SSRF-/Allowlist-Schutz, durable Queue, Retry/Audit/Monitoring/E2E |
| HubSpot Import | globale Import-Aktion | technisch Launch-off: UI-Entry-Points verborgen, Handler fail-closed; kein Importserverendpunkt | Product-Entscheidung und vollständiger Importvertrag vor späterem ON |

## 10. Erforderliche Product-Entscheidungsvorlage

Product muss für jede Zeile aus Abschnitt 5 mindestens liefern:

```text
surface_id:
decision: LAUNCH-ON | LAUNCH-OFF | INTERNAL-ONLY
public_name_de:
public_name_en:
allowed_product_roles:
allowed_technical_roles:
public_routes:
api_routes:
cron_queue_provider_side_effects:
fallback_semantics:
product_owner:
engineering_owner:
security_owner:
operations_owner:
approved_at:
approval_version:
```

Danach ist pro Entscheidung technisch nachzuweisen:

- `LAUNCH-ON`: Positiv-, Negativ-, Rollen-, Tenant-, Daten-, Side-Effect- und Cleanup-Nachweis;
- `LAUNCH-OFF`: Navigation und Quick Actions entfernt **und** Page/API/Cron/Queue/Provider serverseitig fail-closed;
- `INTERNAL-ONLY`: serverseitige explizite Novalure-Rollenallowlist, 404/403 für alle anderen Rollen, interne Kennzeichnung und Audit.

## 11. Remediation-Delta vom 22.08.2026

Dieser Abschnitt dokumentiert den Stand des **nicht deployten Remediation-Kandidaten** im sauberen Worktree. Er supersediert ausschließlich die nachfolgend ausdrücklich genannten Ausgangsbefunde in den Abschnitten 4–9; die ursprünglichen Tabellen bleiben als nachvollziehbare Point-in-Time-Inventur erhalten. Aus diesem Delta folgt weder eine Product-Freigabe noch eine Aussage über den derzeitigen Produktionsstand.

| Ausgangsbefund | Remediation im Kandidaten-Code | Prüfevidenz | Verbleibende Grenze |
|---|---|---|---|
| LS-06 – ungeschützte Funnel-Preview | Test-Preview ist authentifiziert und tenantgebunden. Live-Preview akzeptiert nur einen persistierten, aktiven DB-Blueprint mit exakt passendem Public Token; Fixture-/Fallback-Rendering ist entfernt. | `src/app/preview/[funnelId]/page.tsx`, `src/lib/funnel-public-access.ts`, `scripts/funnel-public-access-tests.mjs` | Funktionsgrenze geschlossen; ein globaler Launch-Scope-Guard und eine freigegebene Product-Einstufung fehlen weiterhin. |
| LS-07 – Newsletter-Unsubscribe als öffentlicher GET-Write mit PII-Parametern | GET rendert nur eine neutrale Bestätigung und mutiert nichts. Der opake, authentifizierte Token wird aus dem URL-Fragment übernommen; die Abmeldung erfolgt ausschließlich über einen expliziten Same-Origin-POST nach `/unsubscribe/confirm`. Suppression, Kontaktstatus und Consent werden workspacegebunden atomar persistiert; die Antwort enthält keine PII. | `src/app/unsubscribe/page.tsx`, `src/app/unsubscribe/unsubscribe-confirmation.tsx`, `src/app/unsubscribe/confirm/route.ts`, `src/lib/newsletter-unsubscribe-token.ts`, `scripts/newsletter-unsubscribe-security-tests.mjs` | Sicherheitslücke im Kandidaten geschlossen; alte unsichere Links sind absichtlich ungültig. Produkt-/Operationsfreigabe und echte QA-E2E-Evidenz bleiben offen. |
| LS-05 – abweichende Rollenregel für System & Releases | `/api/system/database` akzeptiert nur noch `platform_admin` oder `novalureAdmin` und entspricht damit der sichtbaren Adminfläche. Andere interne Produktrollen erhalten keinen Diagnosezugriff. | `src/app/api/system/database/route.ts`, `scripts/system-releases-contract-tests.mjs` | Rolleninkonsistenz geschlossen; die Surface ist ohne signierte Matrix noch nicht verbindlich als `INTERNAL-ONLY` freigegeben. |
| LS-10 – statisches Governance-„QA-verifiziert“ | Statische grüne bzw. „QA-verifiziert“-Aussagen wurden entfernt. Das Panel kennzeichnet Evidenz- und Freigabestatus amber/offen, statt einen Runtime- oder QA-Nachweis vorzutäuschen. | `src/components/admin/governance-compliance-panel.tsx`, `scripts/admin-navigation-smoke-tests.mjs`, `scripts/system-releases-contract-tests.mjs` | False-Green geschlossen; eine evidenzgebundene Runtimequelle und die formelle Scope-Einstufung fehlen weiterhin. |
| LS-08 – sichtbare, nicht implementierte Importfunktion | Import ist technisch `LAUNCH-OFF`: Desktop- und Mobile-Header, Quick Action sowie Modal-Reichweite sind über `importLaunchEnabled = false` entfernt; der Handler beendet fail-closed. Im Repository existiert keine Import-API, die separat erreichbar wäre. | `src/components/crm-workspace.tsx`, `scripts/launch-scope-fail-closed-tests.mjs` | Die Oberfläche ist im Kandidaten nicht erreichbar. Eine signierte Product-Entscheidung und ein zentraler serverseitiger Scope-State fehlen weiterhin; vor einem späteren `LAUNCH-ON` ist ein vollständiger Importvertrag erforderlich. |
| LS-09 – Funnel-Webhook suggeriert Readiness ohne Zustellung | Funnel-Webhook-Zustellung ist technisch `LAUNCH-OFF`: die UI bietet keine editierbare Webhookkonfiguration und zeigt den Zustand amber; der Write-Endpunkt entfernt `webhookUrl`, das Repository löscht einen eventuell gespeicherten Tracking-Key, der Adapter mappt ihn nicht, und Submission-Antworten melden fest `webhookDelivery: "launch_off"` sowie `webhookReady: false`. Es findet keine Outbound-Zustellung statt. | `src/components/funnel-command-center.tsx`, `src/app/api/crm/funnels/route.ts`, `src/lib/db/crm-write-repositories.ts`, `src/lib/funnel-builder-adapter.ts`, `src/app/api/funnels/[funnelId]/submissions/route.ts`, `scripts/launch-scope-fail-closed-tests.mjs` | Technischer OFF-Zustand geschlossen. Eine spätere Aktivierung benötigt weiterhin Product-Freigabe, SSRF-/Allowlist-Schutz, durable Queue, Retry, Audit, Monitoring und E2E-Abnahme. |
| Public Funnel – interner Blueprint, Publish-Credential und überreiche Live-Response | Eine explizite Deep-Allowlist-DTO kopiert nur Renderersemantik. Publish-Token, Workspace-/Projekt-/CRM-IDs, Handover, Empfänger, interne Tracking-/Providerdaten, Custom CSS und nicht freigegebene Mediadetails bleiben serverseitig. Der Browser nutzt einen kurzlebigen Public Proof; die Live-Response enthält nur minimalen Erfolg/Persistenzstatus. Datenbankfehler werden nicht als 4xx maskiert. | `src/lib/funnel-public-dto.ts`, `src/app/preview/[funnelId]/page.tsx`, `src/components/funnel-renderer.tsx`, `src/app/api/funnels/[funnelId]/submissions/route.ts`, `scripts/funnel-public-dto-security-tests.mjs` (4/4) | P0 im Kandidaten geschlossen. Der bislang im Live-Frontend verwendete Publish-Token muss vor GO extern rotiert und die alte Capability widerrufen werden; dies wurde nicht ausgeführt. Deploytes Browser-/Network-E2E bleibt offen. |
| Public Funnel – Teilwrites, parallele Kontaktduplikate und Publish-/Consent-/Alias-Drift | Canonical Field-/Score-/Consent-/Identity-Alias-Validierung; ein atomarer PostgreSQL-DML-CTE schreibt die Domainkette samt lease-gefenceter Replayresponse. Mit Forms geteilte Email-/Phone-Contact-Identity-Advisory-Locks werden als separate Anweisungen innerhalb derselben Tenant-Transaktion genommen, sodass das DML-Statement einen frischen Snapshot erhält. Publish, Restore und Runtime teilen denselben Preflight und verweigern nicht submitbare aktive Blueprints bzw. mehrdeutige Alias-Contracts. | `src/lib/db/runtime-repositories.ts`, `src/lib/funnel-submission-validation.ts`, Blueprint-/Submission-Routen, `src/lib/db/public-submission-abuse-repository.ts`, `migrations/070_funnel_submission_idempotency_recovery.sql`, Funnel-Zielsuites (finaler Freeze 29/29) | Kandidatencode geschlossen. Migration 070 und echtes DB-Concurrency-/Zwei-Tenant-/Cleanup-E2E bleiben offen. |
| Newsletter-Send – Providerwirkung ohne abgeschlossene Freigabe | Der Send-Endpunkt liefert vor Versand/Providerzugriff 503/no-store `NEWSLETTER_DELIVERY_LAUNCH_OFF`; beide Sendaktionen sind in der UI verborgen und der OFF-Status wird amber angezeigt. | `src/lib/newsletter-launch-scope.ts`, `src/app/api/newsletter/send/route.ts`, `src/components/newsletter-command-center.tsx`, Newsletter-/E-Mail-/Launch-Scope-Zielsuites | Technischer OFF-Zustand geschlossen. Resend/Domain/From/QA-Mailbox und Product-Einstufung bleiben offen; spätere Aktivierung benötigt genau einen allowlisteten QA-Send plus Cleanup. |
| Public Booking – Create/Cancel/Reschedule ohne abgeschlossene Provider-/Recovery-Abnahme | Alle drei öffentlichen Write-Pfade enden vor Body-Parsing, DB und Provider mit stabiler 503/no-store-Launch-off-Antwort. Auch das Erstellungsrepository verweigert vor Verfügbarkeits-/DB-/Providerzugriff; die UI zeigt lokalisierten OFF-Status und rendert keine Write-Formulare. Der Legacy-Resolver propagiert DB-Ausfälle statt sie als 404 zu maskieren. | `src/lib/meetings/booking-lifecycle.ts`, `src/app/api/meetings/bookings/route.ts`, Cancel-/Reschedule-Routen, `src/lib/db/meeting-repositories.ts`, `src/app/book/public-booking-page.tsx`, Booking-/i18n-Zielsuites | Technischer OFF-Zustand und Fehlerklassifikation geschlossen. Product-/Providerfreigabe, QA-Kalender, vollständiger Lifecycle und Cleanup sind vor späterem ON zwingend. |
| Knowledge – lokaler Embedding-Fallback konnte als semantischer Providerpfad wirken | Freigegebene Imports und semantische Suche verlangen einen konfigurierten externen Provider; jeder lokale Fallback/Timeout endet fail-closed mit 503, bevor persistiert bzw. gesucht wird. Source und Chunks werden atomar und projekt-/tenantgebunden geschrieben; Logs verwenden feste redigierte Gründe statt roher Provider-`error.message`. | `src/app/api/bots/knowledge/route.ts`, `src/lib/integrations/embeddings.ts`, `src/lib/db/runtime-repositories.ts`, `scripts/forms-knowledge-production-truth-tests.mjs` | Knowledge-Teil von LS-13 einschließlich Log-Redaction im Kandidaten geschlossen; Providerziel, QA-E2E und separate Bot-Chat-Fallback-Entscheidung bleiben offen. |
| Unit/Building – parallele Doppelerstellung und instabile Replayantwort | Semantische Unit-/Building-Idempotenz-Ledger, tenantqualifizierte FKs und stabile Response-Replay-/409-Konfliktsemantik. Der Advisory Lock läuft als separate Anweisung in derselben Tenant-Transaktion; Domain-, Ledger- und Auditwrite sind atomar. | `src/lib/db/property-inventory-repositories.ts`, `migrations/069_property_unit_idempotency.sql`, Inventory-/Migration-/Reset-Zielsuites (44/44) | P1 im Kandidaten geschlossen; Migration 069 und echtes DB-Concurrency-/Zwei-Tenant-E2E bleiben offen. |
| Public Forms – Teilpersistenz, instabile Multipart-Retries und interne DTO-/Response-Daten | Semantischer Multipart-Fingerprint, leaseVersion-Fencing und ein atomarer Domain-/Minimalresponse-CTE mit exakter Replayresponse; Public Deep-Allowlist-DTO nur über `field.id`; Owner-Tenant-Guard über Migration 071; shared Email-/Phone-Identity-Locks mit Funnel und Collision/Hijack fail-closed. | `src/app/api/forms/submissions/route.ts`, `src/lib/public-form-dto.ts`, `src/lib/db/form-repositories.ts`, `migrations/071_forms_owner_tenant_guard.sql`, `migrations/072_form_submission_atomicity.sql`, `scripts/form-submission-atomicity-tests.mjs` (12/12), Migration-Guards 20/20 | Kandidatencode geschlossen; Migrationen 071/072 sowie deploytes Submit-/Cleanup-E2E fehlen. |
| Public Forms – File/RoundRobin/Custom Pattern/Consent ohne tragfähigen Runtimevertrag | Admin-Save/UI, Public Page, Embed und Submission-API verweigern diese Modi konsistent. Public Body maximal 256 KiB und 0 Dateien; auch authentifiziertes Admin-JSON ist streamingbegrenzt auf 256 KiB. Consent nutzt eine feste Truthy-Positiv-Allowlist, verlangt required/unconditional/unchecked Privacy, trennt Marketing als unconditional/unchecked und blockt Analytics/unclassified. | `src/lib/public-form-dto.ts`, `src/lib/form-consent.ts`, `src/app/forms/public-form-page.tsx`, `src/app/forms/embed/route.ts`, `src/app/api/forms/submissions/route.ts`, `src/components/form-command-center.tsx`, Forms 12/12, Reviewer-Zielbündel 39/39, finaler Forms/Knowledge/Public-Abuse-Freeze 26/26 | Technischer OFF-/Consent-/Body-Limit-Zustand im Kandidaten geschlossen. Spätere Aktivierung benötigt Product-Freigabe, sichere Implementierung und vollständige E2E-Abnahme. |

### 11.1 Unabhängiger Code-Abschlussreview und P2-Grenzen

Der Abschlussreview meldet für den lokalen Kandidatencode **0 offene P0 und 0 offene P1**. Unit 358/358, Remediation 120/120, finale Kernpfade 40/40, zusätzliche Migration/Unit/Newsletter-Zielgruppe 39/39, Funnel 29/29 sowie Forms/Knowledge/Public-Abuse 26/26, Typecheck, vollständiges ESLint, Security Audit ohne Vulnerabilities, `git diff --check` und Next-Production-Build mit 82 Seiten sind grün. Der Windows-QA-Target-Entrypoint verweigert ohne QA-Fingerprint mit Exit 1. Dies ist keine Product-Freigabe und keine deployte Scope-Abnahme.

Verbleibende P2-/Scope-relevante Grenzen:

- Public-Submission-Proofs laufen nach 15 Minuten ab; ein Refreshflow für lange Form-/Funnel-Sessions fehlt.
- Die fachliche Kopplung von Unit-Status zu Buyer-/Deal-Beziehungen ist nicht vollständig serverseitig erzwungen.

Diese Punkte sind ohne Owner/Termin/Risikoakzeptanz nicht als Nach-Go-Live-Backlog genehmigt.

P3-Härtungshinweis: Der shared bounded-JSON-Reader berechnet im Forms-Editor einen dort ungenutzten HMAC-Fingerprint und koppelt diesen Adminpfad unnötig an das korrekt erforderliche `NOVALURE_ABUSE_SECRET`. Bei korrekter Go-Live-ENV ist dies kein Sicherheits- oder Releaseblocker; die Verantwortlichkeiten sollten später entkoppelt werden.

### 11.2 Warum `SCOPE-01` trotzdem blockiert bleibt

Die dokumentierten Remediations beseitigen konkrete False-Green-, Public-Access-, Datenintegritäts- und Scheinfunktionsrisiken oder setzen nicht abgenommene Write-Flächen technisch fail-closed. Sie ersetzen aber nicht die verbindliche Gesamtentscheidung:

1. Es gibt weiterhin keine von Product, Engineering, Security und Operations signierte, versionierte Matrix, die **jede** inventarisierte Produktfläche genau als `LAUNCH-ON`, `LAUNCH-OFF` oder `INTERNAL-ONLY` einstuft.
2. Es gibt weiterhin keinen zentralen serverseitigen Scope-Guard, der denselben Zustand konsistent auf Navigation, Quick Actions, Direkt-URLs, APIs, Cron, Queue und Provider-Side-Effects erzwingt.
3. Für die übrigen OFF-/INTERNAL-Surfaces fehlt weiterhin die vollständige Direct-URL-/API-/Rollen-/Tenant-Negativmatrix.
4. Die hier dokumentierten Änderungen sind Kandidaten-Code ohne Preview-/Produktionsdeployment und daher keine Live-Abnahme.

Damit bleiben insbesondere LS-01, LS-02, LS-03, LS-04, LS-11, der nicht zentral geschlossene Teil von LS-12, die Bot-Chat-/Productseite von LS-13 und LS-14 sowie die nicht entschiedenen Produktflächen offen. `SCOPE-01` bleibt bis zur signierten Matrix, zentralen Enforcement-Policy und vollständigen Negativverifikation **FEHLER / RELEASEBLOCKER**.

## 12. Aktueller LB-04-Gate-Status

| Gate | Status | Begründung |
|---|---|---|
| vollständige Inventur von Navigation, Quick Actions, Public Routes, APIs und Providern | BESTANDEN (Code-Inventur) | Abschnitte 5–9; Kandidaten-Delta in Abschnitt 11 |
| verbindliche Product-Einstufung | NICHT AUSGEFÜHRT | kein freigegebener Input vorhanden |
| serverseitige Scope-Erzwingung | FEHLER | einzelne Funktionsgrenzen gemäß Abschnitt 11 remediated; zentrale Policy und übrige Restlücken fehlen |
| Direct-URL/API-Negativmatrix je OFF/INTERNAL-Funktion | NICHT AUSGEFÜHRT | Entscheidungen und gemeinsame Policy fehlen |
| `SCOPE-01` | **FEHLER / RELEASEBLOCKER** | `PENDING PRODUCT DECISION` ist nicht launchfähig |
