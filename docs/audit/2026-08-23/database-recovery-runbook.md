# Datenbank-Recovery-, Migrations- und Rollback-Runbook

Stand: 23.08.2026
Status: `BLOCKED_HISTORICAL_UNSIGNED`. Das Manifest deklariert für Candidate `2d29252a7252bac9e5367662cf72c22006222067` den damaligen Drill-PASS, ist aber `schemaVersion=1`, nicht Final-Runtime-Evidenz und weiterhin `PENDING_SIGNATURE`. Der Verifier gibt deshalb ausdrücklich `status=BLOCKED` und `passEligible=false` zurück.

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

Der reproduzierbare Verifier ist strikt read-only. Er besitzt keinen Netzwerk-, SQL- oder Schreibpfad. Er liest aktuelle Dateien ausschließlich als größenbegrenzte reguläre Dateien ohne Symlinks. Im `--evidence-commit`-Modus liest er zusätzlich nur reguläre Git-Blobs des exakten Evidence-Commits und verlangt Bytegleichheit zum aktuellen sauberen Worktree. Er prüft Manifest- und Sidecar-Hashes, den exakt einen vollständigen historischen Drill, den expliziten Ausschluss der drei FAIL-Versuche, den 14er-Migrationsplan, die drei ausgeschlossenen Cutovers, Branchtrennung und die kanonische Gleichheit beider Ledger-/Row-Fingerprints. Historische Integrität ist dabei ausdrücklich kein Release-PASS:

```powershell
# Für das historische schemaVersion-1/PENDING-Manifest ist Exitcode 2 (BLOCKED) korrekt.
node scripts/database-recovery-evidence-verify.mjs
npm run test:database-recovery
```

Quellen:

- `docs/audit/2026-08-23/database-recovery-evidence-manifest.json`
- `docs/audit/2026-08-23/database-recovery-rollback-evidence.json`

Die Schema-Diff-API antwortete weiterhin mit HTTP 413. Der Verifier verlangt deshalb `countedAsPassEvidence=false`; eine Änderung zu einem erfundenen Schema-Diff-PASS lässt den Contract fehlschlagen.

Die beobachtete Branch-Bereitstellung von etwa 34 Sekunden ist nur ein Infrastruktur-RTO-Anteil. Ein realistisches Release-RTO muss zusätzlich App-Umschaltung, Verifikation und Entscheidungslatenz enthalten. Die derzeit gemeldete History-Retention von 21.600 Sekunden ist ein Launch-Risiko und benötigt eine Operations-/DBA-Freigabe oder eine belastbar längere Backup-Strategie.

## Final-SHA-Live-Evidence-Collector

Für einen neuen Runtime-SHA darf die historische Evidenz nicht umetikettiert werden. Der lokale Collector `scripts/database-recovery-live-evidence.mjs` besitzt bewusst keinen Netzwerk-, SQL- oder Datenbank-Mutationspfad. Deshalb ist ein bloß vom Operator erstelltes JSON niemals PASS-fähig: Unsignierte Beobachtungen werden ausschließlich als `status=BLOCKED`, `verificationStatus=UNPROVEN`, `passEligible=false` und mit `NEON_PROVENANCE_UNVERIFIED` verarbeitet. Eine vom stdin-Dokument selbst mitgebrachte Behauptung `VERIFIED` wird ohne externen Trust-Anchor abgewiesen.

Ein technischer Live-PASS benötigt einen unabhängigen Ed25519-Observer. Dessen öffentlicher Schlüssel liegt als größenbegrenzte reguläre Datei außerhalb des Repositorys; erwarteter SPKI-SHA-256, exakte Observer-Identity und Key-ID kommen getrennt aus geschützten Prozessvariablen `NOVALURE_RECOVERY_OBSERVER_PUBLIC_KEY_SHA256`, `NOVALURE_RECOVERY_OBSERVER_IDENTITY` und `NOVALURE_RECOVERY_OBSERVER_KEY_ID`. Weder Public Key noch erwarteter Digest dürfen aus dem Evidence-stdin abgeleitet werden. Die detached Signatur bindet die feste Provideridentität `NEON / NEON_CONTROL_PLANE_AND_SQL`, Projekt, Candidate, Datenbank, alle drei Branches, Query-Pack-Version/Digest, ein höchstens 24 Stunden breites Beobachtungsfenster und die vollständige Request-/Operation-Lineage. Der Collector muss die Evidenz spätestens eine Stunde nach Ende dieses Fensters finalisieren; ein später wiederverwendetes Receipt-Bundle wird als stale abgewiesen.

