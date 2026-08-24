# Production-Launch-Aktivierungsvertrag

Stand: 24.08.2026

Status: **technisch fail-closed implementiert, aber nicht aktiviert; kein Receipt und kein Trust Anchor werden im Repository behauptet**

## Zweck und Sicherheitsgrenze

Die eingecheckte Launch-Scope-Policy bleibt wahrheitsgemäß `PENDING_SIGNATURE`. Der Code kann keine Product-, Engineering-, Security- oder Operations-Freigabe erfinden. Production öffnet eine `LAUNCH-ON`- oder `INTERNAL-ONLY`-Surface nur, wenn derselbe Runtime-Prozess gleichzeitig einen frischen Production-Flag-Read, eine gültige kurzlebige Launch-Aktivierung, ein dreifach signiertes aktuelles Production-Cutover-Bundle und eine außerhalb der Vercel-Control-Plane verankerte Vertrauenskette nachweist. Jeder Fehler fällt auf `OFF`/`INVALID` und damit `LAUNCH_SCOPE_UNSIGNED` zurück.

`LAUNCH-OFF` bleibt unabhängig von jeder Signatur immer aus. `INTERNAL-ONLY` behält die im Code festgelegten Rollen und Permissions. Unbekannte Surfaces, Browserausführung, Self-Hosting mit `NODE_ENV=production`, eine ambige Vercel-Runtime sowie fehlende, partielle oder abweichende Bindungen bleiben geschlossen.

## Signierte Aktivierung und kurze Lease

Das detached Ed25519-Receipt der externen Rolle `launch-activation-attestor` trägt `recordType=NOVALURE_LAUNCH_ACTIVATION_RECEIPT` und bindet exakt:

- `GO`, Candidate-Commit, Evidence-Deployment-ID und -Host;
- aktive Production-Deployment-ID, unveränderlichen Deployment-Host, Vercel-Projekt-ID und Production-Host;
- Policy-Version `2026-08-22.12`, vollständigen Policy-Digest und ausführbaren Decision-/Rollen-/Permission-Digest;
- Release-Gate-Matrix-, Final-Attestation- und Document-Bundle-Digest;
- Cutover-Evidence-Digest sowie die drei Receipt-Digests von DBA, Platform Operations und Release Observer;
- `activationGeneration` (aktuell code-gepinnte Mindestgeneration `2`), `activationNotBefore`, `activationExpiresAt`;
- das exakt im Code gepinnte Flags-Environment `production` und einen `flagsRevisionFloor`.

Die Aktivierungs-Lease ist höchstens 30 Minuten lang. Offline-Verifier und Runtime verlangen `activationNotBefore <= now < activationExpiresAt`; abgelaufene und zukünftige Aktivierungen werden nicht als `VERIFIED` ausgegeben. Das Launch-Receipt darf höchstens 15 Minuten vor `activationNotBefore` signiert sein. Der vollständige Production-Cutover-Lauf von `startedAt` bis `completedAt` sowie seine drei Receipts müssen bei Aktivierung innerhalb des 30-Minuten-Readiness-Fensters liegen und dürfen maximal 60 Sekunden zukunftsdatiert sein. Zeitstempel sind ausschließlich reale, kanonische UTC-Werte mit Millisekunden.

Ein alter GO-Umschlag ist damit an dasselbe Deployment, dieselbe Signaturgeneration und ein kurzes Zeitfenster gebunden. Es gibt in Vercel Flags keinen unabhängigen, persistenten Monotonic-Revocation-Store. `OFF` ist deshalb innerhalb der noch gültigen Lease ein reversibler Control-Plane-Toggle und kein dauerhafter Tombstone: Ein Flags-Schreibberechtigter könnte denselben noch gültigen Umschlag erneut setzen. Dauerhafter Widerruf verlangt `OFF`, das Sperren aller alten immutable Deployment-Hosts und einen neuen Candidate mit angehobener code-gepinnter Mindestgeneration. Ohne diesen Incident-Schritt bleibt das als explizite P2-Betriebsgrenze offen und darf nicht als sofortige permanente Revocation bezeichnet werden.

## Unabhängige Vertrauenswurzel

Für die Offline-Prüfung ist der Trust Anchor eine größenbegrenzte, kanonische, reguläre Datei außerhalb des Repositorys; sein erwarteter SHA-256 kommt über einen getrennten Freigabekanal. Er enthält getrennte aktive Ed25519-Keys für:

- Launch Activation Attestor;
- Production Cutover DBA;
- Production Cutover Platform Operations;
- Production Cutover Release Observer.

Für den Launch Activation Attestor und die drei Cutover-Rollen müssen sowohl `signerSubject` als auch der SHA-256 des kanonischen SPKI-DER-Public-Keys über alle vier Rollen eindeutig sein. Zusätzlich darf der code-gepinnte Root-Public-Key keinem dieser Rollenkeys entsprechen. Verschiedene Key-IDs oder Rollen um denselben Schlüssel beziehungsweise dieselbe Signer-Identität zählen nicht als unabhängige Freigaben.

