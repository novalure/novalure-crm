# Gezielter Testentwurf: Reservierungshistorie und manuelle Folgeaufgaben

Stand: 7. November 2026. Vorbereitung im gemeinsamen Worktree; noch kein funktionaler Lauf. Die Datei `scripts/reservation-history-tasks-tests.ts` verwendet genau eine vorhandene lokale Sales-PG-Fixture (`startLocalSalesDb` / `applySalesSchema`) und reguläre Route-Handler mit echten `Request`/`Response`-Objekten. Sie startet keinen Next-/HTTP-Server und enthält keinen Browser-, Provider-, Mail- oder Produktivnachweis. Der historische Sales-Schemabootstrap behält seine dokumentierten Ausschlüsse; daraus folgt keine vollständige Produktionsmigrationsprüfung oder SCRAM-Browserqualifikation.

## Dreizehn eng begrenzte Unterfälle

1. Anfrage, Bestätigung und Verlängerung: je genau eine offene manuelle Aufgabe, korrekter Mandant/Projekt/Kontakt/Lead/aktueller Actor, `due_at IS NULL`, Reservierungsfrist nur in Metadaten; Task-ID im unveränderlichen Receipt und Historien-DTO. Spätere rechtmäßige Neuzuweisung bewahrt den historischen Link und ursprünglichen Actor.
2. Ablauf einer synthetisch bereits fälligen Reservierung: genau eine ebenfalls undatierte Aufgabe. Rücknahme: genau eine bisherige Aufgabe mit DB-`now()` bleibt unverändert. Zusammen werden alle fünf Reservierungs-Historienarten geprüft.
3. Friständerung, veränderte Wiederholung und echte parallele Befehle: Versions-/Idempotenzkonflikt ohne zusätzliche Aufgaben; identische Wiederholung genau ein Command/Task und ursprüngliches Receipt.
4. Fehlender Freigabenachweis sowie kontrollierte Fehler beim Aufgaben-, Audit- oder Receipt-Insert: Reservierung, Einheit, Aufgabe und Command-Belege rollen gemeinsam zurück. Die nur lokal eingefügten Fehlertrigger werden jeweils entfernt.
5. Ältere `resource_id IS NULL`-Receipts bleiben bei exakt passendem Event-/Receipt-/Record-Scope lesbar. Falscher W/P/U/R-Bezug, Actor, Operation, Audit, Correlation, Resource oder Status wird ausgeschlossen. Keine historischen Vorherwerte oder Aufgaben werden erfunden.
6. Unit-Audit als getrennte sanierte Quelle; Reservierungsfilter erfordert einen tatsächlichen Bezug derselben Einheit. Rohe Preise, Käufermail/-telefon und gezielte private Payloadmarker gelangen nicht ins DTO. Dies ist keine allgemeine PII-Erkennung für erlaubten Actor-Namen oder begrenzten fachlichen Quellenfreitext.
7. 45 Ereignisse mit gleicher Mikrosekunden-Zeit: zwei Seiten mit 40/5 eindeutigen Einträgen; stabile Wiederholung; Cursor strikt an W/P/U/R gebunden, fehlerhafte Cursor abgelehnt.
8. Frischer Projekt- und Actorentzug blockiert Lesen, Befehlswiederholung und neue Folgeaufgabe ohne neue Domain-Effekte.
9. Entzug der spezifischen Bauträgervollmacht blockiert auch identische Bestätigungs-/Verlängerungs-Replays. Anfrage und Ablauf bekommen keine erfundene zusätzliche Vollmacht.
10. Echter initialer Preisfreigabebefehl, danach ausschließlich Entzug der spezifischen Preisvollmacht: identische Wiederholung liefert keine alte Receiptantwort; keine neue Wirkung.
11. Echter initialer Verkaufsfreigabebefehl, danach ausschließlich Entzug der spezifischen Verkaufsvollmacht: dieselbe enge Wiederholungsgrenze ohne Preis-/Verkaufssuite.
12. Echter gespeicherter v2-Cookie plus regulärer CSRF: Reservierungsanfrage, erneute identische POST-Anfrage, kundenseitiger Core-Task und private History-GET. Fehlender CSRF, frische unangemeldete GETs, doppelte Selektoren und widerrufener Cookie verweigern. Der generische Reconcile-Endpunkt bleibt für Property-Sales auch bei bekanntem Receipt `UNSUPPORTED_OPERATION`.
13. Unterschiedliche echte Befehle (Anfrage und Preisfreigabe) teilen absichtlich denselben Idempotenzschlüssel und dieselbe Correlation. Eine dritte Transaktion hält die exakte Idempotenzsperre. Beide echten Tenant-PIDs müssen an dieser Sperre warten; eine unabhängige `FOR UPDATE NOWAIT`-Probe muss die konkrete Einheit dennoch sperren können. Nach Freigabe genau ein Commit und ein `409 IDEMPOTENCY_CONFLICT`, ein Receipt und nur gegebenenfalls die eine Anfrageaufgabe. Das beobachtete DB-Sperrkriterium ersetzt eine zeitabhängige Pause; die Befehle haben ein begrenztes Statementbudget.

## Ausführung nach gemeinsamem Freeze

```text
node --conditions=react-server --import tsx --test --test-concurrency=1 scripts/reservation-history-tasks-tests.ts
```

Root führt diesen gezielten Lauf erst nach Freigabe des gemeinsamen Backend-/UI-Entwurfs aus. Keine Wiederholung der vollständigen 81er-Rücknahme- oder 96er-Kalendersuite. Bis zu einem tatsächlichen Lauf bestehen ausschließlich vorbereitete Assertions und statische Prüfung; bestehende frühere Browserbelege behalten ihre Original-SHA und werden dadurch nicht neu zu PASS erklärt.
