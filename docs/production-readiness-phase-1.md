# Production Readiness Phase 1

Datum: 2026-05-26

## Ziel

Die vorhandene Persistenz-Schicht wird fuer die zwei im Pilottest sichtbarsten Kernfluesse verbindlich gemacht: Projekt anlegen und Lead anlegen/aendern. Lokale Erfolgs-Fallbacks duerfen in diesen Pfaden keinen gespeicherten Zustand mehr vortaeuschen.

## Erledigt

- Projekt-Wizard schreibt weiter ueber `/api/crm/projects`, erzeugt aber keine `project_session_*` Datensaetze und kein `sessionProjects` Overlay mehr.
- Nach erfolgreicher Projektanlage wird der serverseitig gespeicherte Datensatz in `liveCoreData.projects` uebernommen und anschliessend `/api/crm/core` nachgeladen.
- Projektanlage blockiert Doppelklicks waehrend des Speicherns und zeigt Fehler direkt im Wizard statt einen lokalen Projekt-Erfolg zu erzeugen.
- Lead-Zentrale bekommt `onLeadsChanged={refreshCoreData}` aus dem Workspace.
- Lead-Erstellung und Lead-Statusaenderungen laden nach erfolgreichem Serverwrite die persistente Kernquelle nach und entfernen lokale Overlays, sobald der Refresh erfolgreich war.
- Lead-Erstellung blockiert Doppelklicks waehrend des Speicherns.
- UI-Texte fuer Projektanlage entfernt: keine Formulierung mehr zu "fuer diese Sitzung vorbereitet" oder nachtraeglich anschliessbarer API-Persistenz.
- Deutscher Primaerbutton: "Projekt anlegen".

## Abnahmekriterium

- Projekt anlegen fuehrt nicht mehr zu einem lokalen Session-Projekt. Bei API-Fehler erscheint ein Fehler und kein lokaler Ersatzdatensatz.
- Lead anlegen fuehrt nach Servererfolg zu einem Refresh der gemeinsamen Datenquelle `/api/crm/core`.
- Keine sichtbaren Prototype-Texte fuer die Projektanlage.

Status: ja fuer die umgebauten Projekt-/Lead-Pfade. Die vollstaendige K2-Abnahme mit Logout/Login und zweitem Geraet bleibt Teil der spaeteren End-to-end-Phase.

## Betroffene Dimensionen

- Persistenz/Speicherung: +10 erwartete Punkte, weil lokale Erfolgs-Fallbacks in zwei Kernfluesse entfernt wurden.
- Technik gesamt: +6 erwartete Punkte, weil Projekt-/Lead-Anzeigen nach Serverwrite wieder aus der Kernquelle nachladen.
- UX gesamt: +4 erwartete Punkte, weil Begriffe und Speicherfeedback weniger prototypisch sind.

## Validierung

- `npm.cmd run test:phase1`
- `npm.cmd run lint`
- `npm.cmd run build`

## Offene Punkte / Risiken

- Pipeline, Kalender/Meeting-Settings, Wissensbasis und Funnel-Editor enthalten weiterhin lokale Fallbacks oder lokale Drafts.
- Server-RBAC ist vorhanden, aber die Rechte-Matrix ist noch nicht vollstaendig als fachliche Produktrollenregel abgedeckt.
- Soft-Delete/Papierkorb ist bisher nur fuer Kontakte als Archivierungspfad sichtbar.

## Naechster Schritt

Phase 2: Alle weiteren Lese-/Schreibpfade auf die persistente Kernquelle vereinheitlichen, besonders Pipeline-LocalStorage, Kalender-Settings und Wissensbasis-Fallbacks.
