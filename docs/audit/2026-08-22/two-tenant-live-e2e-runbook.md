# Zwei-Tenant-Live-E2E-Runbook

Stand: 23.08.2026
Scope: echte, isolierte Preview-QA; keine Production-Mutation
Aktueller Status: **SHA-GLEICHER PREFLIGHT 94/94 BESTANDEN / EXECUTE NACH ERFOLGREICHEN KONTAKT-CREATES BEIM ERSTEN KONTAKT-PATCH MIT 409 GESTOPPT / CLEANUP EXAKT UND NULL LIVE-RÜCKSTAND / LOKALER CAS-FIX GRÜN / NO-GO**

## Ziel und Story

Der Kandidat wird als echte Cookie-/MFA-Session über die sichtbaren HTTP-Routen geprüft: Benutzeraktion → API/CSRF/RBAC → tenantgebundene Persistenz → Reload → Cross-Tenant-Negativfall → append-only Batch-Ledger → Dry-run → physischer Reset → Null-Rückstand. Tenant A und Tenant B müssen reale, langlebige QA-Wurzeln sein; nur die pro Lauf erzeugten Geschäftsobjekte werden entfernt.

Der neue Einstiegspunkt ist `scripts/qa-two-tenant-e2e.mjs`. Er ersetzt `test:e2e` und `qa:livegang:api`. Die npm-Kommandos laden lokal über Nodes `--env-file-if-exists` ausschließlich die gitignorierte `.env.qa-two-tenant.local`; in CI und Vercel bleiben direkt gesetzte Umgebungsvariablen maßgeblich. Der alte `qa-livegang-api.mjs` ist hart deaktiviert, weil er zufällige Objekte ohne beweisbare Batch-Closure hinterließ.

## Sicherheitsgrenzen

Der Lauf schreibt erst, wenn alle folgenden Grenzen bestanden sind:

1. Preview-Origin und Production-Origin sind explizit angegeben und verschieden.
2. Der gepoolte Neon-Host, Projekt-, Branch-, Datenbank- und Rollenfingerprint stimmt exakt; unabhängige Production-Projekt-, -Branch- und -Host-Deny-Targets sind vollständig gesetzt und von QA verschieden.
3. Migration `057` sowie die Migrationen `068` bis `077` stehen mit exakt den lokal berechneten SHA-256-Checksummen im Preview-Schema-Ledger; eine bloß formal 64-stellige Fremdchecksumme reicht nicht. Das read-only `pg_catalog`-Gate verlangt für 075 Tabelle, Unique-/FK-/Check-Constraints, Expiry-Index und Minimalgrants, für 076 die exakten State-/Event-Spalten, validierten Checks, Workspace-Unique-, Account/Event-, Legacy-Abwesenheits-, Reclaim- und Account/Received-Indexzustände, 7 Event-Unique-Indizes, die globale Envelope-Quarantänetabelle, die write-only `SECURITY DEFINER`-RPC mit `search_path=pg_catalog` und Minimalgrants, 6 tenantqualifizierte FKs und bewusst keinen Live-FK vom append-only `audit_logs`-Snapshot sowie für 077 die ownergebundene, nicht aktualisierbare `version`-/`checksum`-Projektion bei vollständig entzogenen Direktrechten auf das Basis-Ledger.
4. Alle 19 Tenant-Relationsconstraints aus 073 sind nach dem Anti-Join-Preflight aus 074 `convalidated=true`; der Live-Harness wiederholt alle 19 Driftprüfungen read-only und verlangt Summe null.
5. Beide Workspace-Wurzeln haben `is_qa = true`; Projekte und alle Mitgliedschaften gehören zum erwarteten Workspace.
6. Zwei verschiedene append-only `qa_batches` sind vorprovisioniert und an den jeweiligen Plattform-Admin-Aktor gebunden.
7. Acht getrennte, aktive Rollenaccounts sind mit MFA vorab registriert. Jede Fixture-Credential-Rotation widerruft bestehende Sessions derselben zentralen Identität und konsumiert offene Login-Challenges atomar mit append-only Auth-Audit. Der DB-Preflight verlangt danach vor dem ersten Login exakt null aktive Fixture-Sessions; der Harness enrollt MFA niemals selbst.
8. `GET /api/admin/qa-runtime-identity` bestätigt **vor jedem Auth-Request** ausschließlich Preview-Deployment-ID/-Host, Git-Branch/SHA, einen SHA-256-Digest aus Neon-Projekt/Branch/Datenbank/Rolle sowie aktive Ledger-RLS und Least Privilege. Ein Mismatch stoppt mit genau diesem öffentlichen Request und null `/api/auth/*`-Requests. Erst danach bestätigt der authentifizierte Capability-Preflight dieselbe Identität und die atomare Batchregistrierung.
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

