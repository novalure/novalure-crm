# Persönlicher Kalender – lokale UI-Prüfung

Arbeitsbasis: `7b4d9ca7eb79d19e5529c2a7aa22ed77ebec1e40`. Gemeinsame Arbeitskopie mit separater Root-API-/193- und Providerarbeit; kein eigener UI-Commit. Die Einzelfilehashes in `ui-validation.json` binden diesen UI-Stand. Der spätere gemeinsame Quellenabschluss wird von Root festgehalten.

Die Oberfläche verwendet ausschließlich die neue persönliche, workspacegebundene API und die persönliche OAuth-Brücke. Login-ID besitzt den RAM-Store; Ziel-Workspace und aufgelöste Actor-ID trennen seine Einträge. GET muss den Workspace und eine gültige Zielmitgliedschaft bestätigen; neue Befehle frieren deren `expectedActorId`, Endpoint, Body und UUID ein. Verlorene oder unbestätigte Antworten erlauben nur ausdrücklichen identischen Retry. Auch ein erster 403/409 ist kein Beweis, dass kein Anbieterzugriff begonnen hat: Nur ein ausdrückliches serverseitiges `notStarted:true` bei einem zuvor nicht unklaren Versuch gibt einen 4xx-Intent für Korrekturen frei. Nach unklarem Ausgang bleibt dieselbe Kennung unabhängig von diesem Marker erhalten.

Bestehende Booking-Konfiguration und Buchungsansichten bleiben erhalten. Der alte immer-erstellende Kalender-Sync wird aus dieser Oberfläche nicht mehr aufgerufen; seine Schaltfläche öffnet die persönliche Verwaltung. Bookings oder fremde Herkunft werden nicht als eigene Standalone-Ereignisse angeboten. `processing`/`uncertain` sind keine Anbieterbestätigung. `synced` benötigt den passenden verifizierten Remote-Snapshot. Definitiv fehlgeschlagene lokale Anlagen können ohne Anbieterabsage verworfen werden. Externe Änderungen einschließlich Stornierung werden erst nach sichtbarem Vergleich, Versionsprüfung und Snapshot-ETag-Echo übernommen.

Die Uhrzeiteingabe verwendet die gewählte IANA-Zone. DST-Lücken werden blockiert; doppelte Herbstzeiten benötigen eine Auswahl. Reine Textänderungen erhalten vorhandene Sekunden/Millisekunden und deren ursprüngliches DST-Vorkommen. Projekt und Anbieter bleiben beim Edit unveränderlich; ein im aktuellen Projektfilter nicht mehr vorhandener Create-Entwurf wird nicht automatisch einem anderen Projekt zugeordnet.

Einladungsbestätigung gilt für bisherige und gewünschte Empfänger. Die bisherige Empfängerunion bleibt auch beim Entfernen aller Teilnehmer sichtbar und bestätigungspflichtig. Anzeigen enthalten keine hartcodierten echten Kontoadressen. Die Oberfläche behauptet keine Serienverwaltung oder allgemeine Kalenderimport-Funktion: Sie verwaltet nur eigene journalisierte Standalone-Ereignisse und deren Roundtrip.

## Ausgeführte lokale Prüfungen

- `node --import tsx scripts/personal-calendar-ui-tests.mjs`: **23/23 bestanden**, keine Browserfehler. Reale React-Komponente und echter RAM-Store unter StrictMode, lokale Chrome-Instanz und ausschließlich synthetisches Loopback-HTTP. Szenarien und Ergebnisse: `ui-browser-results.json`, Konsolenausgabe: `ui-browser.log`.
- `node --import tsx --test scripts/calendar-oauth-source-tests.mjs scripts/calendar-accessibility-smoke-tests.mjs`: **12/12 bestanden**, 0 Fail/Skip. Nachweis: `ui-compatibility.log`.
- Typecheck und fokussierter ESLint mit 0 Warnungen wurden auf dem UI-Stand geprüft. Root führt die finale gemeinsame Gruppe erneut aus; die UI-Zahlen sind kein Ersatz für diesen Kandidatennachlauf.

Die anfängliche von Root gemeldete Kompatibilitätsprüfung **9/12 mit drei Fehlern** wird nicht nachträglich umetikettiert. Ein echter neuer Fehler war die anfängliche Anzeige „Nicht verbunden“ vor dem ersten GET; sie zeigt jetzt unbekannt/lädt beziehungsweise nicht verfügbar. Zwei Assertions verlangten den absichtlich entfernten Legacy-Syncwriter bzw. dessen zehnte Home-Guard-Funktion. Die angepasste Prüfung führt alle neun verbliebenen Writer mit verweigertem Home-Kontext aus, verlangt das Fehlen des alten Always-create-Calls und prüft die neuen workspacegebundenen persönlichen Connectlinks. Der entfernte Writer wird nicht mit einer gelockerten Guard-Regel ersetzt.

Ein enger Outcome-Protokollnachlauf schlug zunächst an der alten Versionskonflikt-Fixture fehl: Sie stellte einen definitiven Prestage-409 ohne den nun erforderlichen Nichtbeginn-Nachweis dar. Teilresultat und Standardausgabe bleiben als `ui-outcome-protocol-initial.json`/`.log` erhalten; der Assertion-Stacktrace liegt im Toolprotokoll. Die korrigierte Struktur-/Versions-Fixture sendet den echten neuen Vertragsmarker. Der zusätzliche erste-403-Fall prüft dagegen ausdrücklich ohne diesen Marker den Erhalt des identischen Requests über Remount und Retry.

## Peerreview und gezielte Nachbesserungen

Der begrenzte unabhängige Quellreview identifizierte die Bestätigung beim Entfernen aller Teilnehmer, Sekunden-/Millisekundenverlust bei reinen Textänderungen, editierbare unveränderliche Projektbindung, unvollständige Dirty-Erkennung und fehlende aktuelle Listenaktualisierung nach Same-Scope-Remount. Diese Punkte haben gezielte Komponentenregressionen. Scoped Abschlussversionen invalidieren die aktive Instanz; neue Writes bleiben bis zum frischen GET gesperrt. Nur der aktuelle Scope darf die CRM-Elternansicht aktualisieren. Vollständig zurückgesetzte Formulare und reine Statusmeldungen gelten nicht dauerhaft als ungespeichert.

## Nachweisgrenze

Keine Provider-, OAuth-, Kunden-, Produktionsdatenbank- oder Liveaktion wurde durch diese UI-Prüfung ausgeführt. Kein Browser→wirklicher Anwendungsserver→PostgreSQL→Provider-End-to-End-Nachweis. Root-/Provider-Tests und spätere kontrollierte externe Abnahme bleiben gesonderte Belege. Kein Deployment, keine Migration, keine Einladungen, keine echten Mails und keine zusätzlichen Kosten. RAM-Inhalte werden nicht in localStorage/sessionStorage geschrieben und bei Wechsel der tatsächlichen Login-Identität synchron verworfen.