Der versionierte read-only Query-Pack liegt in `scripts/lib/database-recovery-query-pack.mjs`. Version 1 besitzt den kanonischen Digest `f7efdd2b4cf9aa75115fd5d846dfe8d11c47147de3e8538210974905681101cd` und bindet:

- das exakte Production-Ziel `misty-cloud-70835427 / br-snowy-fog-aldx77v8 / neondb / neondb_owner`
- alle 19 Baseline-Versionen 041–056, 064, 066 und 067 samt committed Checksummen, nicht nur Count und Max-Version
- feste read-only SQL-Abfragen für Server-/Transaktionsidentität, Ledger, vollständige Spalten-/View-/Index-/Constraint-/Policy-/Trigger-/Funktions-Katalogdefinitionen, Grants, Lock-/Session-Zähler und die Release-Assertions
- 36 migrationsberührte oder unmittelbar referenzierte Tabellen einschließlich `bot_channel_webhooks`, `company_profiles`, QA-Ledger, Property-/Building-Idempotency, Form/Funnel- und Tenant-Relationstabellen
- 13 feste Transformationsprojektionen für neu hinzugefügte Default-Spalten sowie die deterministischen Datenänderungen aus 076 und 078

Die externe Final-Runtime-Orchestrierung muss die Abfragen je Snapshot in einer `REPEATABLE READ READ ONLY`-Transaktion ausführen und sechs getrennte, gehashte Snapshot-Receipts mit dem jeweils exakt gebundenen Beobachtungszeitpunkt liefern:

1. Production vor Branch-Erstellung
2. Recovery vor Migration
3. Recovery nach den 14 Migrationen
4. bewahrter migrierter Branch
5. Production exakt am Reset-Quellpunkt (nicht erst nach abgeschlossenem Reset)
6. zurückgesetzter Recovery-Branch

Zusätzlich sind nicht-geheime Neon-Control-Plane-Receipts zwingend. Sie müssen Production-Main, `CREATE_RECOVERY_BRANCH`, `CREATE_PRESERVED_BRANCH` und `RESET_RECOVERY_BRANCH` einschließlich jeweils eindeutiger Request-/Receipt-/Operation-IDs, Hash des unveränderten Raw-Provider-Receipts, Parent-/Target-Branch, Start-/End-/Source-Zeitpunkt, erfolgreichem Operationsstatus sowie direkten Endpoint-IDs und Endpoint-Host-Digests binden. Production-, Recovery- und Preserved-Endpoint müssen verschieden sein; der Reset muss denselben Recovery-Endpoint behalten. Jeder Snapshot bindet Query-Pack-Version/Digest, Raw-/Snapshot-Receipt-Digest, direkte Endpoint-Identität, Rolle, PostgreSQL-Version, Isolation und `transactionReadOnly=true`. SQL-Beobachtung und Schema-Diff besitzen ebenfalls getrennte Request-IDs und Raw-Receipt-Digests. Alle sechs Request-IDs müssen verschieden und von derselben extern signierten Observation umfasst sein.

Jeder Tabellenbeleg enthält ausschließlich Presence-State, Count, feste Projection-ID und kanonischen Content-SHA-256. Raw Rows, Connection-Strings und Hosts werden nicht in die Evidenz übernommen. Für 076 wird neben einer stabilen Businessprojektion die erwartete Hash-/Status-/Reply-Transformation gegen den tatsächlichen und bewahrten Zustand geprüft. Für 078 werden Row-Erhalt, unveränderte Unternehmensstammdaten und die erwartete Approval-Transformation separat gebunden. Ein Löschen der betroffenen Rows kann dadurch keinen PASS mehr erzeugen.

Der Collector verweigert insbesondere:

- einen anderen Candidate als den vor und unmittelbar vor dem Schreiben erneut bestätigten sauberen HEAD
- ein Ziel außerhalb des allowgelisteten Production-Projekts/Main-Branches, der Datenbank oder Migrationsrolle
- fehlende, unvollständige oder selbstwidersprüchliche Parent/Create/Preserve/Reset-/Endpoint-Receipts
- Query-Pack-, Snapshot-Receipt-, Observation-Bundle- oder Control-Plane-Bundle-Drift
- eine Baseline ungleich dem exakten 19-Versionen-/Checksum-Contract
- jede Anwesenheit von 061, 062 oder 065
- ein Delta ungleich exakt 057, 060 und 068–079 mit den committed Checksummen
- Row-Verlust, stabile Content-Änderungen oder abweichende erwartete/tatsächliche Transformationsdigests
- Abweichungen zwischen migriertem und bewahrtem Zustand oder zwischen aktueller Production und Reset-Recovery
- den Legacy-Webhook-Index, aktiviertes Pilot-RLS, unerwartete unvalidierte Constraints oder Approval-Reste
- falsche Grants auf Funnel-Visit-Tabelle, Migrationsledger oder Runtime-Checksum-Projektion
- Lock-/Session-Reste auf Recovery-/Preserved-Zielen und bekannte Token-/Credentialmuster; die Zahl regulärer Live-Sessions auf Production wird nur protokolliert, weil deren Nullsetzung keinen zulässigen Teil dieses read-only Drills darstellt

