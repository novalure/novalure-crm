# Datenbank-Recovery-, Migrations- und Rollback-Runbook

Stand: 23.08.2026
Status: `CURRENT_SHA_REHEARSAL_AND_RESET_PASS` für Candidate `2d29252a7252bac9e5367662cf72c22006222067`; Signatur weiterhin `PENDING_SIGNATURE`.

## Feste Grenzen

- `MIGRATION_TARGET=recovery`; `prod` ist für das Rehearsal verboten.
- Recovery muss im exakt deklarierten Production-Neon-Projekt liegen, aber eine andere explizite Branch-ID als Production Main besitzen.
- Recovery-, Production- und QA-Hosts müssen verschieden sein.
- Die direkte Migrationsrolle muss von der gepoolten App-Rolle verschieden sein.
- Die Verbindungs-URL wird ausschließlich als einzelne, maximal 4.096 Zeichen lange stdin-Zeile übergeben. Sie darf nicht in Argumenten, Dateien, Shell-Historie, Logs oder Evidenz erscheinen.
- Der Runner prüft den verbundenen Neon-Projekt-, Branch-, Datenbank-, Rollen- und PostgreSQL-Fingerprint vor SQL.
- `up` akzeptiert nur einen sauberen, geprüften Commit und einen zuvor auf exakt denselben Commit, Target, Ledger und Plan gebundenen Einmal-Plan-Token.
- Migrationen 061, 062 und 065 werden niemals in diesem Ablauf ausgeführt. Sie bleiben jeweils eigene, ausdrücklich zu autorisierende Cutovers.

## Festgestellter Ausgangszustand

Die nicht-geheime Baseline steht in `database-recovery-baseline.json`. Production Main und der isolierte Recovery-Branch hatten am Messpunkt denselben deterministischen Katalog-Hash, denselben Migrationsledger-Hash und identische Counts in 19 zentralen Tabellen. Die integrierte Schema-Diff-API war wegen HTTP 413 nicht verwendbar. Das ist eine dokumentierte Toolgrenze und ausdrücklich kein Schema-Diff-PASS. Der Drill stützt sich stattdessen auf den vorhandenen deterministischen Katalog-Baseline-Fingerprint sowie den erneut verglichenen Ledger- und 19-Tabellen-Datenfingerprint.

Der Production-Ledger endet bei 067 und enthält 19 Einträge. Neben der ursprünglichen Liste fehlen auch 060, 062, 065 und die neuen Candidate-Migrationen 078/079. Migration 060 ist zwingende Vorbedingung für 068 und 075. Migration 061 bleibt der separate RLS-Cutover. Migration 062 bleibt bis zur physischen Private-Media-Legacy-Migration ausgeschlossen. Migration 065 benötigt eine eigene Security-/DBA-Entscheidung. Die bereits veröffentlichte Migration 075 bleibt checksum-identisch; die nachträgliche Rollenverschärfung liegt deshalb ausschließlich additiv in 079.

## Recovery-Rehearsal

Der saubere Candidate `2d29252a7252bac9e5367662cf72c22006222067` bestand auf dem isolierten Recovery-Branch alle 14 geplanten Migrationen jeweils mit `dry-run=PASS` und `up=PASS`. Die kuratierte PASS-Datei ist:

`artifacts/qa/recovery-rehearsal-2d29252-20260823/database-recovery-rehearsal-2026-08-23T16-45-46-388Z.json`

Ihr SHA-256 ist `a4483c22b676fab393475af2339764cb027165359eeef5344d574da768dd8310`. Drei davor entstandene Dateien mit `status=FAIL` bleiben aus Gründen der Chronologie erhalten, sind im Evidence-Manifest aber ausdrücklich `passEligible=false` und dürfen nicht als bestandener Lauf aggregiert werden.

Jede Migration wird einzeln als `dry-run` und danach als `up` ausgeführt. Der Plan-Token liegt in einem neu erzeugten temporären Verzeichnis außerhalb des Repositorys und wird nach Verbrauch nicht wiederverwendet. Das folgende Muster zeigt bewusst keine URL und keinen Secret-Wert:

```powershell
$env:MIGRATION_TARGET = 'recovery'
# Setze nur die exakten NOVALURE_RECOVERY_*, NOVALURE_PRODUCTION_* und NOVALURE_QA_*
# Zieldeklarationen im Prozess. Übergib die geheime direkte URL als eine stdin-Zeile.
node scripts/db-migrate.mjs dry-run --connection-stdin --only=<version> --plan-token-file=<absolute-temp-file>
node scripts/db-migrate.mjs up --connection-stdin --only=<version> --plan-token-file=<absolute-temp-file>
```

