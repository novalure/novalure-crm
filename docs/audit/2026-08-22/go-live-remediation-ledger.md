# Go-Live-Remediation-Ledger — novalure-crm.app

Stand: 22.08.2026<br>
Projekt: novalure-crm.app<br>
Arbeitsbranch: <code>codex/go-live-remediation-20260822</code><br>
Ausgangs-/Live-SHA zum Prüfstart: <code>77b751d6568487193e9151c7b16545649cfacde7</code>
Finale Remediation-SHA: wird nach dem Dokument-Freeze im Handoff ausgewiesen.

## 1. Aussagegrenzen und Statuslogik

Dieses Ledger trennt strikt zwischen:

- belegten Code-, Contract- und lokalen Buildtests;
- read-only erhobener Live-/Vercel-/Neon-Evidenz sowie separat ausgewiesenen, nicht produktiven Infrastrukturänderungen;
- nicht ausgeführten Preview-Runtime-, Provider-, Zwei-Tenant- und Production-Prüfungen;
- produktiven Daten-, Schema- und Deploymentänderungen, die nicht vorgenommen wurden. Auf Vercel wurden ausschließlich Preview-Blob-Ressourcen neu angelegt, bestehende Resource-Connections enger auf Production/Preview begrenzt und zehn sensitive Variablen branchgebunden nur für `codex/go-live-remediation-20260822` hinterlegt. Preview-Main enthält jetzt 057, 060 sowie 068–077; 11/11 geforderte Migrationen stimmen bytegenau mit den lokalen Checksummen überein. Auf dem temporären Evidence-Branch wurde der Cutover 057 + 073–076 zuvor vollständig angewandt, geprüft, vom Parent wiederhergestellt und identisch erneut angewandt; 077 wurde dort danach separat least-privilege-validiert und nach ausdrücklicher Freigabe atomar auf Preview-Main angewandt. Production blieb unverändert.

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
- Import ist in Desktop-, Mobile- und Quick-Action-Oberflächen explizit LAUNCH-OFF. Im geprüften Codebestand existiert kein entsprechender Server-Importendpunkt. Eine versionierte, fail-closed Launch-Scope-Policy liegt inzwischen als nicht signierter Kandidat vor und wird für die remediated Surfaces verwendet; die vollständige Inventarabdeckung, Signaturen und deployte Negativmatrix fehlen weiterhin.
- Newsletter-Versand ist in API und UI explizit LAUNCH-OFF; der API-Pfad beendet vor Providerzugriff mit 503/no-store.
- Öffentliche Booking-Erstellung, -Stornierung und -Umbuchung sind in Route und UI explizit LAUNCH-OFF. Zusätzlich beendet auch das Erstellungsrepository vor DB-/Providerzugriff fail-closed.

### Newsletter und E-Mail

- Unsubscribe-GET ist read-only.
- Abmeldeinformationen werden als opaker AES-GCM-Token im URL-Fragment übertragen.
- Bestätigung erfolgt über einen expliziten Same-Origin-POST auf <code>/unsubscribe/confirm</code>.
- Suppression, Kontaktstatus und Consent werden workspace-gebunden atomar aktualisiert; die Antwort enthält keine PII.
- Die Resend-Produktionsgrenze verlangt exakten Key und From-Wert, besitzt keinen Mock-/Fallback-Pfad und erzwingt einen expliziten Delivery-Purpose. Passwortreset und Workspace-Einladung bleiben getrennte Account-Access-Verträge; Newsletter sowie Meeting-, Bot-, Dokument- und QA-Testversand werden vor Provider- und Send-State durch die jeweilige zentrale Launch-Regel blockiert. Unbekannte Zwecke schlagen fail-closed fehl; der Meeting-QA-Pfad verlangt zusätzlich eine QA-Allowlist.
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
- Die zentrale, unveränderliche Launch-Scope-Policy (`2026-08-22.7`, `PENDING_SIGNATURE`) enthält 25 Regeln und erzwingt unbekannte bzw. nicht freigegebene Surfaces fail-closed. Sie umfasst unter anderem Customer-Communication-Providerwrites, Funnel-Token-Cutover/-Rotation, Public-Form-Submission/-Proof-Refresh, Calendar-Mutationen, Bot-Channel-Inbound, Reservation-Relationship-Sync, QA und Systemdiagnostik; sie ist noch keine signierte Vollmatrix aller Produktflächen.
- Ein deterministischer Zwei-Tenant-QA-Harness samt Konfigurations-, Target-, Rollen-, Batch-, Secret-Evidence- und Cleanup-Guards ist vorhanden. Zwei isolierte `is_qa=true`-Tenants mit insgesamt neun Auth-Identitäten, zehn MFA-fähigen Mitgliedschaften und zwei leeren Batches sind provisioniert. Der Harness wurde noch nicht gegen ein SHA-identisches Preview-Deployment ausgeführt.

### Validierung, Navigation, Security, Consent und i18n

- Inventory verwendet gemeinsame Validierung und Idempotenz.
- Deal-Erstellung validiert explizit, vermeidet stille Returns und schützt mit <code>useRef</code> vor Doppelauslösung.
- Die Profilnavigation hält den <code>#analysis</code>-Invariant.
- CSP verwendet Nonce plus <code>strict-dynamic</code>, begrenzte Framing-Regeln und einen sicheren Fallback.
- Consent besitzt einen zugänglichen Dialog, Kategorien und Storage-Synchronisation.
- Nach einem im lokalen Browser gefundenen Fokusverlust wurde der Consent-Trigger im DOM gehalten und der Fokus beim Schließen zuverlässig zurückgeführt.
- Public Language/Booking behandelt Locale, dynamische 404 und <code>noindex</code> explizit.

## 3. Automatisierte Test- und Build-Evidenz

Der vollständige lokale Kandidat einschließlich Preview-Blob-Isolation, zentraler Scope-Policy, Form-Proof-Refresh, atomarer QA-Batchregistrierung, Zwei-Tenant-Harness und PostgreSQL-Migrationsparser wurde nach dem Delta erneut geprüft. Diese Evidenz ersetzt weiterhin keine fehlenden Preview-/Production-E2E-Nachweise; die lokale Abschluss-SHA wird nach dem Dokument-Freeze im Handoff ausgewiesen.