Die Runtime übernimmt Anchor und erwarteten Digest nicht gemeinsam aus gewöhnlichen Vercel-Variablen. Stattdessen verifiziert sie `NOVALURE_LAUNCH_ACTIVATION_TRUST_BUNDLE_BASE64URL`: ein kanonisches Bundle aus Anchor, Anchor-Digest und monotoner Anchor-Generation, detached signiert durch einen Security-Owner-Root-Key. Nur dessen öffentlicher Ed25519-Key und Mindestgeneration werden im Candidate in `src/lib/launch-activation-root-trust.server.ts` gepinnt. Der private Root-Key gehört weder ins Repository noch zu Vercel.

Der Root-Pin steht derzeit bewusst auf `PENDING_SECURITY_OWNER_KEY` und enthält keinen Schlüssel. Damit kann der aktuelle Candidate keine Production-Aktivierung akzeptieren. Tests erzeugen ausschließlich kurzlebige Testschlüssel im Testprozess und prüfen Root-Substitution, Anchor-Tamper, widerrufene Generationen und nicht kanonischen Transport.

## Request-freier Vercel-Flags-Kanal

Der einzige Flag-Key ist `novalure-production-launch-activation`; sein Code-Default ist exakt `OFF`. Projekt und Environment sind unabhängig im Code auf `prj_R32Okl6AHijTohvuKmryuTLjWMsk` und `production` gepinnt.

`src/instrumentation.ts` startet den Kanal nur in der Node-Production-Runtime. Alle zehn Sekunden entsteht ein neuer `@vercel/flags-core`-Client. Er verwendet weder `flags/next`, Request-Header/Cookies, Streaming, Polling noch einen wiederverwendeten SDK-Cache. Genau ein `no-store`-Read von `/v1/datafile` wird nach zwei Sekunden abgebrochen; ausschließlich die Metrics-Kombination `source=remote`, `cacheStatus=MISS`, `mode=offline`, `connectionState=disconnected` ist zulässig. Eingebettete, gecachte, gestreamte, gepollte oder stale Daten dürfen die Aktivierung nicht erneuern. Der neue Client wird nach der reinen Evaluation sofort verworfen.

Ein erfolgreicher Snapshot lebt höchstens 30 Sekunden und muss sowohl nach monotoner Prozesszeit als auch nach Epoch-Zeit frisch sein; mehr als eine Sekunde Zukunftsdrift wird abgelehnt. Ein fehlgeschlagener Folge-Read veröffentlicht sofort `INVALID`; selbst ein hängender Read endet vor Ablauf des vorherigen Snapshots. Der Vercel-Read beweist eine frische HTTP-Beobachtung, nicht eine mathematisch linearisierbare Control-Plane. Revision, `configUpdatedAt`, Projekt-/Environment-Pins und die kurze Lease bilden deshalb gemeinsam den akzeptierten Fail-closed-Vertrag.

Vor dem Build benötigt das Production-Deployment nur:

- das von Vercel Flags verwaltete `FLAGS`-SDK-Secret;
- `NOVALURE_LAUNCH_ACTIVATION_TRUST_BUNDLE_BASE64URL` mit dem öffentlichen, Root-signierten Trust Bundle.

`FLAGS_SECRET`, ein roher Anchor und dessen Digest sind keine Runtime-Eingaben dieses Vertrags. Private Signaturschlüssel, Provider-Tokens und QA-Zugangsdaten dürfen weder im Flag-Umschlag noch im Trust Bundle stehen.

## Verifizierte Runtime-Bindung

Nach vollständiger Kryptoprüfung erzeugt der Verifier folgende Diagnosebindung. Sie befindet sich im signierten Flag-Umschlag und wird nicht nachträglich als Deployment-Environment installiert:

- `NOVALURE_LAUNCH_ACTIVATION_EXPIRES_AT`
- `NOVALURE_LAUNCH_ACTIVATION_GENERATION`
- `NOVALURE_LAUNCH_ACTIVATION_NOT_BEFORE`
- `NOVALURE_LAUNCH_ACTIVATION_CANDIDATE_COMMIT`
- `NOVALURE_LAUNCH_ACTIVATION_CONTRACT`
- `NOVALURE_LAUNCH_ACTIVATION_DECISION`
- `NOVALURE_LAUNCH_ACTIVATION_DECISION_SHA256`
- `NOVALURE_LAUNCH_ACTIVATION_EVIDENCE_DEPLOYMENT_HOST`
- `NOVALURE_LAUNCH_ACTIVATION_EVIDENCE_DEPLOYMENT_ID`
- `NOVALURE_LAUNCH_ACTIVATION_DOCUMENT_BUNDLE_SHA256`
- `NOVALURE_LAUNCH_ACTIVATION_FINAL_ATTESTATION_SHA256`
- `NOVALURE_LAUNCH_ACTIVATION_FLAGS_ENVIRONMENT`
- `NOVALURE_LAUNCH_ACTIVATION_FLAGS_REVISION_FLOOR`
- `NOVALURE_LAUNCH_ACTIVATION_POLICY_SHA256`
- `NOVALURE_LAUNCH_ACTIVATION_POLICY_VERSION`
- `NOVALURE_LAUNCH_ACTIVATION_PRODUCTION_DEPLOYMENT_HOST`
- `NOVALURE_LAUNCH_ACTIVATION_PRODUCTION_DEPLOYMENT_ID`
- `NOVALURE_LAUNCH_ACTIVATION_PRODUCTION_HOST`
- `NOVALURE_LAUNCH_ACTIVATION_PROJECT_ID`
- `NOVALURE_LAUNCH_ACTIVATION_RECEIPT_SHA256`
- `NOVALURE_LAUNCH_ACTIVATION_RELEASE_GATE_MATRIX_SHA256`
- `NOVALURE_LAUNCH_ACTIVATION_TRUST_ANCHOR_SHA256`

