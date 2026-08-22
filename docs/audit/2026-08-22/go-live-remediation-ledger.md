# Go-Live-Remediation-Ledger — novalure-crm.app

Stand: 22.08.2026<br>
Projekt: novalure-crm.app<br>
Arbeitsbranch: <code>codex/go-live-remediation-20260822</code><br>
Ausgangs-/Live-SHA zum Prüfstart: <code>77b751d6568487193e9151c7b16545649cfacde7</code>
Finale Remediation-SHA: wird nach dem Dokument-Freeze im Handoff ausgewiesen.

## 1. Aussagegrenzen und Statuslogik

Dieses Ledger trennt strikt zwischen:

- belegten Code-, Contract- und lokalen Buildtests;
- read-only erhobener Live-/Vercel-Evidenz;
- nicht ausgeführten Preview-, Provider-, Datenbank- und Production-Prüfungen;
- produktiven Änderungen, die ohne ausdrückliche Freigabe nicht vorgenommen wurden.

Ein Gate ist nur dann als <strong>PASS / BESTANDEN</strong> markiert, wenn der im Master-Prompt geforderte Nachweis für den geprüften Scope vorliegt. Ein vorhandener Unit- oder Contract-Test schließt kein Gate, das zusätzlich einen echten Preview-, Provider-, Zwei-Tenant-, Browser-, Cleanup- oder Production-Nachweis fordert. <strong>NOT RUN / NICHT AUSGEFÜHRT</strong> zählt gemäß Master-Prompt als nicht bestanden.

Aktuelle Gesamtentscheidung: <strong>NO-GO</strong>.

## 2. Umgesetzte Remediation im Code

### Persistenz und Public Resolver

- Forms verwenden DB-only-Wahrheit; Fixture-/Fallback-Ausgaben wurden entfernt.
- Public-Form-Resolver, optimistische Versionierung und Owner-Tenant-Guards wurden gehärtet. Der Kandidat besitzt einen lease-gefenceten atomaren Domain-/Minimalresponse-CTE, einen semantischen Multipart-Fingerprint und shared Email-/Phone-Identity-Locks mit Funnel. Exact Replay liefert öffentlich nur `{persisted:true}`; Identity-Collision/Hijack schlägt fail-closed fehl.
- Die Public-Form-DTO ist eine explizite Allowlist und veröffentlicht nur öffentliche `field.id`-Namen; Hidden-Defaults bleiben serverautoritativ. File (0 Dateien/256 KiB Body), RoundRobin, Custom Pattern und unsichere Consent-Konfigurationen sind in Admin-Save/UI, Public Page, Embed und Submission-API fail-closed. Consent verwendet eine feste Truthy-Positiv-Allowlist; Privacy ist required/unconditional/unchecked, Marketing getrennt/unconditional/unchecked, Analytics und unclassified bleiben off.
- Der authentifizierte Forms-Admin-JSON-Write ist auf 256 KiB streamingbegrenzt. Legacy Booking propagiert Datenbankfehler statt sie als 404 zu maskieren. Knowledge-Logs verwenden feste redigierte Gründe statt rohe `error.message`.
- Knowledge Sources und Chunks verwenden DB-only-Wahrheit; Source plus Chunks werden atomar geschrieben. Freigegebene Imports und semantische Suche benötigen einen konfigurierten externen Embedding-Provider und schlagen bei lokalem Fallback oder Timeout vor Persistenz/Suche mit 503 fail-closed fehl.
- Funnel-Daten und KPIs verwenden persistierte Daten; Fixture-Fallbacks wurden entfernt.
- Funnel-Preview ist tenant- und authentifizierungsgebunden; Live-Zugriff erfordert Token, aktiven Status und persistierten Blueprint.
- Gespeicherte Funnel-Inhalte werden als sicherer Plaintext behandelt.
- Die öffentliche Funnel-Grenze serialisiert ausschließlich eine tief explizit allowlistete Renderer-DTO. Publish-Token, Workspace-/Projekt-/CRM-IDs, Handover-, Empfänger-, Provider- und interne Trackingdaten bleiben serverseitig; die Live-Submission-Response ist minimal.
- Funnel-Submissions canonicalisieren Blueprint-Felder, Identity-Aliasse, Consent und Scores und persistieren die Domainkette in einem atomaren DML-CTE mit lease-gefenceter Replayresponse. Vorgelagerte Email-/Phone-Identity-Advisory-Locks laufen als separate Anweisungen in derselben Tenant-Transaktion, sodass das Hauptstatement einen frischen Read-Committed-Snapshot erhält. Publish, Restore und Runtime verwenden denselben Preflight; ein aktiver, nicht submitbarer Blueprint oder ein mehrdeutiger Alias-Contract wird vor Veröffentlichung abgelehnt.
- Form und Funnel verwenden denselben Contact-Identity-Advisory-Lock-Namespace für normalisierte E-Mail und Telefonnummer; Cross-Channel-Submits teilen damit dieselbe tenantgebundene Serialisierungsgrenze.

### Explizite Launch-Off-Grenzen

- Outbound-Funnel-Webhooks sind explizit LAUNCH-OFF: Konfiguration wird in der Oberfläche verborgen, vom API-Contract entfernt und beim Speichern aus persistierten Daten entfernt.
- Import ist in Desktop-, Mobile- und Quick-Action-Oberflächen explizit LAUNCH-OFF. Im geprüften Codebestand existiert kein entsprechender Server-Importendpunkt; eine zentrale serverseitige Launch-Scope-Policy fehlt weiterhin.
- Newsletter-Versand ist in API und UI explizit LAUNCH-OFF; der API-Pfad beendet vor Providerzugriff mit 503/no-store.
- Öffentliche Booking-Erstellung, -Stornierung und -Umbuchung sind in Route und UI explizit LAUNCH-OFF. Zusätzlich beendet auch das Erstellungsrepository vor DB-/Providerzugriff fail-closed.

