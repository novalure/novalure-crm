# G27 Production Readiness – historische Geld-/Steuersemantik

Stand: 2026-09-18

CRM-Basis: `1595dd03cbf7ac23518116d19f934dd7c99d0e0d`

Evelyn-Basis: `6fe55077c560224edbe452d64fd9549951b5c96a`

Branch: `codex/crm-production-readiness-g27`

## Ergebnis

**G27 Production Readiness: BLOCKED**

**G27 Status: OPEN**

Der Auftrag verlangt einen Stopp, sobald die vollständige G27-Lösung den bestehenden Evelyn-Contract beeinflusst. Diese Bedingung ist erfüllt. Deshalb enthält dieser Branch keine Laufzeit-, Datenbank- oder Evelyn-Änderung. Die zusätzlich fehlenden Steuer- und Rundungsregeln verbieten jede berechnende Steuerlogik; ausdrücklich autorisierte Net-/Tax-/Gross-Minor-Units könnten dagegen ohne erfundene Steuersätze gespeichert und arithmetisch geprüft werden.

## G27 Root Problem

Die autoritative Ursprungsdefinition steht in Evelyn unter `docs/integrations/crm/crm-gap-analysis.md`: Preis- und Budgetdaten liegen teils als Bigint-Cents, JavaScript-Number, formatierter Text oder untypisierte JSON-Zahlen vor. Währung und Steuerbasis sind nicht durchgängig gebunden. Präzision, Netto-/Gesamtverpflichtung und widerspruchsfreie Geldsemantik müssen vor finanziellen Entscheidungen vertraglich festgelegt sein.

Das CRM besitzt aktuell keinen einheitlichen, transaktionszeitgebundenen Money-/Tax-Contract. Beträge verlieren je nach Pfad Währung, Netto-/Bruttobasis, Rundungsregel, fachliche Quelle oder Gültigkeitszeitpunkt. Mehrere historische Auswertungen lesen später veränderliche Stammdaten erneut ein.

## Betroffene Daten

- `deals.value_cents` ohne gespeicherte Währung oder Steuerbasis; Loader liefern daraus wieder formatierten EUR-Text.
- Unitpreise und Reservierungsanzahlungen als nackte Bigint-Cents; Loader konvertieren sie zu JavaScript-Number.
- Leadbudgets als Freitext und BuyerProfile-/Suchprofilbudgets als nicht einheitlich typisierte Zahlen.
- `property_cost_items` mit getrennten Netto-, VAT- und Bruttowerten sowie optionalem Prozentsatz, aber ohne Currency, Tax-Code, Jurisdiction, Rundungsbasis oder arithmetischen Konsistenz-Check.
- Angebotsrevisionen mit sicherer EUR-Netto-Cent-Summe, aber ohne Steuerbetrag, Bruttobetrag oder Rundungsnachweis.
- `property_sales` ohne Betrag, Währung oder Netto-/Steuer-/Brutto-Snapshot.
- Reporting-Snapshots und Analytics-Beträge ohne vollständige historische Money-Semantik.

Es wurde kein operatives kanonisches Rechnungs-, Zahlungs- oder Rabattmodell gefunden. OfferLines erlauben positive Mengen und nichtnegative Nettoeinzelpreise, besitzen aber kein Discount-Feld. Vertrags- und Zahlungsausführung sind im bestehenden Angebotsworkflow ausdrücklich deaktiviert.

## Betroffene Prozesse

- Deal-Erstellung, -Änderung und Abschluss
- Angebotsversion, -freigabe und -annahme
- autorisierte Unit-Preisbestätigung
- Reservierungsumwandlung und `sale.confirm`
- Objektkosten, Gebühren und provisionsrelevante Kennzeichnungen
- Sold-Value-, Revenue-, Conversion-, Forecast- und Provisionsdarstellung
- CRM→Evelyn-Vertragsfreigabe im synthetischen Preview-Contract

## Risiko

- Abgeschlossene Verkäufe und Won-Deals können in späteren Berichten einen anderen historischen Wert erhalten.
- Unabhängig gelieferte Netto-, VAT- und Bruttowerte können widersprüchlich persistiert werden.
- Währung, Basis und Einheit gehen beim Wechsel zwischen Bigint, JSON, formatiertem Text und JavaScript-Number verloren.
- Provisions-, Forecast- und Revenue-Werte können dadurch fachlich falsch und nicht reproduzierbar sein.
- Eine Evelyn-Freigabe kann heute nur die EUR-Netto-Projektion signieren; Steuer- und Bruttowerte wären nicht Bestandteil desselben Approval-Hashes.
- Ein stiller Legacy-Backfill aus heutigen Preisen, Ländern oder Company Profiles würde unbelegte historische Tatsachen erzeugen.

