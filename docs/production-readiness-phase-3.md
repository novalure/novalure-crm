# Production Readiness Phase 3

Datum: 2026-05-26

## Ziel

Mandanten- und Rollenrechte muessen serverseitig durchgesetzt werden. UI-Navigation bleibt hilfreich, ist aber nicht die Sicherheitsgrenze.

## Erledigt

- Bestehende Auth-Inventur bestaetigt: Login nutzt signierte HttpOnly-Session `novalure_session`, Nutzer/Rolle kommen aus `workspace_users`, Workspacewechsel laeuft ueber `resolveWorkspaceScopedSession`.
- Read-only Produktrollen (`viewer`, `external_partner`) behalten keine Schreibfaehigkeiten wie `pipeline:write`, `newsletter:send`, `settings:manage`, Bot-Publishing oder Knowledge-Write.
- CRM-Schreibpfade fuer Deals, Leads und Aufgaben pruefen nun zusaetzlich zur Route auch die Datensatzberechtigung:
  - Workspace-Admins, Owner, interne Novalure-Operatoren und Teamleiterrollen koennen Workspace-Datensaetze bearbeiten.
  - `broker_agent` darf nur eigene zugewiesene Datensaetze bearbeiten.
  - `developer_sales` und `project_sales_member` duerfen eigene Datensaetze oder Projekte mit expliziter `project_pipeline_permissions.can_edit_deals`-Berechtigung bearbeiten.
  - Sonstige Produktrollen werden fuer diese Schreibpfade abgelehnt.
- Pipeline-Phasenwechsel verwendet dieselbe Workspace-/Projekt-Admin-Regel statt nur die technischen Rollen `owner/admin`.
- Aufgaben-Repository liest `owner_user_id` jetzt mit, damit fremde Aufgaben serverseitig erkannt werden koennen.
- Statische Phase-3-Tests decken Produktrollen, Workspacewechsel, Owner-/Projektregeln und route-seitige Pflichtrechte ab.

## Abnahmekriterium

- Konto A kann ohne Managed-Service-Rechte nicht per `workspaceId`-Parameter in Mandant B wechseln.
- Read-only Rollen haben keine Server-Schreibfaehigkeiten.
- Ein `broker_agent` kann fremde Deals, Leads und Aufgaben nicht mehr ueber die API bearbeiten.
- Projektvertriebsrollen brauchen eigene Zuweisung oder explizite Projektberechtigung.

Status: ja fuer die zentralen CRM-Schreibpfade Deal, Lead und Aufgabe. Vollstaendige End-to-end-Abnahme mit zwei echten Testkonten/Mandanten folgt in Phase 8.

## Betroffene Dimensionen

- Technik gesamt: +8 erwartete Punkte durch serverseitige Owner-/Projektregeln in Kern-Schreibpfaden.
- Rollenlogik: +12 erwartete Punkte, weil Makler-/Projektvertriebsgrenzen nicht mehr nur UI-seitig sind.
- Persistenz/Speicherung: +3 erwartete Punkte, weil unberechtigte Schreibversuche keine fremden persistenten Daten veraendern.

## Validierung

- `npm.cmd run test:phase3`
- `npm.cmd run test:phase2`
- `npm.cmd run lint`
- `npm.cmd run build`

## Offene Punkte / Risiken

- Kontaktbearbeitung ist weiter workspace-gescoped, aber noch nicht vollstaendig owner-gescoped, weil Kontakte aktuell keinen eigenen `owner_user_id` besitzen.
- Geschuetzte Exporte, Loeschschutz, Bot-Aktivierung und Integrationsrechte werden in Phase 4 bis 6 weiter gehaertet.
- Die finale K4-Abnahme braucht zwei echte Testkonten in zwei Mandanten.

## Naechster Schritt

Phase 4: Pflichtfeld-/Negativvalidierung, klares Speicherfeedback, Doppelklickschutz und Soft-Delete/Papierkorb fuer Loeschpfade.