`GET /api/admin/qa-runtime-identity` ist ein absichtlich unauthentifizierter, aber ausschließlich in der explizit aktivierten Preview-QA-Runtime verfügbarer Pre-Auth-Endpunkt. Er enthält keine Workspace-, Tenant-, User-, Session-, Credential- oder rohen Datenbankkennungen und ist im Release-Surface-Manifest als `INTERNAL` inventarisiert:

```json
{
  "version": 1,
  "deploymentId": "<exact dpl_...>",
  "deploymentHost": "<exact Preview host>",
  "gitBranch": "<exact codex/... branch>",
  "gitSha": "<40-character candidate SHA>",
  "databaseTargetDigest": "sha256:<64 hex>",
  "databaseRlsActive": true,
  "databaseLeastPrivilege": true
}
```

`GET /api/admin/qa-batch-capability` benötigt eine persistierte Plattform-Admin-Cookie-Session und muss liefern:

```json
{
  "atomicRegistration": true,
  "version": 1,
  "header": "x-novalure-qa-batch-id",
  "gitSha": "<40-character candidate SHA>",
  "databaseTargetDigest": "sha256:<same 64 hex>",
  "databaseRlsActive": true,
  "databaseLeastPrivilege": true
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

Unmittelbar vor jedem QA-Batch-Write und jedem Reset-DML liest ein zentraler Guard **in derselben aktiven Tenant-Transaktion** `neon.project_id`, `neon.branch_id`, `current_database()` und `current_user`. Diese vier Werte müssen exakt mit den branchgebundenen Preview-Runtime-Werten `NOVALURE_QA_PROJECT_ID`, `NOVALURE_QA_BRANCH_ID`, `NOVALURE_QA_DATABASE_NAME` und `NOVALURE_QA_DATABASE_ROLE=novalure_app` übereinstimmen. Zusätzlich müssen `NOVALURE_PRODUCTION_PROJECT_ID` und `NOVALURE_PRODUCTION_BRANCH_ID` vollständig gesetzt und vom QA-Ziel verschieden sein. Ein fehlender Wert, Production-Overlap oder Runtime-Mismatch wirft `QA_BATCH_DATABASE_TARGET_MISMATCH`, rollt die Transaktion zurück und bewirkt **null Geschäfts-, Ledger- oder Reset-Writes**. Der frühere HTTP-/DB-Preflight bleibt eine zusätzliche Vorprüfung, ersetzt diesen Write-Time-Guard aber nicht.

Reset und Registrierung serialisieren über denselben exklusiven Transaction-Advisory-Lock pro Batch. Ein erfolgreiches Execute versiegelt den Batch endgültig anhand des append-only `qa_reset_audit_events`-Eintrags mit `mode=execute` und `outcome=executed`. Eine bereits wartende oder später eintreffende Mutation erhält `QA_BATCH_SEALED`; eine Mutation, die den Lock vorher besitzt, committed vollständig vor dem Reset und wird dadurch in dessen geschlossener Zielmenge berücksichtigt. Die append-only Batchzeile selbst bleibt unverändert.

Der Capability-Preflight prüft zusätzlich persistierte Plattform-Admin-Cookie-Session, Launch-Scope/RBAC, QA-Allowlist, `workspaces.is_qa`, Ledger-Verfügbarkeit und den Kandidaten-SHA, bevor er `atomicRegistration: true` meldet.

## Benötigte IDs und Umgebungswerte

### Am 22.08.2026 provisionierter Preview-Stand

Das isolierte Preview-Projekt `weathered-term-98273025`, Branch `br-lucky-heart-alrm9dlw`, enthält jetzt 057, 060 sowie 068–077 und zwei ausschließlich synthetische `is_qa=true`-Wurzeln. Preview-Main wurde mit 11/11 exakten lokalen Checksummen, 19/19 validierten deferrable Tenant-FKs, 0/19 Anti-Join-Verstößen, 21/21 Launch-Schemaartefakten und dem vollständigen 077-Owner-/ACL-Gate bestätigt. Zuvor wurde auf Evidence-Branch `br-spring-math-aljuzher` der vollständige Cutover 057 + 073–076 per Apply/Restore/Reapply geprüft; Migration 077 wurde dort anschließend separat mit demselben Least-Privilege-Gate validiert, bevor sie nach ausdrücklicher Freigabe atomar auf Preview-Main angewandt wurde. Die Credentials und TOTP-Secrets wurden lokal in der gitignorierten Datei `.env.qa-two-tenant.local` mit restriktivem Dateimodus abgelegt und weder protokolliert noch committed.

| Tenant | Workspace | Projekt | ursprünglich provisionierter Batch (historische Fixture-ID) |
|---|---|---|---|
| A | `498dc41e-031c-59ef-a422-edecd37c9c7d` | `e8ce7cc8-52c5-53bd-8b3e-a8d7ffda8fd8` | `97acc9d6-e115-501d-a82f-bb687fa43603` |
| B | `e791ad83-3637-56cc-bf2f-fd39d75cd1df` | `47a6fdfd-cb2c-5bd5-947c-af8332135cda` | `05fd30dd-538e-5034-af0b-89c74d221ff0` |

DB-Verifikation am Provisionierungstag: zwei QA-Workspaces, je fünf aktive Mitgliedschaften (`customer_owner`, `workspace_admin`, `team_member`, `viewer`, `platform_admin`), insgesamt neun zentrale Auth-Identitäten, zehn MFA-fähige Mitgliedschaften, je fünf Pipeline-Stages, zwei leere append-only Batches und null registrierte Geschäftsobjekte. Die gemeinsame Reset-Identität besitzt absichtlich je eine getrennte Mitgliedschaft in beiden QA-Tenants.

Die Tabelle dokumentiert den Provisionierungsstand vom 22.08.2026 und ist keine Freigabe zur Wiederverwendung dieser Batch-IDs. Die späteren Execute- und Repository-Proben verwendeten weitere append-only Batches; alle dabei verwendeten Batches wurden nach Cleanup/Reset versiegelt. Vor jedem neuen Execute müssen deshalb zwei frische, tenantgebundene Batches erzeugt und erneut geprüft werden.

Der wiederverwendbare Generator ist `scripts/qa-two-tenant-provision.mjs`. Er verlangt die exakte Confirmation `PROVISION_ISOLATED_TWO_TENANT_QA`, `NOVALURE_QA_EXPECTED_GIT_BRANCH` als expliziten `codex/`-Preview-Branch, `NOVALURE_QA_EXPECTED_GIT_SHA` als vollständige kleingeschriebene Candidate-SHA sowie unabhängige QA-/Production-Projekt-, -Branch- und -Host-Identitäten. Sein Schema-v2-Plan ist nur als eine Transaktion zulässig: Statement 0 attestiert über `current_setting('neon.project_id')`, `current_setting('neon.branch_id')` und `current_database()` das exakte QA-Ziel und blockiert Production-Overlap, bevor irgendein DML folgt. Credential-Rotation, Session-Widerruf, Challenge-Verbrauch und Auth-Audit bleiben je Identität in einem SQL-Statement atomar. Branch und SHA werden in das lokale Fixture-Bundle geschrieben; die SHA wird zusätzlich unveränderlich in die Metadaten jedes frisch erzeugten QA-Batches geschrieben. Der Generator läuft bewusst vor dem Deployment, damit seine sensitiven Branch-Variablen in das Candidate-Deployment einfließen können. Erst nachdem dieses Deployment `READY` ist, muss dessen exakte ID separat als `NOVALURE_QA_EXPECTED_DEPLOYMENT_ID` in den lokalen Runner-Prozess injiziert werden; sie darf nicht erneut als Vercel-Variable hochgeladen werden, weil dies ein neues Deployment und damit einen Bindungszyklus erzeugen würde. Der Generator schreibt ausschließlich Dateien mit dem gitignorierten Präfix `.env.qa-two-tenant*`, verweigert Überschreiben und gibt auf stdout nur nicht geheime IDs aus. Er erzeugt zunächst eine leere Datei, erzwingt und verifiziert unter Windows per nicht-shellbasiertem `icacls` eine einzige nicht geerbte Full-Control-ACE des aktuellen Owner-SID beziehungsweise unter POSIX exakt `0600`, schreibt erst danach Secrets und löscht die Datei bei jedem nicht beweisbaren ACL-/Mode-Zustand. Bundle und Plan werden bei partieller Generierung gemeinsam zurückgerollt. Ein neuer Execute-Lauf benötigt nach Batch-Seal einen neu provisionierten Batch.

### Gemeinsame Zielwerte

- `NOVALURE_QA_BASE_URL`: SHA-identische Preview-Origin, niemals Production.
- `NOVALURE_PRODUCTION_ORIGIN`: expliziter Deny-Target.
- `NOVALURE_QA_EXPECTED_GIT_BRANCH`: exakter `codex/`-Preview-Branch.
- `NOVALURE_QA_EXPECTED_DEPLOYMENT_ID`: exakte Vercel-Preview-Deployment-ID; erst nach `READY` ausschließlich lokal in den Runner-Prozess injizieren.
- `NOVALURE_QA_EXPECTED_GIT_SHA`: 40-stelliger Kandidaten-SHA.
- `NOVALURE_QA_DATABASE_URL`, `NOVALURE_QA_DATABASE_HOST`, `NOVALURE_QA_PROJECT_ID`, `NOVALURE_QA_BRANCH_ID`, `NOVALURE_QA_DATABASE_NAME`, `NOVALURE_QA_DATABASE_ROLE`.
- `NOVALURE_PRODUCTION_PROJECT_ID`, `NOVALURE_PRODUCTION_BRANCH_ID`, `NOVALURE_PRODUCTION_DATABASE_HOST`: drei eigenständige und verpflichtend von QA verschiedene DB-Deny-Targets.
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
- `NOVALURE_QA_PROJECT_ID`, `NOVALURE_QA_BRANCH_ID`, `NOVALURE_QA_DATABASE_NAME` und exakt `NOVALURE_QA_DATABASE_ROLE=novalure_app` als branchgebundene erwartete Write-Time-Zielidentität.
- `NOVALURE_PRODUCTION_PROJECT_ID` und `NOVALURE_PRODUCTION_BRANCH_ID` als vollständige, vom QA-Ziel disjunkte Deny-Identität; der getrennte Production-Datenbankhost bleibt für die vorgelagerten Host-Gates verpflichtend.
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
# Sensitive Branch-Variablen hochladen, Candidate deployen und READY/Deployment-ID verifizieren.
npm.cmd run qa:two-tenant:bind-runtime
npm.cmd run qa:two-tenant:validate
npm.cmd run qa:two-tenant:preflight:protected
npm.cmd run qa:two-tenant:execute:protected
```

