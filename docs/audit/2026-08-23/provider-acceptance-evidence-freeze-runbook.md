# Provider-Acceptance-Evidence-Freeze

Stand: 23.08.2026

Der Freeze-Runner erzeugt `provider-boundaries.json` ausschließlich aus zwei
bereits vorhandenen Evidenzklassen:

1. dem unveränderten `provider-fail-closed-evidence.json` samt passender
   `.sha256`-Sidecar und einem separat übergebenen erwarteten SHA-256-Digest;
2. exakt sechs real extern signierten Provider-Acceptance-Receipts: vier durch
   den Resend-/Domain-Owner sowie je eines für Google Calendar und Microsoft
   Graph durch den Calendar-Owner;
3. einem siebten, zeitlich nach allen sechs Abnahmen signierten
   Final-Cleanup-Receipt mit DB-, QA-Batch- und Provider-Residual-Evidenz.

Der Runner führt selbst keine Provideraktion und keine Production-Mutation
aus. Er setzt den Release-Status nur dann auf `PASS`, wenn der technische
Fail-closed-Lauf weiterhin wahrheitsgemäß `BLOCKED`/`UNPROVEN` ist, dessen
HTTP- und unveränderte Datenbank-Postcondition vollständig passen und alle
sechs externen Receipts und der abschließende Nullrest-Nachweis
kryptografisch gültig sind.

## Voraussetzungen

- Die Quelldatei und ihre Sidecar sind reguläre, nicht verlinkte und begrenzte
  Dateien. Der erwartete Quelldigest kommt aus einem unabhängigen Kanal.
- Der Trust Anchor liegt außerhalb des Repositorys, ist ebenfalls über einen
  unabhängigen SHA-256-Digest gepinnt und enthält genau den aktiven Schlüssel
  für `provider-resend-domain-owner`, `provider-calendar-owner` und den davon
  getrennten `provider-final-cleanup-attestor`.
- Jedes Receipt ist an denselben Candidate-Commit, Branch, Preview-Deployment,
  Preview-Host und dieselbe isolierte Neon-Branch gebunden.
- Alle Receipt-Payloads binden den Byte- und kanonischen Inhaltsdigest des
  ursprünglichen BLOCKED-Collectors, dessen Abschlusszeit und dessen
  unveränderte Datenbank-Postcondition. Das Beobachtungsfenster muss danach
  beginnen. Ein Receipt von einem anderen Deployment oder Snapshot wird als
  Replay abgelehnt.
- Jedes Acceptance-Receipt enthält eine vom zuständigen Owner signierte
  Freigabe des exakten QA-Zielfingerprints, Provider-Account-Fingerprints,
  Provider-Log-/Acceptance-Artefaktdigests sowie eine nachgelagerte
  DB-/Cleanup-Postcondition mit null Live-Residuen.
- Das Final-Cleanup-Receipt bindet das komplette Receipt-Bundle und wird erst
  nach dessen jüngster Signatur erstellt. Es verlangt null verbleibende
  QA-Objekte und null externe Provider-Sessions sowie separate DB-, Provider-
  und QA-Batch-Inventardigests.
- Das Ausgabeverzeichnis existiert und ist kein Symlink. Bestehende
  `provider-boundaries.json` oder Sidecars werden nie überschrieben.

## Ausführung

Alle Pfade und Bindungen werden ausschließlich als begrenztes JSON über stdin
übergeben. Secrets, Session-Cookies, Share-Tokens und Provider-Tokens gehören
weder in diese Eingabe noch in die Receipts.

```json
{
  "cleanupReceiptPath": "<absolute final provider cleanup receipt>",
  "expectedSourceSha256": "<64 lowercase hex>",
  "expectedTrustAnchorSha256": "<64 lowercase hex>",
  "kind": "provider-acceptance",
  "outputDirectory": "<absolute existing output directory>",
  "receiptPaths": [
    "<absolute password-reset receipt>",
    "<absolute workspace-invitation receipt>",
    "<absolute invitation-resend receipt>",
    "<absolute customer-access receipt>",
    "<absolute Google Calendar receipt>",
    "<absolute Microsoft Graph receipt>"
  ],
  "runtime": {
    "branch": "codex/go-live-remediation-20260822",
    "candidateCommit": "<40 lowercase hex>",
    "databaseBranchId": "<isolated Preview Neon branch id>",
    "deploymentHost": "<exact Preview .vercel.app host>",
    "deploymentId": "<exact dpl_ id>"
  },
  "schemaVersion": 1,
  "sourcePath": "<absolute provider-fail-closed-evidence.json path>",
  "sourceSidecarPath": "<absolute source .sha256 path>",
  "trustAnchorPath": "<absolute external trust-anchor path>"
}
```

Der vorgesehene Aufruf ist:

```text
node scripts/provider-acceptance-evidence-freeze.mjs
```

Das JSON wird dabei über stdin eingespeist. Bei Erfolg schreibt der Runner
exklusiv:

- `provider-boundaries.json`
- `provider-boundaries.json.sha256`

Die finale Datei enthält die sechs verifizierten Acceptance-Receipts, das
separate Final-Cleanup-Receipt, die originale
unveränderte DB-Postcondition und eine `providerAcceptanceAssembly`-Bindung an
Byte-/Inhaltsquelldigest, DB-Digest, Acceptance-Inventar, Evidence-Manifest,
Receipt-Bundle und Receipt-Payload-Digests. `completedAt` ist die Signaturzeit
des Final-Cleanup-Receipts; der jüngste Acceptance-Zeitpunkt und der
Abschlusszeitpunkt des unveränderten Fail-closed-Collectors bleiben separat
gebunden. Vor
dem Schreiben wird zusätzlich der bestehende finale
`observedFinalPreviewGateStatus`-Verifier ausgeführt. Jede Abweichung endet
ohne PASS-Artefakt.

## Abbruchkriterien

Der Freeze bleibt unter anderem bei folgenden Zuständen geschlossen:

- fehlender, doppelter oder falscher Acceptance-Typ;
- zusammengelegte Resend-/Kalender-/Cleanup-Rolle oder falscher Rollen-Key;
- Beobachtung vor Abschluss des gebundenen BLOCKED-Collectors;
- nicht freigegebenes QA-Ziel, falscher Provider-Account oder ungebundene
  Log-/Acceptance-Evidenz;
- fehlender, zu früher oder nicht-nullrestiger Final-Cleanup-Nachweis;
- ungültige Ed25519-Signatur oder falscher Trust Anchor;
- Runtime-, Deployment-, Branch- oder DB-Replay;
- veränderte Quelldatei, Sidecar oder Datenbank-Postcondition;
- bereits auf PASS umetikettierter Quellcollector;
- Symlink, Hardlink, übergroße oder während des Lesens veränderte Datei;
- Secret-/Provider-Token-Muster im finalen Output;
- bereits vorhandene Zieldatei oder Sidecar.

Ein technisch erzeugtes `provider-boundaries.json` ersetzt keine reale
Provider-Abnahme. Ohne die sechs echten extern signierten Acceptance-Receipts
und das getrennte echte Cleanup-Receipt gibt es
kein Provider-Gate-PASS.