| Command/Suite | Ergebnis | Einordnung |
|---|---:|---|
| <code>npm ci</code> | Exit 0 | reproduzierbare Installation im lokalen Worktree |
| <code>npm run ci:toolchain</code> | Exit 0 | mit temporär isolierter, exakt gepinnter Laufzeit Node 24.14.0/npm 11.9.0 verifiziert |
| <code>npm run lint</code> | Exit 0 | vollständiges ESLint auf aktuellem Delta |
| <code>npm run typecheck</code> | Exit 0 | aktueller Delta-Stand |
| <code>npm run test:unit</code> | 492/492 | 241/241 Basissuite plus 251/251 Go-Live-Remediation, zwei Runner; unter Node 24.14.0/npm 11.9.0 wiederholt |
| Funnel-Zielsuites | Deep-DTO 4/4; finaler Consent-/Alias-/Publish-Preflight-Zielstand 29/29; früherer breiter P1-Handoff 99/99 | Deep-Redaction, Minimalresponse, Atomizität, Abuse/Lease, Fresh Snapshot und einheitlicher Publish-/Restore-/Runtime-Preflight lokal belegt |
| Unit-/Building-Zielsuites | 44/44 | nach Tenant-Transaction-/Fresh-Snapshot-Fix |
| Knowledge-Zielsuite | 6/6 | nach External-Provider-Fail-Closed-Fix |
| Form-Zielsuite | 12/12; unabhängiges Reviewer-Zielbündel 39/39 | DTO/Minimalresponse, Atomizität/Replay, Identity, Consent und Launch-off-Grenzen nach letzter Consent-Nachschärfung belegt |
| Forms + Knowledge + Public Abuse | 26/26 | finaler Freeze nach bounded Admin-JSON, Knowledge-Log-Redaction und Public-Abuse-Nachschärfungen |
| Migration-Guards im Forms-Handoff | 20/20 | Migrationen 069–072/Dependencies und Safety-Contracts im Zielstand |
| <code>npm run test:go-live-remediation</code> | 251/251 | aktueller Delta-Stand einschließlich Scope, Providergrenzen, Proof-Refresh/Visits, Funnel-Token-CAS, durable Webhooks, Blob, QA-Batch-Ownership, Zwei-Tenant-Vertrag und Migrationsparser |
| finale gezielte Kernpfade | 40/40 | unabhängiger Abschlussreview |
| finale Migration/Unit/Newsletter-Zielgruppe | 39/39 | einschließlich Migration-Teil 20/20 |
| Booking-Zielsuites | gezielt grün | Create/Cancel/Reschedule Launch-off in API, Repository und UI; im aktuellen Remediation-Lauf 251/251 enthalten |
| <code>npm run test:integration</code> | 15/15 bestanden | lokaler Integrationstest |
| <code>npm run test:i18n</code> | 10/10 bestanden | lokaler i18n-Test |
| <code>npm run test:company-profile-settings</code> | 7/7 bestanden | lokaler Settings-Test |
| <code>npm run test:contact-access</code> | 4/4 bestanden | lokaler Contact-Access-Test |
| <code>npm run test:property-department</code> | 18/18 bestanden | lokaler Property-Test |
| Production-Security-Suite | bestanden, 0 Vulnerabilities | lokaler automatisierter Security-Nachweis |
| <code>npm run build</code> | Exit 0 | aktueller Next-Production-Build grün; 84 generierte Seiten, einschließlich QA-Capability und Form-Proof-Refresh |
| <code>git diff --check</code> | Exit 0 | keine Whitespace-/Patch-Formalfehler |
| <code>npm run release:verify-vercel-env</code> | nicht erfolgreich | lokaler Lauf verlangt <code>VERCEL_TOKEN</code>; Live-Metadaten wurden separat read-only geprüft |

Der aktuelle Delta-Stand ist für Unit 492/492 (241/241 Basis plus 251/251 Remediation), Integration 15/15 und i18n 10/10 grün. Unter der exakt gepinnten Ziel-Toolchain Node 24.14.0/npm 11.9.0 sind Toolchain-Check, vollständiges ESLint, Typecheck, Security Audit mit 0 Vulnerabilities, <code>git diff --check</code> und der Next-Production-Build mit 84 generierten Seiten bestanden. Der Remediation-Verbund wurde nach dem letzten Scope-/Dokument-Delta nochmals mit 251/251 bestätigt. Die zwei älteren Funnel-P1-Befunde zu Proof-Refresh und Visit-Persistenz wurden gegen den aktuellen Stand mit 33/33 fokussierten Tests als überholt bestätigt. Ältere Zähler sind supersediert; die unveränderliche Kandidaten-SHA entsteht mit dem anschließenden Commit-Freeze und wird im Deployment-Nachweis festgehalten.

Neue, über <code>test:go-live-remediation</code> in <code>test:unit</code> eingebundene Suites:

- <code>booking-lifecycle-remediation-tests.mjs</code>
- <code>bot-crm-atomicity-tests.mjs</code>
- <code>bot-webhook-durability-tests.mjs</code>
- <code>calendar-readonly-credential-tests.mjs</code>
- <code>content-security-policy-tests.mjs</code>
- <code>cookie-consent-accessibility-tests.mjs</code>
- <code>deal-create-ux-regression-tests.mjs</code>
- <code>email-production-boundary-tests.mjs</code>
- <code>form-submission-atomicity-tests.mjs</code>
- <code>forms-knowledge-production-truth-tests.mjs</code>
- <code>funnel-production-boundary-tests.mjs</code>
- <code>funnel-public-access-tests.mjs</code>
- <code>funnel-public-dto-security-tests.mjs</code>
- <code>funnel-publish-token-rotation-tests.mjs</code>
- <code>funnel-runtime-proof-visit-tests.mjs</code>
- <code>funnel-safe-content-tests.mjs</code>
- <code>funnel-submission-abuse-remediation-tests.mjs</code>
- <code>inventory-validation-regression-tests.mjs</code>
- <code>launch-scope-fail-closed-tests.mjs</code>
- <code>launch-tenant-relation-guard-tests.mjs</code>
- <code>navigation-profile-invariant-tests.mjs</code>
- <code>newsletter-unsubscribe-security-tests.mjs</code>
- <code>postgres-statement-splitter-tests.mjs</code>
- <code>preview-blob-isolation-tests.mjs</code>
- <code>property-inquiry-routing-security-tests.mjs</code>
- <code>public-booking-i18n-remediation-tests.mjs</code>
- <code>qa-batch-lock-order-live-tests.mjs</code>
- <code>qa-batch-registration-tests.mjs</code>
- <code>qa-reset-safety-tests.mjs</code>
- <code>qa-two-tenant-matrix-tests.mjs</code>
- <code>qa-two-tenant-provision-tests.mjs</code>
- <code>readonly-audit-safety-tests.mjs</code>
- <code>system-releases-contract-tests.mjs</code>
- <code>transaction-concurrency-remediation-tests.mjs</code>