- `provision` ist ein separat bestätigter, zielgeprüfter Preview-Schritt und darf niemals gegen Production laufen; für den dokumentierten Lauf ist er bereits abgeschlossen.
- `plan` benötigt keine Env-Werte, öffnet keine Verbindung und schreibt nichts.
- `bind-runtime` liest nach `READY` genau ein strikt typisiertes Schema-v2-JSON von stdin, bindet Deployment-ID/Origin sowie die isolierte Preview-DB an das lokale owner-only-Bundle und gibt weder DB-URL noch Credentials aus. QA-Projekt, -Branch, -Datenbank und -Host sowie Production-Projekt, -Branch und -Host müssen dem unveränderten Provisionierungsplan entsprechen und voneinander verschieden sein. Dieser Schritt lädt keine Vercel-Variable hoch und löst kein neues Deployment aus.
- `validate` prüft nur Formate, Eindeutigkeit und Production-Deny-Ziele.
- `preflight:protected` liest die deploymentgebundene temporäre Vercel-Share-URL ausschließlich von stdin, behält nur sichere `_vercel_*`-Cookies, prüft zuerst den zero-auth Runtime-Identity-Endpunkt, danach DB-Ziel und null aktive Fixture-Sessions und erst anschließend HTTP/Auth-/Tenant-Grenzen; es schreibt keine CRM-Geschäftsobjekte. Persistierte Auth-Session-/Auditzeilen sind erwartete Sicherheitsbelege.
- `execute:protected` verwendet denselben stdin-Vertrag und verlangt zusätzlich Capability-Proof und beide Bestätigungen; für jeden Reset muss es außerdem den exakten Plandigest des unmittelbar vorherigen blockerfreien Dry-runs zurückreichen. Cleanup wird immer versucht, sobald der erste Geschäftsschreibpfad gestartet wurde.

