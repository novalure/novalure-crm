# Phase 7 - Mobil/Responsive & Performance

## Ziel

Die drei wichtigsten mobilen CRM-Fluesse muessen auf 375-430 px bedienbar bleiben: Lead erfassen, Aufgabe bearbeiten/erledigen und Deal-Pipeline nutzen.

## Umsetzung

- Die Pipeline-Oberflaeche begrenzt ihre aeusseren Layout-Container jetzt mit `min-w-0`, `max-w-full` und kontrolliertem `overflow-hidden`.
- Kanban-Boards und Mapping-Tabellen behalten horizontales Scrollen nur innerhalb ihrer eigenen Flaeche (`max-w-full overflow-x-auto`), statt die gesamte Seite zu verbreitern.
- Primaere Pipeline-Aktionen sind auf schmalen Viewports vollbreit und wechseln erst ab `sm` auf kompakte Desktop-Breite.
- Die vorhandene mobile Tagesansicht bleibt der Einstieg fuer schnelle Lead-, Aufgaben- und Terminaktionen.
- Die Einstellungen/Rechte-Matrix behalten breite Tabellen in lokalen Scrollbereichen, damit auch Admin-Ansichten den mobilen Shell-Viewport nicht verbreitern.

## Abnahme

- Statischer Smoke-Test: `npm run test:phase7`.
- Browser-Smoke auf `390 x 844`: Dashboard, Lead-Zentrale, Aufgaben und Pipeline duerfen keinen Body-level Horizontal-Overflow erzeugen.
- Pipeline: Die Seite bleibt viewport-breit, waehrend die Kanban-Spalten intern scrollbar bleiben.

## Betroffene Dimensionen

- Technik gesamt: Mobile, Navigation/Erreichbarkeit, Datenanlage Deals/Pipeline.
- UX gesamt: Mobile, Effizienz taeglicher Aufgaben, Vertrauen/Professionalitaet.
- Stabilitaet: Keine hängenden Layouts oder verdeckten Aktionen im Standardfluss.

## Offene Punkte

- Echte Performance-Messung mit Produktionsdaten bleibt Teil der Phase-8-Gesamtabnahme.