### Newsletter und E-Mail

- Unsubscribe-GET ist read-only.
- Abmeldeinformationen werden als opaker AES-GCM-Token im URL-Fragment übertragen.
- Bestätigung erfolgt über einen expliziten Same-Origin-POST auf <code>/unsubscribe/confirm</code>.
- Suppression, Kontaktstatus und Consent werden workspace-gebunden atomar aktualisiert; die Antwort enthält keine PII.
- Die Resend-Produktionsgrenze verlangt exakten Key und From-Wert, besitzt keinen Mock-/Fallback-Pfad, unterstützt eine QA-Allowlist und redigierte Fehler sowie Timeout-, Idempotenz- und Größenbegrenzungen.
- Alte unsichere Abmeldelinks werden absichtlich nicht akzeptiert.
- Die Newsletter-Send-Oberfläche und der Send-Endpunkt sind unabhängig von vorhandenen Resend-Werten hart inaktiv; eine spätere Aktivierung benötigt eine neue Product-/Providerabnahme.

### Booking

- DST-Behandlung, Slot-Serialisierung, Correlation IDs, Idempotenz und Zustands-Claims liegen als gehärtete, derzeit inaktive Implementierung vor.
- Öffentliche Create-/Cancel-/Reschedule-POSTs antworten vor Body-Parsing, Datenbank und Provider mit einem stabilen Launch-off-Fehler; die UI zeigt einen lokalisierten OFF-Status statt Write-Formularen.
- Auch das Repository verweigert die Booking-Erstellung vor Verfügbarkeits-, DB- oder Providerzugriff. Ein echter QA-Kalender-/Provider-E2E bleibt vor einer späteren Aktivierung zwingend.

### Inventory

- Unit- und Building-Erstellung verwendet semantische Idempotenz-Ledger mit tenantqualifizierten Fremdschlüsseln und stabiler Response-Replay-/409-Konfliktsemantik.
- Der Identitäts-Advisory-Lock wird als separate Anweisung innerhalb derselben Tenant-Transaktion ausgeführt; dadurch sieht der nachfolgende atomare Domain-/Ledger-/Auditwrite einen frischen Read-Committed-Snapshot.
- Migration <code>069</code> legt die zwei Ledger-Tabellen an, widerruft die Tenant-Rolle zunächst vollständig und erteilt nur die benötigten Rechte. Die Migration ist auf Production nicht angewendet.

### Release, Governance und QA-Reset

- Release-Cockpit-API und -UI verwenden einen expliziten Contract; Diagnoseprobleme werden aus realen Ergebnissen abgeleitet.
- Systemdiagnostik akzeptiert nur <code>platform_admin</code> oder <code>novalureAdmin</code>.
- Statische bzw. unbelegte Aussagen wie „QA-verifiziert“ wurden aus der Governance-Ansicht entfernt; offene Evidenz wird amber dargestellt.
- QA-Reset-Code und die manuelle Migration <code>068</code> enthalten Allowlist, Dry-run, Audit, CSRF, exakte Platform-Admin-Prüfung, FK-Abschluss und Blockierung externer Assets.
- Der Legacy-Reset ist deaktiviert.
- Migration <code>068</code> wurde nicht auf Production angewendet.
- Der Windows-Entrypoint des QA-Target-Guards verweigert ohne freigegebenen QA-Fingerprint mit Exit 1; ein Shell-/Entrypoint-Bypass ist geschlossen.

### Validierung, Navigation, Security, Consent und i18n

- Inventory verwendet gemeinsame Validierung und Idempotenz.
- Deal-Erstellung validiert explizit, vermeidet stille Returns und schützt mit <code>useRef</code> vor Doppelauslösung.
- Die Profilnavigation hält den <code>#analysis</code>-Invariant.
- CSP verwendet Nonce plus <code>strict-dynamic</code>, begrenzte Framing-Regeln und einen sicheren Fallback.
- Consent besitzt einen zugänglichen Dialog, Kategorien und Storage-Synchronisation.
- Nach einem im lokalen Browser gefundenen Fokusverlust wurde der Consent-Trigger im DOM gehalten und der Fokus beim Schließen zuverlässig zurückgeführt.
- Public Language/Booking behandelt Locale, dynamische 404 und <code>noindex</code> explizit.

## 3. Automatisierte Test- und Build-Evidenz

Die folgenden Ergebnisse wurden im sauberen Worktree erhoben. Sie belegen den lokalen Codezustand, ersetzen aber keine noch fehlenden Preview-/Production-E2E-Nachweise. Unit 358/358, gezielte Kernpfade, ESLint, Typecheck, Security Audit, Diff-Check und Production-Build sind auf dem final revalidierten Codezustand grün; die lokale Abschluss-SHA wird nach dem Dokument-Freeze im Handoff ausgewiesen.