Preflight und Execute dürfen denselben noch leeren Batch verwenden. Nach dem ersten Geschäfts-Write werden Run-Prefix und Batch nicht für einen zweiten Testlauf wiederverwendet. Bei fehlgeschlagenem Cleanup wird zunächst der gespeicherte Resetplan repariert und derselbe Batch ausschließlich zur Reconciliation über den sicheren API-Vertrag verwendet; direkte SQL-Löschung ist verboten.

### Manueller GitHub-Workflow

`.github/workflows/livegang-e2e.yml` besitzt ausschließlich `workflow_dispatch` und läuft nur im geschützten GitHub Environment `go-live-preview`; Pull Requests, Pushes, localhost und ein lokaler Production-Server sind ausgeschlossen. Das Environment muss Deployments auf den geschützten Default-Branch `main` begrenzen und vor Secret-Freigabe die vorgeschriebenen Reviewer anwenden. Der Workflow verlangt `GITHUB_REF=refs/heads/main` und den exakten `GITHUB_WORKFLOW_REF` dieses Workflows auf `main`. Vor dem Checkout sind die exakte Confirmation `RUN_EXACT_PROTECTED_PREVIEW_QA`, Candidate-SHA, `codex/`-Branch, READY-Deployment-ID, Preview-Origin und -Host, Neon-Projekt und -Branch sowie eine vertrauenswürdige Harness-SHA als Dispatch-Inputs verpflichtend.

`vercel.json` setzt `git.deploymentEnabled.main=false`. Dadurch kann der geprüfte Harness auf `main` eingefroren werden, ohne dass dieser Git-Schritt automatisch ein Production-Deployment auslöst. Der CI-Vertrag testet diese Sperre. Eine Production-Promotion bleibt davon getrennt und darf ausschließlich explizit mit dem bereits verifizierten Candidate-SHA nach allen harten Gates erfolgen; das Abschalten der Git-Automatik selbst ist keine Promotion und kein GO-Nachweis.

