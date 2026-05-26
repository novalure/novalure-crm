# Production Readiness Phase 2

Datum: 2026-05-26

## Ziel

Die Dealpipeline darf keine zweite Browser- oder Session-Datenwelt mehr erzeugen. Deal-Anlage, Detail-Speichern und Phasenwechsel muessen nach einem Serverwrite die gemeinsame CRM-Kernquelle `/api/crm/core` nachladen.

## Erledigt

- Pipeline-State fuer Deals, Draft-Patches und Stage-Historie wird nicht mehr in `localStorage` geschrieben oder daraus geladen.
- Deal-Anlage akzeptiert keinen lokalen Ersatzdatensatz mehr. Wenn `/api/crm/deals` keinen persistierten Deal liefert, erscheint eine klare Fehlermeldung und es wird nichts lokal als gespeichert angezeigt.
- Erfolgreiche Deal-Anlage, Detail-Speichern und Phasenwechsel rufen `refreshCoreData` aus dem Workspace auf.
- Serverseitig bestaetigte Sofort-Overlays werden nach erfolgreichem Refresh entfernt, damit Liste, Kennzahlen, Detailansicht und Auswertungen wieder aus derselben Kernquelle lesen.
- Der Button "Lokale Aenderungen zuruecksetzen" wurde in "Entwurf verwerfen" umgebaut und verwirft nur noch ungespeicherte Feldentwuerfe.
- Stage-History-Optimismus verwendet keine sichtbare lokale Sitzungsbezeichnung mehr.

## Abnahmekriterium

- Neues Deal-Objekt wird nur nach Servererfolg angezeigt.
- Pipeline-Kennzahlen und Deal-Liste werden nach Deal-Anlage oder Phasenwechsel aus `/api/crm/core` aktualisiert.
- Pipeline-Komponente enthaelt keine `localStorage`-Persistenz und keinen `persistedDeal ?? deal`-Fallback.
- Keine sichtbare Pipeline-Formulierung signalisiert lokale Sitzungsdaten.

Status: ja fuer die Pipeline-Schreibpfade. Vollstaendige Konsistenz fuer Termine, Notizen, Consents und Wissensbasis folgt in den naechsten Phasen.

## Betroffene Dimensionen

- Persistenz/Speicherung: +8 erwartete Punkte, weil Pipeline-Deal-Daten keine lokale Browserquelle mehr nutzen.
- Technik gesamt: +5 erwartete Punkte, weil Pipeline-Aenderungen die gemeinsame CRM-Kernquelle nachladen.
- UX gesamt: +3 erwartete Punkte, weil "lokale Aenderungen" aus der Pipeline-Oberflaeche entfernt wurde.

## Validierung

- `npm.cmd run test:phase2`
- `npm.cmd run test:phase1`
- `npm.cmd run lint`
- `npm.cmd run build`

## Offene Punkte / Risiken

- Kalender-/Meeting-Settings, Sequenzentwuerfe und einzelne spaetere Module enthalten weiterhin lokale Draft- oder Fallback-Hinweise.
- RBAC und Mandantentrennung werden in Phase 3 systematisch gegen die vorhandene Rechte-Matrix gehaertet.
- Soft-Delete/Papierkorb bleibt Phase 4.

## Naechster Schritt

Phase 3: Auth, Mandantenscope und serverseitige Rollenrechte gegen die Rechte-Matrix nachweisen und fehlende Regeln schliessen.
