# G27 Production Readiness – historische Geld-/Steuersemantik

Stand: 2026-09-24

CRM-Repository: `novalure/novalure-crm`

Branch: `codex/crm-production-readiness-g27`

PR: `#65` (Draft)

CRM-Basis: `1595dd03cbf7ac23518116d19f934dd7c99d0e0d`

Evelyn-Repository: `novalure/evelyn`

Evelyn-Money/Tax-V2-Basis: `1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc`

## Abnahmestand

**Lokale G27-Implementierung: PASS**

**G27 Live A–F und Race/Idempotency: PASS**

**G27 Status: OPEN**

Aktueller verbleibender Abschluss: vollständiges Cleanup und abschließender
unabhängiger Security-Review. Die fehlenden QA-Artefakte und die Evelyn-Isolation
sind keine offenen Blocker mehr. 220 Live-Assertions und 93 HTTP-Aufrufe bestanden
am 24.09.2026 zwischen 13:41:31 und 13:42:45 UTC. Siehe
[Live-Evidenz](g27-live-preview-evidence-20260924.json) und
[nachgelagerte READ-ONLY-Datenbankprüfung](g27-post-live-database-20260924.json).

Getestetes CRM: `https://novalure-71fl8c6wh-novalure.vercel.app`, Deployment
`dpl_9dYhwKCWSfuj3uXhoUgZoDnroYjY`, Commit
`5058b06d71d3e48716249bd484a544b4244e6a4c`. Die konfigurierte CRM-Branch-URL wurde
zusätzlich vor jedem Browser-Write über Vercel auf genau dieses Deployment
aufgelöst. Der immutable Pin wurde dabei nicht durch eine Alias-Annahme ersetzt.
Der temporäre Ein-Stunden-Metadaten-Token wurde nach dem Live-Lauf widerrufen;
seine Abwesenheit in der Vercel-Tokenliste ist bestätigt.

### Fortsetzung: isolierte Evelyn-QA und Legacy-Fall E

Die separate Evelyn-G27-QA-Datenbank ist nachgewiesen; die erste Übergabe
`evelyn-jvun9jenl-novalure.vercel.app` ist jedoch für den gemeinsamen Lauf noch
nicht verwendbar: ihr Tenant `a581621e-efab-462f-8400-045e28db40af` weicht vom
bestehenden CRM-QA-Workspace `afeac3f9-7534-47f5-b749-b3fd91b8f91b` ab.
Die bestehende Evelyn-Aufgabe hat ausschließlich die branchgebundene
Preview-Konfiguration korrigiert. Nachfolge-Preview:
`https://evelyn-jyh6ijl3u-novalure.vercel.app`, Deployment
`dpl_78AgPzc13Y2LNKFmZKMLpbDhdDiA`, unveränderter Evelyn-Commit, READY Preview.
Das private Access-Artefakt bestätigt jetzt den CRM-Tenant. Keine Datenbank wurde
neu provisioniert oder erneut befüllt. Die abschließende schreibfreie
Runtime-Authentisierungs-/Tenant-Prüfung und der gemeinsame Live-Lauf sind PASS. Der Server-Client
und Runner sind auf diese Nachfolge-Preview gepinnt.

Fall E verwendet einen tatsächlich erzeugbaren V1-Altvertrag. Request, Verify
und Execute über V2 müssen `EVELYN_CONTRACT_VERSION_MISMATCH` liefern, ohne
Remote-Aufruf, Approval oder Ausführung. Der lokale Regressionstest wies zunächst
fehlende Auditereignisse nach. Die Korrektur persistiert die Ablehnung unter der
bereits geprüften Tenant-/Projektberechtigung und gehaltenen Action-Sperre; Actor,
Version und Correlation stammen aus der Datenbank. Erst nach Commit des Audits
wird die Ablehnung zurückgegeben. Fremde Tenants erzeugen keinen Auditdatensatz;
eine gefälschte Correlation wird nicht in die gespeicherte Historie übernommen.
Es wurden keine Migrationen, Trigger oder RLS-Regeln geändert.

