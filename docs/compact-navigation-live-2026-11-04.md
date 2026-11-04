# Kompakte CRM-Navigation und Website-Blautöne sind live

Veröffentlicht am 4. November 2026 auf https://www.novalure-crm.app.

Produktiver Quellcommit: `8f4bfe0a775b8b0f8783b19b5cdc97dc2866defe`.
Deployment: `dpl_4uztrQ1yg3LgT3nus9EugudBVoc2`.
Branch: `codex/compact-sidebar-live-20261104`.
Unveränderte Produktionsbasis: `1eab66b31a390404251e768cc731de000032c8dd`.
Vorheriges Deployment für einen Rückfall: `dpl_2cqHxDrn5KsbagJJ2DZ5k8UQzVFJ`.

## Verhalten

- Bis zu acht Hauptbereiche: Übersicht, Kontakte, Vertrieb, Immobilien & Projekte, Aufgaben, Termine, Marketing, Wissen & KI. Nur bereits berechtigte Einträge werden gruppiert.
- Bisherige Unterseiten bleiben unter ihren ursprünglichen IDs und Links als Navigation im Inhaltsbereich erreichbar. Verwaltung, Terminbuchung und Benutzeranzeige stehen unten.
- Kompakter Profilwechsel in der Seitenleiste; Projektfilter im Kopfbereich, auch bei eingeklappter Navigation verfügbar.
- Die Breite wechselt ausschließlich durch den Nutzer. Bereichswechsel klappen die Navigation nicht mehr automatisch ein.
- Ein erneuter Klick auf den aktiven Bereich erhält den aktuellen Unterseitenkontext; auf dem Handy schließt er das Menü.
- Website-Palette im angemeldeten CRM: `#2d68f0`, `#1e4fc2`, `#e9f0fe`. Öffentliche Seiten und semantische Erfolgs-/Warn-/Fehlerfarben behalten ihren bisherigen Stil.
- Keine Datenbankmigrationen und keine Änderungen an API-, Rollen- oder Berechtigungslogik.

## Prüfung

- Vollständiger Lint, Typecheck und optimierter Next.js-Build erfolgreich. Der endgültige lokale Build und der Produktionsbuild verwenden den veröffentlichten Quellstand.
- 21 fokussierte Prüfungen für Navigation, Rollen-/Adminziele, Studio und Bedienflächen sowie zwei aktualisierte Immobilien-Navigationsprüfungen bestanden.
- Acht echte Browserabläufe mit synthetischem Passwort-/TOTP-Login bestanden: Bereiche und Unterseiten in Makler-, internem und Adminprofil, ursprüngliche Links, Browserhistorie, Neuladen, Projektfilter, Laptopgrößen, Tastatur, Handy und Farbwerte.
- Kein Scrollen in der Seitenleiste oder ihrem Hauptmenü bei 1440×900, 1366×768, 1280×720 und 1200×720, jeweils ausgeklappt (240px) und eingeklappt (80px).
- Handybreite 390px: alle berechtigten Bereiche und Unterseiten erreichbar, kein horizontaler Überlauf; aktiver Bereich schließt das Menü, Escape stellt den Fokus wieder her.
- Weiß auf Website-Primärblau: Kontrast 4,83:1; Dunkelblau auf heller Tönung: 6,22:1.

Die unveränderte Produktionsbasis enthält ältere fehlschlagende Quelltextprüfungen für Aufgabenentwürfe, das LeadInbox-Layout und eine Immobilien-KPI-Implementierung. Die ersten beiden wurden auf dem ursprünglichen Release reproduziert; die betroffenen Implementierungen wurden hier nicht geändert. Die isolierte Browserdatenbank enthält zudem nicht sämtliche produktiven Firmenprofil-/Wissensansichten. Der Browsernachweis bestätigt deshalb Navigation und Darstellung und ersetzt keine vollständige Abnahme aller Fachmodule.

## Veröffentlichung und Nachkontrolle

Der Build wurde zuerst ohne Domainzuweisung bereitgestellt, geprüft und anschließend unverändert auf die Produktionsdomain übernommen. Die bestehende exakte Studio-Anfragebindung wurde im Build, in der Deployment-Laufzeit und für künftige Produktionsdeployments auf den veröffentlichten SHA gesetzt.

Auf der echten Domain bestätigt: Versionskennung und Deployment-ID, Gesundheitsprüfung200, Anmeldung200, geschützte CRM-/Abrechnungs-APIs401 ohne Anmeldung und ungültiger öffentlicher PDF-Link404. Die ausgelieferten Styles enthalten die neue kompakte Navigation und alle drei Website-Blautöne. Zum Zeitpunkt der Nachkontrolle keine Fehler-/Fatal-Laufzeitlogs für dieses Deployment. Die zusätzliche Log-Drain-Abfrage war über den Provider nicht verfügbar (404); daraus wird keine Aussage über eingerichtete Drains abgeleitet.

Lokale Nachweise ohne Zugangsdaten: `../.sidebar-release-ops-20261104/` sowie ignorierte Browserergebnisse und Screenshots unter `.npm-cache/qa/compact-navigation/`. Der ausschließlich lokale Testserver wurde sauber beendet. Ein nachfolgender Commit enthält nur erweiterte Browserprüfungen und diesen Bericht; der produktive Anwendungsstand bleibt der oben genannte Commit.
