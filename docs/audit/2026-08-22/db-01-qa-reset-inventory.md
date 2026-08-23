# DB-01 — QA-Tenant- und Reset-Inventur

Stand: 22.08.2026
Scope: Repository-/Migrationsartefakte, isolierter Preview-Neon-Migrations-/Restore-Drill, Preview-Schema-Cutover und sichere Zwei-Tenant-/Identity-/Batch-Provisionierung; keine Production-Datenbank-, Provider-Send- oder Kalender-Mutation.

## Ausgangszustand

- Es gab kein `is_qa`-Kennzeichen, keine `qa_batch_id`, kein Batch-Objekt-Ledger und kein unveränderliches Reset-Audit.
- `scripts/qa-target-guard.mjs` schützt CLI-QA-Zugriffe über einen Neon-Zielfingerprint. Dieser Guard markiert aber keine einzelnen Datensätze und beweist keine referenzielle Batch-Closure.
- `scripts/qa-livegang-reset.mjs` löschte deterministisch berechnete Workspace-Wurzeln direkt. Der Pfad war nicht dry-run-first, nicht Session-/Capability-/CSRF-geschützt und konnte keinen vollständigen Objekt-/Blob-/Job-/Providergraphen beweisen.
- Die bestehenden QA-Skripte verwenden überwiegend `GOLIVETEST_`-Marker; der verbindliche sichtbare Marker `QA-TEST-<YYYYMMDD-HHmm>-<short-id>` und eine unveränderliche Batch-ID waren nicht durchgängig vorhanden.
- `audit_logs` ist append-only, besaß aber zugleich Projekt-/Deal-FKs mit `ON DELETE SET NULL` sowie tenantqualifizierte FKs. Das widersprach einem Reset bei gleichzeitiger Audit-Aufbewahrung.

## Implementierte Sicherheitsgrundlage

- Migration `068_qa_batch_reset_safety.sql`:
  - `workspaces.is_qa` mit sicherem Default `false`;
  - append-only `qa_batches` mit geprüftem `QA-TEST-...`-Marker;
  - append-only `qa_batch_objects` mit global eindeutiger Ressourcenregistrierung, damit dieselbe ID nicht zwei Batches zugeordnet werden kann;
  - append-only `qa_reset_audit_events` mit Modus, Ergebnis, SHA-256-Plandigest, Counts und exaktem Target-Manifest;
  - Trigger verweigert Batch-Erstellung für jeden Workspace ohne `is_qa = true`;
  - RLS und Minimalgrants für die drei Ledger;
  - Projekt-/Deal-UUIDs in `audit_logs` bleiben unveränderliche Snapshots; nur die kollidierenden Live-FKs werden entfernt, Spalten und Indizes bleiben bestehen.
  - der zentrale Migrationsrunner führt 068 niemals automatisch aus; sie ist ein Manual-Cutover mit zwingender, checksummierter 060-Vorbedingung (sichere NOLOGIN-Tenant-Rolle) und benötigt `--only=068_qa_batch_reset_safety --allow-manual-cutover` erst nach den dokumentierten Freigaben. Die separate Migration 061 aktiviert erst später den Kern-CRM-RLS-Pilot und ist keine Voraussetzung für das QA-Ledger.
- `POST /api/admin/qa-reset`:
  - akzeptiert keine frei parametrisierte Tabelle und keine anderen HTTP-Mutationen;
  - benötigt eine persistierte Cookie-Session, technische Rolle `owner`, Produktrolle `platform_admin`, App-Permission `settings:manage` sowie Produkt-Capabilities `novalure:internal` und `settings:manage`;
  - erzwingt CSRF vor Capability-/Reset-Aufruf;
  - akzeptiert nur Workspace-IDs aus der serverseitigen `NOVALURE_QA_RESET_WORKSPACE_IDS`-Allowlist; mindestens zwei IDs sind Pflicht;
  - verlangt eine nichtleere `NOVALURE_PRODUCTION_WORKSPACE_IDS`-Denylist und verweigert jede Überschneidung mit ihr; fehlt sie, antwortet der Runtime-Rand fail-closed mit einem Konfigurationsfehler;
  - führt ohne Modus immer `dry_run` aus;
  - `execute` benötigt zusätzlich `NOVALURE_QA_RESET_EXECUTION_ENABLED=true`, die exakte Confirmation `RESET QA BATCH <workspaceId> <batchId>` sowie `expectedPlanDigest` mit dem exakten SHA-256-Plandigest aus dem unmittelbar vorherigen blockerfreien `dry_run`;
  - Antwort und Audit sind `private, no-store` und enthalten keine Secrets.