Der versionierte Runner `scripts/qa-g27-live-preview.mjs` prüft für E zusätzlich
die unveränderte V1-Revision, Null Approval-/Execution-Zeilen und drei neue
Auditereignisse über READ-ONLY-SQL. Er enthält außerdem einen parallelen
Execute-/Replay-Fall mit Nachweis genau einer synthetischen Execution.
Diese Live-Fälle wurden vollständig ausgeführt und sind **PASS**.

Frische lokale Prüfung dieser Fortsetzung: G27 115/115 plus Runner/Probe 31/31,
Baseline 481/481 plus isolierter Browser 26/26, Neon-Profil 11/11:
**664/664 PASS**. Die zusätzlichen Correlation-/Fremdtenant-Assertions wurden
anschließend im Workflow erneut geprüft (18/18, nicht doppelt gezählt).
Typecheck, Lint, Build und Dependency-Audit (0 Vulnerabilities) PASS.
Dieser lokale Zwischenstand wurde durch die oben verlinkte echte Live-Abnahme ergänzt.
Cleanup und abschließender Security-Review bleiben offen.
Die nachfolgenden älteren Tabellen dokumentieren den bisherigen Stand vor
dieser Fortsetzung und sind nicht zusätzlich zu diesen 664 Tests zu zählen.

Für die vorgeschaltete schreibfreie OIDC-/Tenant-Prüfung existierte kein
verwendbarer CRM-Endpunkt: der fachliche V2-Client lehnt unvollständige Bodies
bereits vor Tokenbeschaffung ab. Temporär hinzugefügt wurde deshalb ausschließlich
`POST /api/qa/g27-isolation`, ohne Datenbank-Import oder frei wählbare Eingaben.
Die Route sendet zwei feste unvollständige Payloads an den gepinnten Evelyn-Pfad:
Control muss 400/INVALID_INPUT, Fremdtenant 401/SERVICE_AUTH_DENIED liefern,
jeweils application/json, no-store, ohne Set-Cookie. Bei abweichendem Control
wird sofort abgebrochen. Evelyn muss anschließend den unveränderten DB-Snapshot
bestätigen; die HTTP-Antwort allein beweist keine Schreibfreiheit.

Der Aufruf ist auf CRM-Preview, G27-Branch, Deployment-Origin und eine
30 Sekunden gültige HMAC-Signatur beschränkt. Der Signaturschlüssel wird per
HKDF mit eigenem Kontext aus dem vorhandenen Preview-Session-Secret abgeleitet.
Die exakte Commit-Bindung ist eine zweiteilige Invariante: der lokale Caller
prüft zuerst die unabhängigen Vercel-URL/Deployment/Project/Team/Branch/SHA-Pins,
signiert dann diesen SHA; die Route vergleicht gegen ihren tatsächlichen SHA.
Die Route allein enthält keine eigenständige SHA-Allowlist.

Unabhängiger Evelyn-Review: 0 Critical/High. Ein Medium im Caller (Vertrauen auf
pass=true ohne exakte Ergebnisreihenfolge) wurde korrigiert und negativ getestet.
Bekanntes Low: die eingehende HMAC ist innerhalb von 30 Sekunden wiederholbar;
es werden ausschließlich die festen unvollständigen Payloads gesendet. Die Route
läuft am 25.09.2026 00:00 UTC ab und muss **vor Merge entfernt** werden.
Die CI prüft Workflow und Runner/Probe jetzt explizit. Kein Live-PASS aus diesen
lokalen Prüfungen abgeleitet.

