# Go-Live-Remediation-Ledger — novalure-crm.app

Stand: 23.08.2026 (Fortschreibung des Prüfstands vom 22.08.2026)<br>
Projekt: novalure-crm.app<br>
Arbeitsbranch: <code>codex/go-live-remediation-20260822</code><br>
Ausgangs-/Live-SHA zum Prüfstart: <code>77b751d6568487193e9151c7b16545649cfacde7</code>
Finale Remediation-SHA: wird nach dem Dokument-Freeze im Handoff ausgewiesen.

## 1. Aussagegrenzen und Statuslogik

Dieses Ledger trennt strikt zwischen:

- belegten Code-, Contract- und lokalen Buildtests;
- read-only erhobener Live-/Vercel-/Neon-Evidenz sowie separat ausgewiesenen, nicht produktiven Infrastrukturänderungen;
- dem auf Preview-Deployment `dpl_4KTHCFXUiHjpSPTgtfNGGZV27ZW9` und Source-SHA `92e38911fb9021a3b07d08b2cb4d232774a4986a` bestandenen Auth-/Tenant-/DB-Preflight (94/94) sowie dem gemäß Stop-Contract nach drei erfolgreichen Kontakt-Creates beim ersten Kontakt-PATCH mit 409 abgebrochenen Full-Execute; dessen exakter Cleanup hinterließ null Live-Rückstand. Der Mikrosekunden-CAS-Root-Cause ist lokal behoben und per realer Create→Update→Reset-Probe bestätigt, aber noch nicht in einem neuen SHA-identischen Preview vollständig HTTP-E2E-verifiziert. Die vollständige Preview-CRUD-/RBAC-/Cleanup-Matrix sowie Provider-, Browser- und Production-Prüfungen bleiben offen;
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
- Ein deterministischer Zwei-Tenant-QA-Harness samt Konfigurations-, Target-, Rollen-, Batch-, Secret-Evidence- und Cleanup-Guards ist vorhanden. Zwei isolierte `is_qa=true`-Tenants mit insgesamt neun Auth-Identitäten und zehn MFA-fähigen Mitgliedschaften sind provisioniert; jeder weitere Execute-Lauf erhält frische append-only Batches. Nach zwei historischen Kontakt-POST-503-Läufen auf `b8c72e3` wurde der SQL-Kommentarfehler korrigiert. Auf `dpl_4KTHCFXUiHjpSPTgtfNGGZV27ZW9` / `92e3891` bestand der Preflight erneut mit 94/94 Ergebnissen und 50 Requests. Der Full-Execute kam durch Owner-, Admin- und Member-Kontakt-Creates sowie die vorgesehenen 401-/403-Grenzen und stoppte danach beim ersten Owner-Kontakt-PATCH mit 409; bis dahin 113 bestandene, zwei fehlgeschlagene Ergebnisse und 75 Requests. Der Cleanup löschte im schreibenden Tenant exakt drei Kontakte plus drei Consent-Zeilen; der zweite Tenant war leer. Unabhängige Postconditions bestätigten null live verbliebene Kontakte, Consents, Deals und Stage-History. Root Cause des falschen Konflikts war der Verlust von PostgreSQL-Mikrosekunden, weil der Neon-HTTP-Treiber `timestamptz` als JavaScript-`Date` mit Millisekunden zurückgab. Der lokale Fix liest Contact-/Archiv-, Deal-, Lead- und Task-CAS-Tokens als Text, behält strikte Timestamp-Gleichheit bei, korrigiert den Task-Parameter und mappt echte Task-Konflikte auf 409. Eine reale `novalure_app`-Probe Create→Update→Reset ist grün und hinterließ null Live-Rückstand. Dieser Beleg ist kein bestandener deployter Full-E2E; dafür sind ein neues SHA-identisches Preview, erneut 94/94 Preflight und der vollständige HTTP-Matrix-/Cleanup-Lauf weiterhin erforderlich.

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
| <code>npm run test:unit</code> | 499/499 | 241/241 Basissuite plus 258/258 Go-Live-Remediation, zwei Runner; unter Node 24.14.0/npm 11.9.0 wiederholt |
| Funnel-Zielsuites | Deep-DTO 4/4; finaler Consent-/Alias-/Publish-Preflight-Zielstand 29/29; früherer breiter P1-Handoff 99/99 | Deep-Redaction, Minimalresponse, Atomizität, Abuse/Lease, Fresh Snapshot und einheitlicher Publish-/Restore-/Runtime-Preflight lokal belegt |
| Unit-/Building-Zielsuites | 44/44 | nach Tenant-Transaction-/Fresh-Snapshot-Fix |
| Knowledge-Zielsuite | 6/6 | nach External-Provider-Fail-Closed-Fix |
| Form-Zielsuite | 12/12; unabhängiges Reviewer-Zielbündel 39/39 | DTO/Minimalresponse, Atomizität/Replay, Identity, Consent und Launch-off-Grenzen nach letzter Consent-Nachschärfung belegt |
| Forms + Knowledge + Public Abuse | 26/26 | finaler Freeze nach bounded Admin-JSON, Knowledge-Log-Redaction und Public-Abuse-Nachschärfungen |
| Migration-Guards im Forms-Handoff | 20/20 | Migrationen 069–072/Dependencies und Safety-Contracts im Zielstand |
| <code>npm run test:go-live-remediation</code> | 258/258 | aktueller Delta-Stand einschließlich Scope, Providergrenzen, Proof-Refresh/Visits, Funnel-Token-CAS, durable Webhooks, Blob, QA-Batch-Ownership, Zwei-Tenant-Vertrag, funktionaler MFA-Challenge-Cookie-Rotation, gepinntem Zwei-Session-Barrieredrill, Migrationsparser, SQL-Kommentar-Guard und exakten CRM-CAS-/Task-409-Regressionen |
| finale gezielte Kernpfade | 40/40 | unabhängiger Abschlussreview |
| finale Migration/Unit/Newsletter-Zielgruppe | 39/39 | einschließlich Migration-Teil 20/20 |
| Booking-Zielsuites | gezielt grün | Create/Cancel/Reschedule Launch-off in API, Repository und UI; im aktuellen Remediation-Lauf 258/258 enthalten |
| <code>npm run test:integration</code> | 15/15 bestanden | lokaler Integrationstest |
| <code>npm run test:i18n</code> | 10/10 bestanden | lokaler i18n-Test |
| <code>npm run test:company-profile-settings</code> | 7/7 bestanden | lokaler Settings-Test |
| <code>npm run test:contact-access</code> | 4/4 bestanden | lokaler Contact-Access-Test |
| <code>npm run test:property-department</code> | 18/18 bestanden | lokaler Property-Test |
| Production-Security-Suite | bestanden, 0 Vulnerabilities | lokaler automatisierter Security-Nachweis |
| <code>npm run build</code> | Exit 0 | aktueller Next-Production-Build grün; 84 generierte Seiten, einschließlich QA-Capability und Form-Proof-Refresh |
| <code>git diff --check</code> | Exit 0 | keine Whitespace-/Patch-Formalfehler |
| <code>npm run release:verify-vercel-env</code> | nicht erfolgreich | lokaler Lauf verlangt <code>VERCEL_TOKEN</code>; Live-Metadaten wurden separat read-only geprüft |