## Warum G27 ein Go-live-Blocker ist

Das CRM kann derzeit weder garantieren, dass ein alter Abschluss morgen denselben Geldwert ausweist, noch dass Netto, Steuer und Brutto eines relevanten Vorgangs widerspruchsfrei und durch dieselbe Freigabe gebunden sind. Dadurch fehlen Reproduzierbarkeit, Auditierbarkeit und eine verlässliche Grundlage für Verkaufswert, Umsatz, Provision und steuerbezogene Dokumentdarstellung. Das ist vor finanziellen Entscheidungen und einem Produktionsstart nicht vertretbar.

## Kompakte Evidenz

| Befund | Beleg |
|---|---|
| Autoritative G27-Definition und Evelyn-Anpassung `ja` | Evelyn `docs/integrations/crm/crm-gap-analysis.md:61` |
| Dealwert ohne Currency/Tax-Basis | `migrations/001_initial_novalure_crm.sql:144-162` |
| Deal-Cents werden zu formatiertem EUR-Text | `src/lib/db/crm-loaders.ts:2993-3047`, `3225-3231` |
| Kosten ohne Currency und Konsistenz-Constraint | `migrations/035_property_department_content.sql:74-98` |
| Kosten werden clientbasiert gelöscht und neu angelegt | `src/lib/db/property-department-repositories.ts:682-788` |
| Ambiguer Euro-/Cent-Parser | `src/lib/db/property-department-repositories.ts:1649-1668` |
| Sale ohne Money-Snapshot | `migrations/082_crm_property_sales_workflow.sql:43-53`, `src/lib/db/property-sales-repositories.ts:170-176` |
| Preisänderung auch nach Verkauf möglich | `src/lib/db/property-sales-repositories.ts:115-124` |
| Sold-Report liest aktuellen Unitpreis | `src/lib/db/crm-loaders.ts:2463-2475` |
| Historische Conversion liest aktuelle Dealwerte | `src/lib/db/recommendation-runtime-repositories.ts:2007-2045` |
| Customer-Revenue kann durch Lead×Deal-Join vervielfacht werden | `src/lib/db/customer-access-repositories.ts:1081-1101` |
| Unbelegte 3-%-Provision | `src/components/dashboard-overview.tsx:33-35`, `566-570` |
| Servicevertrag markiert Unit/Deposit/Budget als nicht verifiziert | `src/lib/crm-service-contract.ts:112-125` |
| CRM→Evelyn-Action ist strikt EUR/netto | `src/lib/evelyn-approval-client.ts:15-20`, `79-96`; `src/lib/db/evelyn-contract-repositories.ts:75-103` |
| Evelyn-Bridge akzeptiert exakt EUR, `net: true`, `netCents` | Evelyn `src/approval-bridge/model.ts:10-22` |

## Belegte historische Fehler

### Property Sale

`migrations/082_crm_property_sales_workflow.sql` speichert in `property_sales` Projekt, Unit, Reservierung, Käufer, Authority, Quelle, Zeitpunkt und Unit-Version, aber keinen Geldwert und keine Steuersemantik. `src/lib/db/property-sales-repositories.ts` setzt anschließend Unit und optionalen Deal auf den Abschlussstatus.

Der Command `unit.price.confirm` kann den Preis einer bereits verkauften Unit weiterhin ändern. `src/lib/db/crm-loaders.ts` berechnet `soldValueCents` aus dem jeweils aktuellen `property_units.price_cents`. Eine spätere Preisänderung verändert daher rückwirkend den ausgewiesenen Wert des alten Verkaufs.

### Deals und Reporting

Nicht durch den kanonischen Offer-Workflow geschützte Dealwerte können nach einem terminalen Status weiterhin überschrieben werden. Historische Conversion-Auswertungen summieren aktuelle Dealwerte für vergangene Perioden. Der Customer-Project-Report verbindet Leads und Deals vor der Summe, sodass mehrere Zeilen Geldwerte zusätzlich vervielfachen können.

### Property Costs

Die UI übermittelt Netto, VAT und Brutto unabhängig. Das Repository löscht den vorhandenen Kostensatz und legt ihn aus den Clientwerten neu an. Es gibt weder serverseitig noch in der Datenbank die Invariante `net + tax = gross`.

Die Konvertierung verwendet JavaScript-Number und `Math.round`. Eine Größenheuristik wechselt bei Beträgen oberhalb `999_999` zudem implizit zwischen Euro und Cent. Damit ist die Einheit vom Betrag abhängig und nicht vom Vertrag.

### Provision