CRM-Preview `https://novalure-8m6kth0qt-novalure.vercel.app`, Deployment
`dpl_3R1Zxys3EWy4xWdcFderD8jGUv2E`, Commit
`06914fdd73e0a15e3dfa9451400bc2832ba7f79c`: READY, vollständige CI PASS.
Der erste signierte Aufruf endete am 24.09.2026 13:08:37 UTC mit HTTP 400,
application/json, no-store, ohne Set-Cookie und ohne Control-/Foreign-Ergebnis.
Das ist **kein OIDC-PASS**. Der Body-Guard wurde korrigiert, damit ein tatsächlich
leerer Stream wie ein fehlender Body behandelt wird; Datenbytes bleiben verboten.
Neue Regression einschließlich geschlossenem Request-Stream PASS. Ein neuer
CRM-Preview-Pin und Evelyns read-only After-Snapshot sind vor Wiederholung nötig.

Deployment Protection bleibt eingeschaltet. Der lokale Caller verwendet ein
frisches, ausschließlich im Prozess geladenes Development-OIDC des CRM-Projekts
als Trusted-Source-Header für genau dessen gepinnte Preview. Das fachliche
Service-OIDC wird separat erst im CRM-Preview erzeugt. Es wurde kein projektweiter
Automation-Bypass angelegt und kein Token in Dateien geschrieben.

Der lokale Implementierungs-, Regressions- und Sicherheitsstand ist vollständig grün. G27 bleibt bis zum geforderten Live-Preview-Nachweis A–F offen. Es wurde weder eine Production-Datenbank verändert noch ein Production-Deployment oder Merge ausgeführt.

## Ergebnis der Implementierung

Das CRM konsumiert den gemergten Evelyn-Money/Tax-Contract V2 ohne eigene abweichende Finanzspezifikation:

- Money V2 verwendet ausschließlich kanonische Minor-Unit-Integerstrings, explizite Währung und expliziten Exponenten.
- FinancialSnapshotV1 bindet wirtschaftliche Komponenten, mehrere Steuerkomponenten, Net/Tax/Gross, Currency-, Tax- und Rounding-Policy-Referenzen, Source-Referenz, Provenance, Business-Version und Review-State.
- Canonicalization und SHA-256-Domänentrennung entsprechen dem gepinnten Evelyn-Stand.
- Sämtliche Berechnung verwendet `BigInt` beziehungsweise exakte Integer-/Rationalarithmetik. Browserwerte und JavaScript-Floats sind keine Finanzautorität.
- Historische Snapshots, Policy-Versionen und Events sind append-only.
- Unsichere Altbestände bleiben `NEEDS_REVIEW`; fehlende Currency-, Tax-, Jurisdiction- oder Rounding-Semantik wird nicht geraten.
- Sensitive Evelyn-V2-Ausführung ist nur mit einem `COMPLETE`/`VERIFIED` Snapshot und vollständiger Hashbindung möglich.

## Contract- und Rechenmodell

Die CRM-Grenze in `src/lib/evelyn-money-tax-v2.ts` spiegelt die öffentlichen Evelyn-V2-Schemas für:

- `MoneyV2`
- `FinancialSnapshotV1`
- `ApprovalActionV2`
- versionierte Financial References
- Currency Definition
- Tax Policy Reference und Tax Source Provenance
- mehrere Tax Components
- Canonical Snapshot Hash und Action Hash
- `NEEDS_REVIEW`, `POLICY_REQUIRED` und Threshold-Kontext

Der echte Paritätstest lädt die Money/Tax-V2-Quelle direkt aus dem lokalen Evelyn-Checkout. Er verweigert einen abweichenden Commit, abweichende Source-/Lockfile-Blobs oder eine abweichende Zod-Version. Golden-Vektoren, Normalisierung, Decimal-Konvertierung, Tax-Reconciliation, Schwellenlogik und 128 Fuzz-Fälle werden auf beiden Implementierungen ausgeführt.

Materialänderungen an Betrag, Currency, Exponent, Economic Component, Tax Component, Jurisdiction, Tax-Policy-Version, Rounding-Policy oder Action-Version ändern den gebundenen Hash. Eingabereihenfolge kann den normalisierten Hash nicht verändern.

## Policy Registry

`crm_financial_policy_versions` speichert ausschließlich explizit registrierte, versionierte Policy-Inhalte:

- `CURRENCY`: ISO-4217-Code, Exponent und Verifikationszeitpunkt
- `TAX`: Jurisdiction, Treatment, Category, exakte Rate und belegte Source Provenance
- `ROUNDING`: Modus, Currency-Exponent und Berechnungsscope

Es werden keine länderspezifischen Steuersätze, Jurisdictions, Wechselkurse, Provisionssätze oder Rundungsregeln vorgegeben. Migration 087 legt keine reale Policy an.

Eine Snapshot-Erstellung löst exakt die angeforderten höchstens 22 `(policyId, version)`-Referenzen tenant- und projektgebunden in SQL auf. Unbekannte, doppelte, falsche, abgelaufene oder unpassende Policies werden fail-closed abgewiesen. Currency allein bestimmt keine Jurisdiction. Ein Nicht-EUR-Fall ohne freigegebene Vergleichs-/FX-Policy endet vor Persistenz oder Remotezugriff mit `POLICY_REQUIRED`.

## Migration 087

`migrations/087_crm_financial_snapshots.sql` ist ausschließlich vorwärtsgerichtet und ändert keine frühere Migration.

Sie führt ein:

- `crm_financial_policy_versions`
- `crm_financial_snapshots`
- `crm_financial_events`
- V2-Bindung auf `crm_evelyn_contract_revisions`
- deterministische Backfills für Offer, Deal, Property Sale und Property Cost Matrix
- Fixierungs-Trigger für künftige terminale Deal- und Property-Sale-Vorgänge
- exakte SQL-Validatoren und kanonische Hashfunktionen
- eindeutige Ressourcen-/Business-Versionen und `supersedes_snapshot_id`
- `numeric(78,0)` für exakte historische Conversion-Aggregate

Alle drei neuen Tabellen verwenden FORCE RLS, vorhandene Projektberechtigungen und Actor-Bindung. Runtime-Zugriff ist auf Lesen und die tatsächlich benötigten Inserts beschränkt. Update, Delete und Truncate werden durch append-only Trigger abgewiesen. Snapshot- und Event-Fremdschlüssel binden Workspace, Projekt, Snapshot-Hash und V1/V2-Vertragsversion.

Die SQL-Validierung weist auch explizites JSON-`null` in Pflichtfeldern ab. Der unabhängige Review verglich 66 einzelne Snapshot-Nullmutationen und 25 Policy-Nullmutationen mit dem strikten CRM-Parser; es blieb keine Abweichung.

Fresh Install, Upgrade, realistischer Legacy-Backfill, Null-/Duplicate-/Constraint-Fälle, RLS, Retry, atomarer Fehlerrollback und nativer `pg_dump`/`pg_restore` wurden gegen kurzlebige lokale PostgreSQL-18-Cluster geprüft.

## Historische Fixierung und Legacy

Die Implementierung verwendet ausschließlich vorhandene fachliche Grenzen:

- angenommene Offer-Revision
- erstmaliger terminaler Dealabschluss
- bestätigter Property Sale
- versionierter Property-Cost-Command

Spätere Änderungen aktueller Unitpreise, Dealwerte oder Policy-Registry-Zeilen verändern bestehende Snapshot-JSONs und Hashes nicht. Eine fachliche Korrektur erzeugt eine neue Business-Version mit neuem Snapshot und `supersedes_snapshot_id`.

Der Backfill klassifiziert:

- **A:** vollständig belegbar; ein vollständiger Snapshot ist möglich.
- **B:** teilweise belegbar; nur unveränderliche Evidenz wird übernommen.
- **C:** historisch nicht eindeutig; veränderliche heutige Werte werden ausdrücklich ausgeschlossen.

Die realistische Upgrade-Fixture erzeugt vier B- und zwei C-Snapshots. Alle bleiben `NEEDS_REVIEW`; Tax, Currency, Gross, Jurisdiction oder Rounding werden nicht ergänzt, wenn die alte Quelle sie nicht beweist.