Der aktuelle Delta-Stand ist für Unit 499/499 (241/241 Basis plus 258/258 Remediation), Integration 15/15 und i18n 10/10 grün. Unter der exakt gepinnten Ziel-Toolchain Node 24.14.0/npm 11.9.0 sind Toolchain-Check, vollständiges ESLint, Typecheck, Security Audit mit 0 Vulnerabilities, <code>git diff --check</code> und der Next-Production-Build mit 84 generierten Seiten bestanden. Der Remediation-Verbund enthält jetzt auch die gepinnte PgBouncer-Zwei-Session-Prüfung, den append-only-ACL-konformen Workspace-Lock, fail-closed Rollback-/PID-Negativfälle, den Regressionstest für die QA-Batch-SQL-Abfrage durch den realen Tenant-Single-Statement-Guard sowie Texttoken-/Strict-CAS- und Task-409-Verhaltensprüfungen. Die fokussierte Zwei-Tenant-Suite bestätigt den funktionalen Cookiefluss einschließlich Rotation und sichere Redirectdiagnostik mit 15/15. Die zwei älteren Funnel-P1-Befunde zu Proof-Refresh und Visit-Persistenz sind auf Kandidatencode-/Contract-Ebene adressiert; 33/33 lokale Zieltests sind grün. Der deployte Browser-/Expiry-/HTTP-/Postgres-Nachweis fehlt weiterhin. Public-Funnel-Visit-Tracking bleibt LAUNCH-OFF und gilt nicht als operativ abgenommen. Frühere lokale Testzählungen sind durch den aktuellen 499/499-Stand ersetzt; die unveränderliche Kandidaten-SHA entsteht mit dem anschließenden Commit-Freeze und wird im Deployment-Nachweis festgehalten.

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

Damit sind 34 Remediation-Suites in <code>test:go-live-remediation</code> verdrahtet und 258/258 Tests bestanden. Provisionierung, Code-/Contract-, Barrier- und lokale Repository-/Reset-Evidenz ersetzen noch keinen vollständig bestandenen Runtime-/Cleanup-E2E-Nachweis auf dem SHA-identischen Preview-Kandidaten.

## 4. Live-Baseline- und Vercel-Preview-Ressourcenevidenz

