# Legal-, Unternehmensprofil- und Product-Freigabepaket

Stand: 23.08.2026
Status: **NO-GO – menschliche Freigaben fehlen**

Dieses Paket friert ausschließlich die technisch geprüften Quellen ein. Es ist keine Rechtsberatung und ersetzt weder Legal- noch Product-Unterschriften. Der finale Candidate-SHA, das SHA-identische Preview-Deployment und gerenderte Content-Hashes werden erst nach dem finalen Deployment in einer getrennten Release-Attestation eingetragen.

Der maschinenlesbare v2-Vertrag dafür liegt in `final-preview-release-attestation.schema.json`, die bewusst leere Hülle in `final-preview-release-attestation.template.json` und die read-only Prüfung in `scripts/final-preview-release-attestation-contract.mjs`. Die Hülle bleibt bis zum neuen SHA-identischen Preview auf `PENDING`/`NOT_RUN`, ohne Candidate, Deployment, Evidenz-Hashes, Trust-Anchor oder Signaturen. Beim Evidence-Freeze muss der Prüfer den Runtime-Candidate aus jedem gehashten Quelldokument erneut lesen; das bloße Umetikettieren alter Evidenz auf einen neuen SHA ist ungültig. Ein lokal erzeugtes JSON mit selbst erzeugter Sidecar-Datei oder eine freie URL-/URN-Referenz gilt ausdrücklich nicht als Freigabe.

## Legal-Inhalt

Das maschinenlesbare Manifest liegt in legal-content-manifest.json. Es umfasst /imprint, /privacy, /terms, /cookies, /data-deletion, /meta und /unsubscribe jeweils mit getrennten DE-/EN-Rendernachweisen. Der Legacy-Alias /datadeletion ist explizit an /data-deletion gebunden; /unsubscribe/confirm ist als eigener funktionaler POST-Vertrag inventarisiert. Die Source-Hashes werden durch scripts/legal-approval-manifest-tests.mjs gegen den Dateibaum geprüft. Render-Hashes, Legal-Owner und Freigabestatus bleiben bis zum finalen SHA-identischen Preview bewusst leer beziehungsweise PENDING.

Noch zwingend durch Legal zu bestätigen:

- Directors beziehungsweise vertretungsbefugte Personen;
- VAT-/Steuerdaten oder eine dokumentierte Nichtanwendbarkeit;
- Privacy-/DPO-Kontakt oder dokumentierte DPO-Nichtanwendbarkeit;
- PSRA-/Immobilienlizenz oder signierte Entscheidung, dass keine lizenzpflichtige Vermittlung erfolgt;
- Geschäfts- und Billing-Anschrift, soweit vom Registered Office abweichend;
- Aussagen zu Meta, KI, Tracking, Rechtsgrundlagen, Aufbewahrung und Drittanbietern;
- ein eigener Versions-/Updated-Stand für /unsubscribe;
- lokalisierte Datumsdarstellung in DE und EN;
- gerenderter Content-Hash je Route und Sprache auf dem finalen Preview.

## Unternehmensprofil

Die technische Approval-Grenze wurde gehärtet:

- Fallback und Seed gelten nicht mehr automatisch als belastbare Freigabe;
- approved/locked benötigt einen erfolgreichen Länder-Preflight, Approver und Zeitpunkt;
- freigegebene Inhalte können nicht in demselben Request entsperrt und verändert werden;
- Wechsel zu draft/needs_review löscht alte Approval-Metadaten;
- Profil, Version und Audit werden in einer Transaktion geschrieben;
- Migration 078 stuft bestehende unvollständige Scheinf­reigaben auf needs_review zurück und erzwingt Approval-Integrität.

Nachtrag 23.08.2026: Migration 078 und die additive Rollenverschärfung 079 wurden nach separater ausdrücklicher Freigabe ausschließlich auf der isolierten Preview-Main-Datenbank angewandt und checksummengebunden nachgeprüft. Migration 061, 062 und 065 sowie Production blieben unverändert. Das Preview-Unternehmensprofil wurde dabei korrekt von einer unvollständigen Scheinf­reigabe auf needs_review zurückgestuft; dies ist keine Legal-Freigabe. Die bereits angewandte Migration 075 wurde nicht nachträglich verändert. Es wurden keine fehlenden Unternehmensdaten erfunden.

