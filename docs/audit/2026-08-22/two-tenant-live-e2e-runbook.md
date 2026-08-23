# Zwei-Tenant-Live-E2E-Runbook

Stand: 22.08.2026
Scope: echte, isolierte Preview-QA; keine Production-Mutation
Aktueller Status: **TENANTS PROVISIONIERT / RUNTIME-E2E NOCH NICHT AUSGEFÜHRT**

## Ziel und Story

Der Kandidat wird als echte Cookie-/MFA-Session über die sichtbaren HTTP-Routen geprüft: Benutzeraktion → API/CSRF/RBAC → tenantgebundene Persistenz → Reload → Cross-Tenant-Negativfall → append-only Batch-Ledger → Dry-run → physischer Reset → Null-Rückstand. Tenant A und Tenant B müssen reale, langlebige QA-Wurzeln sein; nur die pro Lauf erzeugten Geschäftsobjekte werden entfernt.

Der neue Einstiegspunkt ist `scripts/qa-two-tenant-e2e.mjs`. Er ersetzt `test:e2e` und `qa:livegang:api`. Die npm-Kommandos laden lokal über Nodes `--env-file-if-exists` ausschließlich die gitignorierte `.env.qa-two-tenant.local`; in CI und Vercel bleiben direkt gesetzte Umgebungsvariablen maßgeblich. Der alte `qa-livegang-api.mjs` ist hart deaktiviert, weil er zufällige Objekte ohne beweisbare Batch-Closure hinterließ.

## Sicherheitsgrenzen

Der Lauf schreibt erst, wenn alle folgenden Grenzen bestanden sind:

1. Preview-Origin und Production-Origin sind explizit angegeben und verschieden.
2. Der gepoolte Neon-Host, Projekt-, Branch-, Datenbank- und Rollenfingerprint stimmt exakt; Production-Host ist ausgeschlossen.
3. Migration `057` sowie die Migrationen `068` bis `077` stehen mit exakt den lokal berechneten SHA-256-Checksummen im Preview-Schema-Ledger; eine bloß formal 64-stellige Fremdchecksumme reicht nicht. Das read-only `pg_catalog`-Gate verlangt für 075 Tabelle, Unique-/FK-/Check-Constraints, Expiry-Index und Minimalgrants, für 076 die exakten State-/Event-Spalten, validierten Checks, Workspace-Unique-, Account/Event-, Legacy-Abwesenheits-, Reclaim- und Account/Received-Indexzustände, 7 Event-Unique-Indizes, die globale Envelope-Quarantänetabelle, die write-only `SECURITY DEFINER`-RPC mit `search_path=pg_catalog` und Minimalgrants, 6 tenantqualifizierte FKs und bewusst keinen Live-FK vom append-only `audit_logs`-Snapshot sowie für 077 die ownergebundene, nicht aktualisierbare `version`-/`checksum`-Projektion bei vollständig entzogenen Direktrechten auf das Basis-Ledger.
4. Alle 19 Tenant-Relationsconstraints aus 073 sind nach dem Anti-Join-Preflight aus 074 `convalidated=true`; der Live-Harness wiederholt alle 19 Driftprüfungen read-only und verlangt Summe null.
5. Beide Workspace-Wurzeln haben `is_qa = true`; Projekte und alle Mitgliedschaften gehören zum erwarteten Workspace.
6. Zwei verschiedene append-only `qa_batches` sind vorprovisioniert und an den jeweiligen Plattform-Admin-Aktor gebunden.
7. Acht getrennte, aktive Rollenaccounts sind mit MFA vorab registriert. Der Harness enrollt MFA niemals selbst.
8. Der Runtime-Capability-Preflight bestätigt **vor dem ersten Geschäftsobjekt** die atomare Batchregistrierung und exakt den erwarteten Commit-SHA.
9. Schreib- und Cleanup-Bestätigung sind unabhängig voneinander gesetzt.
10. `POST /api/admin/qa-reset` akzeptiert beide Workspaces über die serverseitige QA-Allowlist, hat keinen Production-Overlap und erlaubt Execute ausdrücklich.
11. Provider-/Blob-Schreibpfade sind nicht Bestandteil dieses Laufs. Ein unerwartetes Blob-/Providerziel blockiert den Reset.