Damit sind 34 Remediation-Suites in <code>test:go-live-remediation</code> verdrahtet und 251/251 Tests bestanden. Provisionierung und Code-/Contract-Evidenz ersetzen noch keinen ausgeführten Runtime-/Cleanup-E2E-Nachweis auf dem SHA-identischen Preview-Kandidaten.

## 4. Live-Baseline- und Vercel-Preview-Ressourcenevidenz

| Gegenstand | Evidenz | Bewertung |
|---|---|---|
| Vercel-Projekt | <code>novalure/novalure-crm</code> | identifiziert |
| Deployment-ID | <code>dpl_4r6tWnAMRAPMpeBbhGegYzu5tu1C</code> | READY, Production |
| Deployment-URL | <code>novalure-msj34yn5t-novalure.vercel.app</code> | aktuelles Baseline-Deployment, nicht der Remediation-Kandidat |
| Source-SHA | <code>77b751d6568487193e9151c7b16545649cfacde7</code> | entsprach beim Prüfstart dem damaligen Main-/Live-Stand |
| Logs | 24-Stunden-Read-only-Prüfung ohne Fehler/5xx | kein kontrollierter Fehler-/Trace- oder Alarmtest |
| frühere CI | grün | gilt für Baseline-SHA, nicht für den noch nicht deployten Remediation-Kandidaten |
| Vercel CLI | Version 59.4.0 über <code>npx</code> aufgelöst, Netzwerkzugriff endete jedoch mit <code>fetch failed</code> | derzeit nicht operativ nutzbar; globale Installation mit <code>npm i -g vercel</code> wird stark empfohlen, um <code>vercel env pull</code>, <code>vercel deploy</code> und <code>vercel logs</code> direkt nutzen zu können. In-App-Vercel und Vercel-MCP waren erreichbar |
| Marketplace | Neon vorhanden, Resend nicht installiert | MAIL-01 offen |
| Preview Blob | neue private und öffentliche Preview-Stores in FRA1, jeweils ausschließlich mit Preview verbunden | Ressourcen-/Connection-Trennung umgesetzt; deployter Upload-/Read-/Delete-E2E fehlt |
| bestehende Blob-Verbindungen | alter Private Store nur Production; alter Public Store Production+Development, Preview entfernt | verhindert Preview-Fallback auf die bisherigen Stores auf Connection-Ebene |

Es wurde kein Remediation-Preview und kein Remediation-Production-Kandidat deployt. Daher dürfen Baseline-Deployment und Baseline-Logs nicht als Evidenz für den geänderten Code verwendet werden.

## 5. ENV-01 — Fingerprints und harter Stopp

Es wurden nur nicht reversible Secret-Werte ausschließende Fingerprints bzw. Key-Metadaten erfasst.

| Ziel | Production | Preview | Ergebnis |
|---|---|---|---|
| Datenbank | <code>sha256:36e38778071baa281fe6</code> | <code>sha256:b8d9af25b0eeccdf276e</code> | verschieden |
| Private Blob | bestehender Private Store, Connection Production-only | eigener neuer Preview-Private-Store, Connection Preview-only | auf Ressourcen-/Connection-Ebene getrennt; Runtime-E2E offen |
| Public Blob | bestehender Public Store, Connection Production+Development | eigener neuer Preview-Public-Store, Connection Preview-only | auf Ressourcen-/Connection-Ebene getrennt; Runtime-E2E offen |
| Queue | Ziel nicht eindeutig belegt | Ziel nicht eindeutig belegt | Gate-Fehler |
| Provider | Ziel/Scope nicht eindeutig getrennt | Ziel/Scope nicht eindeutig getrennt | Gate-Fehler |

Zusätzliche Env-Metadaten:

- <code>RESEND_FORM</code> ist vorhanden; <code>RESEND_FROM</code> fehlt.
- <code>NOVALURE_EMAIL_FROM</code> ist in Production vorhanden.
- Provider-Key-Metadaten umfassen Preview und Production; eine sichere Trennung wurde nicht nachgewiesen.
- Der Kandidat liest in `VERCEL_ENV=preview` ausschließlich die neuen Preview-Tokenvariablen und fällt bei fehlendem Preview-Token leer/fail-closed aus; ein Rückfall auf Production-Blob-Token ist per Contract-Test ausgeschlossen.

Konsequenz: Die frühere Blob-Kollision ist auf Ressourcen-, Connection- und Codeebene remediated. ENV-01 bleibt dennoch <strong>FAIL / FEHLER</strong>, weil Queue-/Providertrennung sowie ein SHA-identischer Preview-Runtime-/Uploadnachweis fehlen. Die sichere QA-Tenant-/Batch-Provisionierung ist erfolgt; Preview-CRM-CRUD, Upload, Provider-Smoke und Reset wurden weiterhin nicht ausgeführt.

## 6. Produktionsschema und Migration-Ledger, read-only

### 6.1 Historischer Production-Audit

Dieser Audit wurde vor den Kandidatenmigrationen 069–077 erhoben und darf nicht als Schemaaudit des aktuellen Worktrees ausgegeben werden.

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
| erwartete CRM-Tabellen laut <code>src/lib/db/schema.ts</code> | 118; <code>bot_channel_webhook_envelopes</code> liegt bewusst außerhalb <code>crmTables</code> |
| Kandidatenmigrationen | <code>068</code>–<code>077</code> einschließlich des manuellen Vor-Cutovers <code>057</code> |
| zusätzliche tatsächliche Tabellen gegenüber dem 115er Auditstand | mindestens <code>property_unit_idempotency</code>, <code>property_building_idempotency</code>, <code>public_funnel_visit_events</code> und <code>bot_channel_webhook_envelopes</code>; damit mindestens 119 tatsächliche Tabellen |
| isolierte Preview-Zustände | Preview-Main: <code>057</code>, <code>060</code> + <code>068</code>–<code>077</code>; 11/11 exakte lokale Checksummen, 19/19 validierte/deferred Tenant-FKs, 0/19 Anti-Join-Verstöße, 21/21 Launch-Artefakte und vollständiges 077-Owner-/ACL-Gate. Evidence-Branch: <code>057</code> + <code>073</code>–<code>076</code> mit bestandenem Apply/Restore/Reapply, danach 077 separat validiert |
| auf Production angewendet | keine der Migrationen 057, 068–077 |