| Command/Suite | Ergebnis | Einordnung |
|---|---:|---|
| <code>npm ci</code> | Exit 0 | reproduzierbare Installation im lokalen Worktree |
| <code>npm run ci:toolchain</code> | fehlgeschlagen | lokal Node 24.18.0/npm 11.16.0, Repo-Pin Node 24.14.0; lokaler Release-Nachweis daher nicht exakt |
| <code>npm run lint</code> | Exit 0 | vollständiges ESLint auf final revalidiertem Codezustand |
| <code>npm run typecheck</code> | Exit 0 | final revalidierter Codezustand |
| <code>npm run test:unit</code> | 358/358 | 238/238 Basissuite plus 120/120 Go-Live-Remediation, zwei Runner |
| Funnel-Zielsuites | Deep-DTO 4/4; finaler Consent-/Alias-/Publish-Preflight-Zielstand 29/29; früherer breiter P1-Handoff 99/99 | Deep-Redaction, Minimalresponse, Atomizität, Abuse/Lease, Fresh Snapshot und einheitlicher Publish-/Restore-/Runtime-Preflight lokal belegt |
| Unit-/Building-Zielsuites | 44/44 | nach Tenant-Transaction-/Fresh-Snapshot-Fix |
| Knowledge-Zielsuite | 6/6 | nach External-Provider-Fail-Closed-Fix |
| Form-Zielsuite | 12/12; unabhängiges Reviewer-Zielbündel 39/39 | DTO/Minimalresponse, Atomizität/Replay, Identity, Consent und Launch-off-Grenzen nach letzter Consent-Nachschärfung belegt |
| Forms + Knowledge + Public Abuse | 26/26 | finaler Freeze nach bounded Admin-JSON, Knowledge-Log-Redaction und Public-Abuse-Nachschärfungen |
| Migration-Guards im Forms-Handoff | 20/20 | Migrationen 069–072/Dependencies und Safety-Contracts im Zielstand |
| <code>npm run test:go-live-remediation</code> | 120/120 | nach letzter Forms-Consent-Nachschärfung |
| finale gezielte Kernpfade | 40/40 | unabhängiger Abschlussreview |
| finale Migration/Unit/Newsletter-Zielgruppe | 39/39 | einschließlich Migration-Teil 20/20 |
| Booking-Zielsuites | gezielt grün | Create/Cancel/Reschedule Launch-off in API, Repository und UI; im Remediation-Lauf 120/120 enthalten |
| <code>npm run test:integration</code> | 15/15 bestanden | lokaler Integrationstest |
| <code>npm run test:i18n</code> | 10/10 bestanden | lokaler i18n-Test |
| <code>npm run test:company-profile-settings</code> | 7/7 bestanden | lokaler Settings-Test |
| <code>npm run test:contact-access</code> | 4/4 bestanden | lokaler Contact-Access-Test |
| <code>npm run test:property-department</code> | 18/18 bestanden | lokaler Property-Test |
| Production-Security-Suite | bestanden, 0 Vulnerabilities | lokaler automatisierter Security-Nachweis |
| <code>npm run build</code> | Exit 0 | finaler Next-Production-Build grün; 82 Seiten plus dynamische Routen |
| <code>git diff --check</code> | Exit 0 | keine Whitespace-/Patch-Formalfehler |
| <code>npm run release:verify-vercel-env</code> | nicht erfolgreich | lokaler Lauf verlangt <code>VERCEL_TOKEN</code>; Live-Metadaten wurden separat read-only geprüft |

Der final revalidierte Codezustand ist für Unit 358/358, ESLint, Typecheck, Security Audit, gezielte Kernpfade, Diff-Check und Production-Build grün. Ältere Werte wie 314/314, 315/315 oder Booking 5/5 sind supersediert. Die lokale Abschluss-SHA wird nach dem Dokument-Freeze im Handoff ausgewiesen.

Neue, über <code>test:go-live-remediation</code> in <code>test:unit</code> eingebundene Suites:

- <code>booking-lifecycle-remediation-tests.mjs</code>
- <code>content-security-policy-tests.mjs</code>
- <code>cookie-consent-accessibility-tests.mjs</code>
- <code>deal-create-ux-regression-tests.mjs</code>
- <code>email-production-boundary-tests.mjs</code>
- <code>form-submission-atomicity-tests.mjs</code>
- <code>forms-knowledge-production-truth-tests.mjs</code>
- <code>funnel-production-boundary-tests.mjs</code>
- <code>funnel-public-access-tests.mjs</code>
- <code>funnel-public-dto-security-tests.mjs</code>
- <code>funnel-safe-content-tests.mjs</code>
- <code>funnel-submission-abuse-remediation-tests.mjs</code>
- <code>inventory-validation-regression-tests.mjs</code>
- <code>launch-scope-fail-closed-tests.mjs</code>
- <code>navigation-profile-invariant-tests.mjs</code>
- <code>newsletter-unsubscribe-security-tests.mjs</code>
- <code>public-booking-i18n-remediation-tests.mjs</code>
- <code>qa-reset-safety-tests.mjs</code>
- <code>readonly-audit-safety-tests.mjs</code>
- <code>system-releases-contract-tests.mjs</code>

Damit sind derzeit 20 Remediation-Suites in <code>test:go-live-remediation</code> verdrahtet; die finale aggregierte Zahl wird erst nach dem stabilen Gesamtlauf eingetragen.

## 4. Live-/Vercel-Evidenz, ausschließlich read-only

| Gegenstand | Evidenz | Bewertung |
|---|---|---|
| Vercel-Projekt | <code>novalure/novalure-crm</code> | identifiziert |
| Deployment-ID | <code>dpl_4r6tWnAMRAPMpeBbhGegYzu5tu1C</code> | READY, Production |
| Deployment-URL | <code>novalure-msj34yn5t-novalure.vercel.app</code> | aktuelles Baseline-Deployment, nicht der Remediation-Kandidat |
| Source-SHA | <code>77b751d6568487193e9151c7b16545649cfacde7</code> | entsprach beim Prüfstart dem damaligen Main-/Live-Stand |
| Logs | 24-Stunden-Read-only-Prüfung ohne Fehler/5xx | kein kontrollierter Fehler-/Trace- oder Alarmtest |
| frühere CI | grün | gilt für Baseline-SHA, nicht für den noch nicht deployten Remediation-Kandidaten |
| Vercel CLI | über <code>npx --yes vercel@latest</code>, Version 59.4.0 nutzbar | globale Installation fehlt; <code>npm i -g vercel</code> wird stark empfohlen, um <code>vercel env pull</code>, <code>vercel deploy</code> und <code>vercel logs</code> direkt nutzen zu können. Das Fehlen der globalen CLI ist selbst kein Releaseblocker |
| Marketplace | Neon vorhanden, Resend nicht installiert | MAIL-01 offen |

