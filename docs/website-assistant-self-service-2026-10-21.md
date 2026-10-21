# Website-Chat über die zentrale CRM-Plattform

## Betriebsmodell

Novalure betreibt ein gemeinsames CRM, eine gemeinsame öffentliche Chat-API und ein gemeinsames Widget. Ein Kunde verbindet seine bestehende Website durch eine gespeicherte CRM-Verbindung und ein Script. Weder ein eigenes Vercel-Konto noch ein Vercel-Teamplatz, GitHub-Zugang oder ein Deployment pro Kunde bzw. Domain ist dafür vorgesehen.

Die vorhandene Vercel-Blockade bei Studio PR 8 betrifft die interne Git-/Deployment-Identität `Franz-source104`. Sie ist von der Kundenanbindung unabhängig. Kundenverträge und Nutzungskontingente bleiben CRM-Daten. Die zentralen Hosting-, Datenbank- und Modellkosten entstehen beim Plattformbetreiber und können in dessen Kundenpaketen abgebildet werden. Dieser Änderungsvorschlag bestellt keine neuen Konten, Plätze oder Abonnements.

## Ablauf für einen berechtigten Kunden

1. Im CRM den passenden Assistenten und das zugehörige Projekt auswählen. Die vorhandene Assistentenverwaltung bleibt für dessen Anlage zuständig.
2. Wissen veröffentlichen und dem Assistenten ausdrücklich für Webchat zuordnen. Die erste Wissenszuordnung reserviert einen Assistentenplatz.
3. Unter „Wissen & KI → Websites“ eine Website-Verbindung anlegen. Exakte HTTPS-Adressen, z. B. `https://www.example.com`, eintragen. Eine alternative Adresse ohne `www` muss gesondert erlaubt werden.
4. Assistent und Darstellung wählen. Neue Verbindungen beginnen im Trainingsmodus mit Status `test`. Dieser Status ist auf den erlaubten Websites bereits öffentlich erreichbar und kann Modellnutzung auslösen; für die erste Prüfung eine Testdomain verwenden.
5. Den ausgegebenen Code in die eigene Website einfügen:

   ```html
   <script async src="https://www.novalure-crm.app/chat/widget.js" data-site-key="PUBLIC_SITE_KEY_FROM_CRM"></script>
   ```

6. Reale Wissensfragen, fehlendes Wissen und eine nicht erlaubte Domain prüfen. Die Anzeige „veröffentlichtes Wissen vorhanden“ ist noch kein bestandener Antworttest.
7. Nach erfolgreicher Abnahme den gewünschten Betriebsstatus setzen. Die Verbindung kann später pausiert oder widerrufen werden. Ein Widerruf ist endgültig; eine neue Verbindung erhält einen neuen öffentlichen Schlüssel.

Der öffentliche Schlüssel ist eine Widget-Kennung, kein Provider- oder Administratorschlüssel. Die Website braucht keinen Zugriff auf interne Zugangsdaten. Diese Verwaltung bearbeitet erlaubte Website-Adressen; sie registriert keine Domains und ersetzt keine DNS-Verwaltung oder einen Nachweis des Domainbesitzes.

## Umsetzung und Grenzen

### Verwaltung

`/api/integrations/websites` verwendet die dauerhafte angemeldete CRM-Sitzung, die aktuelle Mitgliedschaft, CSRF-Schutz und Projektrechte. Ein Assistent muss aus demselben Mandanten und demselben Projekt stammen. Aktualisierungen benötigen den unveränderten Zeitstempel des gelesenen Datensatzes; ein Konflikt lässt den Entwurf zur erneuten Prüfung bestehen.

Bestehende Formular-/Lead-Fähigkeiten, öffentliche Schlüssel und private Konfiguration werden bei einer Chat-Reparatur erhalten. Eine neue bzw. aktive Chat-Verbindung benötigt gültigen Vertrag, freigeschalteten Webchat und zugeordnetes veröffentlichtes Wissen. Reiner Entzug und Pause bleiben auch nach Vertrags- oder Modulabschaltung möglich. Ein inzwischen unveröffentlichtes altes Formular blockiert die Chat-Entkopplung nicht.