Es erfolgte kein Production-Schema-Write. Preview-Main enthält jetzt 057, 060 und 068–077; das Zielgate bestand dort mit 11/11 exakten lokalen Checksummen, 19/19 validierten, deferrable und initial deferred Tenant-FKs, 0/19 Anti-Join-Verstößen, 21/21 Launch-Artefakten sowie exaktem 077-Checksum- und vollständigem Owner-/ACL-Beweis. Der vorangegangene Evidence-Drill für 057 + 073–076 ist durch den unveränderlichen Pre-073-Snapshot, Apply, Katalogprüfung, Restore, Abwesenheitsprüfung und identischen Reapply abgesichert; 077 wurde danach auf demselben Evidence-Branch separat geprüft. Eine spätere Production-Anwendung bleibt bis zu DBA-/Release-Freigabe, Production-Backup und bestätigtem Rollbackziel gesperrt; 061 bleibt zusätzlich bis zum App-Rollen-Cutover gesperrt.

### 6.3 Isolierter Preview-/Migration- und Restore-Drill

- Ausgangsziel war ausschließlich das getrennte Neon-Projekt `novalure-crm-tenant-isolation-test`, Preview-Main `br-lucky-heart-alrm9dlw`; Production wurde weder adressiert noch verändert.
- Auf dem inzwischen supersedierten Drill-Branch `go-live-f5c8c8a-drill-20260822` wurden 060 sowie 068–072 mit dem versionierten PostgreSQL-Statement-Splitter transaktional angewandt und strukturell verifiziert. Der Branch wurde nach Erhalt der neueren Snapshots und Evidence gelöscht, um das Neon-Branchlimit für den finalen Restore-Drill freizugeben.
- Der migrierte Zustand wurde als `go-live-f5c8c8a-postmigration-proof-20260822` (`br-royal-hat-al9sbbbl`) erhalten. Danach wurde `br-dawn-base-alycxxsv` per `reset_from_parent` auf den unmigrierten Elternzustand zurückgesetzt; dort waren 072 und die QA-Grenze anschließend wieder abwesend. Damit ist der funktionale Restore-/Rollback-Drill belegt.
- Vor dem Preview-Cutover wurde zusätzlich Snapshot `go-live-preview-main-precutover-20260822` (`br-round-haze-aljmj73e`) erstellt. Danach wurden 060 sowie 068–072 auf Preview-Main in einer Transaktion angewandt und Ledger/QA-Tabellen/Constraints verifiziert. Anschließend wurden zwei isolierte `is_qa=true`-Workspaces mit insgesamt zehn MFA-fähigen Mitgliedschaften und je einem leeren Batch provisioniert; CRM-Geschäftsobjekte wurden noch nicht erzeugt.
- Vor 073 wurde Snapshot `go-live-preview-main-pre073-20260822` (`br-square-bird-alpv01dg`) erstellt. Auf Evidence-Branch `go-live-final-evidence-20260822-v2` (`br-spring-math-aljuzher`) wurde 057 + 073–076 zunächst angewandt. Das Gate bestätigte 5/5 exakte lokale Checksummen, 19/19 validierte, deferrable und initial deferred Tenant-FKs, 0/19 Anti-Join-Verstöße sowie 21/21 Artefakte für Visit-Truth und durable Webhook-Verarbeitung. Danach wurde der Branch ohne Preserve auf Preview-Main zurückgesetzt; alle fünf Ledgerzeilen, 19 Constraints und beide neuen Tabellen waren wieder abwesend, der Legacy-Webhook-Index wieder vorhanden. Der identische Reapply bestand anschließend dasselbe Gate erneut.
- Migration 077 wurde anschließend auf dem Evidence-Branch als ownergebundene, nicht aktualisierbare Runtime-Projektion validiert. Nach ausdrücklicher Freigabe wurde exakt der committed SHA-256-Stand `6465c9173b38198f1000204acee5d18ef3c370f32755454570aa983d0c46d6ae` atomar auf Preview-Main angewandt. Dort sind 11/11 Pflichtchecksummen identisch. Die View `public.novalure_schema_migration_checksums` enthält exakt `version` und `checksum`, verwendet `security_barrier=true` sowie `security_invoker=false` und besitzt exakt denselben Owner wie das Basis-Ledger. App- und Tenant-Rolle besitzen null Direktzugriff einschließlich Tabellen-/Spaltenrechten, `TRUNCATE` und PostgreSQL-17-`MAINTAIN`; `novalure_app` besitzt ausschließlich SELECT ohne Grant-Option auf der Projektion, PUBLIC besitzt keine Tabellen-/Spalten-ACL und die App kann den Owner nicht übernehmen. Ein zusätzlicher Gesamtschema-Diff gegen den Evidence-Branch überschritt die Connector-Grenze mit HTTP 413; deshalb basiert die Abnahme auf den fokussierten Katalogbeweisen.
- Der Connector darf die App-Rolle nicht per `SET ROLE` impersonieren. Katalogseitig ist belegt: `novalure_app` besitzt keine direkten SELECT/INSERT/UPDATE/DELETE-Rechte auf der globalen Envelope-Tabelle, aber EXECUTE auf die validierende SECURITY-DEFINER-RPC; der tatsächliche App-Login-RPC-Probe bleibt Bestandteil des SHA-identischen Preview-E2E.
- Migration 061 wurde absichtlich nicht angewandt: Die sichere Gruppe `novalure_tenant_app` ist vorhanden, aber App-Verbindung, direkte Mitgliedschaft und immutable Deployment-Attestation sind noch nicht als gemeinsam wirksamer Cutover belegt. RLS auf den fünf Pilot-Tabellen bleibt daher aus.
- RPO/RTO-Zielwerte, Recovery-Reconciliation und formale DBA-/Release-Signatur bleiben offen; der technische Restore-Drill selbst ist nicht mehr offen.