Das Dashboard verwendet eine hart codierte 3-%-Annahme. Es gibt dafür keine persistierte Provisionsbasis, Steuersemantik, Regelversion oder fachliche Quelle. Diese Konstante ist keine autoritative Finanzregel und darf nicht als historische Wahrheit übernommen werden.

## Bereits brauchbare Grenzen

- Angebotspositionen verwenden Safe-Integer-Cents und der Server berechnet die EUR-Netto-Summe mit Überlaufprüfung.
- Angebotsrevisionen und Freigaben sind unveränderlich und an Revision sowie Content-Digest gebunden.
- Offer-Annahme und Property Sale besitzen vorhandene terminale fachliche Zustände.
- Property-Preis, Reservierung und Verkauf verwenden projektbezogene Authority-, Versions- und Quellenbelege.
- CRM-Command-Receipts, Domain-Events und Deal-Stage-History liefern append-only Auditmuster mit Tenant-, Actor- und Correlation-Bindung.
- Der CRM-Servicevertrag gibt unsichere Unit-, Deposit- und Budgetsemantik bereits fail-closed als `currency: null`, `taxBasis: NOT_VERIFIED` beziehungsweise `budgetUnit: NOT_VERIFIED` aus.

Diese Grenzen schließen G27 nicht, liefern aber das Sicherheitsmuster für eine spätere Umsetzung.

## Keine Steuerregel erfinden

Im Repository existiert keine autoritative Quelle für:

- anwendbare Steuerart oder Tax-Code je Vorgang,
- Steuersatz und zeitliche Gültigkeit,
- Leistungs-/Objektklassifikation für die Steuerentscheidung,
- Ländergrenzen für AT, DE, CH, ES und IE,
- Rundung je Position oder Gesamtdokument,
- Provisionsbasis und deren Steuerbehandlung.

Company Profiles enthalten Land, VAT-ID und Steuernummer sowie einzelne Pflichtfeldprüfungen. Diese Daten bilden keine Steuerregel-Engine. Bestehende `vat_percent`-Felder, `Math.round` und die Dashboard-3-%-Konstante sind ebenfalls keine fachliche Quelle.

Unbelegte Legacy-Dimensionen dürfen weder aus Land, VAT-ID, Spaltenname, Betrag, heutigem Unitpreis noch aktuellem Firmenprofil abgeleitet werden. Bereits nachweisbare Felder bleiben erhalten: Eine akzeptierte Offer-Revision belegt zum Beispiel EUR, NET, `total_net_cents`, Revision und Digest. Ihr vollständiger Money-/Tax-Snapshot bleibt wegen fehlender Tax-/Gross-/Rundungsdimensionen dennoch `NEEDS_REVIEW`; ausschließlich die unbelegten Dimensionen bleiben unbestätigt.

## Evelyn-Contract-Auswirkung und Stop

Der bestehende CRM→Evelyn-Contract ist ein strikt validierter EUR-Netto-Vertrag:

- `src/lib/evelyn-approval-client.ts` erlaubt exakt `amount`, `currency: "EUR"`, `net: true` und `payload.price.netCents`.
- Der Action-Hash umfasst genau diese Struktur; zusätzliche Felder werden abgelehnt.
- `src/lib/db/evelyn-contract-repositories.ts` erstellt `contract.send` aus `crm_offer_revisions.total_net_cents`.
- Evelyn `src/approval-bridge/model.ts` verlangt ebenfalls exakt EUR, `net: true` und `amount === price.netCents`.

Steuerbetrag, Bruttobetrag, Tax-Code/-Regelversion und Rundungsbasis sind nicht Bestandteil des signierten Action-Hashes. Ein CRM-interner Snapshot daneben würde diese Werte daher nicht von Evelyns Freigabe erfassen. `amount` darf nicht still von Netto auf Brutto umgedeutet werden, weil dies bestehende Hashes, Golden-Vektoren, Schwellenregeln und Auditbelege semantisch ändern würde.

Eine Freigabe der vollständigen Gesamtverpflichtung benötigt deshalb eine neue versionierte Evelyn-Contractform mit abgestimmtem Canonical Hash und Policy-Verhalten. Der Auftrag verbietet eine eigenmächtige Evelyn-Änderung und schreibt bei Contract-Auswirkung den Stopp vor. Dieser Blocker ist vor Implementierungsbeginn eingetreten.

## Kleinster sicherer Lösungsrahmen nach Auflösung des Blockers

Die nachfolgende Skizze ist keine implementierte Migration.