### Assistentenkontingent

`limits.maxAssistants` zählt unterschiedliche Assistenten mit mindestens einer gespeicherten Wissenszuordnung. Mehrere Domains, Wissensbereiche und Kanäle desselben Assistenten zählen einmal. Unverbundene Botentwürfe zählen nicht. Archivierte Bereiche und pausierte Kanäle geben keinen Platz frei; erst der ausdrückliche Entzug des letzten Grants tut dies. Ein Downgrade löscht keine bestehenden Daten, blockiert aber zusätzliche Verbindungen über dem Limit.

Migration 107 ergänzt einen eng begrenzten Zähler mit aktueller Mandanten-/Mitgliedschaftsprüfung. Das Gesamtaggregat berücksichtigt auch Projekte, die der jeweilige Benutzer nicht einzeln lesen darf. Eine gezielte Bot-Abfrage setzt dessen Lesbarkeit voraus. Parallele Vergaben des letzten Platzes werden in einer Transaktion serialisiert. Details: `knowledge-connected-assistant-quota-2026-10-21.md`.

### Antworten

`/api/public/integrations/chat/answers` nimmt nur Sitzung und Frage an. Mandant, Projekt, Assistent, Branche, erlaubte Domain und Wissen stammen aus der gespeicherten Verbindung. Die vollständige Originalfrage bleibt in den Schutzprüfungen erhalten; eine begrenzte deterministische Suche bewahrt deutsche, englische und spanische Originalbegriffe und ergänzt ausgewählte Suchsynonyme.

Der neue Modellpfad erhält höchstens fünf veröffentlichte Auszüge. Die serverseitige Ausgabe ist strukturiert, auf 900 Ausgabe-Tokens und 20 Sekunden begrenzt; es gibt keine automatischen Modellwiederholungen. Quellenangaben dürfen nur aus den tatsächlich übergebenen Quellen und Versionen stammen. Ohne ausreichendes Wissen bzw. bei einem Providerfehler folgt eine ehrliche Standardantwort. Vor und nach dem Modellaufruf werden Berechtigung, Sitzung, Bindung und alle verwendeten Veröffentlichungen erneut geprüft. Eine währenddessen entzogene Quelle darf nicht mehr ausgegeben werden.

Der allgemeine Preisfilter berücksichtigt jetzt die gespeicherte Projektbranche. Website-Paketpreise im Bereich `WEB_DESIGN` bleiben nutzbar, während konkrete Immobilienpreise und Verfügbarkeit weiterhin den bestehenden Schutz benötigen. Der Browser kann diese Branche nicht wählen.

Diese erste gemeinsame Antwortfunktion führt keine CRM-Aktionen aus, bucht keine Termine und behauptet keine gespeicherte Anfrage oder Übergabe. Sie sendet keinen Gesprächsverlauf an das Modell und speichert keine Antworten als CRM-Chatnachrichten. Die vorhandenen separaten Formular-/Lead-Pfade bleiben eigenständig. Struktur- und Quellenprüfungen allein beweisen nicht die inhaltliche Richtigkeit jeder echten Modellantwort; reale Antwortabnahmen bleiben erforderlich.

### Widget und Website-Einbettung

Script und CSS werden zentral ausgeliefert. API-Anfragen verwenden die Script-Origin, `credentials: omit`, die echte Browser-Origin und den öffentlichen Schlüssel. Das Sitzungstoken bleibt im Arbeitsspeicher des Widgets; es wird nicht in URL, DOM oder Browser-Speicher geschrieben. Antworten werden als Text gerendert.