## 7. Verbindliche Gate-Matrix

Zusammenfassung: 2 PASS, 6 FAIL, 38 NOT RUN. Da jedes NOT RUN laut Master-Prompt als Fehler zählt, ist eine GO-Entscheidung ausgeschlossen.

| Test-ID | Status | Präziser Nachweis bzw. Grund |
|---|---|---|
| REL-01 | FAIL / FEHLER | lokaler Freeze unter Node 24.14.0/npm 11.9.0 für Toolchain, Unit 492/492, Remediation 251/251, Integration 15/15, i18n 10/10, vollständiges ESLint, Typecheck, Security Audit, Diff-Check und Production-Build mit 84 Seiten grün; für den 077-Dokument-Freeze fehlt noch der neue SHA-identische Preview-Deploy samt Deployment-/Alias-Parität |
| REL-02 | FAIL / FEHLER | historischer Production-Audit <code>ok: false</code> bei 112/115 Tabellen und Ledger 067; Preview-Kandidat erwartet nach 075/076 mindestens 119 Tabellen und Migrationen 068–077 einschließlich manuellem Cutover 057, ohne Production-Anwendung |
| REL-03 | NOT RUN / NICHT AUSGEFÜHRT | isolierter Neon-Migrations-/Restore-/Reapply-Drill bestanden, Pre-Cutover-Snapshot vorhanden und Preview-Main checksummengenau auf 057 + 068–077 einschließlich vollständigem 077-Least-Privilege-Gate; RPO/RTO/Reconciliation, 061-App-Rollen-Cutover, echter App-Login-RPC-Probe, privater-Blob-End-to-End, Queue-/Cron-SLO und signierte Ops-Evidenz fehlen |
| REL-04 | NOT RUN / NICHT AUSGEFÜHRT | fünf Unternehmensprofilblocker sowie Legal-/Ops-Abnahme nicht belegt |
| SCOPE-01 | FAIL / FEHLER | versionierte zentrale Policy für die remediated Surfaces vorhanden und unbekannte Surfaces fail-closed; vollständige signierte ON/OFF/INTERNAL-Matrix, Vollabdeckung und deployte Negativmatrix fehlen |
| ENV-01 | FAIL / FEHLER | Preview-DB und Preview-Blob auf Ressourcen-/Connection-/Codeebene getrennt; zehn sensitive Variablen sind ausschließlich branchgebunden gesetzt. Queue-/Providerziele und der Runtime-E2E des neuen Kandidaten bleiben offen |
| DATA-01 | PASS / BESTANDEN | Forms, Knowledge und Funnel verwenden DB-only-Wahrheit; automatisierte Produktionswahrheits-/Fallback-Negativtests grün |
| DATA-02 | NOT RUN / NICHT AUSGEFÜHRT | kein vollständiger UI/API/DB-Drei-Wege-Abgleich für alle Launch-KPIs |
| CRUD-01 | FAIL / FEHLER | Migrationen 068–077 sind auf isoliertem Preview angewandt; zwei reale `is_qa`-Tenants, zehn MFA-fähige Mitgliedschaften, zwei leere Batches, branchgebundene Runtime-ENV und der atomare Rollen-/Batch-/Cleanup-Harness sind vorhanden. Capability-Preflight und Matrix-/Reset-E2E des neuen Kandidaten fehlen |
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
| ADV-01 | NOT RUN / NICHT AUSGEFÜHRT | Funnel DB-only, Deep-DTO, Minimalresponse, atomarer DML-CTE, shared Identity-Serialisierung sowie tenantatomare Publish-Token-Rotation mit Revision-CAS, Idempotenz, Response-Redaction und Secret-Sanitization lokal getestet; realer Production-Cutover und vollständiger Publish-/Analytics-/KPI-E2E fehlen |
| ADV-02 | NOT RUN / NICHT AUSGEFÜHRT | Knowledge Source/Chunk atomar und DB-only; approved/search ohne externen Embedding-Provider fail-closed; UI/API/DB-Semantik und Bot-Nachweis fehlen |
| ADV-03 | NOT RUN / NICHT AUSGEFÜHRT | Gesprächs-/Kanal-Scope nicht vollständig fachlich und technisch abgenommen |
| ADV-04 | NOT RUN / NICHT AUSGEFÜHRT | Customer/User/Grant-Semantik und 0-versus-4-Abgleich fehlen |
| ADV-05 | NOT RUN / NICHT AUSGEFÜHRT | Consent/Suppression/Unsubscribe-Code gehärtet; Newsletter-Send explizit Launch-off; exakt ein später freigegebener QA-Versand und Provider-/Cleanup-Evidenz fehlen |
| ADV-06 | NOT RUN / NICHT AUSGEFÜHRT | kein Detect/Resolve/Ignore/Merge-E2E ausschließlich auf QA-Daten |
| ADV-07 | NOT RUN / NICHT AUSGEFÜHRT | keine vollständige QA-Sandbox-/Approval-/Side-Effect-Matrix für Bots und Automation |
| ADV-08 | NOT RUN / NICHT AUSGEFÜHRT | Funnel-Webhooks, Import, Calendar-Provider-/OAuth-Mutationen, Customer-Communication-Providerwrites, Reservation-Sync und Funnel-Tokenflächen sind zentral fail-closed klassifiziert; vollständige signierte Gesamtmatrix und deployte Negativtests fehlen |
| SEARCH-01 | NOT RUN / NICHT AUSGEFÜHRT | kein vollständiger Suche/Umlaut/Filter/Sortierung/Pagination/QA-Export-Abgleich |
| PROP-01 | NOT RUN / NICHT AUSGEFÜHRT | Property-Tests 18/18 grün; fachliche Pflichtinhalte/Dokumente/Publish-Blocker nicht vollständig abgenommen |
| OBS-01 | NOT RUN / NICHT AUSGEFÜHRT | 24h Baseline-Logs ohne Fehler/5xx; kein kontrollierter Fehler bis Vercel/Provider und keine PII-/Secret-Prüfung auf Kandidatenlogs |
| OBS-02 | NOT RUN / NICHT AUSGEFÜHRT | keine getesteten Monitore/Alarme und kein vereinbarter Beobachtungsnachweis |
| PERF-01 | NOT RUN / NICHT AUSGEFÜHRT | kein Kandidaten-Lighthouse und keine p75-LCP/INP/CLS-Messung gegen vereinbarte Budgets |
| PROD-01 | NOT RUN / NICHT AUSGEFÜHRT | Remediation-Code nicht deployt; kein SHA-identischer Kandidat unter kanonischem Alias und kein kontrollierter Production-Smoke |
| CLEAN-01 | NOT RUN / NICHT AUSGEFÜHRT | sichere Tenant-/Identity-/Batch-Provisionierung ausgeführt; noch keine CRM-Geschäftsobjekt-Writes, kein Batch-Dry-run/Execute und kein Null-Rückstands-Cleanup. Zwei leere Batches sind vorhanden |

