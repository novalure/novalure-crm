# Gezielter Testentwurf: Reservierungshistorie und manuelle Folgeaufgaben

Stand: 7. November 2026. Gezielter Test im gemeinsamen Worktree. Die Datei `scripts/reservation-history-tasks-tests.ts` verwendet genau eine vorhandene lokale Sales-PG-Fixture (`startLocalSalesDb` / `applySalesSchema`) und reguläre Route-Handler mit echten `Request`/`Response`-Objekten. Sie startet keinen Next-/HTTP-Server und enthält keinen Browser-, Provider-, Mail- oder Produktivnachweis. Der historische Sales-Schemabootstrap behält seine dokumentierten Ausschlüsse; daraus folgt keine vollständige Produktionsmigrationsprüfung oder SCRAM-Browserqualifikation.

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

Root führt diesen gezielten Lauf nach Freigabe des gemeinsamen Backend-/UI-Entwurfs aus. Keine Wiederholung der vollständigen 81er-Rücknahme- oder 96er-Kalendersuite. Gesamterfolg des korrigierten Scripts ist erst durch den erneuten tatsächlichen Lauf belegt; bestehende frühere Browserbelege behalten ihre Original-SHA und werden dadurch nicht neu zu PASS erklärt.

## Erster tatsächlicher Root-Lauf und enge Fixturekorrektur

Der abgeschlossene Lauf auf `195fe315bb5abc23a20f8c762e81a7b3d5f13a2c` in `history-tasks-195fe31.log` ergab zehn vollständig bestandene Unterfälle und drei fehlgeschlagene Unterfälle; Node zählt zusätzlich den dadurch fehlgeschlagenen äußeren Fixturetest (14 insgesamt, 10 PASS, 4 FAIL). Exitcode 1. Laut Root war der eigene PG-Port 60389 nach Abschluss mit `ECONNREFUSED` geschlossen. Dies ist kein Gesamt-PASS.

Zwei Unterfälle scheiterten ausschließlich am vollständigen Receiptvergleich von direkten PG-`Date`-Objekten mit den ISO-Strings des gespeicherten JSON-Receipts. Die Korrektur normalisiert beide vollständigen `data`-Bäume über JSON, ohne Felder zu entfernen. Die nach der jeweiligen fehlgeschlagenen Assertion liegenden Historien-/Reassignment- beziehungsweise weiteren Parallel-/Zählerassertions waren im ersten Lauf noch nicht erreicht.

Der Cookie-/CSRF-Unterfall erreichte die reguläre Anfrage, Wiederholung, Core-Aufgabe, History-GET, den verweigerten generischen Reconcile, doppelte Selektoren und beide frischen unangemeldeten GETs (401). Der anschließende SQL-Fixtureentzug setzte bisher nur `revoked_at` und verletzte dadurch `auth_sessions_revocation_reason_check` aus Migration 056. Die Korrektur setzt wie vorhandene HTTP-Fixtures gemeinsam `revoked_at` und `revoked_reason='SYNTHETIC HTTP test'`. Der eigentliche GET mit widerrufenem Cookie und die nachfolgenden Unverändertheitsassertions sind erst im erneuten Lauf zu belegen. Keine Constraint- oder Grantänderung und kein Backendfehler wird daraus abgeleitet.

Alle zehn anderen Unterfälle waren im ersten Log vollständig grün, einschließlich echter K-vor-Unit-Sperrprobe, Legacy-NULL-Receiptgrenzen, Pagination, atomarem Rollback und der vier spezifischen Vollmachtentzüge. Ein erneuter gezielter Lauf des korrigierten Scripts bleibt Root vorbehalten; frühere Belege werden unverändert erhalten.