| Gegenstand | Evidenz | Bewertung |
|---|---|---|
| Vercel-Projekt | <code>novalure/novalure-crm</code> | identifiziert |
| Deployment-ID | <code>dpl_4r6tWnAMRAPMpeBbhGegYzu5tu1C</code> | READY, Production |
| Deployment-URL | <code>novalure-msj34yn5t-novalure.vercel.app</code> | aktuelles Baseline-Deployment, nicht der Remediation-Kandidat |
| Source-SHA | <code>77b751d6568487193e9151c7b16545649cfacde7</code> | entsprach beim Prüfstart dem damaligen Main-/Live-Stand |
| Logs | 24-Stunden-Read-only-Prüfung ohne Fehler/5xx | kein kontrollierter Fehler-/Trace- oder Alarmtest |
| frühere Baseline-CI | grün | gilt ausschließlich für Baseline-SHA; der Remediation-Preview-Build wird separat ausgewiesen |
| Vercel CLI | nicht global installiert | globale Installation mit <code>npm i -g vercel</code> wird stark empfohlen, um <code>vercel env pull</code>, <code>vercel deploy</code> und <code>vercel logs</code> direkt nutzen zu können. In-App-Vercel und Vercel-MCP waren erreichbar |
| Marketplace | Neon vorhanden, Resend nicht installiert | MAIL-01 offen |
| Preview Blob | neue private und öffentliche Preview-Stores in FRA1, jeweils ausschließlich mit Preview verbunden | Ressourcen-/Connection-Trennung umgesetzt; deployter Upload-/Read-/Delete-E2E fehlt |
| bestehende Blob-Verbindungen | alter Private Store nur Production; alter Public Store Production+Development, Preview entfernt | verhindert Preview-Fallback auf die bisherigen Stores auf Connection-Ebene |
| früheres Remediation-Preview | <code>dpl_BcDq1dTKfxYuSpDYztPt2qG4NKu2</code>, READY, Source-SHA <code>2a765ebec250316fe0802155a2c591567438dda9</code> | Preview-only; historische read-only Preflight-Evidenz, durch spätere Kandidaten-SHAs supersediert |
| aktuell geprüfter Preview-Kandidat | <code>dpl_4KTHCFXUiHjpSPTgtfNGGZV27ZW9</code>, READY, Source-SHA <code>92e38911fb9021a3b07d08b2cb4d232774a4986a</code> | Preview-only; temporärer Zugang exakt deployment-spezifisch freigegeben, Geheimwert nicht dokumentiert; Production unverändert |
| SHA-identischer Zwei-Tenant-Preflight | 94/94 Ergebnisse, 50 Requests, zehn authentifizierte Rollen-/Reset-Sessions, acht fremde Tenant-Reads korrekt 403, zwei anonyme API-Reads 401; Evidence-Digest <code>e84e56a971fd46f7cc153d0e48e036d6b65124572d086afd7e11c9cba4e6b9cd</code> | valide Teilevidenz auf <code>92e3891</code>; keine CRM-Mutationsroute im Preflight |
| Zwei-Tenant-Full-Execute | drei positive Kontakt-Creates 200 und negative 401/403-Grenzen bestanden; Stop beim ersten Owner-Kontakt-PATCH mit 409 nach 113 PASS / 2 FAIL / 75 Requests; Evidence-Digest <code>33d413abad603f98e56cc0ed05106db77bd96d7598a0b807cf6a955af152d7bb</code> | Mikrosekunden-CAS-Runtimefehler auf <code>92e3891</code>; vollständige CRUD-/RBAC-/IDOR-Matrix nicht ausgeführt und nicht bestanden |
| Execute-Cleanup | Tenant A exakt 3 Kontakte + 3 Consents gelöscht, Tenant B leer; Dry-run-/Execute-Digests und Ziel-/Löschcounts identisch; unabhängiger Live-Rückstand für Kontakte, Consents, Deals und Stage-History 0 | beide Batches versiegelt; append-only Ledger/Audits erwartungsgemäß retained |
| Repository-/Reset-Probe nach CAS-Fix | reales Repository mit <code>novalure_app</code> persistierte Kontakt + Consent, aktualisierte den Kontakt erfolgreich und bestätigte committed/already-registered Batchzustand; Reset löschte exakt 1 Kontakt + 1 Consent, Live-Rückstand 0 | isolierte Preview-Main, aber kein deployter HTTP-Full-E2E; lokale Fixvalidierung |
| PostgreSQL-Barrieredrill | 4/4 Reihenfolgen PASS, zwei getrennte gepinnte App-Sessions, bestätigte Rollbacks, <code>writes: 0</code>; Null-Rückstand unabhängig read-only bestätigt | gültiger isolierter Preview-Main-Barrierenbeleg; der spätere Kommentarsemikolon-Fix betrifft den vorgeschalteten Statement-Guard, nicht diese Lockreihenfolge |

Es wurden Remediation-Previews ausschließlich auf dem autorisierten Branch deployt; Production-Kandidat, Promotion und Aliasumschaltung wurden nicht ausgeführt. Das Preview auf `92e3891` enthält bereits den Kommentarsemikolon-Fix und belegt erstmals erfolgreiche Kontakt-Creates, reproduziert jedoch den Mikrosekundenverlust im nachfolgenden CAS-PATCH. Der lokale Texttoken-/Task-CAS-Fix benötigt einen neuen unveränderlichen Commit und ein neues Preview; Baseline-Deployment und Baseline-Logs dürfen weiterhin nicht als Evidenz für den geänderten Code verwendet werden.

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