Es wurde kein Remediation-Preview und kein Remediation-Production-Kandidat deployt. Daher dürfen Baseline-Deployment und Baseline-Logs nicht als Evidenz für den geänderten Code verwendet werden.

## 5. ENV-01 — Fingerprints und harter Stopp

Es wurden nur nicht reversible Secret-Werte ausschließende Fingerprints bzw. Key-Metadaten erfasst.

| Ziel | Production | Preview | Ergebnis |
|---|---|---|---|
| Datenbank | <code>sha256:36e38778071baa281fe6</code> | <code>sha256:b8d9af25b0eeccdf276e</code> | verschieden |
| Private Blob | <code>sha256:7c024de0f594165110e9</code> | <code>sha256:7c024de0f594165110e9</code> | identisch, Gate-Fehler |
| Queue | Ziel nicht eindeutig belegt | Ziel nicht eindeutig belegt | Gate-Fehler |
| Provider | Ziel/Scope nicht eindeutig getrennt | Ziel/Scope nicht eindeutig getrennt | Gate-Fehler |

Zusätzliche Env-Metadaten:

- <code>RESEND_FORM</code> ist vorhanden; <code>RESEND_FROM</code> fehlt.
- <code>NOVALURE_EMAIL_FROM</code> ist in Production vorhanden.
- Provider-Key-Metadaten umfassen Preview und Production; eine sichere Trennung wurde nicht nachgewiesen.
- Private-Blob-Konfiguration umfasst Preview und Production und zeigt auf denselben Fingerprint.

Konsequenz: ENV-01 ist <strong>FAIL / FEHLER</strong>. Deshalb wurden weder Preview-Seed noch Preview-CRUD, Upload, Provider-Smoke oder Reset ausgeführt.

## 6. Produktionsschema und Migration-Ledger, read-only

### 6.1 Historischer Production-Audit

Dieser Audit wurde vor den Kandidatenmigrationen 069–072 erhoben und darf nicht als Schemaaudit des aktuellen Worktrees ausgegeben werden.

| Prüfung | Historisches Production-Ergebnis |
|---|---|
| damals erwartete Tabellen | 115 |
| tatsächlich vorhandene Tabellen | 112 |
| aktuelle Ledger-Migration | <code>067_app_role_runtime_grants</code> |
| checksummierte Ledger-Zeilen | 19 |
| damals ausstehende manuelle/Kandidatenmigrationen | <code>057</code>, <code>060</code>, <code>061</code>, <code>062</code>, <code>065</code>, <code>068</code> |
| fehlende Tabellen | <code>qa_batches</code>, <code>qa_batch_objects</code>, <code>qa_reset_audit_events</code> |
| Gesamtresultat des Audits | <code>ok: false</code> |

### 6.2 Aktueller nicht deployter Release-Kandidat

| Prüfung | Kandidatenstand |
|---|---|
| erwartete Tabellen laut <code>src/lib/db/schema.ts</code> | 117 |
| neue, nicht angewendete Kandidatenmigrationen | <code>068</code> QA-Reset, <code>069</code> Unit-/Building-Idempotenz, <code>070</code> Funnel-Recovery, <code>071</code> Forms-Owner-Tenant-Guard, <code>072</code> Form-Submission-Atomizität |
| zusätzliche Tabellen gegenüber dem 115er Auditstand | <code>property_unit_idempotency</code>, <code>property_building_idempotency</code> aus Migration 069 |
| auf Production angewendet | keine der Migrationen 068–072 |

Es erfolgte keine Migration und kein Schema-Write. Die kontrollierte Kette bis 072 darf erst nach Backup, Dry-run, geprüftem Rollback, Restore-Nachweis und ausdrücklicher DBA-/Release-Freigabe angewendet werden.

## 7. Verbindliche Gate-Matrix

Zusammenfassung: 2 PASS, 6 FAIL, 38 NOT RUN. Da jedes NOT RUN laut Master-Prompt als Fehler zählt, ist eine GO-Entscheidung ausgeschlossen.

