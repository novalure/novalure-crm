# Evelyn CRM – Design Concepts

Drei isolierte, interaktive Designstudien für ein späteres Evelyn CRM. Kunden,
Umsätze, Projekte, Verträge, Gespräche und KI-Aktivitäten sind synthetisch.
Dies ist keine funktionale CRM-Umstellung.

## Gewählte Designrichtung

Der Nutzer hat **C – Evelyn AI Command Center** als gemeinsame Designrichtung
für alle Bereiche gewählt, ausdrücklich einschließlich der Farben. Dashboard,
Kunden und Mandanten, Novalure Studio, KI-Assistenten und Wissen folgen daher
künftig derselben C-Gestaltung; auch vereinfachte Kundenportalansichten verwenden
diese gemeinsame visuelle Grundlage. A und B bleiben als Vergleichsstudien erhalten.

Die C-Palette kombiniert die dunkelblaue Navigationsleiste `#171d30`, den
hellen Hintergrund `#f7f8fc`, weiße Karten, Text in `#252c40` und den
violettblauen Akzent `#666ad1`. Der vorhandene Dark Mode bleibt optional.
Die Auswahl ersetzt die frühere Empfehlung, A, B und C je nach Bereich zu mischen.
Sie legt die visuelle Richtung fest; die produktive Integration ist ein späterer Schritt.

## Direkt ansehen und herunterladen

Die private Ergebnisseite enthält die interaktive Vorschau, die drei großen
Designansichten und bestätigte Dateianhänge:

https://chatgpt.com/space/page_c4e8b4f5bddc81919c228c97c0f8ae80

Die einzelne Datei `evelyn-crm-interaktiv.html` funktioniert nach dem Download
per Doppelklick im aktuellen Browser. Keine Installation und kein Server nötig.
Sie enthält dieselben 15 Ansichten, Demo-Interaktionen und den Variantenvergleich.

Die portable HTML-Datei lässt sich mit den bestehenden Projektabhängigkeiten erzeugen:

```sh
node scripts/build-shareable-preview.cjs /absoluter/pfad/evelyn-crm-interaktiv.html
```

## Lokal öffnen

```sh
cd design-concepts
npm ci
npm run build
python -m http.server 4173 --directory out
```

Danach `http://localhost:4173/` öffnen. Alternativ nach dem Build `python scripts/run-static-preview.py` verwenden. Die Demos benutzen dieselben Versionen
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
in ein eigenständiges Vercel-Projekt hochgeladen. Das autorisierte
Deploymentziel ist ausschließlich **Preview**. Der tatsächliche Onlineversuch ist
blockiert: Vercel ordnete die Erstdeployments der neuen Projekte automatisch
Production zu. Beide Projekte wurden pausiert und werden nicht als Preview
übergeben; Details stehen im Abschlussbericht. Es werden keine CRM-Quellen, `.env`-Dateien,
Serverfunktionen, Datenbanken, Providerverbindungen oder Cronjobs veröffentlicht.
Die CSP sperrt Verbindungen und native Formularübermittlung zusätzlich.
Vercels bestehender Zugangsschutz bleibt bestehen. Die produktive CRM-Version
und deren Domains wurden nicht verändert. Die automatisch erzeugten
Production-Zuordnungen der isolierten Demoprojekte sind als Abweichung dokumentiert.

Die einzige Änderung außerhalb dieses Verzeichnisses ist ein Eintrag in der
bestehenden `vercel.json`: automatische Deployments des vollständigen CRM sind
für `codex/evelyn-crm-design-concepts` deaktiviert. Andere Branchregeln und
Produktionskonfigurationen werden dadurch nicht verändert.

Analyse, Referenzen, fachlicher Designvergleich, Integrationsplan und technischer
Abschlussstatus stehen in [DESIGN-REPORT.md](DESIGN-REPORT.md).

## Durchgeführte Designprüfung

`npm run build` und `npm run typecheck` bestanden. Die gezielte Browserprüfung
liegt unter `scripts/verify-browser.mjs` und nutzt das bereits im CRM vorhandene
Playwright (nach Installation der Root-Dev-Abhängigkeiten). Ein vorhandener
Playwright-Pfad kann über `PLAYWRIGHT_MODULE_PATH` gesetzt werden. Geprüft wurden
15 Ansichten bei Desktop- und Smartphonebreite, drei Tablet-Dashboards und die
zentralen Demo-Interaktionen. Ergebnisse: `verification/summary.json`.