## 8. Befund → Fix → Test/Evidenz → Reststatus

| Befund | Umgesetzter Fix | Test/Evidenz | Reststatus |
|---|---|---|---|
| Fixture-/Fallback-Risiko bei Forms/Knowledge/Funnel | DB-only-Repositories und fail-closed Resolver; Knowledge approved/search nur mit externem Provider | zielgerichtete Forms-/Knowledge-/Funnel-Suites und Unit 492/492 | DATA-01 für den Code-Contract bestanden; deployed E2E weiterhin offen |
| Public Funnel überträgt internen Blueprint/Diagnostik | Deep-Allowlist-DTO; Public Proof statt Publish-Token im Browser/POST; minimale Live-Response ohne interne IDs; DB-Fehler bleiben 5xx | Funnel-Public-DTO-Security 4/4 und Funnel-Zielsuites | Kandidatencode geschlossen; externer Publish-Token muss vor GO rotiert werden; deployed E2E offen |
| Funnel-Submit konnte Teilwrites, parallele Kontaktduplikate oder Consent-/Alias-Drift erzeugen | atomarer Domain-/Claim-CTE; lease-gefencete Replayresponse; shared Form/Funnel-Email-/Phone-Identity-Advisory-Locks in Tenant-TX; kanonische Consent-/Identity-Aliasse; gemeinsamer Publish-/Restore-/Runtime-Preflight | Funnel-Abuse-/Migration-/Boundary-/Preflight-Zielsuites, finaler Freeze 29/29 | Kandidatencode geschlossen; echtes DB-Concurrency-/Zwei-Tenant-E2E offen |
| Funnel-Webhooks ohne freigegebenen Scope | Konfiguration/API/Persistenz/Adapter explizit LAUNCH-OFF | Funnel-Production-Boundary-Test | Teil von SCOPE-01; Gesamtgate offen |
| Import sichtbar, aber nicht freigegeben | Entry Points ausgeblendet; kein Server-Importendpunkt vorhanden; `importReview` zentral `LAUNCH-OFF` | Launch-Scope-Fail-Closed-Test | Signatur und deployte Negativverifikation fehlen |
| Unsicherer Unsubscribe-GET/PII-Link | opaker Fragmenttoken, expliziter POST, atomare Suppression/Consent-Aktualisierung | Newsletter-Unsubscribe-Security 7/7 | alter Link absichtlich ungültig; Provider-/QA-Versand offen |
| Newsletter-Versand ohne freigegebene Providerabnahme | API vor Providerzugriff 503/no-store Launch-off; UI-Sendaktionen verborgen | Newsletter-/E-Mail-/Launch-Scope-Zielsuites | Product-/Providerfreigabe und genau ein QA-Send offen |
| Booking-Race-/Lifecycle-Risiken ohne abgeschlossene Providerabnahme | öffentliche Create-/Cancel-/Reschedule-Route, Repository und UI hart Launch-off vor Body/DB/Provider; Legacy-Resolver propagiert DB-Ausfälle statt sie als 404 zu maskieren | Booking-/i18n-/Launch-Scope-Zielsuites sowie finaler P2-Recheck | Product-/Providerfreigabe und vollständiges QA-Lifecycle-E2E vor Launch-on offen |
| Unit-/Building-Doppelwrites bei Parallelität | semantische Idempotenz-Ledger; separate Advisory-Lock-Anweisung innerhalb Tenant-TX; atomarer Domain-/Ledger-/Auditwrite | 44/44 Unit-/Migration-/Reset-Zielsuites; Migration 069 auf isoliertem Preview angewandt | echtes DB-Concurrency-E2E offen |
| Form-Submit-Teilwrites/instabile Retries/Infoleak | lease-gefenceter atomarer Domain-/Minimalresponse-CTE; semantischer Multipart-Fingerprint; Public-Allowlist-DTO; Owner-Tenant-Guard; shared Identity-Locks/Conflict-Schutz; authentifiziertes Admin-JSON streamingbegrenzt auf 256 KiB | Forms 12/12, Reviewer-Bündel 39/39, Migration 20/20, Remediation 251/251, Migrationen 071/072 auf isoliertem Preview | Kandidatencode geschlossen; deploytes Submit-/Cleanup-E2E offen |
| File-/RoundRobin-/Custom-Pattern-/unsichere Consent-Formen wirkten public-fähig | Admin-Save/UI, Public Page, Embed und API durchgängig fail-closed; feste Consent-Truthy-Allowlist, Privacy/Marketing getrennt und nicht vorselektiert; Analytics/unclassified off | Forms 12/12 und Reviewer-Bündel 39/39 | Kandidatencode geschlossen; spätere Aktivierung benötigt eigene sichere Implementierung und E2E-Abnahme |
| E-Mail-Fallback-/Leak-Risiko | expliziter Resend-Purpose, keine Mock-Fallbacks, redigierte Fehler; Newsletter und Customer-Communication vor Provider-/Send-State OFF, unbekannte Zwecke fail-closed; Account-Access-Mail getrennt | Email-Production-Boundary- und Launch-Scope-Tests | Resend/Domain/From/QA-Mailbox nicht live validiert |
| Falsch-grünes Release-/Governance-UI | reale Contract-Diagnostik, statische Verifikation entfernt | System-Releases-Contract-Test | Production-Schema ist tatsächlich rot |
| Zu breite Systemdiagnostikrolle | exakt Platform Admin bzw. novalureAdmin | Contract-/Role-Test | vollständige RBAC-Matrix offen |
| Gefährlicher QA-Reset | Audit/Allowlist/Dry-run/CSRF/FK-Closure; atomare Contact-/Consent-/Deal-/History-Batchregistrierung; Ownership-Guard gegen Idempotency-Kollisionen; Legacy deaktiviert | QA-Reset- und QA-Batch-Tests einschließlich paralleler Baseline-Kollision; Migration 068 und zwei Tenants auf isoliertem Preview | echter Runtime-Dry-run/Execute/Null-Rest-Reset nicht ausgeführt |
| Deal-/Inventory-Doppel- oder Silent-No-op-Risiko | gemeinsame Validierung, Idempotenz, sichtbare Fehler, Doppelklickguard | Deal-UX- und Inventory-Regressionstests | vollständige Browser-/Parallel-Tab-Matrix offen |
| Profilnavigation verliert Analysezustand | <code>#analysis</code>-Invariant | Navigation-Profile-Invariant-Test | UX-02 bestanden |
| Schwache CSP-/Framing-Grenze | Nonce, strict-dynamic, Frame-Restriktionen, Fallback-CSP | CSP-Test | vollständiger Kandidaten-Header-/Embed-E2E offen |
| Consent-Fokusverlust nach Escape | Trigger bleibt gemountet, verbundener Vorfokus wird erhalten und wieder fokussiert | gezielte Suite 3/3, Lint, Typecheck, Build | vollständige Mobile-/Screenreader-Matrix offen |
| falsche Sprache/dynamische Public-404 | Locale-, noindex- und Not-found-Grenzen | Public-Booking-i18n-Test und lokale DE-Beobachtung | vollständige Pflicht-Routen-Matrix offen |