Vor der ersten gesendeten Frage zeigt das Widget neutrale Standards. Erst dann wird eine Sitzung angelegt und deren gespeicherte Darstellung übernommen: Unternehmen, Name, Begrüßung, Farbe, Position und Sprache. Es gibt keinen Vorab-Sitzungsaufruf beim bloßen Laden der Website.

Bei einer kundenseitigen Content Security Policy müssen `script-src`, `style-src` und `connect-src` den Host `https://www.novalure-crm.app` erlauben. Das statische Widget-Layout wird als externe CSS-Datei geladen; eine globale `unsafe-inline`-Freigabe ist dafür nicht vorgesehen. Eine echte Browserprüfung mit der konkreten Kunden-CSP gehört zur Abnahme.

## Lokale Nachweise

Die Regressionen laufen ausschließlich mit synthetischen Daten und normaler, RLS-gebundener Laufzeitrolle auf isoliertem PostgreSQL. Modelltests verwenden den offiziellen AI-SDK-Mock und verursachen keine echten Providerkosten.

- Branchen-/Knowledge-Runtime-Regressionen: 59 erfolgreich, keine übersprungen.
- Kontingent und Verwaltung nach Vertragsaus: 8 erfolgreich, einschließlich letztem freien Platz bei parallelen Anfragen und verborgenem Projekt.
- Website-Verwaltung: 10 erfolgreich, einschließlich dauerhafter Cookie-Sitzung/CSRF, fremden Mandanten und Projekten, Konflikten, Widerruf und konkurrierendem Besucher-/Editorzugriff.
- Antwortpipeline: 10 erfolgreich, einschließlich deutscher/spanischer Originalquellen, nachträglichem Entzug, Providerfehlern, ungültigen Referenzen, strikten HTTP-Feldern, CORS und Sitzungslimit.
- Embed-Schlüssel: 2 erfolgreich, einschließlich neuer Base64url-Schlüssel und Attribut-Injektion.
- Widget-Verhalten: 7 erfolgreich, einschließlich gespeicherter Darstellung, Sprachwahl, Textausgabe, Sitzung erst bei erster Frage und Tokenbegrenzung.
- Bestehende öffentliche Gateway-Regressionen einschließlich gespeicherter Sprache: 10 erfolgreich.
- Checksummierter Migrationsplan einschließlich des Vorgängers von Migration 107: 21 erfolgreich.

Der zusätzliche echte React-Browsertest ist lokal erfolgreich und in CI eingebunden. Zwei vollständige UI-Szenarien prüfen Anlage im Trainingsmodus, Projektfilter, Embedcode, Bearbeitung mit unverändertem Zeitstempel, Erhalt des Entwurfs nach einem Konflikt sowie reine Pause-Berechtigung. Der echte `WebsiteIntegrationPanel` und `csrfFetch` liefen in Chrome for Testing 153.0.8010.12 gegen ausschließlich synthetische HTTP-Antworten auf Loopback. Es gab keine Browserfehler oder unerwarteten Netzanforderungen. Dies ist ein UI-Nachweis mit simulierten HTTP-Antworten, keine gehostete Auth-/Datenbank-/Provider-Abnahme.

Der erste Browserdownload über das Playwright-CDN lieferte eine HTML-Fehlerseite. Die anschließend verwendete offizielle Google-Quelle war im Chrome-for-Testing-Manifest exakt für die von Playwright 1.63.0 verlangte Version ausgewiesen; das vollständige ZIP wurde geprüft. Der Qualitätslauf muss die Browserfälle weiterhin am endgültigen Commit bestätigen.

Der vollständige Befehl `npm run test:knowledge-center` besteht mit 217 Server-/Datenbank-/Auth-Tests und 19 UI-Tests. Die historischen 60/13/94-Vorgängerprüfungen bleiben unverändert; Migration 107 wird in diesen Fixtures erst vor den aktuellen Anwendungsszenarien ergänzt. Die zusätzlich betroffene Monitoring-Fixture besteht mit 8 Tests. Der gepinnte Gitleaks-Scanner meldet sowohl über die vollständige Historie als auch im aktuellen Dateibaum null Funde. Die einzige neue Ausnahme erfasst genau einen unabhängig geprüften historischen synthetischen öffentlichen Widget-Schlüssel; keine aktuelle Dateiausnahme oder Scanregel wurde ergänzt bzw. deaktiviert.