Konsequenz: Die frühere Blob-Kollision ist auf Ressourcen-, Connection- und Codeebene remediated. ENV-01 bleibt dennoch <strong>FAIL / FEHLER</strong>, weil Queue-/Providertrennung sowie ein vollständiger SHA-identischer Preview-Runtime-/Uploadnachweis fehlen. Die sichere QA-Tenant-/Batch-Provisionierung, der Auth-/Tenant-/DB-Preflight auf `92e3891` und der direkte Preview-Main-Barrieredrill sind erfolgt. Der aktuelle Preview-Full-Execute bestand die ersten drei Kontakt-Creates und die negativen 401-/403-Grenzen, stoppte aber beim ersten Kontakt-PATCH mit 409; Cleanup/Reset löschte exakt drei Kontakte plus drei Consents und hinterließ null Live-Rückstand. Der lokale CAS-Fix ist noch nicht neu deployt. Der vollständige CRM-CRUD-Lauf, Upload und Provider-Smoke wurden nicht bestanden beziehungsweise nicht ausgeführt.

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
- Für das frühere Preview-Deployment `dpl_BcDq1dTKfxYuSpDYztPt2qG4NKu2` auf Commit `2a765ebec250316fe0802155a2c591567438dda9` bestand der read-only Preflight bereits 94/94 Ergebnisse und 50 HTTP-Requests. Redigierte historische Evidenz: `artifacts/qa/preview-2a765eb-preflight-20260823`, SHA-256 `f000d7b7ba89ad1051423872a7c98de179dffbd020090c754adbb8d886f23062`.
- Der vollständige read-only Preflight wurde auf Preview-Deployment `dpl_5ZgXwxJqZyUUhyE95QPZBVYHUhjk` und Source-SHA `b8c72e3745c42aaceab0ee013cfe5bef117e47a3` wiederholt und bestand erneut 94/94 Ergebnisse bei 50 Requests. Er belegt zehn konfigurierte Rollen-/Reset-Clients mit erfolgreicher Session-/Rollenbindung, beide QA-Tenants, wechselseitige 403-Tenantgrenzen, öffentliche 401/200-Grenzen, RLS, leere Laufbatches, 11/11 Migrationschecksummen, 19/19 validierte Tenant-Constraints, null Anti-Joins sowie den App-Rollen-/Ledger-Projektionsvertrag. Redigierte Evidenz: `artifacts/qa/preview-b8c72e3-preflight-20260823/preflight-two-tenant-e2e.json`, SHA-256 `0bdc4c36f35a53e9d7a4f38aff73283ec948e86f5702d38eb6587175064fcadb`.
- Zwei danach mit jeweils frischen Batches gestartete Full-Execute-Läufe stoppten gemäß Verification-Stop-Contract deterministisch beim ersten `POST /api/crm/contacts` mit HTTP 503. Der erste Lauf protokollierte 102 bestandene und zwei fehlgeschlagene Ergebnisse bei 67 Requests; der zweite bestätigte denselben ersten gebrochenen Boundary. In beiden Läufen wurde der `finally`-Cleanup für beide Tenants ausgeführt; die Owner-Postconditions zeigten null Batchobjekte und null live verbliebene Kontakte, Consents, Deals oder Stage-History. Evidenz: `artifacts/qa/preview-b8c72e3-execute-20260823`, SHA-256 `98a33ad309c9b79f9901cecebc44d40f9bf36930862ecabcfab2df7f5d9c7fd3`, sowie `artifacts/qa/preview-b8c72e3-retry1-execute-20260823`, SHA-256 `acd1c3300712672f35cc2b2c922892d5dde91442ab50d748b44b55b3ed648112`. Diese Läufe sind ausdrücklich nicht als bestandener Full-E2E zu bewerten.
- Die reproduzierte Ursache lag vor dem DB-Write: Das Semikolon in einem SQL-Kommentar der QA-Batch-Verfügbarkeitsabfrage wurde vom Tenant-Single-Statement-Guard als zweite SQL-Anweisung gewertet. Der minimale Fix ersetzt ausschließlich dieses Kommentarsemikolon; ein Regressionstest führt die reale Repository-Abfrage durch den echten Tenant-Guard und ist lokal grün. Eine zusätzliche reale Repository-Probe als `novalure_app` persistierte einen Kontakt plus Consent, bestätigte die committed QA-Batchregistrierung und ließ beide Zeilen durch den echten Reset exakt löschen. Die append-only Ledgerzeilen und Reset-Audits blieben erwartungsgemäß erhalten, während der Live-Rückstand für Kontakt und Consent null war. Auch dieser direkte Repository-/Reset-Beleg ersetzt nicht den deployten HTTP-Full-E2E auf dem neuen Fix-SHA.
- Der Kommentarfix wurde mit Commit `92e38911fb9021a3b07d08b2cb4d232774a4986a` auf Preview-Deployment `dpl_4KTHCFXUiHjpSPTgtfNGGZV27ZW9` READY bereitgestellt. Der SHA-identische Preflight bestand 94/94 Ergebnisse bei 50 Requests. Evidenz: `artifacts/qa/preview-92e3891-preflight-20260823/preflight-two-tenant-e2e.json`, SHA-256 `e84e56a971fd46f7cc153d0e48e036d6b65124572d086afd7e11c9cba4e6b9cd`.
- Der Full-Execute auf demselben Deployment bestand Owner-/Admin-/Member-Kontakt-Creates mit 200, Capability-Checks sowie die vorgesehenen 401-/403-Grenzen und stoppte danach beim ersten Owner-Kontakt-PATCH mit 409. Ergebnis bis zum Stop: 113 PASS, 2 FAIL einschließlich Stop-Bedingung, 75 Requests. Evidenz: `artifacts/qa/preview-92e3891-execute-20260823/execute-two-tenant-e2e.json`, SHA-256 `33d413abad603f98e56cc0ed05106db77bd96d7598a0b807cf6a955af152d7bb`. Deployment-spezifische Vercel-Runtime-Logs bestätigen genau diesen `PATCH /api/crm/contacts` mit 409; für die Route lag kein gruppierter Runtime-Error-Cluster vor.
- Der Cleanup löschte im schreibenden Tenant exakt drei Kontakte plus drei Consent-Zeilen; der zweite Tenant war leer. Dry-run-Ziel, Execute-Löschung und Plandigest stimmten überein. Unabhängige Owner-Postconditions bestätigten null live verbliebene Kontakte, Consents, Deals oder Stage-History; append-only Ledger- und Reset-Audits blieben erhalten. Beide Batches sind versiegelt.
- Die reale Reproduktion belegte einen Precision-Transportfehler statt konkurrierender Writes: Neon HTTP dekodierte `timestamptz` zu JavaScript-`Date` und verlor PostgreSQL-Mikrosekunden, sodass der anschließend strikt verglichene CAS-Token nicht mehr identisch war. Der lokale Fix liest interne `updated_at`-Tokens für Contact/Archiv, Deal, Lead und Task als Text, behält die exakte Timestamp-Gleichheit bei, korrigiert den Task-CAS-Parameter und mappt nur kontrollierte Task-CAS-Misses auf 409. Eine neue reale `novalure_app`-Probe bestand Create→Update→Reset mit null Live-Rückstand. Die lokale Suite ist mit 499/499 Unit-Tests (241 Basis + 258 Remediation), Integration 15/15, Lint, Typecheck, Security Audit und Production-Build grün. Ein neues SHA-identisches Preview und der vollständige HTTP-Execute fehlen weiterhin.
- Der echte Lock-/Rollback-Drill gegen isolierte Preview-Main deckte zunächst einen Runtimefehler auf: `novalure_app` besitzt absichtlich kein UPDATE auf dem append-only `qa_batches`, während `FOR SHARE` genau dieses Zusatzrecht erfordert. Der Kandidat lockt nun nur die mutable Workspace-QA-Grenze und serialisiert Batchoperationen weiterhin über denselben exklusiven Transaction-Advisory-Lock; die unveränderliche Batchzeile benötigt keinen Row-Lock. Der gehärtete Wiederholungslauf bestand vier von vier Reihenfolgen mit zwei getrennten gepinnten Sessions und bestätigten Rollbacks. Evidenz `artifacts/qa/preview-lock-barrier-pending-sha-20260823/lock-order-evidence.json`, SHA-256 `81af6d6e2ae8580d41e920bc71330265a85b750b17a18c19f7247f6dd3299666`; unabhängiger Postcondition-Beleg SHA-256 `a61e3013db0d2328cc0e03ef518b8f3f652f3fbc390eeb0177219a145f54cca5`: Workspace weiterhin QA, Batch vorhanden, 0 Batchobjekte, 0 Reset-Audits und 0 Markerreste.
- Migration 061 wurde absichtlich nicht angewandt: Die sichere Gruppe `novalure_tenant_app` ist vorhanden, aber App-Verbindung, direkte Mitgliedschaft und immutable Deployment-Attestation sind noch nicht als gemeinsam wirksamer Cutover belegt. RLS auf den fünf Pilot-Tabellen bleibt daher aus.
- RPO/RTO-Zielwerte, Recovery-Reconciliation und formale DBA-/Release-Signatur bleiben offen; der technische Restore-Drill selbst ist nicht mehr offen.