### 8.1 Unabhängiger Abschlussreview

Der aktuelle Stand enthält zusätzlich Policy 2026-08-22.7, monotone Bot-/Providerkontrollen, durable Inbound-Webhook-Verarbeitung, Funnel-Revision-CAS/Secret-Sanitization sowie Deal-/QA-Batch-Ownership-Härtung. Die unabhängige Schlussprüfung weist `0 P0/0 P1` aus; die externen und E2E-Releasegates aus Abschnitt 9 bleiben davon unabhängig offen.

Verbleibende P2-/Formalgate-Hinweise:

- Für Public Forms und Public Funnels liegen scope-/publikationsgebundene, idempotency-key-erhaltende Proof-Refresh-Flows als Kandidatencode vor; offen bleibt der deployte Browser-/Expiry-/Replay-Nachweis für lange Sessions.
- Die Unit-/Buyer-/Deal-Beziehung ist über <code>propertyReservationRelationshipSync</code> in UI, API, Cron und Repository zentral <code>LAUNCH-OFF</code>. Vor einem späteren ON fehlen fachliche Signatur, atomare Implementierung/Outbox und E2E.

Diese Punkte sind nicht als akzeptierter Nach-Go-Live-Backlog freigegeben; Owner, Termin, Ablaufdatum und Risikoakzeptanz fehlen.

Zusätzlicher P3-Härtungshinweis: Der shared bounded-JSON-Reader berechnet im Forms-Editor einen dort ungenutzten HMAC-Fingerprint und koppelt diesen Adminpfad unnötig an das für den Go-Live korrekt erforderliche <code>NOVALURE_ABUSE_SECRET</code>. Bei korrekter Go-Live-ENV ist dies kein Sicherheits- oder Releaseblocker; die Verantwortlichkeiten sollten später entkoppelt werden.

## 9. Verbleibende externe, fachliche und operative Blocker

1. Preview besitzt getrennte DB- und Blob-Ressourcen/Connections; Queue- und Providerziele sowie der SHA-identische Runtime-/Uploadnachweis fehlen weiterhin und blockieren den vollständigen ENV-01-Abschluss.
2. Eine versionierte zentrale technische Launch-Scope-Policy ist vorhanden; vollständige fachliche ON/OFF/INTERNAL-Signaturen, Vollabdeckung und deployte Negativmatrix fehlen.
3. Unternehmensprofil, rechtliche DE/EN-Inhalte, Legal-Sign-off, ES-Entscheidung und verbindliche KPI-Definitionen fehlen.
4. Production-Schema/Ledger ist nicht releasebereit: historisch 112/115 Tabellen bei Ledger 067; Preview-Main ist kontrolliert und checksummengenau auf 057 + 068–077, Production hingegen unverändert.
5. Der technische Preview-Backup-/Restore-Drill ist bestanden. Offen bleiben 061-App-Rollen-Cutover, formale RPO/RTO- und Reconciliation-Abnahme, Production-Backup/Rollbackziel sowie DBA-/Releasefreigabe.
6. Resend-Integration, Domain/From/Key, eigene QA-Mailbox und genau ein echter allowlisteter Versand sind nicht validiert.
7. Eigener QA-Kalender und kompletter Booking-Lifecycle einschließlich Providerstatus und Cleanup sind nicht validiert; die öffentlichen Write-Pfade bleiben deshalb Launch-off.
8. Zwei QA-Tenants und echte Rollen sind provisioniert; die vollständigen CRM-CRUD-, RBAC-, IDOR-, Auth-, Datei-, Newsletter-, Data-Hygiene-, Bot-, OAuth- und Integrations-E2Es auf einem SHA-identischen Preview fehlen.
9. Cron-/Queue-SLO, Recovery, Monitore und getestete Alarme fehlen.
10. Der lokale Toolchain-Nachweis Node 24.14.0/npm 11.9.0 ist bestanden; offen bleibt der SHA-identische CI-/Deployment-Nachweis.
11. Ein früherer Remediation-Preview für SHA `976e91c3560c04a7e11c125e35c80795e9d58646` ist deployt; für den aktuellen 077-Dokument-Freeze fehlen noch der neue SHA-identische Preview, Kandidaten-Screenshots, vollständiges Axe-/Screenreader- und Mobile-Set sowie Lighthouse-/Web-Vitals-Evidenz. Ein Production-Kandidat wurde nicht deployt.
12. Production-Beobachtungsfenster von 60 Minuten, 24 Stunden und sieben Tagen wurden für den Remediation-Kandidaten nicht begonnen.
13. Der bislang im öffentlichen Live-Funnel verwendete Publish-Token muss vor GO rotiert, die alte Capability widerrufen und die neue Capability kontrolliert verteilt werden. Diese externe Rotation wurde nicht ausgeführt.