Der minimale Review-Pfad `POST /api/crm/financial-snapshots` verlangt `crm:write` und `settings:manage`. Der Client benennt nur Projekt, Vorgänger, erwarteten Vorgängerhash, die Entscheidung `VERIFY_EVIDENCED_NET`, explizite Policy-Auswahl, Idempotency-Key und Correlation-ID. Unter einem Advisory Transaction Lock liest der Server den unveränderlichen Vorgänger und dessen `legacy_evidence`; daraus leitet er `effectiveAt`, Pricing-/Source-Referenz und sämtliche Nettokomponenten ab. Clientwerte für Zeitpunkt, Pricing-Referenz oder Beträge werden an der HTTP-Grenze abgewiesen. Klassifikation C oder unzureichende Evidenz bleibt fail-closed in `NEEDS_REVIEW`. Aus belegter Evidenz und den ausgewählten Policies berechnet der Server Net/Tax/Gross und erzeugt atomar einen `COMPLETE`-Nachfolger sowie:

- `SNAPSHOT_RECORDED`
- `SUPERSEDED`
- `REVIEW_VERIFIED`
- `POLICY_BOUND`

Der unveränderte `NEEDS_REVIEW`-Vorgänger bleibt als Evidenz bestehen. Ohne verifizierten Nachfolger darf er kein Approval-Event autorisieren.

## Evelyn Approval V2

Neue G27-relevante `contract.send`-Aktionen verwenden explizit `approvalContractVersion=v2`. Bestehende V1-Revisionen bleiben unverändert; ein späterer V2→V1-Downgrade wird in der Datenbank abgewiesen.

Der V2-Ablauf bindet:

- vollständigen `FinancialSnapshotV1`
- `financialSnapshotHash`
- `ApprovalActionV2`
- `actionHash`
- Action-/Resource-Version
- ursprünglichen Workflow und Requesting Actor
- Tenant, Projekt und Correlation-ID

Evelyn akzeptiert Version 1 zuerst und danach ausschließlich lückenlose Versionen. Deshalb darf das CRM eine Revision erst fortschreiben, wenn die aktuelle Version eine dauerhaft gespeicherte Remote-Registrierung besitzt. `request1 → revise2 → request2 → revise3 → request3` ist geprüft. Unregistrierte Versionen, Timeout, Servicefehler und lokaler Rollback nach erfolgreicher Remote-Registrierung bleiben wiederaufnehmbar und können keine Versionslücke erzeugen.

Die bestehende creator-bound RLS bleibt erhalten: Ein anderer Projekteditor kann die Action nicht als ursprünglichen Antragsteller fortschreiben und hinterlässt bei der Ablehnung keine Revision, keinen Snapshot und kein Receipt.

Der Pflichtfall **EUR 20.370 netto** erzeugt einen vollständigen Snapshot mit zwei Tax Components, zwei erforderlichen Approval-Schritten und erfolgreicher V2-Verifikation. Ein materiell geänderter Snapshot erhält einen anderen Hash; die alte Approval-Bindung kann ihn nicht autorisieren.

## Server Authority, Concurrency und Rollback

Die HTTP-Grenzen akzeptieren keine Clientfelder für Net, Tax oder Gross. Der Legacy-Review-Endpunkt akzeptiert zusätzlich weder `effectiveAt`, `pricingReference` noch Komponenten. Tatsächliche Cookie-/CSRF-Requests mit gefälschten Beträgen, Pricing-Quellen oder Zeitpunkten werden vor jedem dauerhaften Write abgewiesen. Offer-Quelle, Revision, Digest, Annahmebeleg, Legacy-Evidenz, Policies und Snapshot werden unter Tenant-/Projektprüfung serverseitig gelesen und berechnet.

Geprüft sind:

- parallele Snapshot-/Versionsanforderungen
- identische Replay-Requests
- gleiche Idempotency Identity mit anderer Payload
- stale Versionen
- Snapshot/Approval- und Snapshot/Status-Races
- Cross-Tenant Read/Write
- fehlende Projektberechtigung
- injizierte Snapshot-, Event-, Approval-Binding-, Receipt- und Auditfehler
- Remote-Erfolg mit lokalem Rollback und identischem Recovery-Request

