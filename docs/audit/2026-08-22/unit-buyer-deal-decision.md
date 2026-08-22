# Unit-Status, Käufer- und Deal-Beziehung – offene Go-Live-Entscheidung

Stand: 22.08.2026
Technischer Policy-Key: `propertyReservationRelationshipSync`
Aktueller technischer Zustand: `LAUNCH-OFF`
Fachliche Freigabe: ausstehend

## Warum die Entscheidung vor Launch erforderlich ist

Der bestehende Reservierungsworkflow schreibt dieselbe fachliche Zuordnung an mehreren Stellen:

- `property_reservations` speichert Einheit, Kontakt, optionalen Deal, Reservierungsstatus und Frist;
- `property_units` speichert zusätzlich Status, `buyer_contact_id` und `deal_id`;
- eine Reservierungsaktion kann außerdem Deal-Stage, Wahrscheinlichkeit, Next Action, Aufgabe, Teams-Job, Audit und Analytics verändern;
- der Expiry-Cron kann eine Reservierung beenden, die Einheit auf `available` setzen und Käufer-/Deal-Links entfernen.

Damit sind ohne fachliche Festlegung mehrere widersprüchliche Zustände möglich: reservierte Einheit ohne aktive Reservierung, verkaufte Einheit ohne Käufer, abgelaufene Reservierung mit gewonnenem Deal, mehrere Reservierungen für dieselbe Einheit oder ein Deal, dessen Stage nicht zur Unit passt. Der aktuelle Workflow führt zudem mehrere fachliche Writes nacheinander aus. Eine fehlgeschlagene Folgewirkung kann deshalb vor einer atomaren/outbox-basierten Neugestaltung einen Teilzustand hinterlassen.

## Entscheidungsoptionen

### Option A – Reservierung ist Source of Truth

- Käufer- und Deal-Beziehung leben primär an der aktiven Reservierung.
- Der Unit-Status wird aus aktiver Reservierung bzw. Verkauf abgeleitet; Felder an `property_units` sind nur eine atomar gepflegte Projektion.
- Genau eine aktive Reservierung pro Workspace und Einheit wird per Datenbank-Constraint erzwungen.
- Deal-Stage-Änderungen laufen ausschließlich über eine projektspezifische, freigegebene Mapping-Tabelle und eine transaktionale Outbox.
- Ablauf entfernt nur die von genau dieser Reservierung gesetzte Projektion; ein unabhängiger Käufer-/Deal-Link wird nicht stillschweigend gelöscht.

Vorteil: sauberer Verlauf und klare Reservierungssemantik.
Nachteil: benötigt Constraint-, Backfill-, Reconciliation- und Outbox-Arbeit vor Aktivierung.

### Option B – Einheit ist Source of Truth

- `property_units.status`, `buyer_contact_id` und `deal_id` sind der verbindliche aktuelle Zustand.
- Reservierungen sind Historien-/Fristdatensätze und dürfen die Einheit nur über eine atomare Unit-State-Machine verändern.
- Jede Mutation sperrt die Unit-Zeile und validiert erlaubte Übergänge (`available → reserved → sold`, definierter Rückweg).
- Deal-Stage bleibt entweder rein manuell oder wird über eine separate, explizit aktivierte Automation synchronisiert.

Vorteil: einfache Abfrage des aktuellen Bestandszustands.
Nachteil: Historie und parallele Reservierungsversuche benötigen besonders strikte Sperr- und Konfliktregeln.

### Option C – Entkoppelter Pilotumfang

- Reservierungen dürfen nach atomarer Härtung nur Reservierung und Unit-Status verändern.
- Käufer wird an der Reservierung geführt; ein Unit-Käuferfeld ist höchstens Projektion.
- Deal-Verknüpfung ist optional und verändert niemals automatisch Stage, Probability oder Next Action.
- Verkauf/Deal-Abschluss erfolgt im Pilot manuell mit einem sichtbaren Konsistenzhinweis.

Vorteil: kleinster und risikoärmster Go-Live-Umfang.
Nachteil: weniger Automatisierung und zusätzlicher manueller Prozess.

## Verbindlich zu signierende Detailfragen

Product, Sales Operations, Engineering und Data/Compliance müssen vor `LAUNCH-ON` je Frage genau eine Antwort festhalten:

1. Welcher Datensatz ist Source of Truth für Unit-Status, Käufer und Deal?
2. Darf eine Einheit mehr als eine aktive Reservierung haben? Falls ja: Priorität und Kontingent.
3. Ist ein Käufer für `reserved` und/oder `sold` zwingend? Darf er nach Verkauf wechseln?
4. Ist ein Deal optional oder zwingend? Darf ein Deal mehrere Units und eine Unit mehrere Deals referenzieren?
5. Welche Unit-Übergänge sind erlaubt, wer darf sie ausführen und wann ist Vier-Augen-Freigabe nötig?
6. Welche Reservierungsaktion darf welche Deal-Stage verändern? Was passiert, wenn eine Projektpipeline keine passende Stage besitzt?
7. Was geschieht beim Ablauf: Unit freigeben, Käufer lösen, Deal zurückstufen, Aufgabe erzeugen oder nur Review markieren?
8. Was geschieht bei Konvertierung/Storno nach bereits gewonnenem Deal?
9. Welche Änderungen müssen atomar sein, welche laufen über Outbox/Retry und welche benötigen Reconciliation?
10. Wie werden Legacy-Widersprüche vor Aktivierung inventarisiert, bereinigt und nachweisbar wiederherstellbar gemacht?

## Technische Aktivierungskriterien

Der Policy-Key darf erst in einem eigenen, reviewten Commit auf `LAUNCH-ON` wechseln, wenn mindestens Folgendes vorliegt:

- signierte Antworten auf alle zehn Detailfragen;
- Datenmodell/Constraints und tenant-qualifizierte Foreign Keys für die gewählte Kardinalität;
- atomare Mutation oder Outbox mit Idempotency, Retry und Reconciliation;
- explizite Projektpipeline-Mappings ohne sprachabhängige Stage-Heuristik;
- Rollen-, Tenant-, Parallelitäts-, Replay-, Failure-Injection- und Cleanup-E2E;
- Backfill-/Conflict-Report, Restore-/Rollback-Probe und Observability-Alarme;
- UI-, API-, Cron- und Repository-Gates werden gemeinsam aktiviert.

Bis dahin bleiben UI-Aktionen, `/api/crm/reservations`, der Property-Reservation-Cron und direkte Repository-Mutationen fail-closed. Inventarlesen und das Anlegen von Gebäuden/Einheiten bleiben davon getrennt verfügbar.

## Freigabe

| Rolle | Name | Entscheidung A/B/C | Datum | Signatur/Referenz |
|---|---|---|---|---|
| Product |  |  |  |  |
| Sales Operations |  |  |  |  |
| Engineering |  |  |  |  |
| Data/Compliance |  |  |  |  |