`vars.NOVALURE_QA_TRUSTED_HARNESS_SHA` muss im geschützten Environment auf genau den freigegebenen 40-stelligen Commit von `main` zeigen. Input, Environment-Variable, `GITHUB_SHA` und der anschließend ausgecheckte Commit müssen identisch sein; der Commit muss als Vorfahr von `origin/main` nachweisbar sein. Ausschließlich dieser Trust-Anchor wird installiert und ausgeführt. Die Candidate-SHA wird **nicht** ausgecheckt oder als lokaler Code ausgeführt, sondern bleibt die erwartete Identität des externen, bereits `READY` gemeldeten Preview-Deployments. Damit kann ein beliebiger Candidate-Commit die zur Laufzeit freigegebenen Secrets nicht über eigenen Runner-Code auslesen. Fehlt die geschützte Branch-/Reviewer-/Trust-Anchor-Konfiguration, ist der Lauf `NOT_RUN`/rot und darf nicht als E2E-Beleg gelten.

Die später im Runner-JSON gespeicherten `GITHUB_*`-Strings sind allein kein Herkunftsnachweis. Der finale PASS-Verifier verlangt zusätzlich das exakte Fünf-Dateien-Artefaktmanifest sowie eine extern verwurzelte Ed25519-Receipt der Rolle `github-actions-attestor`. Diese bindet OIDC-Issuer, Subject und Audience, Repository, geschützte Environment, Workflow-Ref, immutable Main-Harness-SHA, Run-ID/Attempt, SLSA-Predicate, Artifact-Attestation-Bundle und den exakten Artefakt-Digest an denselben Candidate/Deployment/DB-Branch. Ohne diese kryptografische Receipt bleibt selbst eine fachlich grüne Matrix `BLOCKED`.

Das Environment muss zur Aktionszeit genau zwei verschlüsselte Secrets liefern:

- `NOVALURE_QA_TWO_TENANT_ENV_B64`: Base64 des vollständigen, bereits deployment- und datenbankgebundenen `.env.qa-two-tenant.local`-Bundles einschließlich beider Tenant-Fixtures, Ausführungsbestätigungen und der drei Production-Deny-Targets.
- `NOVALURE_QA_VERCEL_SHARE_URL`: temporäre Share-URL direkt auf der exakten Preview-Origin; eine generische `vercel.com/share`-URL wird im Workflow bewusst abgewiesen.

Das Base64-Bundle und die Share-URL existieren ausschließlich als action-time Secret-Umgebungswerte des vertrauenswürdigen Node-Harness. Das Bundle wird nur im Speicher kanonisch decodiert und strikt gegen die vollständige Key-Allowlist geparst; es wird weder im Workspace noch unter `RUNNER_TEMP`, in `GITHUB_ENV`, in Outputs oder in irgendeiner temporären Datei materialisiert. Server-only DB-/Auth-Secrets und beide Action-Secrets werden keinem Child-Prozess mitgegeben. Die drei Child-Läufe erhalten jeweils nur die explizit benötigten Runner-Werte; die Share-URL wird Preflight/Execute ausschließlich über stdin übergeben.

Nach `validate`, Protected-Preflight und Protected-Execute akzeptiert der Runner genau vier geheimnisfreie Quell-Evidenzdateien: Preflight-/Execute-JSON und deren SHA-256-Sidecars. Aus dem validierten Execute-Dokument erzeugt er zusätzlich die kanonische, erneut auf secret-förmige Schlüssel geprüfte und noch referenzfreie Datei `two-tenant-parent-base.json`. Quelle und außerhalb des Workspace liegendes Staging-Ziel müssen normale, nicht verlinkte Einzeldateien mit genau einem Hardlink sein; Größe, Inode/Device und Digest werden fail-closed geprüft. Allowlist, deterministisches Tar, Manifest und Upload umfassen exakt diese fünf Dateien. Der finale Verifier entfernt ausschließlich `protectedWorkflowArtifactManifest` und `protectedWorkflowReceipt` aus dem finalen Two-Tenant-Dokument, kanonisiert den verbleibenden Parent und verlangt exakt dessen Digest und Bytegröße im attestierten Manifest. Damit können nachträgliche Änderungen an Results, Requests, Cleanup oder Runtime nicht unter einem gültigen Provenance-Anhang passieren; eine Selbstreferenz entsteht nicht. Das Staging wird anschließend in `if: always()` gelöscht. Die Execute-Evidenz enthält außerdem einen `workflowTrust`-Receipt mit Candidate-SHA, Trusted-Harness-SHA, Workflow-Ref und Workflow-SHA; ohne exakte Übereinstimmung mit `runtime.trustedHarnessSha` darf die finale Release-Attestierung keinen PASS ausstellen.

Der Workflow provisioniert, deployt, promoted oder verändert Production nicht und wird durch diese Dokumentation nicht automatisch ausgelöst.