## Product-Entscheidungen

Product muss die vollständige Surface-Matrix mit exakt LAUNCH-ON, LAUNCH-OFF oder INTERNAL-ONLY je Zeile signieren. Mindestens zu bestätigen:

- Kern-CRM und Rollenmodell;
- Public Forms/Funnels, Consent und Proof-Refresh;
- Provider-Reads und -Writes;
- reduzierte OFF-Flächen;
- spanische öffentliche Produktoberfläche als explizite `LAUNCH-OFF`-Surface ohne öffentliche Sprachwahl oder hreflang-Angebot;
- Unit-/Buyer-/Deal-Beziehungen;
- bekannte P2-Risiken samt Owner und Termin.

Für Unit-/Buyer-/Deal-Beziehungen bleibt ausschließlich der reduzierte Weg zulässig, bis die zehn Fachentscheidungen in docs/audit/2026-08-22/unit-buyer-deal-decision.md beantwortet sind. Die Initial-Launch-OFF-Entscheidung ist zusätzlich als `specialDecisions.unitBuyerDealRelationship` in der Gesamtmatrix abgebildet und benötigt eigene Signaturen von Product, Sales Operations, Engineering und Data/Compliance. Die API-, Cron-, Repository- und nun auch Viewing-/Offer-UI-Pfade bleiben technisch OFF.

## Signaturhülle

| Freigabe | Name | Rolle | Datum/Zeit | Candidate-SHA | Deployment | Matrix-/Content-Hash | akzeptierte OFF-/INTERNAL-Flächen | Signaturreferenz |
|---|---|---|---|---|---|---|---|---|
| Product | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Engineering | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Security | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Operations/DBA | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Legal | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | Legal-Content | _offen_ |
| Privacy | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | Privacy-Content | _offen_ |
| Sales Operations | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | Unit-/Buyer-/Deal-OFF | _offen_ |
| Data/Compliance | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | Unit-/Buyer-/Deal-OFF | _offen_ |

Leere Zeilen oder pauschale Freigaben sind ungültig. Bis alle Pflichtrollen den finalen SHA und dieselben Hashes bestätigen, bleiben launchScopePolicyApproval und die Gesamtentscheidung auf PENDING_SIGNATURE beziehungsweise NO-GO.

## Final-Attestation-v2-Runbook

Der Trust-Anchor ist ein bewusst **außerhalb des Repositorys** verwahrtes, unveränderliches JSON-Dokument. Für die Release-Entscheidung sind acht getrennte aktive Ed25519-Rollen verpflichtend: `product`, `engineering`, `security`, `operations`, `legal`, `privacy`, `sales-operations` und `data-compliance`. Der gleiche externe Envelope enthält zusätzlich die exakt benötigten Gate-Attestor-Rollen; jede Rolle besitzt eine eigene Key-ID und darf nicht durch eine andere Rolle ersetzt werden. Private Schlüssel, Signaturgeheimnisse und ein kopierter Trust-Anchor dürfen nicht in Git eingecheckt werden. Der absolute externe Pfad und sein unabhängig beziehungsweise out-of-band festgelegter SHA-256 werden ausschließlich beim Prüflauf übergeben:

- `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_PATH`: absoluter Pfad zum externen Trust-Anchor;
- `NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR_SHA256`: vorab fixierter SHA-256 des exakt gelesenen Trust-Anchors.