Für die manuellen Cutovers 057, 060, 068, 074, 078 und 079 wird in beiden Befehlen zusätzlich `--allow-manual-cutover` verwendet. Exakte Reihenfolge:

1. 057 Bot-Webhook Legacy Index Cutover
2. 060 Tenant-RLS-Pilot Prepare
3. 068 QA Batch Reset Safety
4. 069 Property Unit Idempotency
5. 070 Funnel Submission Idempotency Recovery
6. 071 Forms Owner/Tenant Guard
7. 072 Form Submission Atomicity
8. 073 Launch Tenant Relation Guards
9. 074 Validate Launch Tenant Relation Guards
10. 075 Public Funnel Visit Truth
11. 076 Durable Bot Webhook Processing
12. 077 Schema Ledger Runtime Projection
13. 078 Company Profile Approval Integrity
14. 079 Public Funnel Visit Role Boundary

Nach jedem Schritt: Ledgerzeile und Checksumme, relevante Katalogobjekte, RLS/Constraints, zentrale Counts und unerwartete DML prüfen. Abbruch bei Host-/Projekt-/Branch-/Rollenabweichung, Checksum-Drift, fehlender Vorbedingung, Lock- oder Statement-Timeout, RLS-/Tenant-Fehler oder unerwarteter Count-Änderung.

## Rollback-/Restore-Drill

Ein SQL-Down-Mix wird nicht als belastbarer Rollback gewertet. Nach dem erfolgreichen Rehearsal wurde der migrierte Zustand auf `br-empty-tree-alp9d9z1` bewahrt und der vorgesehene Recovery-Branch `br-calm-poetry-al5i1a9c` vom Production-Parent zurückgesetzt. Production und Reset-Recovery besitzen danach denselben kanonischen Datenfingerprint `c05c3a3d39c67510db92079f593756fcb7551d8f5446c47aa07aa3be4b2e45b8`: 19 Tabellen ohne Count-Abweichung sowie jeweils Ledger 19 / Max-Version `067_app_role_runtime_grants`. Production Main, Production-App, Vercel-Variablen und Aliase blieben unverändert.

Der reproduzierbare Verifier ist strikt datei- und read-only. Er besitzt keinen Netzwerk-, SQL-, Spawn- oder Schreibpfad. Er prüft Manifest- und Sidecar-Hashes, den exakt einen vollständigen PASS, den expliziten Ausschluss der drei FAIL-Versuche, den 14er-Migrationsplan, die drei ausgeschlossenen Cutovers, Branchtrennung und die kanonische Gleichheit beider Ledger-/Row-Fingerprints:

```powershell
node scripts/database-recovery-evidence-verify.mjs
npm run test:database-recovery
```

Quellen:

- `docs/audit/2026-08-23/database-recovery-evidence-manifest.json`
- `docs/audit/2026-08-23/database-recovery-rollback-evidence.json`

Die Schema-Diff-API antwortete weiterhin mit HTTP 413. Der Verifier verlangt deshalb `countedAsPassEvidence=false`; eine Änderung zu einem erfundenen Schema-Diff-PASS lässt den Contract fehlschlagen.

Die beobachtete Branch-Bereitstellung von etwa 34 Sekunden ist nur ein Infrastruktur-RTO-Anteil. Ein realistisches Release-RTO muss zusätzlich App-Umschaltung, Verifikation und Entscheidungslatenz enthalten. Die derzeit gemeldete History-Retention von 21.600 Sekunden ist ein Launch-Risiko und benötigt eine Operations-/DBA-Freigabe oder eine belastbar längere Backup-Strategie.

## Production-Gate

Dieses Runbook erteilt keine Production-Autorisierung. Der bestandene Recovery-Nachweis ändert Production nicht und ist noch nicht signiert. Eine spätere, aktionsbezogene Freigabe muss Projekt, Datenbank, Main-Branch, exakte Migrationen einschließlich 060, 078 und 079, Entscheidungen zu 062/065, Change Window, Backup/PITR, Restore-Ziel, Rollbackentscheidung und den Satz „Production darf jetzt verändert werden“ enthalten. Migration 061 benötigt ein eigenes Change Window und eine eigene Freigabe.