Der Runtime-Verifier vergleicht Candidate, Deployment-ID, Deployment-Host, Projekt und Production-Host zusätzlich bytegenau mit `VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_URL`, `VERCEL_PROJECT_ID` und `VERCEL_PROJECT_PRODUCTION_URL` und verlangt `VERCEL=1`, `VERCEL_ENV=production`. Ein Same-SHA-Redeploy oder auf ein anderes Target kopierter Umschlag bleibt geschlossen. Dieser Deployment-ID-Fixpunkt ist der Grund für den kontrollierten Flag-Kanal nach einem `--skip-domain`-Build.

## Offline-Prüfung und Capability-Datei

`npm run release:verify-launch-activation --` bleibt netzwerkfrei. Es verlangt alle Argumente als exakte Paare:

```text
--activation-expires-at <canonical-utc>
--activation-generation <integer-at-least-2>
--activation-not-before <canonical-utc>
--candidate <40-char-sha>
--deployment-host <verified-evidence-host>
--deployment-id <dpl_...>
--document-bundle-sha256 <sha256>
--expected-trust-anchor-sha256 <sha256>
--final-attestation-sha256 <sha256>
--flags-environment production
--flags-output <absolute-new-path-outside-repository>
--flags-revision-floor <non-negative-integer>
--production-cutover <absolute-external-production-cutover.json>
--production-deployment-host <immutable-host.vercel.app>
--production-deployment-id <dpl_...>
--production-host <host-without-scheme>
--project-id <prj_...>
--receipt <absolute-path>
--release-gate-matrix-sha256 <sha256>
--rollback-deployment-host <immutable-host.vercel.app>
--rollback-deployment-id <dpl_...>
--trust-anchor <absolute-outside-repository-path>
```

Der replay-fähige GO-Wert wird niemals nach stdout geschrieben. `--flags-output` muss auf eine noch nicht vorhandene Datei außerhalb des Repositorys zeigen; der Verifier öffnet sie exklusiv (`wx`, POSIX `0600`), prüft reguläre Datei, Linkzahl, Identität und Größe und synchronisiert den Inhalt. Wegen der nicht portabel beweisbaren privaten ACL-Vererbung läuft diese Capability-Ausgabe ausschließlich auf einem kontrollierten Linux/POSIX-Runner; unter Windows bricht der Verifier vor jedem Read oder Write fail-closed ab. stdout enthält nur Status, Digests, Größen und die nicht geheime Diagnosebindung. Die Capability-Datei ist wie ein temporäres Secret zu behandeln: nicht in CI-Logs oder Artefakte kopieren, nur über den freigegebenen Operations-Kanal in den Production-Flag übernehmen und nach Aktivierung beziehungsweise Ablauf sicher entfernen.

## Kontrollierte Reihenfolge

1. denselben Candidate mit `vercel --prod --skip-domain` staged bauen;
2. Backup/PITR, Restore, Migrationen, Blob, Smokes, Monitoring und Rollback gegen genau dieses Deployment abschließen;
3. Cutover-Bundle, Trust Bundle und Launch-Receipt durch die getrennten Rollen signieren;
4. die höchstens 30-minütige Lease unmittelbar vor Promotion verifizieren und die Capability-Datei exklusiv erzeugen;
5. Flag weiterhin auf `OFF` bestätigen, dann Alias/Promotion gemäß Cutover-Vertrag durchführen;
6. Capability-Wert ohne Logging in das exakt gepinnte Production-Flag übernehmen und Activation-Smoke ausführen;
7. bei jeder Abweichung zuerst Flag `OFF`, dann Rollback, alte Deployment-Erreichbarkeit sperren und Beobachtungsfenster fortführen.

## Noch nicht erledigt

Dieser Code erzeugt keine echte Freigabe und provisioniert keine Production-Konfiguration. Es fehlen weiterhin der reale Security-Owner-Root-Public-Key, das Root-signierte Trust Bundle, alle echten rollengetrennten Signaturen, die signierte Launch-Matrix, Legal-/Product-Freigaben, freigegebene Provider-Abnahmen sowie der tatsächliche kontrollierte Production-Cutover, Smoke und das Beobachtungsfenster. Bis diese externen Hard Gates erfüllt sind, bleibt `PENDING_SIGNATURE`, der Root-Pin bleibt inaktiv und Production bleibt unverändert.