Es gibt keinen Direktlösch-Fallback. Schlägt Dry-run, Graph-Closure oder Execute fehl, bleibt der Batch mit Auditbeleg erhalten und der Lauf ist rot.

## Rollenmatrix

| Sicht | technische Rolle | Produktrolle | Create | Read | Update | Delete |
|---|---|---|---:|---:|---:|---:|
| Owner | `owner` | `customer_owner` | 200 | 200 | 200 | 200, reversible Archivierung |
| Admin | `admin` | `workspace_admin` | 200 | 200 | 200 | 200, reversible Archivierung |
| Member | `agent` | `team_member` | 200 | 200 | 200, eigenes Objekt | 403 |
| Customer | `assistant` | `viewer` oder `external_partner` | 403 | 200, serverseitig gefiltert | 403 | 403 |
| Public | keine Session | keine | 401 | öffentliche Seite 200, privates API 401 | 401 | 401 |

„Delete“ bedeutet im Benutzervertrag Kontaktarchivierung. Die physische Löschung aller im Batch registrierten Geschäftszeilen erfolgt ausschließlich über den DB-01-Reset nach grünem Dry-run.

## Verbindliche Matrix je Tenant

- Login mit persistierter Cookie-Session, CSRF und vorab registriertem TOTP.
- Prüfung von User-ID, Workspace-ID, technischer Rolle und Produktrolle gegen die Fixture-IDs.
- Kontakt Create/Read/Update/Delete für Owner, Admin, Member, Customer und Public gemäß Tabelle.
- Fremde `workspaceId` im Create-Payload darf die Session-Scope nicht überschreiben.
- Deal-Create für Owner, Admin und Member sowie Owner-Update.
- Zwei parallele Deal-POSTs mit identischem `Idempotency-Key`: beide erfolgreich, genau dieselbe Deal-ID.
- Neue Owner-Session und Core-Reload: aktualisierte Deal-Werte müssen weiterhin vorhanden sein.
- Jede nichtinterne Rolle versucht, den jeweils anderen Workspace zu lesen: zwingend 403.
- Fremde Kontakt-ID wird aus dem anderen Tenant aktualisiert: zwingend 403 oder 404.
- Öffentliche Tenant-Seite lädt mit 200 und enthält nicht die Workspace-ID des anderen Tenants.
- Reset-Dry-run ohne Blocker; Execute übergibt danach die exakte Workspace-/Batch-Confirmation und den unveränderten SHA-256-Plandigest aus diesem Dry-run; Digest und Löschcounts müssen mit dem Dry-run übereinstimmen.
- Exakte Ledger-IDs in `contacts`, `consent_records`, `deals` und `deal_stage_history`: verbleibende Zeilen = 0.
- Alle vom Harness erzeugten Cookie-Sessions werden abschließend serverseitig ausgeloggt/revoziert; Auth-/Auditbelege bleiben gemäß Retention erhalten.

Der Verification-Stop-Contract gilt: Beim ersten gebrochenen Boundary wird die fachliche Matrix gestoppt; Cleanup läuft trotzdem im `finally` für beide bereits geöffneten Batches.

## Implementierter Runtime-Vertrag

Der Kandidat implementiert den serverseitigen Vertrag fail-closed. Er wird nur aktiv, wenn `VERCEL_ENV=preview`, `NOVALURE_QA_BATCH_REGISTRATION_ENABLED=true`, ein 40-stelliger `VERCEL_GIT_COMMIT_SHA` vorhanden ist, `NOVALURE_QA_RESET_WORKSPACE_IDS` mindestens zwei QA-Workspaces enthält und eine nichtleere, dazu disjunkte `NOVALURE_PRODUCTION_WORKSPACE_IDS`-Denylist konfiguriert ist. Fehlt die Production-Denylist, liefern Capability, QA-Mutationen und Reset einen Konfigurationsfehler; in Production wird jeder Request mit QA-Batchheader vor einem Write abgewiesen.

