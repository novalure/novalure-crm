# Datenbank-Recovery-, Migrations- und Rollback-Runbook

Stand: 23.08.2026
Status: Restore-Snapshot verifiziert; Migrations- und Rollback-Rehearsal bis zum sauberen Candidate-Commit `NOT RUN`.

## Feste Grenzen

- `MIGRATION_TARGET=recovery`; `prod` ist für das Rehearsal verboten.
- Recovery muss im exakt deklarierten Production-Neon-Projekt liegen, aber eine andere explizite Branch-ID als Production Main besitzen.
- Recovery-, Production- und QA-Hosts müssen verschieden sein.
- Die direkte Migrationsrolle muss von der gepoolten App-Rolle verschieden sein.
- Die Verbindungs-URL wird ausschließlich als einzelne, maximal 4.096 Zeichen lange stdin-Zeile übergeben. Sie darf nicht in Argumenten, Dateien, Shell-Historie, Logs oder Evidenz erscheinen.
- Der Runner prüft den verbundenen Neon-Projekt-, Branch-, Datenbank-, Rollen- und PostgreSQL-Fingerprint vor SQL.
- `up` akzeptiert nur einen sauberen, geprüften Commit und einen zuvor auf exakt denselben Commit, Target, Ledger und Plan gebundenen Einmal-Plan-Token.
- Migration 061 wird niemals in diesem Ablauf ausgeführt.

## Festgestellter Ausgangszustand

Die nicht-geheime Baseline steht in `database-recovery-baseline.json`. Production Main und der isolierte Recovery-Branch hatten am Messpunkt denselben Katalog-Hash, denselben Migrationsledger-Hash und identische Counts in 19 zentralen Tabellen. Die integrierte Schema-Diff-Funktion war wegen HTTP 413 nicht verwendbar; deshalb wurde ein eigener deterministischer Fingerprint über Spalten, Constraints, Indizes, Policies und Trigger verglichen.

Der Production-Ledger endet bei 067 und enthält 19 Einträge. Neben der ursprünglichen Liste fehlen auch 060, 062, 065 und die neuen Candidate-Migrationen 078/079. Migration 060 ist zwingende Vorbedingung für 068 und 075. Migrationen 062 und 065 sind keine Vorbedingung der Candidate-Kette, müssen aber vor einem Production-Fenster ausdrücklich aufgenommen oder mit begründeter Risikoentscheidung ausgeschlossen werden. Die bereits veröffentlichte Migration 075 bleibt checksum-identisch; die nachträgliche Rollenverschärfung liegt deshalb ausschließlich additiv in 079.

## Recovery-Rehearsal

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

Ein SQL-Down-Mix wird nicht als belastbarer Rollback gewertet. Nach erfolgreichem Rehearsal wird ausschließlich der temporäre Recovery-Branch verworfen und ein neuer Child-Branch am protokollierten Parent-Zeitpunkt erstellt. Auf dem neuen Branch müssen erneut Katalog-, Ledger- und Count-Fingerprints exakt der Baseline entsprechen. Production Main, Production-App, Vercel-Variablen und Aliase bleiben während des gesamten Drills unverändert.

Die beobachtete Branch-Bereitstellung von etwa 34 Sekunden ist nur ein Infrastruktur-RTO-Anteil. Ein realistisches Release-RTO muss zusätzlich App-Umschaltung, Verifikation und Entscheidungslatenz enthalten. Die derzeit gemeldete History-Retention von 21.600 Sekunden ist ein Launch-Risiko und benötigt eine Operations-/DBA-Freigabe oder eine belastbar längere Backup-Strategie.

## Production-Gate

Dieses Runbook erteilt keine Production-Autorisierung. Eine spätere, aktionsbezogene Freigabe muss Projekt, Datenbank, Main-Branch, exakte Migrationen einschließlich 060, 078 und 079, Entscheidung zu 062/065, Change Window, Backup/PITR, Restore-Ziel, Rollbackentscheidung und den Satz „Production darf jetzt verändert werden“ enthalten. Migration 061 benötigt ein eigenes Change Window und eine eigene Freigabe.