## 7. Verbindliche Gate-Matrix

Zusammenfassung: 2 PASS, 6 FAIL, 38 NOT RUN. Da jedes NOT RUN laut Master-Prompt als Fehler zählt, ist eine GO-Entscheidung ausgeschlossen.

| Test-ID | Status | Präziser Nachweis bzw. Grund |
|---|---|---|
| REL-01 | FAIL / FEHLER | lokaler Freeze unter Node 24.14.0/npm 11.9.0 für Toolchain, Unit 499/499, Remediation 258/258, Integration 15/15, i18n 10/10, vollständiges ESLint, Typecheck, Security Audit, Diff-Check und Production-Build mit 84 Seiten grün; nach dem Mikrosekunden-CAS-Fix fehlt der neue SHA-identische Preview-Deploy samt Deployment-/Alias-Parität |
| REL-02 | FAIL / FEHLER | historischer Production-Audit <code>ok: false</code> bei 112/115 Tabellen und Ledger 067; Preview-Kandidat erwartet nach 075/076 mindestens 119 Tabellen und Migrationen 068–077 einschließlich manuellem Cutover 057, ohne Production-Anwendung |
| REL-03 | NOT RUN / NICHT AUSGEFÜHRT | isolierter Neon-Migrations-/Restore-/Reapply-Drill bestanden, Pre-Cutover-Snapshot vorhanden und Preview-Main checksummengenau auf 057 + 068–077 einschließlich vollständigem 077-Least-Privilege-Gate; RPO/RTO/Reconciliation, 061-App-Rollen-Cutover, echter App-Login-RPC-Probe, privater-Blob-End-to-End, Queue-/Cron-SLO und signierte Ops-Evidenz fehlen |
| REL-04 | NOT RUN / NICHT AUSGEFÜHRT | fünf Unternehmensprofilblocker sowie Legal-/Ops-Abnahme nicht belegt |
| SCOPE-01 | FAIL / FEHLER | versionierte zentrale Policy für die remediated Surfaces vorhanden und unbekannte Surfaces fail-closed; vollständige signierte ON/OFF/INTERNAL-Matrix, Vollabdeckung und deployte Negativmatrix fehlen |
| ENV-01 | FAIL / FEHLER | Preview-DB und Preview-Blob auf Ressourcen-/Connection-/Codeebene getrennt; zehn sensitive Variablen sind ausschließlich branchgebunden gesetzt. Queue-/Providerziele und der Runtime-E2E des neuen Kandidaten bleiben offen |
| DATA-01 | PASS / BESTANDEN | Forms, Knowledge und Funnel verwenden DB-only-Wahrheit; automatisierte Produktionswahrheits-/Fallback-Negativtests grün |
| DATA-02 | NOT RUN / NICHT AUSGEFÜHRT | kein vollständiger UI/API/DB-Drei-Wege-Abgleich für alle Launch-KPIs |
| CRUD-01 | FAIL / FEHLER | Migrationen 068–077 sind auf isoliertem Preview angewandt; zwei reale `is_qa`-Tenants, zehn MFA-fähige Mitgliedschaften und branchgebundene Runtime-ENV sind vorhanden. Der SHA-identische Preflight auf `92e3891` bestand 94/94. Der Full-Execute bestand drei Kontakt-Creates und die negativen RBAC-Grenzen, stoppte beim ersten Kontakt-PATCH mit 409 und hinterließ nach exaktem Cleanup null Live-Rückstand. Der Mikrosekunden-CAS-Root-Cause ist lokal für Contact/Archiv, Deal, Lead und Task behoben und durch Regression sowie reale Create→Update→Reset-Probe bestätigt. Der vollständige HTTP-Matrix-/Reset-/Cleanup-E2E auf einem neuen SHA-identischen Fix-Preview fehlt weiterhin |
| CRUD-02 | NOT RUN / NICHT AUSGEFÜHRT | die CRM-Kernkette erreichte Create→Read, stoppte aber beim ersten Update; Relation, Filter und vollständiger HTTP-Cleanup-Abgleich wurden dadurch nicht ausgeführt |
| CRUD-03 | NOT RUN / NICHT AUSGEFÜHRT | einzelne Idempotenz-/Validierungsfixes getestet, aber keine vollständige Doppelklick-/Zwei-Tab-/Offline-/Retry-Matrix |
| FORM-01 | NOT RUN / NICHT AUSGEFÜHRT | Resolver-/Persistenz-Code gehärtet, aber kein Adminstatus/DB/Canonical/Embed-E2E auf einem Kandidaten |
| FORM-02 | NOT RUN / NICHT AUSGEFÜHRT | atomarer Submission-/Minimal-Replay-, DTO-, Identity- und Consent-Contract lokal 12/12, Migration-Guards 20/20; echter allowlisteter QA-Submit mit Relations- und Cleanup-Abgleich fehlt |
| BOOK-01 | NOT RUN / NICHT AUSGEFÜHRT | öffentliche Create-/Cancel-/Reschedule-Pfade sind in API, Repository und UI Launch-off; echter QA-Kalender-/Providerstatus und Cleanup vor späterem Launch-on fehlen |
| MAIL-01 | FAIL / FEHLER | Resend nicht installiert, From-/Env-Metadaten inkonsistent, Domain/Readiness und allowlistete QA-Mail nicht belegt |
| MAIL-02 | NOT RUN / NICHT AUSGEFÜHRT | redigierte Fehler-/Timeout-Grenzen im Code; kein kontrollierter echter Providerfehler mit End-to-End-Nachweis |
| AUTH-01 | NOT RUN / NICHT AUSGEFÜHRT | Teilbeleg: zehn konfigurierte Rollen-/Reset-Clients erreichten `/api/auth/session` mit 200 und zehn Logout-Aufrufe 303. Die Evidenz codiert nicht für jeden Client den konkreten Challenge-Typ. Vollständige Login/MFA-/Workspace-Challenge-, Post-Logout-, Reload-, CSRF-, Rate-Limit-, Ablauf- und Token-Matrix fehlt |
| RBAC-01 | NOT RUN / NICHT AUSGEFÜHRT | Teilbeleg: Owner/Admin/Member/Customer wurden in beiden Tenants authentifiziert und acht fremde `/api/crm/core`-Reads korrekt mit 403 verweigert. Vollständige serverseitige Endpoint-/CRUD- und UI-Matrix fehlt |
| TENANT-01 | NOT RUN / NICHT AUSGEFÜHRT | Teilbeleg: wechselseitige Core-Reads aller vier Rollen 8/8 mit 403 sowie zwei öffentliche Seiten ohne fremde Workspace-ID. Vollständige Zwei-Tenant-IDOR-/CRUD-/Relationssuite gegen isolierte QA-Daten fehlt |
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
| PROD-01 | NOT RUN / NICHT AUSGEFÜHRT | Remediation-Preview `92e3891` deployt und READY, aber der Full-Execute reproduzierte den Kontakt-PATCH-409 und machte den lokalen Mikrosekunden-CAS-Fix erforderlich; kein finaler SHA-identischer Kandidat unter kanonischem Alias und kein kontrollierter Production-Smoke |
| CLEAN-01 | NOT RUN / NICHT AUSGEFÜHRT | der aktuelle Preview-Execute führte den API-Cleanup für beide Laufbatches aus: exakt drei Kontakte plus drei Consents im schreibenden Tenant, leerer zweiter Tenant, identische Ziel-/Löschcounts und null unabhängiger Live-Rückstand. Die post-fix Repository-Probe bestand zusätzlich Create→Update→Reset mit exakt einem Kontakt plus Consent und null Rückstand. Der vollständige deployte HTTP-Matrixlauf mit allen CRM-Objekten und unabhängiger Gesamtreconciliation fehlt weiterhin |