Die neuen Fälle sind über `npm run test:website-self-service` und die bestehende Kontingent-/Knowledge-Suite in den Qualitätslauf eingebunden. Ein unabhängiger technischer Review während der Implementierung ersetzt den vorgeschriebenen GitHub-App-Check auf dem endgültigen Commit nicht.

Gesamtes ESLint ohne Warnungen, TypeScript-Prüfung und Next.js-Produktionsbuild waren lokal erfolgreich. Der Audit der Produktionsabhängigkeiten meldete keine bekannten Schwachstellen. Der erste Build in der eingeschränkten Sandbox blieb stehen; nach gezieltem Beenden ausschließlich dieses Prozesses war derselbe Build mit regulären lokalen Workerfunktionen erfolgreich.

## Freigabe und Rollout

1. Den endgültigen Commit mit dem verpflichtenden unabhängigen App-Review und den normalen CI-Gates freigeben. Die derzeitige Reviewer-Sperre wird durch diesen Änderungsvorschlag nicht aufgehoben.
2. Einen isolierten Preview-Datenbankzweig und die passenden Runtime-/Migrationrollen verwenden. Migration 107 über den vorhandenen checksummierten `db-migrate.mjs`-Ablauf erst planen und dann mit dessen Plan-Token anwenden. Der Runner verlangt den veröffentlichten Vorgänger 101. Keine direkten Schemaänderungen über die normale Runtime-Rolle.
3. Migration 107 vor dem zugehörigen Anwendungscode bereitstellen. Das neue Knowledge-Snapshot benötigt die Zählerfunktion. Das Schema ist additiv; bei einem Anwendungsrollback auf die vorherige freigegebene Version kann die neue Funktion zunächst bestehen bleiben. Der vorherige Code erzwingt das neue Kontingent allerdings nicht.
4. Serverseitigen AI-Gateway-Zugang und `NOVALURE_LLM_MODEL` auf dem freigegebenen Ziel prüfen. Keine Schlüssel in Embedcode oder Browser übernehmen. Den tatsächlichen Providerpfad und dessen Kosten einmal mit echten, begrenzten Fragen abnehmen.
5. In zwei isolierten Mandanten den ganzen Ablauf prüfen: Wissen veröffentlichen, Assistent zuordnen, Domain verbinden, einbetten, antworten, Quellversion ändern, Zugriff entziehen und erneut abfragen. Fremde Schlüssel, Origin, Sitzung, Bot- und Projektbezüge müssen scheitern. Lokale Negativtests ersetzen diesen Nachweis auf dem bereitgestellten Ziel nicht.
6. Erst anschließend für Studio bzw. den jeweiligen Kunden freischalten. Vorherige Bereitstellung als Rückfallziel und minimale Diagnosebelege bereithalten.

## Bereits beobachteter Studio-Zustand

Die bestehende Studio-Webchat-Wissenszuordnung und die alte Integration wurden im autorisierten Wartungsschritt repariert, mit Auditnachweis und erhaltenem Formular-/Lead-Kontext. Ein echter öffentlicher Sitzungsaufruf war danach erfolgreich. Die erlaubte Domain blieb `https://novalurestudio.ie`, der Modus blieb `training`.

Die anschließenden echten Wissensabfragen fanden serverseitig veröffentlichte Quellen, verwarfen deren Inhalte jedoch durch den alten Preisfilter. Deshalb gab es zu diesem Zeitpunkt noch keine erfolgreiche echte Modellantwort. Die hier beschriebenen neuen Änderungen, Migration 107 und das gemeinsame Widget sind mit diesem Dokument noch nicht als produktiv bereitgestellt bestätigt.