- Repository:
  - eine tenantgebundene Transaktion für Plan, Graphprüfung, Löschung und Audit;
  - Workspace-Lock, `is_qa`-Prüfung, Allowlist-Prüfung und workspacegebundene Batch-Prüfung;
  - ausschließlich feste Tabellenallowlist; Workspaces, Nutzer, Audit, Auth, Security und definierte Telemetrie sind nicht löschbar;
  - exakte UUIDs ausschließlich aus `qa_batch_objects`;
  - DB-Katalogprüfung aller FKs zu den Zieltabellen;
  - kompletter Abbruch bei unbekannter Tabelle/FK-Form, fehlender oder fremd-tenantiger ID, unregistrierter/fremder Batch-Abhängigkeit oder Mutation unveränderlicher Evidenz;
  - deterministische Child-before-Parent-Löschreihenfolge;
  - Blob-/Providerressourcen und Tabellen mit möglichen externen Side Effects blockieren Execute, solange kein verifizierter Adapter/Reconciliation-Nachweis vorhanden ist;
  - Löschcount-Abweichung wirft innerhalb derselben Transaktion und rollt alles einschließlich Erfolgsaudit zurück.
- Der alte Direktlöschpfad `scripts/qa-livegang-reset.mjs` ist hart deaktiviert und öffnet keine Datenbank mehr.
- Der alte `scripts/qa-livegang-api.mjs`-Schreibpfad ist ebenfalls hart deaktiviert. `test:e2e` und `qa:livegang:api` zeigen jetzt auf den neuen Zwei-Tenant-Harness; dieser verlangt vor dem ersten CRM-Write einen SHA-gebundenen Runtime-Proof für atomare Batchregistrierung und ist bis dahin fail-closed.
- Rollen-/CRUD-/Cross-Tenant-/Reload-/Concurrency-/Cleanup-Matrix, Zielvertrag und geheimnisfreies Evidence-Schema stehen in [`two-tenant-live-e2e-runbook.md`](./two-tenant-live-e2e-runbook.md).
- `scripts/qa-batch-lock-order-live.mjs` stellt den unabhängigen echten PostgreSQL-Barriere-Nachweis bereit. Der Default ist ein netzwerkfreier Plan; der bestätigungspflichtige Preview-Lauf verwendet zwei getrennte `novalure_app`-Sessions und ausschließlich `BEGIN`, feste `SET LOCAL`-Werte, `SELECT`-/Lock-Statements, genau das feste `UPDATE workspaces SET is_qa=false` für den QA-Flag-Race-Nachweis und `ROLLBACK`; das Update wird immer zurückgerollt.

## Explizit aufbewahrte Evidenz

Die versionierte Liste steht in `qaResetRetainedTables`. Dazu gehören insbesondere Workspace-/Rollenwurzeln, Auth-/Securityzustände, `audit_logs`, `auth_audit_events`, definierte Audit-/Telemetrytabellen, Abuse-/Idempotency-Guards, Schema-Ledger und die neuen QA-Ledger. Diese Bestände sind getrennt von operativen Geschäfts-KPIs zu reconciliieren.

## Noch nicht erfüllt / harte Restgrenzen