| Test-ID | Status | Präziser Nachweis bzw. Grund |
|---|---|---|
| REL-01 | FAIL / FEHLER | finaler Codezustand für Unit 358/358, ESLint, Typecheck, Security Audit, gezielte Kernpfade und Production-Build grün; exakter Node-Pin verfehlt, lokale Abschluss-SHA folgt im Handoff, kein deployter Kandidat und keine SHA-/Deployment-/Alias-Parität |
| REL-02 | FAIL / FEHLER | historischer Production-Audit <code>ok: false</code> bei 112/115 Tabellen und Ledger 067; Kandidat erwartet 117 Tabellen und Migrationen 068–072, ohne Production-Anwendung |
| REL-03 | NOT RUN / NICHT AUSGEFÜHRT | kein Restore-Drill, kein privater-Blob-End-to-End, kein Queue-/Cron-SLO und keine signierte Ops-Evidenz |
| REL-04 | NOT RUN / NICHT AUSGEFÜHRT | fünf Unternehmensprofilblocker sowie Legal-/Ops-Abnahme nicht belegt |
| SCOPE-01 | FAIL / FEHLER | Inventar vorhanden und einzelne Flächen fail-closed; vollständige signierte ON/OFF/INTERNAL-Matrix und zentrale serverseitige Durchsetzung fehlen |
| ENV-01 | FAIL / FEHLER | Private Blob identisch; Queue- und Providerziele unklar |
| DATA-01 | PASS / BESTANDEN | Forms, Knowledge und Funnel verwenden DB-only-Wahrheit; automatisierte Produktionswahrheits-/Fallback-Negativtests grün |
| DATA-02 | NOT RUN / NICHT AUSGEFÜHRT | kein vollständiger UI/API/DB-Drei-Wege-Abgleich für alle Launch-KPIs |
| CRUD-01 | FAIL / FEHLER | QA-Reset-Tabellen/Migration fehlen in Production; keine zwei QA-Tenants und kein Reset-E2E |
| CRUD-02 | NOT RUN / NICHT AUSGEFÜHRT | vollständige CRM-Kernkette Create→Reload→Update→Relation→Filter→Cleanup nicht in isolierter QA-Umgebung ausgeführt |
| CRUD-03 | NOT RUN / NICHT AUSGEFÜHRT | einzelne Idempotenz-/Validierungsfixes getestet, aber keine vollständige Doppelklick-/Zwei-Tab-/Offline-/Retry-Matrix |
| FORM-01 | NOT RUN / NICHT AUSGEFÜHRT | Resolver-/Persistenz-Code gehärtet, aber kein Adminstatus/DB/Canonical/Embed-E2E auf einem Kandidaten |
| FORM-02 | NOT RUN / NICHT AUSGEFÜHRT | atomarer Submission-/Minimal-Replay-, DTO-, Identity- und Consent-Contract lokal 12/12, Migration-Guards 20/20; echter allowlisteter QA-Submit mit Relations- und Cleanup-Abgleich fehlt |
| BOOK-01 | NOT RUN / NICHT AUSGEFÜHRT | öffentliche Create-/Cancel-/Reschedule-Pfade sind in API, Repository und UI Launch-off; echter QA-Kalender-/Providerstatus und Cleanup vor späterem Launch-on fehlen |
| MAIL-01 | FAIL / FEHLER | Resend nicht installiert, From-/Env-Metadaten inkonsistent, Domain/Readiness und allowlistete QA-Mail nicht belegt |
| MAIL-02 | NOT RUN / NICHT AUSGEFÜHRT | redigierte Fehler-/Timeout-Grenzen im Code; kein kontrollierter echter Providerfehler mit End-to-End-Nachweis |
| AUTH-01 | NOT RUN / NICHT AUSGEFÜHRT | keine vollständige Login/MFA/Reload/Logout/CSRF/Rate-Limit/Ablauf/Token-Matrix |
| RBAC-01 | NOT RUN / NICHT AUSGEFÜHRT | keine vollständige serverseitige Owner/Agent/Assistant/Viewer-Endpoint- und UI-Matrix |
| TENANT-01 | NOT RUN / NICHT AUSGEFÜHRT | keine Zwei-Tenant-IDOR-Suite gegen isolierte QA-Daten |
| TENANT-02 | NOT RUN / NICHT AUSGEFÜHRT | keine vollständigen URL/API/Export/Relationship-Negativtests für ungültige IDs |
| I18N-01 | NOT RUN / NICHT AUSGEFÜHRT | lokale i18n-Tests grün; vollständige Route×Locale×Navigation×Reload-Matrix fehlt |
| I18N-02 | NOT RUN / NICHT AUSGEFÜHRT | einzelne lokale DOM-/Metadata-Beobachtungen; vollständige Pflicht-Routen-Matrix fehlt |
| I18N-03 | NOT RUN / NICHT AUSGEFÜHRT | keine vollständigen DE/EN CRM-, Template-, Validierungs-, Toast-, Format- und Mail-E2Es |
| LEGAL-01 | NOT RUN / NICHT AUSGEFÜHRT | vollständiger DE/EN-Content und fachlicher Legal-Sign-off fehlen |
| FALLBACK-01 | NOT RUN / NICHT AUSGEFÜHRT | Produktentscheidung und vollständiger Nachweis für ES, Deaktivierung oder korrekten EN-Fallback fehlen |
| UX-01 | NOT RUN / NICHT AUSGEFÜHRT | Validierungsfixes lokal getestet; keine vollständigen Browser-/Network-Assertions null Request invalid/ein Request valid |
| UX-02 | PASS / BESTANDEN | automatisierter Profil-/<code>#analysis</code>-Navigationsinvariant grün |
| A11Y-01 | NOT RUN / NICHT AUSGEFÜHRT | kein vollständiger Axe-, Tastatur- und Screenreader-Nachweis für Form und Booking |
| A11Y-02 | NOT RUN / NICHT AUSGEFÜHRT | Consent-Fokusfix lokal gezielt geprüft; vollständige Drawer-/Inert-/Touch-/Overflow-Matrix bei 320/375/390/430 px fehlt |
| SEC-02 | NOT RUN / NICHT AUSGEFÜHRT | CSP, Consent, Unsubscribe und Public-Token-Grenzen automatisiert gehärtet; vollständige Header/Cookie/CORS/private-Media/DE-EN-Tastaturmatrix fehlt |
| FILE-01 | NOT RUN / NICHT AUSGEFÜHRT | kein PDF/JPG/PNG/DOCX-, MIME-, Übergröße-, Rechte-, Download-, Delete- und Cleanup-E2E |
| ADV-01 | NOT RUN / NICHT AUSGEFÜHRT | Funnel DB-only, Deep-DTO, Minimalresponse, atomarer DML-CTE und shared Email-/Phone-Identity-Fresh-Snapshot-Serialisierung über Form/Funnel lokal getestet; Publish-Token-Rotation und vollständiger Publish-/Analytics-/KPI-E2E fehlen |
| ADV-02 | NOT RUN / NICHT AUSGEFÜHRT | Knowledge Source/Chunk atomar und DB-only; approved/search ohne externen Embedding-Provider fail-closed; UI/API/DB-Semantik und Bot-Nachweis fehlen |
| ADV-03 | NOT RUN / NICHT AUSGEFÜHRT | Gesprächs-/Kanal-Scope nicht vollständig fachlich und technisch abgenommen |
| ADV-04 | NOT RUN / NICHT AUSGEFÜHRT | Customer/User/Grant-Semantik und 0-versus-4-Abgleich fehlen |
| ADV-05 | NOT RUN / NICHT AUSGEFÜHRT | Consent/Suppression/Unsubscribe-Code gehärtet; Newsletter-Send explizit Launch-off; exakt ein später freigegebener QA-Versand und Provider-/Cleanup-Evidenz fehlen |
| ADV-06 | NOT RUN / NICHT AUSGEFÜHRT | kein Detect/Resolve/Ignore/Merge-E2E ausschließlich auf QA-Daten |
| ADV-07 | NOT RUN / NICHT AUSGEFÜHRT | keine vollständige QA-Sandbox-/Approval-/Side-Effect-Matrix für Bots und Automation |
| ADV-08 | NOT RUN / NICHT AUSGEFÜHRT | Funnel-Webhooks und Import explizit LAUNCH-OFF; übrige OAuth-/Sync-/Notification-/Reservation-/Token-Lifecycle-Flächen nicht vollständig klassifiziert/abgenommen |
| SEARCH-01 | NOT RUN / NICHT AUSGEFÜHRT | kein vollständiger Suche/Umlaut/Filter/Sortierung/Pagination/QA-Export-Abgleich |
| PROP-01 | NOT RUN / NICHT AUSGEFÜHRT | Property-Tests 18/18 grün; fachliche Pflichtinhalte/Dokumente/Publish-Blocker nicht vollständig abgenommen |
| OBS-01 | NOT RUN / NICHT AUSGEFÜHRT | 24h Baseline-Logs ohne Fehler/5xx; kein kontrollierter Fehler bis Vercel/Provider und keine PII-/Secret-Prüfung auf Kandidatenlogs |
| OBS-02 | NOT RUN / NICHT AUSGEFÜHRT | keine getesteten Monitore/Alarme und kein vereinbarter Beobachtungsnachweis |
| PERF-01 | NOT RUN / NICHT AUSGEFÜHRT | kein Kandidaten-Lighthouse und keine p75-LCP/INP/CLS-Messung gegen vereinbarte Budgets |
| PROD-01 | NOT RUN / NICHT AUSGEFÜHRT | Remediation-Code nicht deployt; kein SHA-identischer Kandidat unter kanonischem Alias und kein kontrollierter Production-Smoke |
| CLEAN-01 | NOT RUN / NICHT AUSGEFÜHRT | keine QA-Writes durchgeführt, daher kein Batch und kein Cleanup nötig; verbindlicher Vorher/Nachher-Reconciliation-Lauf fehlt dennoch |