1. Ein append-only, tenant- und projektgebundener Money-Snapshot je terminalem Vorgang bindet explizit Currency, Net-, Tax- und Gross-Minor-Units, Semantikstatus, Rundungsbasis, Quelle, Quellversion/Digest, `effective_at`, Actor, Authority, Command, Audit und Correlation.
2. Bei bestätigten Snapshots gilt ausschließlich Integer-Arithmetik mit sicheren Grenzen und `net + tax = gross`. Es wird kein Steuersatz aus Land oder Profil abgeleitet.
3. Korrekturen erzeugen eine neue Revision mit `supersedes_snapshot_id`; historische Zeilen bleiben unveränderlich.
4. Der Snapshot wird atomar an vorhandene Grenzen gebunden: angenommene Offer-Revision, erstmaliger Dealabschluss und `sale.confirm`.
5. Altbestände mit unvollständiger Gesamtsnapshotsemantik werden `NEEDS_REVIEW`. Bereits belegte Felder werden unverändert als Evidenz übernommen; ausschließlich unbelegte Currency-, Basis-, Tax-, Gross- oder Rundungsdimensionen bleiben `NULL` und dürfen nicht aus aktuellen Stammdaten abgeleitet werden.
6. Sold- und Revenue-Reports aggregieren nur bestätigte Snapshots, gruppieren nach Currency/Basis und zeigen `needsReviewCount` separat. Mutable Unit-/Dealwerte bleiben als aktuelle Schätzung gekennzeichnet.
7. Die Datenbank übernimmt das FORCE-RLS-/Immutability-Muster aus Migration 080/081. Runtime-Rollen erhalten kein `UPDATE`, `DELETE` oder `TRUNCATE` auf Snapshot-Evidenz.
8. Objektkosten benötigen explizite Einheiten, deterministisches Decimal→Minor-Unit-Parsing und einen versionierten Kostensatz statt `DELETE + INSERT`.
9. Vor Evelyn-Nutzung muss entschieden und versioniert werden, ob deren Freigabebetrag die Netto-Projektion oder die tatsächlich zahlbare Gesamtverpflichtung bezeichnet.

## Migration und Legacy

Es wurde keine Migration erstellt oder ausgeführt. Eine sichere Folgeumsetzung wäre ausschließlich vorwärtsgerichtet; bestehende Migrationen bleiben unverändert. Fresh-Install, Upgrade von 086, transaktionaler Fehler-Rollback, Ledger-Rerun, Checksum-Mismatch, RLS, Tenant-Isolation, parallele Writes und Dump/Restore wären Pflichtprüfungen.

Ein deterministischer Legacy-Backfill ist nur für bereits belegte Felder möglich. Diese Werte können unverändert als Review-Evidenz übernommen werden. Fehlende Dimensionen dürfen nicht bestätigt oder aus heutigen Stammdaten abgeleitet werden; unvollständige Snapshots gehen nicht als vollständig bestätigte Money-/Tax-Werte in Auswertungen oder Finanzentscheidungen ein.

## Audit und Sicherheit

Der spätere Snapshot muss mindestens Tenant, Projekt, Resource, Quellversion, Actor, Zeitpunkt, Correlation, Operation und Source Reference binden. Finanzwerte dürfen nicht über unkontrollierte Client-Summen autorisiert werden. Server und Datenbank müssen die arithmetische Konsistenz erzwingen. Bestehende RBAC-/Projektgrants bleiben Voraussetzung; Snapshots benötigen FORCE RLS und harte Immutability.

## Verifikation

Wegen der expliziten STOP-Regel wurden keine Laufzeitänderungen vorgenommen und daher keine G27-Implementierungs-, Migrations-, E2E- oder Preview-Tests ausgeführt. Die bestehende CRM-Regression wurde nicht als Beleg für eine nicht vorhandene G27-Implementierung wiederholt.

Production DB geändert: **NEIN**

Production Deployment: **NEIN**

Evelyn main geändert: **NEIN**

## Offene Entscheidungen

G27 kann erst fortgesetzt werden, wenn folgende verbindliche Entscheidungen beziehungsweise Quellen vorliegen:

1. Bedeutet „Gesamtverpflichtung“ für Offer-/Contract-/Sale-Freigaben netto oder tatsächlich zahlbar brutto?
2. Erfasst das CRM ausschließlich ausdrücklich autorisierte Net-/Tax-/Gross-Minor-Units, oder soll es Steuer aus versionierten Regeln berechnen?
3. Falls berechnet wird: Welche autoritative Regelquelle, Länder-/Transaktionsabdeckung und Rundung gelten?
4. Welche versionierte Evelyn-Contractform bindet dieselben Werte und Regeln in Action-Hash und Approval?
5. Welche fachliche Basis gilt für Provisionen und rabatt-/gebührenbezogene Beträge?

Bis diese Punkte geklärt sind, bleiben **Open Critical: 0**, **Open High: 0** und **G27: OPEN/BLOCKED**. Die übrigen sieben Medium-Gaps wurden nicht bearbeitet.