1. Migration 068 wurde im isolierten Drill und anschließend auf Preview-Main angewandt; Production blieb unverändert. Der technische Migrations-/Restore-Drill ist bestanden; die funktionale QA-Batch-Dry-run-/Execute-/Null-Rest-Ausführung ist noch nicht erfolgt.
2. Tenant A und Tenant B wurden mit je fünf Rollen-/Produktrollen-Mitgliedschaften, insgesamt neun Auth-Identitäten, zehn MFA-fähigen Mitgliedschaften und je einem leeren Batch provisioniert. Beide Workspaces sind `is_qa=true`; es wurden noch keine CRM-Geschäftsobjekte erzeugt.
3. Contact- und Deal-Creator registrieren den Hauptdatensatz sowie Consent bzw. Stage-History atomar in `qa_batch_objects`, sobald der explizite Preview-QA-Vertrag aktiv ist. `/api/admin/qa-batch-capability` bestätigt denselben Kandidaten-SHA erst nach Prüfung von Cookie-Session, Launch-Scope/RBAC, Allowlist, `workspaces.is_qa` und Ledger-Verfügbarkeit. PATCH/Archiv dürfen nur bereits batchzugehörige Hauptobjekte ändern.
   Reset und Registrierung verwenden denselben exklusiven Transaction-Advisory-Lock. Nach einem append-only Execute-Audit ist der Batch endgültig versiegelt; parallel wartende und spätere Registrierungen werden vor jedem Geschäftswrite abgewiesen.
   Die lokale Simulation beider Startreihenfolgen ist grün. Der neue Live-Barrierenharness und sein vollständig zurückgerollter Contract sind vorhanden; sein echtes `--execute` gegen den isolierten Preview-Batch wurde in diesem Code-Delta bewusst nicht ausgeführt und bleibt ein Pflichtgate.
4. Blob- und Provider-Cleanup-Adapter fehlen. Deshalb verweigert der Executor entsprechende Batches absichtlich.
5. Migrationen 057 und 068–077 wurden checksummengenau auf Preview-Main verifiziert; 057 + 073–076 wurden zuvor auf dem isolierten Evidence-Branch per Apply/Restore/Reapply geprüft, 077 dort anschließend separat least-privilege-validiert. Preview-Main besteht 11/11 Checksummen, 19/19 Tenant-FKs, 0/19 Anti-Joins, 21/21 Launch-Artefakte und das vollständige 077-Owner-/ACL-Gate. Eine tatsächliche Batch-Closure-FK-Graphprüfung mit erzeugten CRM-Objekten fehlt.
6. RLS ist für die drei QA-Ledger aktiv. Die separate Kern-CRM-Pilotaktivierung 061 ist absichtlich noch nicht angewandt, bis `novalure_app`-Runtimeverbindung, Rollenmitgliedschaft und immutable Deployment-Attestation zusammen belegt sind. Der read-only Preflight belegte die App-Rolle, RLS und acht wechselseitige Tenant-Grenzen; vollständige Zwei-Tenant-IDOR-/Graph-Closure-CRUD bleibt ein separates SEC-01-/Preview-Gate.
7. Die initiale `is_qa`-/Identity-/Batch-Provisionierung ist abgeschlossen. Nach jedem versiegelten Lauf muss ein neuer, gesondert genehmigter und zielgeprüfter Batch provisioniert werden. Es existiert absichtlich keine globale Admin-Delete-Funktion.
8. Weitere Preview-Runtime-Mutationen bleiben bis zur vollständigen Preview-ENV-, Tenant- und Batch-Konfiguration gesperrt. Production-Migration und Production-Reset benötigen jeweils explizite Freigabe, Backup, Dry-run und Rollbackplan.
9. Weitere bestehende QA-Harnesses enthalten eigene direkte Workspace-/User-Cleanups (`e2e-object-creation-tests`, Contact Access, Deal-/Lead-Idempotency, Phase-2/3, Preview-Login-Fixture, Persistence Diagnostics, Property-Pagination, Product-Role-Invite, Public-Slug-Routing und Reservation-Stage-Resolver). Sie wurden in diesem begrenzten Paket nicht pauschal umgeschrieben. Vor Ausführung brauchen sie weiterhin ihren Zielguard plus ENV-01 und müssen für die finale DB-01-Abnahme auf Batch-Ledger/Graph-Reset konsolidiert oder serverseitig deaktiviert werden.
10. Der `livegang-e2e`-Workflow ruft `npm run test:e2e` und damit den neuen Zwei-Tenant-Harness auf; die beiden Aufrufe des deaktivierten Legacy-Resets wurden entfernt. Der Harness bindet seinen Cleanup an den authentifizierten Dry-run-/Execute-/Plan-Digest-Vertrag.

