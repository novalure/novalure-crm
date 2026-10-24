# Novalure CRM: Projektkontext

Repository: `novalure/novalure-crm`. Maßgeblich sind der aktuelle Auftrag,
[AGENTS.md](../../AGENTS.md), bestehende Entscheidungen und der tatsächliche
Quellstand. Die Next.js-Vorgabe bleibt bestehen: vor Anwendungscode die passenden
installierten Guides unter `node_modules/next/dist/docs/` lesen.

## Anforderungen und Grenzen

- [README](../../README.md) und [package.json](../../package.json): CRM-Funktionen,
  Entwicklungsbefehle und Toolchain; historische TODOs gegen aktuellen Code prüfen.
- [Design-C-Integration](../../docs/design-c-integration.md): tatsächliche
  UI-/Leser-Integration und Nachweise; Demo-Typen begründen keine Berechtigung.
- [External Integration Gateway](../../docs/security/external-integration-gateway.md):
  CRM bleibt operative Datenquelle; Mandant, Projekt, Akteur und erlaubte Origin
  stammen aus der gespeicherten Serverbindung. Keine Datenbankzugänge für Websites,
  kein RLS-Bypass, keine echten Geschäftseffekte aus Trainingsdaten.
- [Gemeinsamer Wissensdienst](../../docs/knowledge-assistant-service.md) und
  [Assistentenkontingent](../../docs/knowledge-connected-assistant-quota-2026-10-21.md):
  Webchat und Voice nutzen veröffentlichtes CRM-Wissen mit ausdrücklichen
  Kanal-/Bereichsrechten, aktuellen Mitgliedschaften und Vertragsgrenzen. Ein
  vorbereiteter Voice-Adapter aktiviert weder Telefonanschluss noch Provider.
- [Website-Assistent](../../docs/website-assistant-self-service-2026-10-21.md):
  vorhandene Kundenchat-, Antwort- und Widgetverträge. Die parallel laufende
  Studio-Webchat-Reparatur gehört nicht zur Einrichtung dieses Skill-Pakets.
- [Authentifizierung/MFA](../../docs/security/auth-identity-session-mfa.md):
  bestehende Sitzungs-, Identitäts-, Audit- und Datenschutzgrenzen erhalten.

## Prüfungen proportional auswählen

Die Befehle stammen aus [package.json](../../package.json); Voraussetzungen und
Umfang dort sowie im betroffenen Dokument prüfen. Dies ist keine zusätzliche
Pflichtsuite. Bestehende CI-/Releaseanforderungen bleiben maßgeblich.

| Betroffener Bereich | Vorhandene Befehle |
| --- | --- |
| Statische Prüfung / Build | `npm run lint`, `npm run typecheck`, `npm run build` |
| Bot-Grounding / fehlendes Wissen | `npm run test:phase6` |
| Wissensverwaltung / Kontingent | `npm run test:knowledge-center`, `npm run test:knowledge-assistant-quota` |
| Öffentliche Integration | `npm run test:external-integration-gateway` |
| Website-Verwaltung / Antworten / Widget | `npm run test:website-self-service` |
| Autorisierte CRM-Leser | `npm run test:crm-operational-readers` |

[Go-live-Workflow](../../.github/workflows/livegang-e2e.yml) und
[Secret-Scan](../../.github/workflows/secret-scan.yml) zeigen die vorhandenen Checks.
Lokale/synthetische Ergebnisse nicht als gehostete oder produktive Abnahme ausgeben.
QA-, Migrations- oder Providerbefehle nur im dafür autorisierten Ziel ausführen.

## Unabhängiger Review und Übergabe

Der [Website-Assistent-Vertrag](../../docs/website-assistant-self-service-2026-10-21.md)
verlangt den unabhängigen GitHub-App-Review auf dem endgültigen Commit; lokaler
Agentenreview ersetzt diesen nicht. Der dokumentierte Reviewer-Hold und die
[Release-Gates](../../docs/go-live/external-integration-gateway-cutover.md) bleiben
bestehen. Historische paketbezogene Ausnahmen begründen keine allgemeine Ausnahme.

Aufgabenbezogene Spezifikationen und Übergaben liegen unter
`docs/tasks/<task-id>/spec.md` bzw. `docs/tasks/<task-id>/handoff.md`.
[Produkt-Handoff](../../docs/security/studio-enquiry-handoff.md) ist ein
Integrationsvertrag, kein gemeinsamer Ablageplatz für Entwicklungsübergaben.
Vorhandene Nachweise verlinken; keine Zugangsdaten oder personenbezogenen
Kundendaten in diese allgemeinen Entwicklungsdokumente übernehmen.

## Geeigneter nächster Einsatz

Eine kleine Spezifikation für eigene Dashboard-Datumsbereiche: Das
[README](../../README.md) nennt dies als v2-TODO; im aktuellen
[Dashboard](../../src/components/dashboard-overview.tsx) behandelt `isInPeriod`
`Custom` noch wie `Monat`, und die Periodenauswahl hat keine Datumsfelder.
Mit `novalure-spec` Datumsgrenzen, ungültige Bereiche, gespeicherte Ansichten und
Prüfung mit synthetischen Daten beschreiben; die aktuelle Produktpriorität vor
Implementierung berücksichtigen. Dies startet keine Studio-Webchat-Reparatur.
