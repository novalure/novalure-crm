# Evelyn: KI für das Tagesgeschäft im CRM

## Ziel und Recherche

Ein sichtbarer Arbeitsassistent soll Maklern wiederkehrende Arbeit abnehmen, mit den aktuell zugänglichen CRM-Daten arbeiten und prüfbare Entwürfe liefern. Der Kunde muss keine Bots konfigurieren und keinen eigenen API-Schlüssel hinterlegen.

Die Recherche vom 4. November 2026 nutzt Produktinformationen der Anbieter:

- [Propstack: Proppi und CRM-Kontext](https://www.propstack.de/): verbindet Kontakte, Immobilien, E-Mails, Notizen, Aufgaben und Termine, um offene Punkte und nächste Schritte vorzubereiten.
- [PropstackAI: konkrete Maklerprozesse](https://www.propstack.de/ki-im-immobilien-crm-propstackai/): Objektaufnahme, Dokumentation und Vermarktung profitieren besonders von weniger manuellen Übergaben.
- [onOffice: KI-Unterstützung bei E-Mails](https://onoffice.com/blog/onoffice-inside/release-august/): Antworten formulieren, Stichpunkte ausformulieren, korrigieren, umformulieren, Anrede ändern und zusammenfassen.
- [Reapit: Sales CRM](https://www.reapit.com/platform/sales-crm): Aufgaben, Nachrichten, Termine und Vertriebsfortschritt in einem Arbeitskontext.

Unsere daraus abgeleitete Produktentscheidung: zuerst häufige, gut prüfbare Aufgaben umsetzen; vorhandene Daten, Berechtigungen und Guthaben verwenden. Funktionsbeschreibungen der Wettbewerber belegen keine Funktionsgleichheit unseres Produkts.

## Erste nutzbare Version

| Aufgabe | Grundlage | Ergebnis für den Kunden |
| --- | --- | --- |
| Mein Tagesüberblick | Eigene/unzugeordnete Aufgaben und Termine, zugängliche Anfragen, Fristen | Bis zu fünf begründete Prioritäten mit nächsten Schritten |
| Pipeline analysieren | Exakte zugängliche Summen und begrenzte Detailauswahl | Offene nächste Schritte, veraltete Vorgänge und Datenlücken; keine erfundene Umsatzprognose |
| Lead zusammenfassen | Gewählte Anfrage, lesbarer Kontakt, bisherige Aktivitäten, Aufgaben und Termine | Gesprächsvorbereitung und sinnvolle Rückfragen |
| E-Mail entwerfen | Gewählter Lead, optional eingefügte Nachricht/Stichpunkte, gewünschter Ton und Sprache | Bearbeitbarer Betreff und Nachricht, kopierbar und als Text herunterladbar |
| Objekttext schreiben | Gewähltes aktuelles Objekt mit bekannten Eigenschaften | Factualer Vermarktungstext; fehlende Angaben bleiben offen |
| Frage zu meinen CRM-Daten | Zugängliche CRM-Momentaufnahme und eingegebener Text | Konkrete Antworten, Zusammenfassungen, Übersetzungen und Vorschläge |

Zugang: **Wissen & KI → KI-Assistent**, zusätzlicher Kopfbereich-Button, direkte Route `#ai-assistant`. Für aktive interne/Kundenmitarbeiter; keine reine Beobachter- oder Vertriebspartnerrolle. Die Projektwahl bestimmt den Datenbereich. Antwortsprache Deutsch, Englisch oder Spanisch unabhängig von der CRM-Sprache; Tagesgrenzen aus der Browserzeitzone.

## Ergebnis- und Kostenverhalten

- Echte Modellaufrufe laufen über die vorhandene zentrale KI-Anbindung und verbrauchen das bestehende Unternehmenskontingent.
- Vor dem Aufruf wird Guthaben reserviert; nach bestätigter Nutzung werden die tatsächlichen Credits abgerechnet.
- Antworten werden privat für den anfragenden Mitarbeiter gespeichert. Dieselbe Anfragekennung liefert denselben gespeicherten Ausgang und ruft das Modell nicht erneut auf.
- Unklare Netzwerkergebnisse werden nicht als fertige Antworten ausgegeben. Reservierungen bleiben bis zur Prüfung erhalten.
- E-Mail-Ergebnisse bleiben Entwürfe. Diese Version verschickt keine Nachrichten und ändert keine Geschäftsdaten.
- Quellen, Datenstand und Verbrauch sind sichtbar. Summen werden über alle zugänglichen Datensätze berechnet; die Detailauswahl im Modellkontext ist begrenzt.
- Berechtigungen, Projektzugang und deaktivierte Module werden vor der Verarbeitung und vor der Ausgabe erneut geprüft. Persönliche E-Mail-Postfächer werden nicht automatisch eingelesen.

## Sinnvolle weitere Ausbaustufen

1. Entwürfe direkt aus einer ausgewählten, persönlich freigegebenen E-Mail starten; kontrollierte Übergabe in den vorhandenen Mail-Composer.
2. Aus Vorschlägen nach ausdrücklicher Bestätigung Aufgaben oder Notizen erstellen, mit Vorschau und nachvollziehbarem Änderungsbeleg.
3. Antworten aus freigegebenen Unternehmensdokumenten mit geprüften Quellen- und Versionsrechten ergänzen.
4. Besichtigungsnotizen diktieren und strukturierte Gesprächsprotokolle erstellen; Einwilligung und Sprachverarbeitung gesondert gestalten.
5. Mehr Objektaufnahme-, Dokument- und Vermarktungsabläufe ergänzen, sobald aktuelle Daten zuverlässig aufgelöst werden können.

Diese Ausbaustufen sind kein Bestandteil der ersten ausgelieferten Version. Es gibt keine automatischen Wohnungs-, Kredit- oder Eignungsentscheidungen und keine verbindlichen Bewertungen.