Vor der externen Signatur wird die vollständige Matrix referenzfrei als `READY_FOR_EXTERNAL_SIGNATURE` eingefroren. Ihre acht `signatures`-Slots und die vier `requiredSignatures` der Unit-/Buyer-/Deal-Entscheidung bleiben dabei zwingend `null`; finale, bundle-hash-haltige Signaturreferenzen dürfen niemals in die selbst gehashte Matrix zurückgeschrieben werden. So wird der Dokument-Bundle-Hash genau einmal und ohne kryptografischen Fixpunkt konstruiert. Jede echte Rollenfreigabe ist danach ein getrennt gehashtes Approval-Artifact mit `schemaVersion: 2`, `recordType: NOVALURE_EXTERNAL_RELEASE_APPROVAL`, einem Detached-Ed25519-Signaturwert und der exakt gebundenen Referenz `urn:novalure:release-approval:v2:<trustAnchorId>:<keyId>:<role>:<documentBundleSha256>`. Der Verifier bindet Key-ID, Signer-Subject, Rolle, Candidate-SHA, Deployment-ID, Entscheidung, Bundle-Hash und die fest vorgegebenen Approval-Scopes an den externen Trust-Anchor. Legal und Privacy sind getrennte Signaturen. Die Unit-/Buyer-/Deal-OFF-Entscheidung wird ausschließlich aus den signierten `UNIT_BUYER_DEAL`-Scopes von Product, Sales Operations, Engineering und Data/Compliance abgeleitet; freie Texte, eingebettete Matrix-Referenzen oder pauschale Gesamtfreigaben sind ungültig.

Alle Evidence-Freeze-Artefakte liegen pro Lauf in einem neuen, danach nicht wiederverwendeten Verzeichnis der Form `docs/audit/2026-08-23/final-evidence/runs/run-YYYYMMDDTHHMMSSZ-<12-hex>`. Evidenz, Sidecars und Approval-Receipts müssen reguläre Dateien sein; Symlinks beziehungsweise Reparse-Ziele sind unzulässig. `evidenceProvenance` bindet den Lauf an den vollständigen 40-stelligen `evidenceCommit`, `repositoryState: CLEAN_TRACKED`, die `runDirectory` und deren identische `runId`. `runtime.trustedHarnessSha` bindet zusätzlich den unabhängig geprüften QA-Harness-Stand, damit ein Candidate seine eigene Prüfsemantik nicht selbst als vertrauenswürdig erklären kann.

Die Git-Provenance ist bewusst zweiphasig, weil ein Git-Commit keine Datei enthalten kann, die seine eigene Commit-SHA direkt oder über ein signiertes Bundle enthält. Phase 1 friert alle referenzierten Evidenzdateien und Sidecars bytegenau im `evidenceCommit` ein; das Run-Verzeichnis darf in dessen Parent noch nicht existieren. Phase 2 fügt die auf diesen Commit gebundene Attestation und die kryptografischen Approval-Receipts hinzu. Diese müssen im aktuellen `HEAD` getrackt und bytegleich sein. Der Verifier verlangt, dass `evidenceCommit` ein Vorfahr dieses `HEAD` ist und dass Index, Working Tree und ungetrackte Dateien vollständig sauber sind. Er liest die eingefrorenen Vergleichsbytes per `git show <evidenceCommit>:<path>` und akzeptiert keine später ersetzte Working-Tree-Kopie.

Die leere Vorlage darf im normalen Inspect-Modus geprüft werden und bleibt dabei bewusst `PENDING`/`NO-GO`:

```text
node scripts/final-preview-release-attestation-contract.mjs
```

Die Promotion- beziehungsweise GO-Prüfung ist davon getrennt und muss fail-closed laufen:

```text
npm run release:verify-final-go -- --attestation docs/audit/2026-08-23/final-evidence/runs/<runId>/final-preview-release-attestation.json
```

Dieser Befehl darf nur für `SIGNED` plus `GO`, alle vollständig bestandenen Pflicht-Gates, gültige externe Ed25519-Receipts, den exakten Candidate-SHA sowie die exakt gebundene Preview-Deployment-ID und den Preview-Host erfolgreich enden. `PENDING`, `EVIDENCE_FROZEN`, `CONDITIONAL_GO`, ein falscher Trust-Anchor-Hash, ungetrackte oder veränderte Evidenz und jede Runtime-Abweichung bleiben NO-GO.