### Automatische, read-only CI-/Security-Gates

`.github/workflows/quality-gates.yml` stellt für jeden Pull Request und Push die nichtmutierenden Qualitätsprüfungen wieder her. Die Jobs besitzen standardmäßig nur `contents: read`, verwenden ausschließlich immutable Commit-Pins für Actions, lesen die exakte Node-Version aus `.node-version`, verlangen die im `packageManager` fixierte npm-Version sowie Lockfile-Version 3 und installieren mit `npm ci`. Lint, Typecheck, Unit-/Contract-Tests, Integrationstests und Production-Build laufen als getrennte sichtbare Matrix-Gates ohne Preview-/Production-Secrets.

Security wird nicht aus einem generischen Quality-PASS abgeleitet: ein eigener Production-SCA-Job führt `npm audit --omit=dev --audit-level=moderate` aus; die vollständige Lockfile-Lizenzinventur blockiert unbekannte, fehlende oder nicht explizit erlaubte Lizenzangaben; der Pull-Request-Delta-Gate verwendet die immutable gepinnte Dependency-Review-Action; und ein separater immutable gepinnter CodeQL-Job führt JavaScript-/TypeScript-SAST mit `security-extended` und `security-and-quality` aus. Ein eigener Job erzeugt ein begrenztes CycloneDX-SBOM, prüft die einzelne reguläre Datei und lädt nur diese Datei hoch. Die technische Lizenz-Allowlist ist eine Driftbarriere, **keine** juristische Produktfreigabe.

Diese lokalen Workflow-Verträge belegen nur die fail-closed Konfiguration. Bis GitHub die Jobs auf dem exakten Commit tatsächlich ausgeführt hat und die unveränderlichen Run-URLs/Receipts in der Release-Attestierung referenziert sind, bleiben CI, CodeQL, Dependency Review, SCA, Lizenzprüfung, Build und SBOM operativ `NOT_RUN`; sie dürfen nicht still als PASS gewertet werden. Wenn Repository-/GitHub-Advanced-Security-Funktionen fehlen, muss der entsprechende Job rot/blockiert bleiben oder durch einen gleichwertigen signierten Beleg ersetzt werden.

### PostgreSQL-Barriere-Gate für die Batch-Lockreihenfolge

Der wiederverwendbare Drill `scripts/qa-batch-lock-order-live.mjs` belegt mit zwei echten `novalure_app`-Sessions die Reset-/Mutation-Reihenfolge und die QA-Flag-Race-Grenze, ohne Geschäfts- oder Ledgerdaten dauerhaft zu verändern:

1. Mutation-first hält `Batch-Advisory → Workspace FOR SHARE`; Reset-second muss am identischen Batch-Advisory warten und erwirbt danach `Workspace FOR UPDATE`.
2. Reset-first hält `Batch-Advisory → Workspace FOR UPDATE`; Mutation-second muss am identischen Batch-Advisory warten und erwirbt danach `Workspace FOR SHARE`.
3. Mutation-first blockiert ein paralleles `UPDATE workspaces SET is_qa=false`; QA-Flag-first blockiert spiegelbildlich die Mutation. Das Flag-Update läuft ausschließlich in einer Transaktion, wird in jedem Pfad zurückgerollt und darf nie Production adressieren.

Der Standardaufruf ist offline. Validation und Execute verlangen die exakten UUIDs eines existierenden `is_qa`-Workspace, seines Batches und einer aktiven Workspace-Mitgliedschaft:

```powershell
npm.cmd run qa:batch-lock-order:plan
npm.cmd run qa:batch-lock-order:validate -- --workspace-id <qa-workspace-uuid> --batch-id <qa-batch-uuid> --actor-id <qa-actor-uuid>
$env:NOVALURE_QA_LOCK_ORDER_CONFIRM = "RUN_QA_LOCK_AND_ROLLBACK_DRILL"
npm.cmd run qa:batch-lock-order:execute -- --workspace-id <qa-workspace-uuid> --batch-id <qa-batch-uuid> --actor-id <qa-actor-uuid>
```

Vor dem Verbindungsaufbau müssen `VERCEL_ENV=preview`, die QA-/Production-Origin-Deny-Grenze, getrennte gepoolte QA-/Production-Neon-Hosts, Project-/Branch-/Datenbank-Fingerprint, exakt `NOVALURE_QA_DATABASE_ROLE=novalure_app`, mindestens zwei disjunkte QA-Workspace-IDs und die vollständige Production-Workspace-Denylist gesetzt sein. Das Script akzeptiert ausschließlich `BEGIN`, feste `SET LOCAL`-Timeouts/Kontextwerte, `SELECT`-/Lock-Statements, genau das feste QA-Flag-Update und `ROLLBACK`. Beide Sessions werden immer zurückgerollt; es gibt kein Insert, Delete, Seal, Geschäftsobjekt- oder Ledgerwrite.