## 8. Befund → Fix → Test/Evidenz → Reststatus

| Befund | Umgesetzter Fix | Test/Evidenz | Reststatus |
|---|---|---|---|
| Fixture-/Fallback-Risiko bei Forms/Knowledge/Funnel | DB-only-Repositories und fail-closed Resolver; Knowledge approved/search nur mit externem Provider | zielgerichtete Forms-/Knowledge-/Funnel-Suites und Unit 499/499 | DATA-01 für den Code-Contract bestanden; deployed E2E weiterhin offen |
| Public Funnel überträgt internen Blueprint/Diagnostik | Deep-Allowlist-DTO; Public Proof statt Publish-Token im Browser/POST; minimale Live-Response ohne interne IDs; DB-Fehler bleiben 5xx | Funnel-Public-DTO-Security 4/4 und Funnel-Zielsuites | Kandidatencode geschlossen; externer Publish-Token muss vor GO rotiert werden; deployed E2E offen |
| Funnel-Submit konnte Teilwrites, parallele Kontaktduplikate oder Consent-/Alias-Drift erzeugen | atomarer Domain-/Claim-CTE; lease-gefencete Replayresponse; shared Form/Funnel-Email-/Phone-Identity-Advisory-Locks in Tenant-TX; kanonische Consent-/Identity-Aliasse; gemeinsamer Publish-/Restore-/Runtime-Preflight | Funnel-Abuse-/Migration-/Boundary-/Preflight-Zielsuites, finaler Freeze 29/29 | Kandidatencode geschlossen; echtes DB-Concurrency-/Zwei-Tenant-E2E offen |
| Funnel-Webhooks ohne freigegebenen Scope | Konfiguration/API/Persistenz/Adapter explizit LAUNCH-OFF | Funnel-Production-Boundary-Test | Teil von SCOPE-01; Gesamtgate offen |
| Import sichtbar, aber nicht freigegeben | Entry Points ausgeblendet; kein Server-Importendpunkt vorhanden; `importReview` zentral `LAUNCH-OFF` | Launch-Scope-Fail-Closed-Test | Signatur und deployte Negativverifikation fehlen |
| Unsicherer Unsubscribe-GET/PII-Link | opaker Fragmenttoken, expliziter POST, atomare Suppression/Consent-Aktualisierung | Newsletter-Unsubscribe-Security 7/7 | alter Link absichtlich ungültig; Provider-/QA-Versand offen |
| Newsletter-Versand ohne freigegebene Providerabnahme | API vor Providerzugriff 503/no-store Launch-off; UI-Sendaktionen verborgen | Newsletter-/E-Mail-/Launch-Scope-Zielsuites | Product-/Providerfreigabe und genau ein QA-Send offen |
| Booking-Race-/Lifecycle-Risiken ohne abgeschlossene Providerabnahme | öffentliche Create-/Cancel-/Reschedule-Route, Repository und UI hart Launch-off vor Body/DB/Provider; Legacy-Resolver propagiert DB-Ausfälle statt sie als 404 zu maskieren | Booking-/i18n-/Launch-Scope-Zielsuites sowie finaler P2-Recheck | Product-/Providerfreigabe und vollständiges QA-Lifecycle-E2E vor Launch-on offen |
| Unit-/Building-Doppelwrites bei Parallelität | semantische Idempotenz-Ledger; separate Advisory-Lock-Anweisung innerhalb Tenant-TX; atomarer Domain-/Ledger-/Auditwrite | 44/44 Unit-/Migration-/Reset-Zielsuites; Migration 069 auf isoliertem Preview angewandt | echtes DB-Concurrency-E2E offen |
| Form-Submit-Teilwrites/instabile Retries/Infoleak | lease-gefenceter atomarer Domain-/Minimalresponse-CTE; semantischer Multipart-Fingerprint; Public-Allowlist-DTO; Owner-Tenant-Guard; shared Identity-Locks/Conflict-Schutz; authentifiziertes Admin-JSON streamingbegrenzt auf 256 KiB | Forms 12/12, Reviewer-Bündel 39/39, Migration 20/20, Remediation 258/258, Migrationen 071/072 auf isoliertem Preview | Kandidatencode geschlossen; deploytes Submit-/Cleanup-E2E offen |
| File-/RoundRobin-/Custom-Pattern-/unsichere Consent-Formen wirkten public-fähig | Admin-Save/UI, Public Page, Embed und API durchgängig fail-closed; feste Consent-Truthy-Allowlist, Privacy/Marketing getrennt und nicht vorselektiert; Analytics/unclassified off | Forms 12/12 und Reviewer-Bündel 39/39 | Kandidatencode geschlossen; spätere Aktivierung benötigt eigene sichere Implementierung und E2E-Abnahme |
| E-Mail-Fallback-/Leak-Risiko | expliziter Resend-Purpose, keine Mock-Fallbacks, redigierte Fehler; Newsletter und Customer-Communication vor Provider-/Send-State OFF, unbekannte Zwecke fail-closed; Account-Access-Mail getrennt | Email-Production-Boundary- und Launch-Scope-Tests | Resend/Domain/From/QA-Mailbox nicht live validiert |
| Falsch-grünes Release-/Governance-UI | reale Contract-Diagnostik, statische Verifikation entfernt | System-Releases-Contract-Test | Production-Schema ist tatsächlich rot |
| Zu breite Systemdiagnostikrolle | exakt Platform Admin bzw. novalureAdmin | Contract-/Role-Test | vollständige RBAC-Matrix offen |
| Gefährlicher QA-Reset | Audit/Allowlist/Dry-run/CSRF/FK-Closure; atomare Contact-/Consent-/Deal-/History-Batchregistrierung; Ownership-Guard gegen Idempotency-Kollisionen; Legacy deaktiviert | QA-Reset- und QA-Batch-Tests einschließlich Kommentarsemikolon-Regression; Migration 068, zwei Tenants sowie reale Repository-Persistenz und exakter Kontakt-/Consent-Reset auf isoliertem Preview-Main | deployter vollständiger HTTP-Matrix-Dry-run/Execute/Null-Rest-Abgleich nicht bestanden |
| Deal-/Inventory-Doppel- oder Silent-No-op-Risiko | gemeinsame Validierung, Idempotenz, sichtbare Fehler, Doppelklickguard | Deal-UX- und Inventory-Regressionstests | vollständige Browser-/Parallel-Tab-Matrix offen |
| Profilnavigation verliert Analysezustand | <code>#analysis</code>-Invariant | Navigation-Profile-Invariant-Test | UX-02 bestanden |
| Schwache CSP-/Framing-Grenze | Nonce, strict-dynamic, Frame-Restriktionen, Fallback-CSP | CSP-Test | vollständiger Kandidaten-Header-/Embed-E2E offen |
| Consent-Fokusverlust nach Escape | Trigger bleibt gemountet, verbundener Vorfokus wird erhalten und wieder fokussiert | gezielte Suite 3/3, Lint, Typecheck, Build | vollständige Mobile-/Screenreader-Matrix offen |
| falsche Sprache/dynamische Public-404 | Locale-, noindex- und Not-found-Grenzen | Public-Booking-i18n-Test und lokale DE-Beobachtung | vollständige Pflicht-Routen-Matrix offen |