## 8. Befund → Fix → Test/Evidenz → Reststatus

| Befund | Umgesetzter Fix | Test/Evidenz | Reststatus |
|---|---|---|---|
| Fixture-/Fallback-Risiko bei Forms/Knowledge/Funnel | DB-only-Repositories und fail-closed Resolver; Knowledge approved/search nur mit externem Provider | zielgerichtete Forms-/Knowledge-/Funnel-Suites und Unit 358/358 | DATA-01 für den Code-Contract bestanden; deployed E2E weiterhin offen |
| Public Funnel überträgt internen Blueprint/Diagnostik | Deep-Allowlist-DTO; Public Proof statt Publish-Token im Browser/POST; minimale Live-Response ohne interne IDs; DB-Fehler bleiben 5xx | Funnel-Public-DTO-Security 4/4 und Funnel-Zielsuites | Kandidatencode geschlossen; externer Publish-Token muss vor GO rotiert werden; deployed E2E offen |
| Funnel-Submit konnte Teilwrites, parallele Kontaktduplikate oder Consent-/Alias-Drift erzeugen | atomarer Domain-/Claim-CTE; lease-gefencete Replayresponse; shared Form/Funnel-Email-/Phone-Identity-Advisory-Locks in Tenant-TX; kanonische Consent-/Identity-Aliasse; gemeinsamer Publish-/Restore-/Runtime-Preflight | Funnel-Abuse-/Migration-/Boundary-/Preflight-Zielsuites, finaler Freeze 29/29 | Kandidatencode geschlossen; echtes DB-Concurrency-/Zwei-Tenant-E2E offen |
| Funnel-Webhooks ohne freigegebenen Scope | Konfiguration/API/Persistenz/Adapter explizit LAUNCH-OFF | Funnel-Production-Boundary-Test | Teil von SCOPE-01; Gesamtgate offen |
| Import sichtbar, aber nicht freigegeben | Entry Points ausgeblendet; kein Server-Importendpunkt vorhanden | Launch-Scope-Fail-Closed-Test | zentrale Policy und Gesamtinventar-Sign-off fehlen |
| Unsicherer Unsubscribe-GET/PII-Link | opaker Fragmenttoken, expliziter POST, atomare Suppression/Consent-Aktualisierung | Newsletter-Unsubscribe-Security 7/7 | alter Link absichtlich ungültig; Provider-/QA-Versand offen |
| Newsletter-Versand ohne freigegebene Providerabnahme | API vor Providerzugriff 503/no-store Launch-off; UI-Sendaktionen verborgen | Newsletter-/E-Mail-/Launch-Scope-Zielsuites | Product-/Providerfreigabe und genau ein QA-Send offen |
| Booking-Race-/Lifecycle-Risiken ohne abgeschlossene Providerabnahme | öffentliche Create-/Cancel-/Reschedule-Route, Repository und UI hart Launch-off vor Body/DB/Provider; Legacy-Resolver propagiert DB-Ausfälle statt sie als 404 zu maskieren | Booking-/i18n-/Launch-Scope-Zielsuites sowie finaler P2-Recheck | Product-/Providerfreigabe und vollständiges QA-Lifecycle-E2E vor Launch-on offen |
| Unit-/Building-Doppelwrites bei Parallelität | semantische Idempotenz-Ledger; separate Advisory-Lock-Anweisung innerhalb Tenant-TX; atomarer Domain-/Ledger-/Auditwrite | 44/44 Unit-/Migration-/Reset-Zielsuites | Migration 069 und echtes DB-Concurrency-E2E offen |
| Form-Submit-Teilwrites/instabile Retries/Infoleak | lease-gefenceter atomarer Domain-/Minimalresponse-CTE; semantischer Multipart-Fingerprint; Public-Allowlist-DTO; Owner-Tenant-Guard; shared Identity-Locks/Conflict-Schutz; authentifiziertes Admin-JSON streamingbegrenzt auf 256 KiB | Forms 12/12, Reviewer-Bündel 39/39, Migration 20/20, Remediation 120/120, finaler Forms/Knowledge/Public-Abuse-Freeze 26/26 | Kandidatencode geschlossen; deploytes Submit-/Cleanup-E2E offen |
| File-/RoundRobin-/Custom-Pattern-/unsichere Consent-Formen wirkten public-fähig | Admin-Save/UI, Public Page, Embed und API durchgängig fail-closed; feste Consent-Truthy-Allowlist, Privacy/Marketing getrennt und nicht vorselektiert; Analytics/unclassified off | Forms 12/12 und Reviewer-Bündel 39/39 | Kandidatencode geschlossen; spätere Aktivierung benötigt eigene sichere Implementierung und E2E-Abnahme |
| E-Mail-Fallback-/Leak-Risiko | exakter Resend-Contract, keine Mock-Fallbacks, Allowlist, redigierte Fehler | Email-Production-Boundary-Test | Resend/Domain/From/QA-Mailbox nicht live validiert |
| Falsch-grünes Release-/Governance-UI | reale Contract-Diagnostik, statische Verifikation entfernt | System-Releases-Contract-Test | Production-Schema ist tatsächlich rot |
| Zu breite Systemdiagnostikrolle | exakt Platform Admin bzw. novalureAdmin | Contract-/Role-Test | vollständige RBAC-Matrix offen |
| Gefährlicher QA-Reset | Audit/Allowlist/Dry-run/CSRF/FK-Closure; Legacy deaktiviert | QA-Reset-Safety-Test | Migration 068 und echter QA-Reset nicht ausgeführt |
| Deal-/Inventory-Doppel- oder Silent-No-op-Risiko | gemeinsame Validierung, Idempotenz, sichtbare Fehler, Doppelklickguard | Deal-UX- und Inventory-Regressionstests | vollständige Browser-/Parallel-Tab-Matrix offen |
| Profilnavigation verliert Analysezustand | <code>#analysis</code>-Invariant | Navigation-Profile-Invariant-Test | UX-02 bestanden |
| Schwache CSP-/Framing-Grenze | Nonce, strict-dynamic, Frame-Restriktionen, Fallback-CSP | CSP-Test | vollständiger Kandidaten-Header-/Embed-E2E offen |
| Consent-Fokusverlust nach Escape | Trigger bleibt gemountet, verbundener Vorfokus wird erhalten und wieder fokussiert | gezielte Suite 3/3, Lint, Typecheck, Build | vollständige Mobile-/Screenreader-Matrix offen |
| falsche Sprache/dynamische Public-404 | Locale-, noindex- und Not-found-Grenzen | Public-Booking-i18n-Test und lokale DE-Beobachtung | vollständige Pflicht-Routen-Matrix offen |