Property-Kosten laufen als ein atomarer Command mit Receipt und Correlation-ID. Kosten, Snapshot, Events und Audit committen gemeinsam oder werden vollständig zurückgerollt.

## Historische Reports und Dokumente

Folgende Pfade verwenden für terminale Vorgänge den neuesten unveränderlichen, verifizierten Snapshot:

- Property-Sale-Werte im Unit Board
- Customer-Project-Revenue ohne Lead×Deal-Vervielfachung
- Conversion-Revenue
- Pipeline-Owner-/Stage-Auswertungen
- terminale Deal-Wertdarstellung
- Angebots-/Finanzdokumentdarstellung

Mutable Unit-/Dealwerte bleiben nur für aktive operative Schätzungen zulässig. `NEEDS_REVIEW`, nicht-EUR und abweichende Exponenten werden nicht als EUR-Historienwert ausgegeben. Conversion-Snapshots ohne nachgewiesene FinancialSnapshotV1-EUR/2-Metadaten zeigen keinen autoritativen Geldbetrag. Offene Review- und Policy-Ausschlüsse erscheinen separat.

Die Angebotsdruckansicht liest Net, Tax und Gross aus dem fixierten Snapshot. Ohne passenden `COMPLETE`/`VERIFIED` Snapshot bleibt Drucken blockiert.

Die frühere unbelegte 3-%-Provisionsdarstellung wurde entfernt. Provision bleibt ohne explizite fachliche Policy unverfügbar.

## Audit

Der append-only Ledger bindet mindestens:

- Snapshot created/versioned/superseded
- Legacy `NEEDS_REVIEW`
- Review resolved
- ausgewählte Policy-Versionen
- Approval Contract Version
- Action Hash
- Financial Snapshot Hash
- Actor
- Tenant/Projekt
- Correlation-ID

Es werden keine Credentials oder Secretwerte in Snapshot-, Event- oder Abschlussdokumentation aufgenommen.

## Lokale Verifikation

Frische Abnahme vom 24.09.2026: [Restore-/Browserbericht](g27-recovery-browser-20260924.md) und [strukturierte Evidenz](g27-blocker-evidence-20260924.json). Native Neon-Wiederherstellung mit vollständigem Hashvergleich und 64/64 nachgelagerten RLS-Prüfungen PASS. Preview A–F bleibt offen.

Ausgeführt mit Node `24.18.0` und npm `11.16.0`.

### Bestehende CRM-Regression

| Suite | Ergebnis |
| --- | ---: |
| `test:unit` | 232/232 |
| `test:integration` | 15/15 |
| `test:protected-preview-access` | 17/17 |
| `test:sales` | 90/90 |
| `test:sales:final` | 50/50 |
| `test:sales:migrations` | 15/15 |
| `test:neon:061` | 11/11 |
| `test:g08` | 51/51 |
| `qa:sales:e2e` | 20/20 |
| **Baseline total** | **507/507** |

### G27 zusätzlich

| Suite | Ergebnis | Evidenzart |
| --- | ---: | --- |
| Unit, Money/Tax, Snapshot, Cost, Property/Fuzz | 29/29 | ausgeführte CRM- und echte lokale Evelyn-Module |
| V2 Client Contract | 29/29 | ausgeführte Transport-/Schema-/Bindingtests |
| Reporting | 7/7 | Quell-/Query-Invarianten |
| Migration/DB | 17/17 | echte lokale PostgreSQL-Transaktionen und Dump/Restore |
| Workflow/RBAC/Security/Legacy/Property | 32/32 | echte lokale PostgreSQL- und HTTP-Grenzen |
| **G27 total** | **114/114** | disjunkte Node-Testzählung |
| **Lokaler Gesamtstand** | **621/621** | 507 Baseline + 114 G27 |