### Capability-Preflight

`GET /api/admin/qa-batch-capability` benötigt eine persistierte Plattform-Admin-Cookie-Session und muss liefern:

```json
{
  "atomicRegistration": true,
  "version": 1,
  "header": "x-novalure-qa-batch-id",
  "gitSha": "<40-character candidate SHA>"
}
```

### Atomare Mutationsregistrierung

Jede erlaubte QA-Mutation trägt:

```text
x-novalure-qa-batch-id: <pre-provisioned batch UUID>
```

Die Runtime registriert in derselben Tenant-Datenbanktransaktion wie das Geschäftsobjekt alle neu erzeugten reset-relevanten IDs in `qa_batch_objects`: Contact und ggf. Consent sowie Deal und ggf. Stage-History. PATCH und Archivierung akzeptieren ausschließlich Hauptobjekte, die bereits demselben Batch gehören; dadurch kann kein Altbestand nachträglich in den Cleanup-Scope aufgenommen werden. Erfolgreiche Antworten bestätigen:

```text
x-novalure-qa-batch-id: <same batch UUID>
x-novalure-qa-batch-registration: committed
```

Ein idempotenter Replay oder die Mutation eines bereits batchregistrierten Hauptobjekts liefert `already-registered`. Abgewiesene 401/403/404/409-Mutationen erzeugen keine Ledgerzeile. Ein Header allein oder nachträgliches Registrieren durch den Testclient gilt nicht als Atomicity Proof.

Reset und Registrierung serialisieren über denselben exklusiven Transaction-Advisory-Lock pro Batch. Ein erfolgreiches Execute versiegelt den Batch endgültig anhand des append-only `qa_reset_audit_events`-Eintrags mit `mode=execute` und `outcome=executed`. Eine bereits wartende oder später eintreffende Mutation erhält `QA_BATCH_SEALED`; eine Mutation, die den Lock vorher besitzt, committed vollständig vor dem Reset und wird dadurch in dessen geschlossener Zielmenge berücksichtigt. Die append-only Batchzeile selbst bleibt unverändert.

Der Capability-Preflight prüft zusätzlich persistierte Plattform-Admin-Cookie-Session, Launch-Scope/RBAC, QA-Allowlist, `workspaces.is_qa`, Ledger-Verfügbarkeit und den Kandidaten-SHA, bevor er `atomicRegistration: true` meldet.

## Benötigte IDs und Umgebungswerte

### Am 22.08.2026 provisionierter Preview-Stand

Das isolierte Preview-Projekt `weathered-term-98273025`, Branch `br-lucky-heart-alrm9dlw`, enthält jetzt 057, 060 sowie 068–077 und zwei ausschließlich synthetische `is_qa=true`-Wurzeln. Preview-Main wurde mit 11/11 exakten lokalen Checksummen, 19/19 validierten deferrable Tenant-FKs, 0/19 Anti-Join-Verstößen, 21/21 Launch-Schemaartefakten und dem vollständigen 077-Owner-/ACL-Gate bestätigt. Zuvor wurde auf Evidence-Branch `br-spring-math-aljuzher` der vollständige Cutover 057 + 073–076 per Apply/Restore/Reapply geprüft; Migration 077 wurde dort anschließend separat mit demselben Least-Privilege-Gate validiert, bevor sie nach ausdrücklicher Freigabe atomar auf Preview-Main angewandt wurde. Die Credentials und TOTP-Secrets wurden lokal in der gitignorierten Datei `.env.qa-two-tenant.local` mit restriktivem Dateimodus abgelegt und weder protokolliert noch committed.

| Tenant | Workspace | Projekt | aktueller leerer Batch |
|---|---|---|---|
| A | `498dc41e-031c-59ef-a422-edecd37c9c7d` | `e8ce7cc8-52c5-53bd-8b3e-a8d7ffda8fd8` | `97acc9d6-e115-501d-a82f-bb687fa43603` |
| B | `e791ad83-3637-56cc-bf2f-fd39d75cd1df` | `47a6fdfd-cb2c-5bd5-947c-af8332135cda` | `05fd30dd-538e-5034-af0b-89c74d221ff0` |

