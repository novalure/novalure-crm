# DB-01 — QA-Tenant- und Reset-Inventur

Stand: 22.08.2026
Scope: ausschließlich Repository-/Migrationsartefakte; keine DB-, Vercel-, Provider- oder Netzwerkmutation ausgeführt.

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
  - der zentrale Migrationsrunner führt 068 niemals automatisch aus; sie ist ein Manual-Cutover mit zwingender, checksummierter 061-Vorbedingung und benötigt `--only=068_qa_batch_reset_safety --allow-manual-cutover` erst nach den dokumentierten Freigaben.
- `POST /api/admin/qa-reset`:
  - akzeptiert keine frei parametrisierte Tabelle und keine anderen HTTP-Mutationen;
  - benötigt eine persistierte Cookie-Session, technische Rolle `owner`, Produktrolle `platform_admin`, App-Permission `settings:manage` sowie Produkt-Capabilities `novalure:internal` und `settings:manage`;
  - erzwingt CSRF vor Capability-/Reset-Aufruf;
  - akzeptiert nur Workspace-IDs aus der serverseitigen `NOVALURE_QA_RESET_WORKSPACE_IDS`-Allowlist; mindestens zwei IDs sind Pflicht;
  - verweigert jede Überschneidung mit `NOVALURE_PRODUCTION_WORKSPACE_IDS`;
  - führt ohne Modus immer `dry_run` aus;
  - `execute` benötigt zusätzlich `NOVALURE_QA_RESET_EXECUTION_ENABLED=true` und die exakte Confirmation `RESET QA BATCH <workspaceId> <batchId>`;
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

## Explizit aufbewahrte Evidenz

Die versionierte Liste steht in `qaResetRetainedTables`. Dazu gehören insbesondere Workspace-/Rollenwurzeln, Auth-/Securityzustände, `audit_logs`, `auth_audit_events`, definierte Audit-/Telemetrytabellen, Abuse-/Idempotency-Guards, Schema-Ledger und die neuen QA-Ledger. Diese Bestände sind getrennt von operativen Geschäfts-KPIs zu reconciliieren.

## Noch nicht erfüllt / harte Restgrenzen

1. Migration 068 wurde nicht gegen eine Datenbank ausgeführt oder in Preview/Production angewendet.
2. Tenant A und Tenant B samt Rollen-/Produktrollenmatrix wurden nicht provisioniert; bestehende Tenants wurden nicht als QA markiert.
3. Objekt-Creator registrieren neue IDs noch nicht automatisch in `qa_batch_objects`. Vor einem echten E2E muss jeder Create-/Join-/Historien-/Submission-/Job-/Blob-/Providerpfad den unveränderlichen Batchkontext propagieren oder durch einen kontrollierten Harness atomar registriert werden.
4. Blob- und Provider-Cleanup-Adapter fehlen. Deshalb verweigert der Executor entsprechende Batches absichtlich.
5. Die FK-Graphprüfung wurde nur statisch/mit Contracttests geprüft, nicht gegen das tatsächlich migrierte Preview-Schema und zwei reale QA-Tenants.
6. Die bereits vorhandene RLS-Aktivierung ist nur für Pilot-Tabellen belegt. Zwei-Tenant-IDOR/Graph-Closure über alle Reset-Zieltabellen bleibt ein separates SEC-01-/Preview-Gate.
7. `is_qa`-Provisionierung, Batch-Erstellung und Ledger-Registrierung brauchen einen gesondert genehmigten, zielgeprüften Ablauf. Es existiert absichtlich keine globale Admin-Delete-Funktion.
8. Jede Preview-Mutation bleibt vor ENV-01 verboten; Production-Migration und Production-Reset benötigen jeweils explizite Freigabe, Backup, Dry-run und Rollbackplan.
9. Weitere bestehende QA-Harnesses enthalten eigene direkte Workspace-/User-Cleanups (`e2e-object-creation-tests`, Contact Access, Deal-/Lead-Idempotency, Phase-2/3, Preview-Login-Fixture, Persistence Diagnostics, Property-Pagination, Product-Role-Invite, Public-Slug-Routing und Reservation-Stage-Resolver). Sie wurden in diesem begrenzten Paket nicht pauschal umgeschrieben. Vor Ausführung brauchen sie weiterhin ihren Zielguard plus ENV-01 und müssen für die finale DB-01-Abnahme auf Batch-Ledger/Graph-Reset konsolidiert oder serverseitig deaktiviert werden.
10. Der bestehende `livegang-e2e`-Workflow ruft den nun absichtlich deaktivierten Legacy-Reset auf. Der Workflow bleibt dadurch fail-closed, bis QA-Tenants/Batchregistrierung vorhanden sind und seine Cleanup-Schritte authentifiziert auf den neuen Dry-run-/Execute-Vertrag umgestellt wurden.

DB-01 ist damit code-seitig gehärtet, aber nicht abgenommen. Der Status bleibt `NICHT AUSGEFÜHRT`, bis Migration, zwei Tenantmatrizen, vollständige Registrierung, externe Adapter, Negativläufe, Dry-run/Execute-Parität und Null-Rückstands-Reconciliation in isolierter QA bestanden sind.

## Lokale Evidenz

| Command | Ergebnis |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run test:unit` | PASS, 232/232 |
| `node --test scripts/qa-reset-safety-tests.mjs` | PASS, 14/14 |
| `node --test scripts/qa-reset-safety-tests.mjs scripts/auth-security-tests.mjs scripts/csrf-security-tests.mjs scripts/tenant-hardening-smoke-tests.mjs scripts/migration-cutover-guard-tests.mjs scripts/phase8-acceptance-smoke-tests.mjs` | PASS, 72/72 |
| `npx.cmd eslint src/lib/qa-reset-contract.ts src/lib/db/qa-reset-repository.ts src/app/api/admin/qa-reset/route.ts scripts/qa-reset-safety-tests.mjs scripts/qa-livegang-reset.mjs scripts/db-migrate.mjs scripts/migration-cutover-guard-tests.mjs scripts/phase8-acceptance-smoke-tests.mjs --max-warnings=0` | PASS |
| `git diff --check` | PASS; nur bestehende CRLF-Hinweise |
