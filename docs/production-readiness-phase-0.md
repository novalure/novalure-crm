# Production Readiness Phase 0

Datum: 2026-05-26

## Ziel

Phase 0 inventarisiert den bestehenden Stand, ohne Produktfunktionen umzubauen. Ergebnis ist eine belastbare Baseline fuer Persistenz, Auth, Mandantentrennung, Risiken und Validierung.

## Ist-Architektur

- Frontend: Next.js App Router unter `src/app`, React 19.2.4, Next.js 16.2.6, Tailwind CSS 4.
- UI-Schicht: grosse Client-Komponente `src/components/crm-workspace.tsx` mit fachlichen Command-Centern in `src/components`.
- Datenmodell: TypeScript-Typen in `src/lib/crm-types.ts`; Demo-/Fallback-Daten in `src/lib/crm-data.ts`; Datenquellen-Boundary in `src/lib/crm-source.ts`.
- Persistenz: Postgres/Neon ueber `@neondatabase/serverless`; lazy Client in `src/lib/db/client.ts`.
- Migrationsstand: `migrations/001_initial_novalure_crm.sql` bis `migrations/028_contact_archiving.sql`.
- Datenbank-Status lokal: `/api/system/database` meldet `POSTGRES_URL` und `POSTGRES_URL_NON_POOLING` konfiguriert; erwartete Tabellen vorhanden; `missingTables: []`.
- Auth: eigenes Login unter `/api/auth/login`, signierte HttpOnly-Session `novalure_session`, Nutzer/Rolle aus `workspace_users`.
- Server-Rechte: technische Rollen in `src/lib/auth/permissions.ts`, Produktrollen/Capabilities in `src/lib/product-model.ts`, Request-Gates ueber `requirePermission`, `requirePermissionAndProductCapability` und `resolveWorkspaceScopedSession`.
- Routing/API: zentrale CRM-Lesequelle `/api/crm/core`; Schreibendpunkte fuer Projekte, Leads, Kontakte, Deals, Tasks, Funnels, Bots, Reservierungen, Newsletter und weitere Module.
- Next.js-Doku vor Codeaenderung gelesen: lokale Guides zu Route Handlers und Authentication aus `node_modules/next/dist/docs`.

## Quelle der Wahrheit heute

| Entitaet | Primaere Quelle | Fallback / zweite Quelle | Risiko |
| --- | --- | --- | --- |
| Workspace/Mandant | `workspaces`, `workspace_users` via Auth/API | Demo-Workspace aus `crm-data.ts`, wenn DB/Auth nicht verfuegbar | Produktion muss strict auth + DB erzwingen. |
| Projekte | `projects` via `/api/crm/core` und `/api/crm/projects` | `sessionProjects` in `crm-workspace.tsx` bei Fehlern | Inkonsistente Zaehler/Dropdowns moeglich. |
| Kontakte | `contacts` via `/api/crm/core` und `/api/crm/contacts` | Client-overlays/archived ids im Contact-Center | UI kann kurzfristig vom Server abweichen. |
| Leads | `leads` via `/api/crm/core` und `/api/crm/leads` | `sessionLeads`/`leadOverrides` in `lead-inbox.tsx` | Lead kann nur im Tab sichtbar bleiben, wenn API fehlschlaegt. |
| Deals/Pipeline | `deals`, `deal_stage_history`, `crm_pipelines`, `crm_pipeline_stages` | `localStorage` fuer Patches, manuelle Deals, Stage-History | "Lokale Aenderungen" erzeugen Prototyp-Signal und zweite Wahrheit. |
| Aufgaben | `tasks` via `/api/crm/core` und `/api/crm/tasks` | Task UI feuert API, wenig lokaler Fallback | Grundpfad persistiert, Validierung noch ausbauen. |
| Termine | `calendar_events`, `meeting_pages`, `meeting_bookings` | Meeting-Settings im localStorage bei API-Ausfall | Buchungs-/Settings-Pfade koennen lokal abweichen. |
| Notizen/Kommunikation | `contact_timeline_items`, `conversations`, Bot/Runtime-Tabellen | Lead-Notizen aktuell als lokale Activity | Notizen sind nicht durchgaengig persistent. |
| Consent/Newsletter | `consent_records`, `newsletter_*`, `consent_policy_decisions` | Editor-/Versand-Fallbacks bei fehlender Provider-Konfig | Consent-Regeln vorhanden, End-to-end pruefen. |
| Wissensbasis/Bots | `knowledge_sources`, `knowledge_chunks`, `bots`, Bot-Runtime-Tabellen | vorbereitete lokale Quellen bei API-Ausfall | Governance vorhanden, produktiver Dialog noch abzusichern. |
| Audit | `audit_logs`, Analytics-/Runtime-Tabellen | keine einheitliche UI-Abnahme | Gut fuer Nachweis, aber noch nicht fuer alle Aktionen vollstaendig. |

## Baseline-Validierung

- `npm.cmd run lint`: bestanden.
- `npm.cmd run build`: bestanden; Next.js Build erzeugt 68 App-Routen, alle zentralen API-Routen dynamisch.
- Lokaler App-Start: Bereits laufender Dev-Server auf `http://localhost:3000`; `/login` antwortet `200 OK`.
- Datenbank-Diagnose: `GET /api/system/database` lokal erfolgreich; alle erwarteten Tabellen vorhanden.
- Neuer nicht-destruktiver Test-Runner: `npm.cmd run test:phase0`.

## Phase-0-Befund

Die persistente Schicht ist bereits deutlich vorhanden und lokal konfiguriert. Der Live-Pilot-Befund entsteht wahrscheinlich nicht aus fehlendem Schema, sondern aus UI-Fallbacks und lokalen Overlays, die bei API-Fehlern weiter als Erfolg dargestellt werden. Zentrale Aufgaben fuer Phase 1/2 sind deshalb:

- Keine lokale Erfolgsillusion bei Projekt-, Lead-, Deal-, Termin- und Wissensbasis-Schreibpfaden.
- Nach erfolgreichem Schreiben sofort `/api/crm/core` als einzige sichtbare Quelle aktualisieren.
- Bei fehlender DB oder fehlender Berechtigung klarer Fehler statt lokaler Ersatzdatensatz.
- Server-Rechte fuer alle schreibenden Pfade nach Rechte-Matrix verdichten und mit automatisierten Multi-Tenant-Tests belegen.

## Abnahme Phase 0

- Ist-Architektur dokumentiert: ja.
- App startet lokal: ja, bestehender Dev-Server antwortet auf `/login`.
- Build und Lint gruen: ja.
- Testrunner vorhanden und nicht-destruktiv: ja, `test:phase0`.
- Offene Punkte: Die eigentliche Persistenz-Abnahme K2/K3/K4 ist noch nicht erfuellt, weil lokale UI-Fallbacks in den Kernfluesse noch existieren.