### 8.1 Unabhängiger Abschlussreview

Der aktuelle Stand enthält zusätzlich Policy 2026-08-22.7, monotone Bot-/Providerkontrollen, durable Inbound-Webhook-Verarbeitung, Funnel-Revision-CAS/Secret-Sanitization sowie Deal-/QA-Batch-Ownership-Härtung. Der unabhängige statische Review des lokalen Mikrosekunden-/Task-CAS-Diffs weist `0 P0/0 P1` aus; dies ist ausdrücklich kein finaler Runtimebefund. Der jüngste deployte Execute stoppte auf der vorherigen SHA beim Kontakt-PATCH mit 409, und die externen sowie E2E-Releasegates aus Abschnitt 9 bleiben offen.

Verbleibende P2-/Formalgate-Hinweise:

- Für Public Forms und Public Funnels liegen scope-/publikationsgebundene, idempotency-key-erhaltende Proof-Refresh-Flows als Kandidatencode vor; offen bleibt der deployte Browser-/Expiry-/Replay-Nachweis für lange Sessions.
- Public-Funnel-Visit-Persistenzpfad und Migration liegen nur als Kandidatencode-/Contract-Evidenz vor; `publicFunnelVisit` bleibt LAUNCH-OFF. Operative Visit-Persistenz und KPI-Wahrheit sind bis zum deployten Browser-/HTTP-/Postgres-, Consent-/Retention- und KPI-Baseline-Nachweis nicht abgenommen.
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
8. Zwei QA-Tenants und echte Rollen sind provisioniert; der SHA-identische Auth-/Tenant-/DB-Preflight ist auf `92e3891` 94/94 grün und der direkte Preview-Main-Barrieredrill 4/4 grün. Der Full-Execute bestand Kontakt-Creates und negative RBAC-Grenzen, stoppte beim ersten Kontakt-PATCH mit 409 und hinterließ nach exaktem Cleanup null Live-Rückstand. Der Mikrosekunden-CAS-Root-Cause ist lokal behoben und per realer Create→Update→Reset-Probe bestätigt. Die Wiederholung als vollständiger HTTP-E2E auf dem neuen Fix-SHA sowie die restlichen CRM-CRUD-, RBAC-, IDOR-, Auth-, Datei-, Newsletter-, Data-Hygiene-, Bot-, OAuth- und Integrations-E2Es fehlen.
9. Cron-/Queue-SLO, Recovery, Monitore und getestete Alarme fehlen.
10. Der lokale Toolchain-Nachweis Node 24.14.0/npm 11.9.0 ist bestanden; offen bleibt nach dem CAS-Delta der SHA-identische CI-/Deployment-Nachweis des Nachfolgecommits.
11. Preview `dpl_4KTHCFXUiHjpSPTgtfNGGZV27ZW9` für SHA `92e38911fb9021a3b07d08b2cb4d232774a4986a` ist READY und mit 94/94 vorgeprüft, reproduziert aber den Kontakt-PATCH-409. Für den lokal behobenen Mikrosekunden-CAS-Root-Cause fehlen das neue SHA-identische Preview, der vollständige grüne Execute, Kandidaten-Screenshots, vollständiges Axe-/Screenreader- und Mobile-Set sowie Lighthouse-/Web-Vitals-Evidenz. Ein Production-Kandidat wurde nicht deployt.
12. Production-Beobachtungsfenster von 60 Minuten, 24 Stunden und sieben Tagen wurden für den Remediation-Kandidaten nicht begonnen.
13. Der bislang im öffentlichen Live-Funnel verwendete Publish-Token muss vor GO rotiert, die alte Capability widerrufen und die neue Capability kontrolliert verteilt werden. Diese externe Rotation wurde nicht ausgeführt.