Die Batchzeile ist per Trigger append-only und die App-Rolle besitzt absichtlich kein UPDATE-Recht. Deshalb wird sie nicht mit einem PostgreSQL-Row-Lock belegt; ein solcher `FOR SHARE` würde selbst ein UPDATE-Recht verlangen. Der exklusive Transaction-Advisory-Lock serialisiert weiterhin alle Operationen desselben Batches, während der Workspace-Row-Lock die mutable `is_qa`-Grenze schützt.

Die stdout-Evidenz `novalure.qa.batch-lock-order-evidence.v1` enthält nur SHA-256-Fingerprints, vier Barrierenergebnisse, Sessionanzahl, Laufzeiten und `writes: 0` (dauerhafte Writes). Datenbank-URL, Host, UUIDs, Credentials und rohe Rows werden nicht ausgegeben. Der echte Lauf gegen isolierte Preview-Main bestand am 23.08.2026 mit 4/4 Barrieren, zwei getrennten gepinnten Sessions und bestätigten Rollbacks. Ein separater Owner-read-only-Postcheck bestätigte QA-Flag und Batch sowie null Objekt-, Audit- und Markerreste.

## Beweisformat

Der Harness legt ausschließlich lokale, geheimnisfreie Artefakte unter `NOVALURE_QA_EVIDENCE_DIR` oder `artifacts/qa/<run-prefix>` an:

- `preflight-two-tenant-e2e.json` beziehungsweise `execute-two-tenant-e2e.json`: Schema `novalure.qa.two-tenant-e2e.v1`, Kandidaten-SHA, gehashte Ziel-IDs, Requestpfad/Status/Dauer, Szenario-Ergebnis, Reset-Plandigest, Counts und Null-Rückstand.
- gleichnamige `.sha256`: SHA-256 der kanonisch sortierten JSON-Datei.

Nicht gespeichert werden Passwörter, TOTP-Secrets, Cookies, CSRF-Tokens, Authorization-Header, Datenbank-URL, rohe Antwortkörper oder E-Mail-Adressen. Der Writer verweigert secret-ähnliche Schlüssel und überschreibt keine vorhandene Evidenz.

### Bisherige Runtime-Evidenz

Die zwei historischen Execute-Läufe auf `dpl_5ZgXwxJqZyUUhyE95QPZBVYHUhjk` / `b8c72e3745c42aaceab0ee013cfe5bef117e47a3` stoppten beim ersten Kontakt-POST mit 503. Deren Root Cause war ein Semikolon in einem SQL-Kommentar der QA-Batch-Verfügbarkeitsabfrage, das der Tenant-Single-Statement-Guard als zweite Anweisung behandelte. Der Kommentarfix wurde anschließend in Commit `92e38911fb9021a3b07d08b2cb4d232774a4986a` deployt.

Auf dem exakt autorisierten Preview-Deployment `dpl_4KTHCFXUiHjpSPTgtfNGGZV27ZW9` mit derselben Source-SHA `92e38911fb9021a3b07d08b2cb4d232774a4986a` bestand der Preflight mit 94/94 Ergebnissen und 50 Requests. Belegt sind beide QA-Tenant-Ziele, App-Rolle/RLS/Ledger-Projektion, 11/11 Migrationschecksummen, 19/19 validierte Tenant-Constraints ohne Anti-Join-Verstoß, zehn authentifizierte Rollen-/Reset-Sessions, acht korrekt verweigerte Cross-Tenant-Core-Reads, zwei anonyme 401-Grenzen, zwei öffentliche 200-Seiten ohne fremde Workspace-ID und zehn Logout-Antworten mit Status 303. Die Requestliste enthält keine CRM-Mutationsroute. Evidenz: `artifacts/qa/preview-92e3891-preflight-20260823/preflight-two-tenant-e2e.json`; kanonischer SHA-256: `e84e56a971fd46f7cc153d0e48e036d6b65124572d086afd7e11c9cba4e6b9cd`.

Der anschließende Full-Execute verwendete zwei frische append-only Batches und kam nach dem Kommentarfix erstmals durch alle drei positiven Kontakt-Creates: Owner, Admin und Member erhielten jeweils HTTP 200; die 401-/403-Negativgrenzen blieben korrekt. Der Verification-Stop-Contract stoppte danach beim ersten Owner-`PATCH /api/crm/contacts`: erwartet 200, tatsächlich 409. Bis zu diesem Boundary waren 113 Ergebnisse bestanden, zwei Ergebnisse einschließlich Stop-Bedingung fehlgeschlagen und 75 Requests ausgeführt. Evidenz: `artifacts/qa/preview-92e3891-execute-20260823/execute-two-tenant-e2e.json`; kanonischer SHA-256: `33d413abad603f98e56cc0ed05106db77bd96d7598a0b807cf6a955af152d7bb`. Deployment-spezifische Vercel-Runtime-Logs bestätigen genau einen `PATCH /api/crm/contacts` mit 409; für diese Route wurde kein gruppierter Runtime-Error-Cluster gefunden.