## 10. Bewusst nicht ausgeführte Aktionen

Aufgrund von ENV-01, fehlenden Freigaben und fehlender SHA-identischer Preview-Runtime-Konfiguration wurden folgende Aktionen nicht ausgeführt:

- keine Änderung von Vercel-Production-Env-Variablen;
- keine Providerdomain-, Key-, From-, Mailbox- oder Kalenderänderung;
- keine Production-Migration; Preview-Main enthält checksummengenau 057, 060 und 068–077, der isolierte Evidence-Branch belegt zusätzlich den bestandenen Restore-/Reapply-Drill für 057 + 073–076 und den separaten 077-Least-Privilege-Test; 061 blieb gesperrt;
- kein CRM-Geschäftsobjekt-Seed; ausschließlich die sichere QA-Tenant-/Identity-/Batch-Provisionierung wurde ausgeführt;
- kein Preview-/Production-CRUD und kein Upload;
- kein echter Provider-Mailversand und kein Kalendereintrag;
- kein QA-CRM-Geschäftsobjekt-Write;
- kein Cleanup/Reset in Production;
- keine historische Retry-/Recovery-Aktion;
- kein Production-Deployment, keine Promotion, keine Production-Aliasumschaltung und keine öffentliche Feature-Freischaltung; Preview-Deployments blieben auf den autorisierten Remediation-Branch begrenzt;
- keine Blob-Dateiobjekte, Queue-Nachrichten oder Provider-Sends erzeugt; angelegt wurden ausschließlich die zwei leeren Preview-Blob-Stores sowie Drill-, Preserve- und Pre-Cutover-Snapshot-Branches im isolierten Neon-Projekt;
- keine operative Testdatenbereinigung erforderlich; zwei leere QA-Batches sind vorhanden.

Damit wurden durch diesen Prüfstand weder Production-Daten noch Providerzustände verändert.

## 11. Aktionen mit ausdrücklicher Genehmigungspflicht

Vor Ausführung sind mindestens die jeweils genannten Freigaben und Sicherungen erforderlich:

| Aktion | Vorbedingung |
|---|---|
| Vercel-Production-Env ändern | schriftliche Release-/Ops-Freigabe, dokumentierter Vorherstand und Rollback |
| weitere Preview-Ziele provisionieren/verbinden oder bestehende ändern | freigegebene getrennte Ressourcen und erneuter fingerprintbasierter ENV-01-Nachweis |
| Providerdomain/Key/From ändern | Product/Ops/Provider-Freigabe, Domainverifikation, Secret-Rotation und Rollback |
| Produktionsmigrationen bis einschließlich Kandidatenstand 077, einschließlich manuellem Vor-Cutover 057; 061 bleibt separater App-Rollen-Cutover | Backup, Dry-run, geprüfter Rollback, erfolgreicher Restore-Drill, DBA-/Releasefreigabe |
| Funnel-Publish-Token rotieren | Security-/Ops-Freigabe, kontrollierte Verteilung, Widerruf der alten Capability, Audit und Negativtest der alten URL |
| Production-Deploy oder Promotion | alle Pflichtgates grün, exakte SHA/Lockfile/Env-Buildinput-Evidenz und Rollbackziel |
| produktiver QA-Write | allowlisteter QA-Workspace, genehmigter Batch, Monitoring und Reset-/Reconciliation-Plan |
| echte QA-Mail oder QA-Kalendereintrag | eigene allowlistete Empfänger/Ressourcen, Providerfreigabe und Cleanup |
| Cleanup/Reset in Production | genehmigter Dry-run, exakte QA-Allowlist, Audit und Vorher/Nachher-Zähler |
| historische Retry-/Recovery-Aktion | Incident-/Ops-Freigabe, Idempotenznachweis und begrenzter Scope |
| öffentliche Alias-/Feature-Freischaltung | separate finale GO-Freigabe nach bestandenen Gates |

## 12. Nächste kontrollierte Reihenfolge

1. Launch-Scope, Legal, Unternehmensprofil, ES und KPI-Definitionen fachlich signieren.
2. Die vorhandene DB-/Blob-Trennung per SHA-identischem Preview-Runtime-Test nachweisen, getrennte Queue-/Providerziele schließen und ENV-01 erneut bewerten.
3. Den bestandenen Evidence-Drill 057 + 073–076 und den checksummengenauen Preview-Main-Zielstand 057 + 068–077 formal abnehmen; den echten <code>novalure_app</code>-RPC-/Grant-Probe im Runtime-Preflight ausführen. 061 erst nach SHA-identischem Deployment, sicherer App-Verbindung, Rollenmitgliedschaft und Deployment-Attestation ausführen. RPO/RTO und Reconciliation mit DBA signieren; der fokussierte Schema-/ACL-Beweis ist grün, der Connector-Gesamtdiff wegen HTTP 413 separat zu dokumentieren.
4. Die zehn bereits branchgebundenen Preview-ENV beibehalten und den exakt gepinnten neuen Kandidaten-SHA deployen; Production-ENV und Production-Deployment bleiben gesperrt.
5. Danach Barrieredrill und Zwei-Tenant-Harness einschließlich Dry-run/Execute/Null-Rest-Cleanup ausführen.
6. Den bislang öffentlichen Funnel-Publish-Token kontrolliert rotieren und die alte Capability widerrufen.
7. Vollständige Gate-Matrix einschließlich Zwei-Tenant-, Provider-, File-, A11y-, Mobile-, Performance- und Cleanup-E2Es ausführen.
8. Erst danach einen geschützten Production-Kandidaten genehmigen, smoke-testen, bereinigen und beobachten.
9. Alias-/Feature-Freischaltung nur als separate, ausdrücklich genehmigte Aktion.

## 13. Entscheidung

<strong>Entscheidung: NO-GO</strong>

Die Code-Remediation beseitigt mehrere reale Produkt- und Sicherheitsrisiken und liefert belastbare lokale Tests. Sie schließt jedoch nicht die harten Infrastruktur-, Schema-, Legal-, Provider-, Zwei-Tenant-, Betriebs- und Production-Gates. REL-01, REL-02, SCOPE-01, ENV-01, CRUD-01 und MAIL-01 sind direkt fehlgeschlagen; weitere 38 Pflichtgates wurden nicht vollständig ausgeführt.
