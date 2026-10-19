# Evelyn AI Command Center — Design C

**Einordnung:** Diese Datei beschreibt die historische synthetische Designvorschau. Die aktuelle Integration in das bestehende authentifizierte CRM ist separat in [docs/design-c-integration.md](../docs/design-c-integration.md) dokumentiert. Die Aussage zu Beispieldaten unten gilt für die eigenständige App in diesem Ordner; das integrierte CRM verwendet seine autorisierten Datenadapter.

Isolierte, lokal ausführbare Implementierung der verbindlich ausgewählten Gestaltung C. Alle Zahlen, Kunden, Projekte, Wissensstände und KI-Aktivitäten sind synthetische Beispiele. **Keine Ansicht verwendet echte CRM-Daten.** Alle Aktionsdialoge erklären die fehlende Anbindung; es gibt keine Speicherung, Veröffentlichung, Buchung, Zahlung oder KI-Ausführung.

## Start

Aus dem Repository-Stamm mit Node 24 und npm 11:

```sh
npm ci
npm run design:c:build
npm run design:c:preview
```

Die Vorschau läuft auf `http://127.0.0.1:3190`. Der statische Server bindet ausschließlich an Loopback und liefert nur den Export unter `design-c/out/`. `DESIGN_C_PORT` setzt optional einen anderen Port. Zum Entwickeln: `npm run design:c:dev`. Nicht gleichzeitig auf demselben Port starten.

```sh
npm run design:c:typecheck
npx eslint design-c/app design-c/components design-c/lib design-c/scripts design-c/next.config.ts --max-warnings=0
npm run design:c:browser
```

Für die Browserprüfung muss Chromium für Playwright installiert sein (`npx playwright install chromium`). Sie erwartet den laufenden statischen Server; `DESIGN_C_BASE_URL` kann dessen lokale Adresse überschreiben. Die Prüfung schreibt tatsächliche Ergebnisse und Screenshots nach `design-c/verification/`, beendet sich bei Fehlern mit Exit 1 und ersetzt keine vollständige WCAG-Zertifizierung.

## Umfang und Wiederverwendung

- Zentrale Design-C-Tokens mit optionalem Dark Mode und gekapselter Anpassung der vorhandenen CRM-Basiskomponenten.
- Einklappbare Navigation, mobiler Dialogdrawer, sichtbarer Demo-Mandant, Bereichssuche, Benachrichtigungen, Profil und vereinfachtes Kundenportal.
- Dashboard mit sechs internen KPI-Karten, Evelyn-Briefing, Empfehlungen, Aufgaben, Freigabevorschau, Aktivitäten und Schnellzugriffen.
- Kundenprofil, Mandantenübersicht, Studio, Immobilien, Assistentenverwaltung und universelles Knowledge Center.
- Tabellen mit Suche, Statusfilter, Sortierung, Pagination und leeren Zuständen; Formulare mit lokaler Validierung; native Dialoge mit Fokusführung.
- Komponentenübersicht für Status-, Fehler-, Lade- und Formzustände.

Die gemeinsamen UI-Komponenten nehmen normale React-Props entgegen. Fachansichten und Dashboard sind gegenwärtig **Designkompositionen mit synthetischen Fixtures**, keine fertig verbundenen CRM-Ersatzseiten. `lib/types.ts` beschreibt ausschließlich den Demo-Kontext, kein neues Mandantenmodell. `lib/navigation.ts` unterstützt eine Projektion bereits autorisierter Fähigkeiten; seine Filter sind keine Berechtigungsprüfung. Eine spätere produktive Verwendung benötigt weiterhin die bestehenden serverseitigen Scope-, Rollen- und Modulprüfungen.

## Herkunft, Bestand und Integration

Die Auswahl, Originalfarbwerte, HTML-Prüfsumme und verifizierte CRM-Ausgangsrevision stehen in [reference.json](reference.json). Kontrastanpassungen sind direkt an den Tokens dokumentiert. Es wurden ausschließlich C-Ansichten erstellt.

- [ANALYSIS.md](ANALYSIS.md): tatsächliche CRM-Architektur, verfügbare Revisionen und Paketstände.
- [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md): Tokens, APIs, Gestaltung und Accessibility.
- [INTEGRATION.md](INTEGRATION.md): konkrete Anschlusspunkte und Reihenfolge für Paket 1–4.
- [VERIFICATION.md](VERIFICATION.md): ausgeführte Prüfungen und verbleibende Grenzen.

Ausgangsbasis ist der am 19.10.2026 per Vercel gelesene Production-Quellstand `ea668e625b8c778c2f79dd6a33210e731bb8a662`, nicht das ältere `main`. Der eigene Branch heißt `codex/evelyn-crm-design-c`. Die Produktionsanwendung, ihre Styles, APIs, Authentifizierung, RLS und Datenbank bleiben unverändert. Außerhalb dieses Ordners wurden zusätzliche npm-Kommandos und Ausschlüsse für generierte Preview-Dateien in ESLint und TypeScript ergänzt.

## Preview-Entscheidung

Am 19.10.2026 erneut gelesen: Beide bisherigen Vercel-Demoprojekte melden `live: false`. `evelyn-crm-design-preview` hat weiterhin ein Deployment mit `target: production`; das neueste Deployment von `evelyn-crm-design-concepts` ist `BLOCKED` und hat `target: null`. Daraus ist keine sicher nutzbare geschützte Online-Preview abgeleitet. Es wurde kein Projekt entpausiert, kein Deployment erstellt und keine Domain geändert.

Der lokale statische Export ist die bereitgestellte Alternative. Eine spätere Onlinebereitstellung benötigt einen nachgewiesenen Preview-Zielkontext und wirksamen Zugriffsschutz; sie darf nicht über einen ungeprüften Erstdeploy-Pfad erfolgen.
