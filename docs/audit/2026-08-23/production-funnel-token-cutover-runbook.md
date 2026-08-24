# Authoritativer Production-Funnel-Publish-Token-Cutover

Stand: 24.08.2026

## Zweck und harte Grenze

Dieser Gate ist der einmalige, autoritative Cutover aller bereits in Production vorhandenen Funnel-Publish-Capabilities. Er ist **nicht** der disposable QA-Token-Rotationstest aus `public-form-funnel.json`. Ein PASS aus Preview oder ein nach dem Test gelöschter QA-Funnel erfüllt diesen Gate niemals.

Dieses Runbook führt im aktuellen Repository keine Rotation aus. Der spätere Production-Schritt darf erst in einem freigegebenen Change Window durch eine dazu autorisierte Person beziehungsweise einen getrennten Runner erfolgen. Token, URLs mit Token-Queryparametern, Proof-Signaturen, Cookies, Authorization-Header und Datenbank-Zugangsdaten dürfen weder in Git noch in Evidence, Sidecars, CLI-Argumenten, CI-Logs oder Tickets gelangen.

Vertragsdateien:

- Schema: `production-funnel-token-cutover.schema.json`
- unsigned Vorlage: `production-funnel-token-cutover.template.json`
- Runtime-Prüfer: `scripts/lib/production-funnel-token-cutover-receipt.mjs`
- read-only CLI: `scripts/verify-production-funnel-token-cutover.mjs`
- finaler Gate: `production-funnel-token-cutover.json` im unveränderlichen Final-Evidence-Run

## Unveränderliche Zielbindung

Der Nachweis bindet gleichzeitig:

- den 40-stelligen Candidate-Commit,
- `launchScopePolicyVersion`, den Policy-SHA-256 und den Decision-SHA-256 aus `src/lib/launch-scope.ts`,
- Vercel-Projekt `prj_R32Okl6AHijTohvuKmryuTLjWMsk`, die konkrete Production-Deployment-ID und deren immutable `.vercel.app`-Host,
- den kanonischen Host `www.novalure-crm.app`,
- Neon-Projekt `misty-cloud-70835427`, Production-Branch `br-snowy-fog-aldx77v8` und Datenbank `neondb`.

Ein Receipt für einen anderen Commit, eine andere Policy, ein anderes Deployment, eine andere Datenbank oder einen anderen Host wird fail-closed abgelehnt. Preview-Runtimefelder können nicht anstelle des Production-Targets verwendet werden.

## Externe Vertrauenskette

Der finale Nachweis benötigt immer genau ein detached Ed25519-Receipt mit:

- Rolle `production-funnel-token-cutover-attestor`,
- Record Type `NOVALURE_PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT`,
- einem aktiven, nur dieser Rolle zugeordneten Key im externen Release-Trust-Anchor,
- einem Trust-Anchor, der außerhalb des Repositories liegt und über einen separat übergebenen SHA-256 gepinnt ist.

Der Attestor muss unabhängig vom disposable QA-Runner sein und das vollständige Production-Inventar sowie alle Postconditions prüfen. Das Receipt wird erst **nach** Abschluss aller Beobachtungen signiert. Es signiert den Hash des gesamten Evidence-Dokuments ohne Receipt, den Inventarhash, Count, Modus, Candidate, Policy und Production-Target.

## Phase 0 – Change-Voraussetzungen

Vor einer echten Rotation müssen mindestens folgende Bedingungen außerhalb dieses Gates erfüllt und dokumentiert sein:

1. SHA-identische Production-Promotion und eindeutige Deployment-ID sind bestätigt.
2. Production-Backup/PITR und das freigegebene Rollbackverfahren sind verfügbar.
3. Launch-Policy, Legal/Product und Production-Change sind signiert.
4. Monitoring, Alarmierung und Incident-Verantwortliche sind im Change Window aktiv.
5. Es gibt einen geschützten, flüchtigen Ausführungskontext ohne Shell-History, Debug-Logging oder Artifact-Upload für Capability- und Proof-Material.

Fehlt eine Voraussetzung, bleibt der Gate `NOT_RUN` oder `BLOCKED`; es darf kein PASS-Dokument konstruiert werden.

## Phase 1 – Autoritatives Inventar

1. Führe im read-only Production-Kontext exakt den Query-Vertrag `productionFunnelTokenCutoverInventoryQuery` aus. Sein erwarteter Hash ist `productionFunnelTokenCutoverInventoryQuerySha256` aus dem Runtime-Prüfer.
2. Der Query umfasst jede Funnel-Zeile, die eine nichtleere `tracking.publishToken`- oder Legacy-`tracking.publicToken`-Capability enthält, unabhängig davon, ob der Funnel aktuell aktiv ist. Dadurch kann eine alte Capability nicht durch vorübergehendes Deaktivieren aus dem Cutover fallen.
3. Der Query gibt nur Workspace-ID, Funnel-ID, Revision und den serverseitigen SHA-256 der Capability aus. Er gibt niemals die Capability selbst aus.
4. Sortiere exakt nach `workspaceId`, danach `funnelId`. Berechne `sourceArtifactSha256`, Count und `entriesSha256`. Der finale JSON-Count muss exakt der Zeilenzahl und der Länge von `entries` entsprechen.

Es gibt nur zwei zulässige Ergebnisse:

- `ROTATED`: Count ist größer null und jeder Eintrag wird genau einmal verarbeitet.
- `AUTHORITATIVE_EMPTY`: Count ist exakt null, `entries` ist leer und der externe Attestor signiert ausdrücklich `AUTHORITATIVE_EMPTY_VERIFIED` mit Reason `NO_PREEXISTING_PUBLISHED_FUNNEL_CAPABILITIES`.

Ein bloß leeres Array, ein fehlgeschlagener Query, ein unklarer Tenant-Scope oder ein nicht signierter EMPTY-Vermerk ist kein PASS.

## Phase 2 – Kontrollierter Cutover je Inventareintrag

Der Runner verarbeitet die eingefrorene, sortierte Liste sequenziell oder mit einer nachweisbar konfliktfreien Begrenzung. Für jeden Funnel:

1. Lies Revision und nicht-capabilitybezogenen Funnel-Zustand erneut. Bei Abweichung zum eingefrorenen Inventar abbrechen und ein neues Gesamtinventar erstellen.
2. Erzeuge vor der Rotation einen gültigen Proof über die alte Publication-Revision. Halte Capability und Proof nur flüchtig im Speicher; Evidence enthält ausschließlich ihre SHA-256-Digests.
3. Rotiere über den authentifizierten Production-Endpunkt mit exakt `expectedRevision = revisionBefore` und einem einmaligen Idempotency-Key. Direkte, ungeschützte SQL-Updates sind nicht zulässig.
4. Verlange `revisionAfter = revisionBefore + 1` und eine kryptographisch andere Replacement-Capability. Keine Replacement-Capability darf einer anderen alten oder neuen Capability im Inventar entsprechen.
5. Prüfe die neue öffentliche URL: exakt HTTP 200 und Outcome `PASS`.
6. Erzeuge beziehungsweise validiere einen Proof für die neue Revision: exakt HTTP 200 und Outcome `PASS`.
7. Prüfe die alte öffentliche URL: exakt HTTP 404 und Outcome `NOT_FOUND`. HTTP 200, Redirect, 403, 410 oder ein Netzwerkfehler sind kein PASS.
8. Sende den vor der Rotation erzeugten Proof an den Proof-Refresh-Vertrag: exakt HTTP 409, Outcome `REJECTED`, Code `funnel_publication_stale`.
9. Vergleiche den kanonischen nicht-capabilitybezogenen Zustand vor und nach der Rotation. Beide SHA-256-Digests müssen identisch sein. Blueprint-, Status-, Workspace- oder Inhaltsdrift blockiert den Gate.
10. Speichere nur Zeitpunkte, IDs, Revisionen, Status/Outcome und SHA-256-Digests im Evidence-Eintrag.

Wenn irgendein Eintrag fehlschlägt, ist das Gesamtinventar nicht PASS. Ein erneuter Versuch rotiert niemals zurück auf die alte Capability; er erstellt nach Ursachenbehebung eine weitere neue Capability und friert danach ein neues, vollständiges Inventar ein.

## Phase 3 – Receipt und Freeze

1. Setze `completedAt` erst nach der letzten Postcondition.
2. Stelle sicher, dass alle `checkedAt`-Zeitpunkte nach dem jeweiligen `rotatedAt` und spätestens bei `completedAt` liegen.
3. Erzeuge das externe Ed25519-Receipt. `signedAt` muss gleich oder später als `completedAt` sein.
4. Scanne Evidence rekursiv. Es darf keine unbekannten Felder, URLs, Tokens, Proof-Rohwerte, Cookies, Header oder Zugangsdaten enthalten.
5. Schreibe `production-funnel-token-cutover.json` und dessen SHA-256-Sidecar atomar in den exklusiven Final-Evidence-Run. Danach darf der Run nicht mehr überschrieben werden.

## Read-only Verifikation

Der folgende Prüfer macht keine Netzwerk-, Vercel- oder Datenbankaufrufe und verändert keine Production-Ressource:

```powershell
node scripts/verify-production-funnel-token-cutover.mjs `
  --evidence C:\ABSOLUTER\PFAD\production-funnel-token-cutover.json `
  --candidate <40-STELLIGER-CANDIDATE-SHA> `
  --expected-vercel-deployment-id <DPL_ID> `
  --expected-vercel-deployment-host <IMMUTABLE_DEPLOYMENT_HOST.vercel.app> `
  --trust-anchor C:\EXTERN\release-trust-anchor.json `
  --trust-anchor-sha256 <64-STELLIGER-SHA256>
```

Alle Argumente sind Pflichtfelder. Der Trust-Anchor muss eine bounded regular file außerhalb des Repositories sein. Der Evidence-Reader lehnt Symlinks, Hardlinks, Größenüberschreitungen und Identitätsänderungen während des Lesens ab. Die Ausgabe enthält nur die sichere Zusammenfassung aus Candidate, Modus, Count, Inventarhash und Production-Target.

## Finaler GO-Vertrag

Der Final-Attestation-Gate `production-funnel-token-cutover` wird nur `PASS`, wenn der Runtime-Prüfer das vollständige Dokument und die externe Signatur akzeptiert. `PENDING`, fehlendes Receipt, disposable QA-Evidence, nicht autoritatives EMPTY, Count null im ROTATED-Modus, Target-/Policy-/Candidate-Drift oder eine einzige unvollständige Postcondition bleiben fail-closed.

Ein technischer PASS dieses Gates allein ist keine Freigabe für Production. Der Gesamt-GO benötigt weiterhin alle anderen erforderlichen Gates und Release-Signaturen.