### 8.1 Unabhängiger Abschlussreview

Ergebnis für den lokalen Kandidatencode: **0 offene P0, 0 offene P1**. Es wurden keine weiteren kritischen Security-, Tenant-, Datenintegritäts- oder Buildbefunde gefunden. Dieses Ergebnis schließt ausschließlich den statisch/lokal geprüften Code-Contract; die externen und E2E-Releasegates aus Abschnitt 9 bleiben unverändert offen.

Verbleibende P2-/Formalgate-Hinweise:

- Public-Submission-Proofs besitzen 15 Minuten TTL ohne Refreshflow für lange Form-/Funnel-Sessions.
- Die fachliche Kopplung von Unit-Status zu Buyer-/Deal-Beziehungen ist serverseitig nicht vollständig erzwungen.

Diese Punkte sind nicht als akzeptierter Nach-Go-Live-Backlog freigegeben; Owner, Termin, Ablaufdatum und Risikoakzeptanz fehlen.

Zusätzlicher P3-Härtungshinweis: Der shared bounded-JSON-Reader berechnet im Forms-Editor einen dort ungenutzten HMAC-Fingerprint und koppelt diesen Adminpfad unnötig an das für den Go-Live korrekt erforderliche <code>NOVALURE_ABUSE_SECRET</code>. Bei korrekter Go-Live-ENV ist dies kein Sicherheits- oder Releaseblocker; die Verantwortlichkeiten sollten später entkoppelt werden.

## 9. Verbleibende externe, fachliche und operative Blocker

1. Preview muss nachweislich getrennte DB-, private-Blob-, Queue- und Providerziele erhalten. Der gemeinsame Blob-Fingerprint und unklare Queue-/Providerziele blockieren jeden Preview-Write.
2. Die vollständige, versionierte und fachlich signierte Launch-Scope-Matrix ON/OFF/INTERNAL samt zentraler serverseitiger Durchsetzung fehlt.
3. Unternehmensprofil, rechtliche DE/EN-Inhalte, Legal-Sign-off, ES-Entscheidung und verbindliche KPI-Definitionen fehlen.
4. Production-Schema/Ledger ist nicht releasebereit: historisch 112/115 Tabellen bei Ledger 067; der Kandidat erwartet 117 Tabellen und die kontrollierte Kette 068–072.
5. Backup, Restore-Drill, RPO/RTO, Rollbackziel und DBA-/Releasefreigabe fehlen.
6. Resend-Integration, Domain/From/Key, eigene QA-Mailbox und genau ein echter allowlisteter Versand sind nicht validiert.
7. Eigener QA-Kalender und kompletter Booking-Lifecycle einschließlich Providerstatus und Cleanup sind nicht validiert; die öffentlichen Write-Pfade bleiben deshalb Launch-off.
8. Zwei QA-Tenants und echte Rollen für vollständige CRM-CRUD-, RBAC-, IDOR-, Auth-, Datei-, Newsletter-, Data-Hygiene-, Bot-, OAuth- und Integrations-E2Es fehlen.
9. Cron-/Queue-SLO, Recovery, Monitore und getestete Alarme fehlen.
10. Exakter lokaler Node-Pin 24.14.0 bzw. ein SHA-identischer CI-Nachweis ist offen.
11. Es gibt keinen deployten Remediation-Preview-/Production-Kandidaten, keine Kandidaten-Screenshots, kein vollständiges Axe-/Screenreader- und Mobile-Set und keine Lighthouse-/Web-Vitals-Evidenz.
12. Production-Beobachtungsfenster von 60 Minuten, 24 Stunden und sieben Tagen wurden für den Remediation-Kandidaten nicht begonnen.
13. Der bislang im öffentlichen Live-Funnel verwendete Publish-Token muss vor GO rotiert, die alte Capability widerrufen und die neue Capability kontrolliert verteilt werden. Diese externe Rotation wurde nicht ausgeführt.