DB-Verifikation: zwei QA-Workspaces, je fünf aktive Mitgliedschaften (`customer_owner`, `workspace_admin`, `team_member`, `viewer`, `platform_admin`), insgesamt neun zentrale Auth-Identitäten, zehn MFA-fähige Mitgliedschaften, je fünf Pipeline-Stages, zwei leere append-only Batches und null registrierte Geschäftsobjekte. Die gemeinsame Reset-Identität besitzt absichtlich je eine getrennte Mitgliedschaft in beiden QA-Tenants.

Der wiederverwendbare Generator ist `scripts/qa-two-tenant-provision.mjs`. Er verlangt die exakte Confirmation `PROVISION_ISOLATED_TWO_TENANT_QA`, schreibt ausschließlich Dateien mit dem gitignorierten Präfix `.env.qa-two-tenant*`, verweigert Überschreiben und gibt auf stdout nur nicht geheime IDs aus. Ein neuer Execute-Lauf benötigt nach Batch-Seal einen neu provisionierten Batch.

### Gemeinsame Zielwerte

- `NOVALURE_QA_BASE_URL`: SHA-identische Preview-Origin, niemals Production.
- `NOVALURE_PRODUCTION_ORIGIN`: expliziter Deny-Target.
- `NOVALURE_QA_EXPECTED_GIT_SHA`: 40-stelliger Kandidaten-SHA.
- `NOVALURE_QA_DATABASE_URL`, `NOVALURE_QA_DATABASE_HOST`, `NOVALURE_QA_PROJECT_ID`, `NOVALURE_QA_BRANCH_ID`, `NOVALURE_QA_DATABASE_NAME`, `NOVALURE_QA_DATABASE_ROLE`.
- `NOVALURE_PRODUCTION_DATABASE_HOST`: expliziter DB-Deny-Target.
- `NOVALURE_QA_RUN_PREFIX`: einmalig, Format `GOLIVETEST_<id>`.
- `NOVALURE_QA_RESET_ADMIN_EMAIL`, `NOVALURE_QA_RESET_ADMIN_PASSWORD`, `NOVALURE_QA_RESET_ADMIN_TOTP_SECRET`.
- optional `NOVALURE_QA_PASSWORD` als gemeinsames Passwort-Fallback; es wird niemals ausgegeben oder in Evidenz geschrieben.

### Je Tenant A und B

Für Präfix `NOVALURE_QA_TENANT_A` beziehungsweise `NOVALURE_QA_TENANT_B`:

- `_WORKSPACE_ID`: reale Workspace-UUID, `is_qa = true`.
- `_PROJECT_ID`: bestehendes Projekt mit mindestens zwei DB-Pipeline-Stages.
- `_PUBLIC_PATH`: unterschiedliche, same-origin öffentliche Read-Seite.
- `_BATCH_ID`: vorprovisionierte append-only Batch-UUID.
- `_BATCH_MARKER`: unterschiedlicher Marker `QA-TEST-YYYYMMDD-HHmm-short-id`.
- `_RESET_ACTOR_USER_ID`: aktive `owner`/`platform_admin`-Mitgliedschaft im Zieltenant.
- je `_OWNER`, `_ADMIN`, `_MEMBER`, `_CUSTOMER`: `_EMAIL`, `_PASSWORD` oder gemeinsames Passwort, `_TOTP_SECRET`, `_USER_ID`.
- optional `_CUSTOMER_PRODUCT_ROLE=external_partner`; Default ist `viewer`.

Alle acht Rollen-E-Mails, alle zehn Rollen-/Reset-Mitgliedschafts-IDs, beide Workspace-, Projekt-, Batch-IDs, Marker und Public Paths müssen verschieden sein.

### Serverseitig im Preview-Deployment

