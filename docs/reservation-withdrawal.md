# Reservierung zurücknehmen

Der unterstützte Weg ist **Projektverkauf → Reservierung zurücknehmen** beziehungsweise `POST /api/crm/property-sales` mit `action: "reservation.withdraw"`. Der alte `/api/crm/reservations`-Schreibweg bleibt gesperrt. Rücknahme ist ein eigener Endstatus `withdrawn`; sie verändert keine Reservierungsfrist und wird nicht als Ablauf verbucht.

Der Befehl benötigt die aktuelle aktive Workspace-Mitgliedschaft, `crm:write`, die Produktfähigkeit `reservations:write`, aktuellen Schreibzugriff auf das Projekt sowie eine aktiv dokumentierte Reservierungsvollmacht für dieses Projekt. Der Client sendet die gelesene Reservierungsversion als `expectedVersion`, die Einheitenversion als `payload.unitVersion`, `payload.reservationId`, einen nicht leeren `payload.sourceReference` und UUIDs für `idempotencyKey` und `correlationId`.

Reservierung, Einheit und Vollmacht werden in derselben Transaktion gesperrt. Veraltete Versionen, ein bereits beendeter Vorgang, verkaufter oder gesperrter Bestand, eine abweichende aktuelle Käufer-/Dealbindung und eine weitere offene Reservierung verhindern die Änderung. Eine offene unverbindliche Anfrage und ein alter Hold im verfügbaren Bestand können beendet werden, ohne einen Einheitenstatuswechsel zu erfinden. Ein reservierter Bestand wird nur zusammen mit seiner passenden Reservierung freigegeben.

Der atomare Erfolg erhält die ursprüngliche Bestätigung, Frist, Anzahlung, Vertragsstand und sonstige Metadaten. Er ergänzt den Rücknahmebeleg, die tatsächliche Vorher-/Nachher-Historie, gegebenenfalls den Einheiten-Audit, den unveränderlichen Befehlsbeleg und genau eine verknüpfte offene Aufgabe. Diese Aufgabe fordert **manuelle Prüfung** vertraglicher Folgen und einer Anzahlung. Sie bestätigt keine Vertragsaufhebung oder Rückzahlung. Bestehende Aufgaben ohne eindeutige Reservierungsbindung sowie Verträge, Deals und Zahlungsdatensätze werden nicht geändert. Ein Audit-/Belegfehler rollt auch Einheit und Aufgabe zurück. Ein identischer Retry mit unveränderten IDs konvergiert; entzogene Mitgliedschaft, Projektberechtigung oder Vollmacht erlauben auch keinen Beleg-Replay.

Bestand, Fristwarnungen und Reports behandeln `withdrawn` als beendet. Historische Rücknahmen bleiben im Projektverkaufsverlauf sichtbar. Eine neue offene Reservierung darf hinter älterer Rücknahmehistorie ihre Fristwarnung behalten.

## Migration und Rückweg

Die additive Migration `200_property_reservation_withdrawal` erweitert nur die bestehende Statusprüfung. Historische Migration 082, RLS, Integritäts- und Auditregeln bleiben unverändert; der Runner verlangt 082 als Vorgänger. Migration 200 führt keine Rücknahmen aus.

Sobald `withdrawn`-Zeilen existieren, müssen 199 und 200 beim Anwendungsrückweg erhalten bleiben. Der unveränderte Stand `a1a1995529916c78622d421aa25add5442910a91` ist dafür kein zulässiger Leser: sein Core-Loader bildet unbekannte Statuswerte auf `hold` ab und erzeugt eine falsche aktive Vormerkung. Eine Rückübersetzung auf `expired` ist kein zulässiger Ersatz.

Für den bisherigen lokalen Rückweg `013cd4495c597f8809c62e6feeccf32a04402131` liegt deshalb eine getrennte, eng begrenzte Lesekorrektur vor. Sie übernimmt nur den terminalen Status, Beschriftungen und Warnungsselektion, keinen neuen Rücknahme-Schreibweg. Die lokale Probe liest dieselbe tatsächlich zurückgenommene synthetische Reservierung auf Schema einschließlich 199/200, weist korrekte Reportzahlen nach und bestätigt die Ablehnung neuer Rücknahmebefehle durch die alte Anwendung. Das qualifiziert diesen Lesepfad, keine vollständige gehostete Wiederherstellung oder sämtliche Schreibwege eines Rollbacks.

## Nachweisgrenze

Gezielte lokale PostgreSQL- und Cookie-/CSRF-Tests prüfen Erfolg, Aufgaben-/Preis-/Historienerhalt, Versionskonflikte, Projekt-/Mandantengrenzen, Rechteentzug, parallele Befehle, Audit-/Belegfehler und terminale Warnungen. Die portable lokale Vertriebsfixture ist keine produktionsnahe native Upgradeprobe. Die Prüfung im App-Browser und die Bindung an den später zentral übernommenen Releasekandidaten erfolgen gesondert im autorisierten CRM-Testchat. Für Tests werden ausschließlich isolierte synthetische Reservierungen verwendet.
