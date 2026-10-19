# Evelyn CRM – Design Concepts

Drei isolierte, interaktive Designstudien für ein späteres Evelyn CRM. Kunden,
Umsätze, Projekte, Verträge, Gespräche und KI-Aktivitäten sind synthetisch.
Dies ist keine funktionale CRM-Umstellung.

## Lokal öffnen

```sh
cd design-concepts
npm ci
npm run build
python -m http.server 4173 --directory out
```

Danach `http://localhost:4173/` öffnen. Die Demos benutzen dieselben Versionen
von Next.js, React und Inter wie das untersuchte CRM, ohne dessen produktive
Komponenten oder API-Clients zu importieren. Keine neuen Bibliotheken wurden
dem bestehenden CRM-Paket hinzugefügt.

| Route | Inhalt |
| --- | --- |
| `/` | Zentrale Konzeptauswahl |
| `/a/` | Modern Executive |
| `/b/` | Friendly Smart Workspace |
| `/c/` | Evelyn AI Command Center, optional Dark Mode |
| `/compare/` | Dieselbe Ansicht in allen drei Konzepten |

Die fünf Ansichten verwenden die URL-Fragmente `#dashboard`, `#customers`,
`#studio`, `#assistants` und `#knowledge`. Die optionale Auswahl
`?tenant=haven` zeigt den zweiten synthetischen Mandanten. Mandant und Ansicht
bleiben beim Variantenwechsel erhalten. Die Smartphone-Vorschau verwendet
ein eigenes 390 px breites Iframe. Die Portalstruktur zeigt vier Einstiegspunkte;
sie simuliert keine produktiven Rollen oder Rechte.

## Demo-Interaktionen

- Kontaktprofile durchsuchen, Profile wechseln, Projekt-/Vertrags-/Aktivitätstabs.
- Studioprojekte, Anfragen und synthetische Angebote/Meilensteine.
- Sechs Schritte zur Assistenteneinrichtung, Demo-Chat, Gespräche und Nutzung.
- Drei Wissensebenen, Quellenfilter, lokale Freigabe und Versionsansicht.
- Dateiauswahl zeigt ausschließlich den Dateinamen. Kein Upload, kein Crawling.
- Alle Änderungen bleiben flüchtiger React-Zustand. Neuladen setzt sie zurück.

## Statische Veröffentlichung

Nur Dateien aus `out/` plus `deployment-config.json` als `vercel.json` werden
in das eigenständige Projekt `evelyn-crm-design-concepts` hochgeladen. Das
Deploymentziel ist **Preview**. Es werden keine CRM-Quellen, `.env`-Dateien,
Serverfunktionen, Datenbanken, Providerverbindungen oder Cronjobs veröffentlicht.
Die CSP sperrt Verbindungen und native Formularübermittlung zusätzlich.
Vercels bestehender Zugangsschutz bleibt bestehen. Keine Production-Bereitstellung
und keine Domainänderung.

Die einzige Änderung außerhalb dieses Verzeichnisses ist ein Eintrag in der
bestehenden `vercel.json`: automatische Deployments des vollständigen CRM sind
für `codex/evelyn-crm-design-concepts` deaktiviert. Andere Branchregeln und
Produktionskonfigurationen werden dadurch nicht verändert.

Analyse, Referenzen, fachlicher Designvergleich, Integrationsplan und technischer
Abschlussstatus stehen in [DESIGN-REPORT.md](DESIGN-REPORT.md).