Ausführungsmuster; die direkte Datenbank-URL gehört ausschließlich zum Migrationsrunner und niemals in dieses Evidence-stdin:

```powershell
node scripts/database-recovery-live-evidence.mjs `
  --execute `
  --confirm-candidate=<FINAL_RUNTIME_SHA> `
  --evidence-dir=<ABSOLUTER_PFAD_AUSSERHALB_DES_RUNTIME_WORKTREES> `
  --trusted-observer-public-key=<ABSOLUTER_PUBLIC-KEY-PFAD_AUSSERHALB_DES_REPOSITORYS>
# Danach genau ein nicht-geheimes JSON-Dokument über die offene stdin-Verbindung senden.
```

Ein erst nach dem finalen Reset-Snapshot erzeugter, real leerer und auf Production-Main sowie Reset-Recovery gebundener Schema-Diff wird als `PASS_EMPTY` mit dem SHA-256 der leeren Bytefolge und dem Hash des Tool-Receipts gebunden. Antwortet das Tool erneut mit HTTP 413, bleiben `status=UNAVAILABLE_HTTP_413_TOOL_LIMIT`, `countedAsPassEvidence=false` und `diffSha256=null`; der gesamte Collector bleibt dann selbst bei sonst verifizierten Receipts `BLOCKED/UNPROVEN` und niemals PASS-fähig.

Die erzeugte Datei wird anschließend explizit in den separaten Evidence-Attestation-Commit übernommen. Erst dort werden Manifest, Rollback-Evidenz, Baseline und Sidecars auf den unveränderten Runtime-SHA aktualisiert. Das neue Manifest verwendet `schemaVersion=2` und bindet genau einen Eintrag mit `role=FINAL_LIVE_COLLECTOR_PASS`. Dessen `passEligible` muss exakt dem verifizierten Collector-Ergebnis entsprechen. Bei fehlender Provenienz oder Schema-Diff 413 lautet der Manifeststatus `RECOVERY_BLOCKED_UNPROVEN` und `passEligible=false`. Nur vollständige VERIFIED Receipts plus `PASS_EMPTY` erlauben `CURRENT_SHA_REHEARSAL_AND_RESET_PASS` und `passEligible=true`. Schema-Version 1 bleibt ausschließlich für die unveränderte historische Evidenz zulässig.

```powershell
npm run test:database-recovery
node scripts/database-recovery-evidence-verify.mjs `
  --expected-candidate=<FINAL_RUNTIME_SHA> `
  --evidence-commit=<EVIDENCE_COMMIT_SHA> `
  --trusted-observer-public-key=<ABSOLUTER_PUBLIC-KEY-PFAD_AUSSERHALB_DES_REPOSITORYS>
```

Der Verifier exportiert außerdem `collectRecoveryEvidenceInventory(...)`. Dieses Inventar enthält Manifest, Manifest-Sidecar und jede ausgewählte, ausgeschlossene, Rollback- und Live-JSON-Datei samt Sidecar, Bytezahl und SHA-256. Damit kann die finale Release-Attestation exakt denselben verschachtelten Satz an den Evidence-Commit binden. URL-Pfade, Pfadflucht, Symlink-Dateien/-Blobs, übergroße Dateien und Abweichungen zwischen Evidence-Commit und aktuellem Worktree werden abgewiesen.

## Production-Gate

Dieses Runbook erteilt keine Production-Autorisierung. Der bestandene Recovery-Nachweis ändert Production nicht und ist noch nicht signiert. Eine spätere, aktionsbezogene Freigabe muss Projekt, Datenbank, Main-Branch, exakte Migrationen einschließlich 060, 078 und 079, Entscheidungen zu 062/065, Change Window, Backup/PITR, Restore-Ziel, Rollbackentscheidung und den Satz „Production darf jetzt verändert werden“ enthalten. Migration 061 benötigt ein eigenes Change Window und eine eigene Freigabe.