## 10. Bewusst nicht ausgeführte Aktionen

Aufgrund des weiterhin offenen vollständigen ENV-01-Gates, fehlender fachlicher/providerseitiger Freigaben und des noch nicht deployten SHA-identischen Nachfolgecommits wurden folgende Aktionen nicht ausgeführt:

- keine Änderung von Vercel-Production-Env-Variablen;
- keine Providerdomain-, Key-, From-, Mailbox- oder Kalenderänderung;
- keine Production-Migration; Preview-Main enthält checksummengenau 057, 060 und 068–077, der isolierte Evidence-Branch belegt zusätzlich den bestandenen Restore-/Reapply-Drill für 057 + 073–076 und den separaten 077-Least-Privilege-Test; 061 blieb gesperrt;
- kein Production-CRM-Geschäftsobjekt-Seed; auf isolierter Preview-Main wurden ausschließlich freigegebene QA-Daten geschrieben: im aktuellen HTTP-Execute drei Kontakte plus drei Consent-Zeilen sowie in zwei begrenzten Repository-Proben jeweils ein Kontakt plus Consent; sämtliche Live-Zeilen wurden kontrolliert bereinigt;
- kein vollständiger Preview-CRUD und kein Preview-/Production-Upload; die zwei historischen `b8c72e3`-Executes stoppten vor dem ersten CRM-DB-Write, während der aktuelle `92e3891`-Execute drei Kontakte plus drei Consents persistierte und beim ersten Kontakt-PATCH stoppte;
- kein echter Provider-Mailversand und kein Kalendereintrag;
- kein dauerhafter QA-CRM-Geschäftsobjekt-Rückstand; der aktuelle HTTP-Execute und beide begrenzten Repository-Proben wurden mit Batchregistrierung geschrieben und vollständig zurückgesetzt;
- kein Cleanup/Reset in Production;
- keine historische Retry-/Recovery-Aktion;
- kein Production-Deployment, keine Promotion, keine Production-Aliasumschaltung und keine öffentliche Feature-Freischaltung; Preview-Deployments blieben auf den autorisierten Remediation-Branch begrenzt;
- keine Blob-Dateiobjekte, Queue-Nachrichten oder Provider-Sends erzeugt; angelegt wurden ausschließlich die zwei leeren Preview-Blob-Stores sowie Drill-, Preserve- und Pre-Cutover-Snapshot-Branches im isolierten Neon-Projekt;
- ausschließlich der kontrollierte Cleanup der Preview-Laufbatches und beider Repository-Proben; alle verwendeten Execute-/Probe-Batches sind versiegelt und der nächste Lauf benötigt frische Batches.

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
4. Die zehn bereits branchgebundenen Preview-ENV beibehalten, den Mikrosekunden-/Task-CAS-Fix committen und dessen exakt gepinnten neuen Kandidaten-SHA deployen; Production-ENV und Production-Deployment bleiben gesperrt. Für dessen temporären Zugang ist eine neue, deployment-spezifische Freigabe erforderlich.
5. Danach mit frischen Batches den 94/94-Preflight auf dem exakten Fix-Kandidaten wiederholen und den Zwei-Tenant-Harness einschließlich Capability, vollständiger CRUD-/RBAC-/IDOR-Matrix, Dry-run/Execute und Null-Rest-Cleanup grün abschließen. Der direkte PostgreSQL-Barrieredrill ist 4/4 grün und muss nur bei einem weiteren Lock-/Transaktionsdelta erneut laufen.
6. Den bislang öffentlichen Funnel-Publish-Token kontrolliert rotieren und die alte Capability widerrufen.
7. Vollständige Gate-Matrix einschließlich Zwei-Tenant-, Provider-, File-, A11y-, Mobile-, Performance- und Cleanup-E2Es ausführen.
8. Erst danach einen geschützten Production-Kandidaten genehmigen, smoke-testen, bereinigen und beobachten.
9. Alias-/Feature-Freischaltung nur als separate, ausdrücklich genehmigte Aktion.

## 13. Entscheidung

<strong>Entscheidung: NO-GO</strong>

Die Code-Remediation beseitigt mehrere reale Produkt- und Sicherheitsrisiken und liefert belastbare lokale Tests. Sie schließt jedoch nicht die harten Infrastruktur-, Schema-, Legal-, Provider-, Zwei-Tenant-, Betriebs- und Production-Gates. REL-01, REL-02, SCOPE-01, ENV-01, CRUD-01 und MAIL-01 sind direkt fehlgeschlagen; weitere 38 Pflichtgates wurden nicht vollständig ausgeführt.