- `NOVALURE_QA_RESET_WORKSPACE_IDS=<tenant-a>,<tenant-b>`.
- `NOVALURE_PRODUCTION_WORKSPACE_IDS=<vollständige Production-Allowlist>` ohne Überschneidung.
- `NOVALURE_QA_RESET_EXECUTION_ENABLED=true` nur für das isolierte QA-Deployment.
- Atomic-Batch-Context aktiviert; Funnel, Newsletter, Mail, Kalender, Cron und andere Provider-Side-Effects bleiben in diesem Lauf Launch-OFF.

### Explizite Ausführungsbestätigung

```text
NOVALURE_QA_E2E_WRITE_CONFIRM=RUN_TWO_TENANT_QA
NOVALURE_QA_E2E_CLEANUP_CONFIRM=RESET_TWO_TENANT_QA
```

## Laufreihenfolge

```powershell
npm.cmd run qa:two-tenant:provision
npm.cmd run qa:two-tenant:plan
npm.cmd run qa:two-tenant:validate
npm.cmd run qa:two-tenant:preflight
npm.cmd run qa:two-tenant:execute
```

- `provision` ist ein separat bestätigter, zielgeprüfter Preview-Schritt und darf niemals gegen Production laufen; für den dokumentierten Lauf ist er bereits abgeschlossen.
- `plan` benötigt keine Env-Werte, öffnet keine Verbindung und schreibt nichts.
- `validate` prüft nur Formate, Eindeutigkeit und Production-Deny-Ziele.
- `preflight` liest DB/HTTP-Zustand und prüft echte Auth-/Tenant-Grenzen; es schreibt keine CRM-Geschäftsobjekte. Persistierte Auth-Session-/Auditzeilen sind erwartete Sicherheitsbelege.
- `execute` verlangt zusätzlich Capability-Proof und beide Bestätigungen; für jeden Reset muss es außerdem den exakten Plandigest des unmittelbar vorherigen blockerfreien Dry-runs zurückreichen. Cleanup wird immer versucht, sobald der erste Geschäftsschreibpfad gestartet wurde.

Preflight und Execute dürfen denselben noch leeren Batch verwenden. Nach dem ersten Geschäfts-Write werden Run-Prefix und Batch nicht für einen zweiten Testlauf wiederverwendet. Bei fehlgeschlagenem Cleanup wird zunächst der gespeicherte Resetplan repariert und derselbe Batch ausschließlich zur Reconciliation über den sicheren API-Vertrag verwendet; direkte SQL-Löschung ist verboten.

### PostgreSQL-Barriere-Gate für die Batch-Lockreihenfolge

Der wiederverwendbare Drill `scripts/qa-batch-lock-order-live.mjs` belegt mit zwei echten `novalure_app`-Sessions die Reset-/Mutation-Reihenfolge und die QA-Flag-Race-Grenze, ohne Geschäfts- oder Ledgerdaten dauerhaft zu verändern:

1. Mutation-first hält `Batch-Advisory → Workspace+Batch FOR SHARE`; Reset-second muss am identischen Batch-Advisory warten und erwirbt danach `Workspace FOR UPDATE`.
2. Reset-first hält `Batch-Advisory → Workspace FOR UPDATE`; Mutation-second muss am identischen Batch-Advisory warten und erwirbt danach `Workspace+Batch FOR SHARE`.
3. Mutation-first blockiert ein paralleles `UPDATE workspaces SET is_qa=false`; QA-Flag-first blockiert spiegelbildlich die Mutation. Das Flag-Update läuft ausschließlich in einer Transaktion, wird in jedem Pfad zurückgerollt und darf nie Production adressieren.

Der Standardaufruf ist offline. Validation und Execute verlangen die exakten UUIDs eines existierenden `is_qa`-Workspace, seines Batches und einer aktiven Workspace-Mitgliedschaft:

```powershell
npm.cmd run qa:batch-lock-order:plan
npm.cmd run qa:batch-lock-order:validate -- --workspace-id <qa-workspace-uuid> --batch-id <qa-batch-uuid> --actor-id <qa-actor-uuid>
$env:NOVALURE_QA_LOCK_ORDER_CONFIRM = "RUN_QA_LOCK_AND_ROLLBACK_DRILL"
npm.cmd run qa:batch-lock-order:execute -- --workspace-id <qa-workspace-uuid> --batch-id <qa-batch-uuid> --actor-id <qa-actor-uuid>
```

