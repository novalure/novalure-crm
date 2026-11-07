# Fehlende Aufgabenfälligkeit und manueller Kalenderprovider

Basis: `72d9381025f7b0681d122976ed7045054de332b6`, Tree `1f2f425b16b024f52664b9d8d2f23df730d54708`. Eigener Worktree/Branch; keine Änderung oder Veröffentlichung der aktiven Release- oder QA-Kopie.

Originalbezug: `browser-observations-eaf14c5-targeted-mutations.json` unter `C:/Projects/crm-live-acceptance-20261104/reviews/rc-eaf14c5-app-browser-combined-final/`, SHA-256 `2aa06e08415b7f4652bc0673dee9b342e620e696c9e4a63c96660f32676dc5c0`. Dort sind die tatsächlichen Root-IAB-DOM-Beobachtungen qualifiziert: Tasks All 4 / Focus 4, drei absichtlich undatierte Folgeaufgaben mit Fehltext und eine Rücknahmeaufgabe mit regulärer Jetzt-Fälligkeit; manueller Kalenderprovider im Core-GET, jedoch Microsoft365/microsoft im Detailpanel. Die Befunde betreffen die Anzeige. Keine gesonderten Screenshots wurden behauptet und keine früheren Fachprüfungen auf diesen lokalen Patch umgedeutet.

`formatTaskDue` behandelte den leeren, vom Coreloader aus SQL-NULL erzeugten Wert wie ein ungültiges Datum. Leere beziehungsweise ausschließlich aus Leerraum bestehende Werte heißen nun „Ohne Fälligkeit“ / „No due date“. Nichtleere ungültige Datumswerte behalten die bisherige Fehlanzeige. Parser, Gruppierung, Sortierung und gespeicherte Fälligkeiten bleiben unverändert.

Der Kalender-Coreloader erhält `calendarProvider:manual` bereits korrekt. Die Detailanzeige akzeptierte jedoch nur Microsoft/Google und fiel bei manuell auf den Workspace-Standard zurück. Die reine Anzeigeauflösung erhält nun `manual` beziehungsweise den expliziten `internalManual`-Status; Kalenderlabel und Provider-Mapping zeigen Manuell/Manual beziehungsweise `manual`. OAuth-/Verbindungsprovider, API-/DB-Pfade und externe Aktionen bleiben unverändert.

Gezielter vorhandener Komponentencheck:

```text
node --import tsx --test --test-reporter=tap --test-name-pattern="manual calendar provider stays manual" scripts/calendar-oauth-source-tests.mjs
```

Ergebnis: 1/1 Node-Unterfall bestanden. Die echte React-Komponente wurde 24-mal statisch gerendert: DE/EN × Microsoft-/Google-Workspace-Standard × explizit manuell, manuell ohne Flag, internes Flag ohne Provider, Google, Microsoft und älterer Eintrag ohne Provider. Kalenderdetail und sichtbare Provider-ID werden gemeinsam geprüft. 0 Fetchaufrufe. Keine DB, HTTP-/Next-Server, Browser, OAuth oder Provideraktion; daraus folgt keine erneute Live-Abnahme. Für die reine Aufgabenwortänderung wurde kein neuer Test hinzugefügt.

Gezielter ESLint für die drei geänderten Code-/Testdateien: Exit 0. TypeScript ohne Emit/Incremental: Exit 0. `git diff --check`: Exit 0. Der endgültige Commit/Tree und Patchhash werden zusätzlich im Übergabebeleg festgehalten. Kein Push, Deployment oder Live-Nachtest.