Zusätzlich am 24.09.2026 frisch ausgeführt: G27-Neon-Profil 11/11 PASS, damit insgesamt **632/632** lokale Tests.

Historische zusätzliche unabhängige Negativproben, nicht in dieser frischen Gesamtzahl gezählt:

- 66/66 Snapshot-Nullmutationen
- 25/25 Policy-Nullmutationen
- 8/8 Conversion-Projektions-/Darstellungsfälle
- erneute 16/16 V2-Lifecycle-DB-Prüfung

### Qualitätsgates

| Gate | Ergebnis |
| --- | --- |
| Typecheck | PASS |
| ESLint `--max-warnings=0` | PASS |
| Next.js 16.3.5 Production Build | PASS, 85 statische Seiten generiert |
| Production Dependency Audit | PASS, 0 Vulnerabilities |
| Secret Scan | PASS für 136 Commits der HEAD-Historie; finaler Änderungsdiff wird vor Commit erneut geprüft |
| `git diff --check` | PASS |
| unabhängiger Security-Review | PASS; 0 bestätigte Critical/High und keine G27-blockierenden P2 |

## Preview und Live QA

Die autorisierte Live-Preview-Abnahme ist vollständig PASS. Verwendet wurden
ausschließlich die nachgewiesenen disposable CRM-/Evelyn-Datenbanken und
synthetische Daten. Die öffentliche Evidenz enthält Pins, Testziele, Ergebnisse,
IDs und HTTP-Status; Zugangsdaten verbleiben ausschließlich in geschützten
privaten Artefakten beziehungsweise im Prozessspeicher. Cleanup steht noch aus.

| Fall | Erwartung | Stand |
| --- | --- | --- |
| A | EUR-Vorgang → Snapshot → V2 Two-Step → VALID | PASS – EUR 20.370 netto, EUR 24.444 brutto |
| B | Materialänderung macht alte Approval ungültig | PASS – INVALIDATED; neue Version VALID |
| C | aktueller Preis ändert historischen Snapshot nicht | PASS – EUR 350.000 historisch trotz EUR 360.000 aktuell |
| D | neue Policy-Version ändert alten Snapshot nicht | PASS – synthetisch 20 % → 21 %, V1 unverändert |
| E | Legacy/V1 → V2-Version-Mismatch → Ablehnung, keine Ausführung, Audit | PASS – drei Ablehnungen, drei Audit-IDs, null Approval/Execution |
| F | Cross-Tenant-Zugriff wird verweigert | PASS – Lesen/Schreiben 404, fremder Snapshot unverändert |
| Race/Idempotency | zwei parallele Executes und Replay | PASS – genau eine persistierte synthetische Execution |

G27 darf erst nach einem vollständigen A–F-PASS auf **CLOSED** gesetzt werden. Die Preview muss nachweisen, dass die konfigurierte Evelyn-V2-Runtime dem gepinnten Quellstand `1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc` entspricht; ein älterer G08-Livestatus reicht dafür nicht.

## Produktionsgrenzen

- Production DB geändert: **NEIN**
- Production deployed: **NEIN**
- main gemergt: **NEIN**
- Evelyn-Code unverändert; separate disposable QA-Preview am selben Commit verifiziert. Tenant-Korrektur und gemeinsame Live-Abnahme PASS; Production unverändert.
- reale Steuer-/FX-/Provisionsregeln angelegt: **NEIN**
- reale Kunden-, Vertrags-, Zahlungs- oder Zustelldaten verwendet: **NEIN**

## Offene Findings

- Open Critical: **0**
- Open High: **0**
- G27-blockierende Medium-Findings nach lokalem Fix/Review: **0**
- Übrige Production-Readiness-Medium-Gaps nach erfolgreichem G27-Abschluss: **7**

Nach vollständiger Preview-Abnahme ist der nächste Schritt ausschließlich die Planung von G14/G18/G20/G21/G22/G23/G26. Diese Remediation wird in diesem Auftrag nicht ausgeführt.
