# Phase 8 - Realistische Daten, Gesamt-Abnahme, Self-Check

## Ziel

Die Demo- und QA-Daten duerfen keinen Prototyp- oder Altzustand mehr signalisieren. Der komplette Akzeptanzkatalog wird ueber automatisierte Phase-Smokes, QA-Livegang-Flows und Browser-Smokes belegbar.

## Umsetzung

- Kritische Fallback-Daten fuer Leads, SLA-Zeiten, Aufgaben, Termine, Reservierungen und Deal-Abschluesse verwenden relative Daten statt fester Mai-2026-Werte.
- QA-Livegang-Daten bleiben klar getrennt ueber eigene Workspaces, Nutzer und `metadata.qaSeed = "livegang-8-10"`.
- Phase-8-Smoke prueft, dass alle Phase-Tests registriert sind, alle Phase-Berichte existieren, die QA-Seeds relativ datieren und der Abschlussbericht KO-/Score-Nachweise enthaelt.

## Akzeptanz-Nachweis

| Kriterium | Status | Nachweis |
| --- | --- | --- |
| K1 | gruen | Auth-/Session-Smokes in `qa:livegang:api`; `test:phase3` prueft echte Session-/Workspace-Grenzen. |
| K2 | gruen | `test:phase1`, `qa:livegang:api`: Projekt, Kontakt, Lead, Deal und Aufgabe bleiben ueber persistente APIs verfuegbar. |
| K3 | gruen | `test:phase2`, `test:phase4`: eine Datenquelle, keine stillen Speicherfehler, klare Validierung. |
| K4 | gruen | `test:phase3`, `qa:livegang:api`: QA Makler, Bautraeger und Internal Workspaces sind serverseitig isoliert. |
| K5 | gruen | `test:phase4`: Soft-Delete, Bestaetigung und Wiederherstellbarkeit sind pruefbar. |
| K6 | gruen | `test:phase1`, `test:phase2`, `qa:livegang:api`: Kernobjekte werden angelegt und persistent zugeordnet. |
| K7 | gruen | `npm run lint`, `npm run build`, Browser-Smokes Phase 6/7: Standardfluesse laufen ohne Absturz. |

## Self-Score

| Dimension | Selbstbewertung | Nachweis |
| --- | ---: | --- |
| Technik gesamt | 93 | Persistenz-, RBAC-, Validierungs-, Bot-, Mobile- und Build-Smokes Phase 1-8. |
| UX gesamt | 92 | Begriffe bereinigt, Speicherfeedback/Validierung verbessert, mobile Kernfluesse ohne Seitenueberlauf. |
| Immobilien-CRM-Fit | 94 | Projekt-, Lead-, Deal-, Aufgaben-, Termin-, Objekt-, Funnel-, Bot- und Newsletter-Domaenen bleiben erhalten und persistent. |
| Rollenlogik | 93 | Rechte-Matrix serverseitig in Phase 3 belegt, Navigationsprofile bleiben erhalten. |
| Persistenz/Speicherung | 94 | DB-first CRUD, einheitliche Core-Quelle, QA-Livegang-Persistenz und relative Seed-Daten. |

## Offene Punkte

- Produktionsdeployment benoetigt nach dem finalen Commit Push/PR und anschliessenden GitHub/Vercel-Lauf.
- Provider-Integrationen wie Microsoft 365, Teams und Resend bleiben env-gesteuert und muessen im Zielprojekt mit echten Zugangsdaten betrieben werden.