DB-01 ist code- und Preview-schema-seitig gehärtet, aber noch nicht vollständig abgenommen. Der Status ist `TEILWEISE AUSGEFÜHRT`, bis beide Live-Tenantmatrizen, vollständige Registrierung, externe Adapter, Negativläufe, Dry-run/Execute-Parität und Null-Rückstands-Reconciliation in isolierter QA bestanden sind.

## Lokale Evidenz

| Command | Ergebnis |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run test:unit` | PASS, 241/241 Basissuite plus 253/253 Remediation = 494/494 |
| `node --test scripts/qa-reset-safety-tests.mjs` | PASS, 27/27 inklusive beider Lock-Startreihenfolgen |
| `node --test scripts/qa-reset-safety-tests.mjs scripts/auth-security-tests.mjs scripts/csrf-security-tests.mjs scripts/tenant-hardening-smoke-tests.mjs scripts/migration-cutover-guard-tests.mjs scripts/phase8-acceptance-smoke-tests.mjs` | PASS, 90/90 |
| `npx.cmd eslint src/lib/qa-reset-contract.ts src/lib/db/qa-reset-repository.ts src/app/api/admin/qa-reset/route.ts scripts/qa-reset-safety-tests.mjs scripts/qa-livegang-reset.mjs scripts/db-migrate.mjs scripts/migration-cutover-guard-tests.mjs scripts/phase8-acceptance-smoke-tests.mjs --max-warnings=0` | PASS |
| `git diff --check` | PASS; nur bestehende CRLF-Hinweise |
| `node --test scripts/qa-two-tenant-matrix-tests.mjs` | PASS, 15/15; Config-Deny-Targets, Rollenmatrix, Evidence-Redaction, funktionale Workspace-/MFA-Challenge-Cookie-Rotation, redigierte Redirectdiagnostik und Legacy-Disable |
| `node --test scripts/qa-batch-registration-tests.mjs` | PASS, 8/8; Runtime-, Ownership-, Replay-, Atomaritäts- und Execute-Seal-Vertrag einschließlich unregistriertem Deal-Replay sowie parallelen Idempotency-Kollisionen mit null Ledgerzeilen |
| `node --test scripts/qa-batch-lock-order-live-tests.mjs` | PASS, 7/7; Production-/Target-Deny, rollback-only SQL einschließlich genau eines QA-Flag-Updates, zwei Sessions, Reset-/Mutation- und QA-Flag-Races in beiden Startreihenfolgen, redigierter Fehlerpfad und offline Default |
| `npm.cmd run qa:batch-lock-order:execute -- --workspace-id <uuid> --batch-id <uuid> --actor-id <uuid>` | NICHT AUSGEFÜHRT; echter isolierter Preview-Barrierennachweis bleibt Pflichtgate |
| isolierter Preview-Neon-Drill | PASS; 060 und 068–072 angewandt, migrierten Zustand preserviert, Drill-Branch auf Elternzustand zurückgesetzt |
| isolierter 057+073–076-Evidence-Drill | PASS; 5/5 Checksummen, 19/19 Tenant-FKs, 0/19 Anti-Joins, 21/21 Artefakte; Restore-Abwesenheitsprüfung und identischer Reapply bestanden |
| Preview-Main-Zielstand 057+068–077 | PASS; zusätzlich ist 060 vorhanden; insgesamt 11/11 geforderte lokale Checksummen, 19/19 validierte/deferred Tenant-FKs, 0/19 Anti-Joins, 21/21 Launch-Artefakte und vollständiger 077-Owner-/ACL-Beweis; Production unverändert |
| read-only Zwei-Tenant-Preflight auf Preview-SHA `7faeda2` | PASS, 94/94 Ergebnisse und 50 Requests; zehn konfigurierte Rollen-/Reset-Clients mit Session 200, Rollen-/Sessionbindung, Tenant-Isolation, öffentliche Grenzen, App-Rolle/RLS/Ledger-Projektion und DB-Gates belegt; null CRM-Geschäftswrites, zehn akzeptierte Logout-303. Wegen lokal korrigiertem, noch nicht deploytem Harness auf dem neuen SHA-identischen Kandidaten zu wiederholen |