Vor dem Verbindungsaufbau müssen `VERCEL_ENV=preview`, die QA-/Production-Origin-Deny-Grenze, getrennte gepoolte QA-/Production-Neon-Hosts, Project-/Branch-/Datenbank-Fingerprint, exakt `NOVALURE_QA_DATABASE_ROLE=novalure_app`, mindestens zwei disjunkte QA-Workspace-IDs und die vollständige Production-Workspace-Denylist gesetzt sein. Das Script akzeptiert ausschließlich `BEGIN`, feste `SET LOCAL`-Timeouts/Kontextwerte, `SELECT`-/Lock-Statements, genau das feste QA-Flag-Update und `ROLLBACK`. Beide Sessions werden immer zurückgerollt; es gibt kein Insert, Delete, Seal, Geschäftsobjekt- oder Ledgerwrite.

Die stdout-Evidenz `novalure.qa.batch-lock-order-evidence.v1` enthält nur SHA-256-Fingerprints, vier Barrierenergebnisse, Sessionanzahl, Laufzeiten und `writes: 0` (dauerhafte Writes). Datenbank-URL, Host, UUIDs, Credentials und rohe Rows werden nicht ausgegeben. Dieses Gate gilt erst nach einem echten `--execute` gegen den isolierten SHA-identischen Preview-Kandidaten als bestanden; der Contracttest allein genügt nicht.

## Beweisformat

Der Harness legt ausschließlich lokale, geheimnisfreie Artefakte unter `NOVALURE_QA_EVIDENCE_DIR` oder `artifacts/qa/<run-prefix>` an:

- `preflight-two-tenant-e2e.json` beziehungsweise `execute-two-tenant-e2e.json`: Schema `novalure.qa.two-tenant-e2e.v1`, Kandidaten-SHA, gehashte Ziel-IDs, Requestpfad/Status/Dauer, Szenario-Ergebnis, Reset-Plandigest, Counts und Null-Rückstand.
- gleichnamige `.sha256`: SHA-256 der kanonisch sortierten JSON-Datei.

Nicht gespeichert werden Passwörter, TOTP-Secrets, Cookies, CSRF-Tokens, Authorization-Header, Datenbank-URL, rohe Antwortkörper oder E-Mail-Adressen. Der Writer verweigert secret-ähnliche Schlüssel und überschreibt keine vorhandene Evidenz.

### Bisherige read-only Runtime-Evidenz

Auf Preview-Deployment `dpl_4rArLhVLBRts7JA2B7edY4F5dHon` mit Source-SHA `7faeda244fa964d73ecc63960e1b991d97488c60` bestand der lokal korrigierte Harness den Modus `preflight` mit 94/94 Ergebnissen und 50 Requests. Belegt sind beide QA-Tenant-Ziele, App-Rolle/RLS/Ledger-Projektion, 11/11 Migrationschecksummen, 19/19 validierte Tenant-Constraints ohne Anti-Join-Verstoß, zehn authentifizierte Rollen-/Reset-Sessions, acht korrekt verweigerte Cross-Tenant-Core-Reads, zwei anonyme 401-Grenzen, zwei öffentliche 200-Seiten ohne fremde Workspace-ID und zehn akzeptierte Logout-Aufrufe mit Status 303. Eine Post-Logout-Invalidierung wurde nicht geprüft. Die Requestliste enthält keine CRM-Mutationsroute; Auth-/Session-/Audit-Sicherheitswrites können dennoch erfolgt sein. `cleanup=[]` bedeutet deshalb ausschließlich, dass kein Geschäftswritelauf begonnen wurde, nicht dass Cleanup bewiesen wäre.