Der `finally`-Cleanup lief für beide Tenants. Im schreibenden Tenant stimmten Dry-run-Ziel und Execute-Löschung exakt mit drei Kontakten plus drei Consent-Zeilen überein; der zweite Tenant war leer. Unabhängige Owner-Postconditions bestätigten in beiden Tenants null live verbliebene Kontakte, Consents, Deals und Stage-History. Die sechs Batch-Ledgerzeilen sowie Dry-run-/Execute-Audits bleiben erwartungsgemäß append-only erhalten; beide Batches sind versiegelt und dürfen nicht wiederverwendet werden. Die Evidence-Artefakte und Sidecars wurden zusätzlich auf DB-URL, Zugangstoken, Passwort, TOTP, Cookie und Providersecret geprüft; kein Geheimwert wurde gefunden.

Die reale Repository-Reproduktion zeigte keinen konkurrierenden Writer. `@neondatabase/serverless` lieferte `timestamptz` über den HTTP-Transport als JavaScript-`Date` mit Millisekunden, während PostgreSQL im CAS-Token zusätzliche Mikrosekunden enthielt. Dadurch war die strikte Gleichheit nach einem Roundtrip falsch. Der lokale Fix liest interne `updated_at`-Tokens für Contact/Archiv, Deal, Lead und Task als PostgreSQL-Text und behält in allen Updates die exakte `updated_at = $n::timestamptz`-Gleichheit ohne Toleranz oder `date_trunc` bei. Zusätzlich wurde der fehlerhafte Task-Parameter `$26` auf `$12` korrigiert und ein Task-CAS-Miss explizit als 409-Konflikt klassifiziert.

Eine neue reale Probe als `novalure_app` persistierte nach dem Fix einen Kontakt plus Consent, aktualisierte denselben Kontakt erfolgreich und ließ beide Zeilen durch den echten Reset exakt löschen; der Live-Rückstand ist null. Lokal sind 499/499 Unit-Tests (241 Basis + 258 Remediation), Integration 15/15, Lint, Typecheck, Security Audit mit 0 bekannten Vulnerabilities und der Next-Production-Build grün. Der unabhängige statische Diff-Review weist 0 P0/0 P1 aus; dies ist kein finaler Runtimebefund. Diese lokale und direkte Repository-Evidenz ersetzt weiterhin keinen bestandenen deployten HTTP-Full-E2E.

Der bestehende PostgreSQL-Barrierenbeleg bleibt 4/4 grün: `artifacts/qa/preview-lock-barrier-pending-sha-20260823/lock-order-evidence.json`, SHA-256 `81af6d6e2ae8580d41e920bc71330265a85b750b17a18c19f7247f6dd3299666`; Postcondition SHA-256 `a61e3013db0d2328cc0e03ef518b8f3f652f3fbc390eeb0177219a145f54cca5`. Erforderlich bleiben ein neues SHA-identisches Preview des CAS-Fix-Commits, eine neue deployment-spezifische Zugangsgenehmigung, frische Batches, erneut 94/94 Preflight und der vollständige grüne HTTP-Execute einschließlich Capability, CRUD/RBAC/IDOR, Dry-run-/Execute-Digestabgleich und Null-Rest-Cleanup. Post-Logout-Invalidierung sowie die vollständige MFA-/Ablauf-/Rate-Limit-Matrix sind ebenfalls nicht belegt.

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

Reale QA-Wurzeln, MFA-Fixtures, Migrationen und der atomare Runtime-Vertrag sind vorhanden. Der SHA-identische Preflight auf `92e3891` bestand 94/94 Ergebnisse und 50 Requests; der direkte PostgreSQL-Barrieredrill bestand 4/4 mit Null-Rückstand. Der Full-Execute belegte erfolgreiche Kontakt-Creates und korrekte negative RBAC-Grenzen, stoppte aber beim ersten Kontakt-PATCH mit 409. Cleanup und unabhängige Postconditions bestätigten exakte Löschcounts und null Live-Rückstand. Der Mikrosekunden-CAS-Root-Cause ist lokal für Contact/Archiv, Deal, Lead und Task behoben und durch Regression sowie reale Create→Update→Reset-Probe bestätigt. Offen bleiben das neue SHA-identische CAS-Fix-Preview, dessen erneut deployment-spezifisch freizugebender Zugang, frische Batches, der wiederholte Preflight und der vollständig grüne HTTP-Matrix-/Cleanup-Lauf; Post-Logout-Invalidierung und die vollständige Challenge-Matrix sind ebenfalls nicht bewiesen. Das Gesamtgate bleibt rot.