## 10. Bewusst nicht ausgeführte Aktionen

Aufgrund von ENV-01, fehlenden Freigaben und fehlender QA-Isolation wurden folgende Aktionen nicht ausgeführt:

- keine Änderung von Vercel-Production-Env-Variablen;
- keine Providerdomain-, Key-, From-, Mailbox- oder Kalenderänderung;
- keine Production- oder Preview-Migration;
- kein Production- oder Preview-Seed;
- kein Preview-/Production-CRUD und kein Upload;
- kein echter Provider-Mailversand und kein Kalendereintrag;
- kein produktiver QA-Write;
- kein Cleanup/Reset in Production;
- keine historische Retry-/Recovery-Aktion;
- kein Deployment, keine Promotion, keine Aliasumschaltung und keine öffentliche Feature-Freischaltung;
- keine Blob-, Queue- oder Providerobjekte erzeugt;
- keine operative Testdatenbereinigung erforderlich; QA-Batch-ID: keine.

Damit wurden durch diesen Prüfstand weder Production-Daten noch Providerzustände verändert.

## 11. Aktionen mit ausdrücklicher Genehmigungspflicht

Vor Ausführung sind mindestens die jeweils genannten Freigaben und Sicherungen erforderlich:

| Aktion | Vorbedingung |
|---|---|
| Vercel-Production-Env ändern | schriftliche Release-/Ops-Freigabe, dokumentierter Vorherstand und Rollback |
| Preview-Ziele neu provisionieren/verbinden | freigegebene getrennte Ressourcen und erneuter fingerprintbasierter ENV-01-Nachweis |
| Providerdomain/Key/From ändern | Product/Ops/Provider-Freigabe, Domainverifikation, Secret-Rotation und Rollback |
| Produktionsmigrationen bis einschließlich Kandidatenstand 072 | Backup, Dry-run, geprüfter Rollback, erfolgreicher Restore-Drill, DBA-/Releasefreigabe |
| Funnel-Publish-Token rotieren | Security-/Ops-Freigabe, kontrollierte Verteilung, Widerruf der alten Capability, Audit und Negativtest der alten URL |
| Production-Deploy oder Promotion | alle Pflichtgates grün, exakte SHA/Lockfile/Env-Buildinput-Evidenz und Rollbackziel |
| produktiver QA-Write | allowlisteter QA-Workspace, genehmigter Batch, Monitoring und Reset-/Reconciliation-Plan |
| echte QA-Mail oder QA-Kalendereintrag | eigene allowlistete Empfänger/Ressourcen, Providerfreigabe und Cleanup |
| Cleanup/Reset in Production | genehmigter Dry-run, exakte QA-Allowlist, Audit und Vorher/Nachher-Zähler |
| historische Retry-/Recovery-Aktion | Incident-/Ops-Freigabe, Idempotenznachweis und begrenzter Scope |
| öffentliche Alias-/Feature-Freischaltung | separate finale GO-Freigabe nach bestandenen Gates |

## 12. Nächste kontrollierte Reihenfolge

1. Launch-Scope, Legal, Unternehmensprofil, ES und KPI-Definitionen fachlich signieren.
2. Getrennte Preview-Ressourcen für Blob, Queue und Provider bereitstellen und ENV-01 erneut read-only nachweisen.
3. Backup-/Restore-/Rollback-Verfahren abnehmen; Schema-Diff und manuelle Migrationen bis zum freigegebenen Kandidatenstand 072 mit DBA kontrolliert schließen.
4. Zwei QA-Tenants, Rollen, QA-Mailbox und QA-Kalender ausschließlich nach bestandenem ENV-01 anlegen.
5. Den bislang öffentlichen Funnel-Publish-Token kontrolliert rotieren und die alte Capability widerrufen.
6. Exakten Remediation-Kandidaten mit gepinntem Toolchain-Build als Preview deployen.
7. Vollständige Gate-Matrix einschließlich Zwei-Tenant-, Provider-, File-, A11y-, Mobile-, Performance- und Cleanup-E2Es ausführen.
8. Erst danach einen geschützten Production-Kandidaten genehmigen, smoke-testen, bereinigen und beobachten.
9. Alias-/Feature-Freischaltung nur als separate, ausdrücklich genehmigte Aktion.

## 13. Entscheidung

<strong>Entscheidung: NO-GO</strong>

Die Code-Remediation beseitigt mehrere reale Produkt- und Sicherheitsrisiken und liefert belastbare lokale Tests. Sie schließt jedoch nicht die harten Infrastruktur-, Schema-, Legal-, Provider-, Zwei-Tenant-, Betriebs- und Production-Gates. REL-01, REL-02, SCOPE-01, ENV-01, CRUD-01 und MAIL-01 sind direkt fehlgeschlagen; weitere 38 Pflichtgates wurden nicht vollständig ausgeführt.