Artefakt: `artifacts/qa/preview-7faeda2-cookiefix-precommit-20260823/preflight-two-tenant-e2e.json`; kanonischer SHA-256: `997bdcc41160c874bf5f78727f544063df8ea4124ee665a4f9ac454861cabdbf`. Capability-Endpunkt, atomare Runtime-Batchregistrierung, CRUD, Reset/Cleanup, Barrieredrill, Post-Logout-Invalidierung und vollständige MFA-/Ablauf-/Rate-Limit-Matrix sind nicht belegt. Da der Cookie-Fix-Harness zu diesem Zeitpunkt lokal noch nicht committed/deployt war, muss derselbe Preflight auf dem nächsten SHA-identischen Kandidaten wiederholt werden.

## Inventur der bisherigen QA-Pfade

| Pfad | Status für finale Abnahme | Grund |
|---|---|---|
| `qa-livegang-api.mjs` | hart deaktiviert | Zufallsmarker, kein atomarer Batchkontext, kein eigener Cleanup |
| `qa-livegang-reset.mjs` | hart deaktiviert | alte Root-Löschung; ersetzt durch authentifizierten DB-01-Reset |
| `qa-livegang-seed.mjs` | nicht als finaler Lauf verwenden | erzeugt drei synthetische Roots und Authzustand außerhalb des Batchvertrags |
| `qa-contact-access.mjs` | nur lokale Diagnose | vertraute Auth-Header und direkte Root-/User-Löschung |
| `e2e-object-creation-tests.mjs` | nur isolierte DB-Diagnose | ein Tenant, direkte Workspace-Wurzel und Direktcleanup |
| `qa-deal-idempotency.mjs`, `qa-lead-idempotency.mjs` | ergänzende DB-Diagnose | kein echter Cookie-/MFA-/HTTP-Tenantlauf |
| `qa-two-tenant-e2e.mjs` | verbindlicher finaler Lauf | echte Sessions, feste zwei Tenants, atomarer Batchproof, Reset-Dry-run/Execute, Evidence |
| `qa-batch-lock-order-live.mjs` | verbindlicher DB-Barrierennachweis | zwei echte Sessions, Reset-/Mutation- und QA-Flag-Races, transaktionales Flag-Update mit garantiertem Rollback, redigierte Evidenz |

## GO-Kriterien

GO für SEC-/DB-E2E ist nur möglich, wenn:

- der Capability-/Atomicity-Vertrag im exakt gleichen Kandidaten-SHA implementiert ist;
- beide realen QA-Tenants samt zehn Mitgliedschafts-IDs provisioniert und separat freigegeben sind;
- `plan`, `validate`, `preflight` und `execute` grün sind;
- der echte PostgreSQL-Barriere-Drill für mindestens einen freigegebenen QA-Batch in beiden Startreihenfolgen grün ist;
- alle Matrixzeilen grün, beide Resetpläne blockerfrei und alle operativen Batchzeilen entfernt sind;
- der Evidence-SHA signiert beziehungsweise im Go-Live-Ledger referenziert ist;
- keine Provider-/Blob-Side-Effects im Batch auftauchen und retained Audit/Auth/Security-Evidenz separat reconciled ist.

Der lokale Harness-/Contracttest allein ist kein Live-Beweis. Reale QA-Wurzeln, MFA-Fixtures, leere Batches, Migrationen und der atomare Runtime-Vertrag sind vorhanden. Ein read-only Auth-/Tenant-/DB-Preflight auf dem supersedierten Preview-Commit `7faeda2` bestand mit dem lokal korrigierten Harness 94/94 Ergebnisse und 50 Requests; er erzeugte keine CRM-Geschäftsobjekte, zehn konfigurierte Rollen-/Reset-Clients erreichten Session 200 und zehn Logout-Requests endeten mit 303. Post-Logout-Invalidierung und die vollständige Challenge-Matrix sind damit nicht bewiesen. Weil die Harnesskorrektur noch nicht im deployten SHA enthalten war, bleiben das neue SHA-identische Preview-Deployment, dessen erneut deployment-spezifisch freizugebender Zugang, der wiederholte Preflight, Capability-Proof sowie der echte Matrix-/Cleanup-Lauf offen; deshalb bleibt dieses Gate rot.
