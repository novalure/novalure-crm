# Evelyn CRM – Design Concepts

Stand: 19. Oktober 2026. Diese Entscheidungsvorlage betrifft drei isolierte, interaktive Frontend-Demos mit synthetischen Daten. Sie ist keine Freigabe einer produktiven CRM-Umstellung und bestätigt keine Betriebsfähigkeit der dargestellten zukünftigen Module.

**Festgehaltene Nutzerentscheidung:** C – Evelyn AI Command Center ist die gemeinsame Designrichtung für alle Bereiche, ausdrücklich einschließlich der Farben. Die bisherige Empfehlung einer Kombination aus A, B und C ist damit ersetzt. Die Vergleichsbewertungen bleiben als fachliche Analyse der drei Entwürfe erhalten.

## 1. Auftrag und untersuchte Ausgangslage

Das Ziel ist eine visuelle Entscheidung über Navigation, Informationshierarchie, Bedienung und Gestaltung des zukünftigen Evelyn CRM. Alle Konzepte berücksichtigen dieselben fünf Arbeitsbereiche: Dashboard, Kunden und Mandanten, Novalure Studio, KI-Assistenten und Wissensverwaltung. Unterschiede sollen in der Struktur der Arbeitsoberfläche sichtbar werden.

Untersucht wurden das bestehende CRM, dessen Styles und Navigation sowie die aktuelle Evelyn-Planungsgrundlage. Der laufende Studio-Entwicklungsstand wird als Ausgangsbasis erhalten; die Demos liegen vollständig unter `design-concepts/`.

### Revision und veröffentlichter CRM-Stand

Die folgenden GitHub-/Vercel-Metadaten wurden für diesen Auftrag am 19.10.2026 gelesen:

| Gegenstand | Verifizierter Stand |
| --- | --- |
| Repository | [novalure/novalure-crm](https://github.com/novalure/novalure-crm) |
| GitHub `main` | `5741a591` |
| Aktuell beobachtetes CRM-Production-Deployment | `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk`, Zustand `READY`, Ziel `production` |
| Quellrevision dieses Deployments | `ea668e625b8c778c2f79dd6a33210e731bb8a662` |
| Deployment-Adresse | [novalure-17ga46bw1-novalure.vercel.app](https://novalure-17ga46bw1-novalure.vercel.app) |
| Bestehender CRM-Alias | [novalure-crm-novalure.vercel.app](https://novalure-crm-novalure.vercel.app) |
| Ausgangsrevision der Designarbeit | `ea668e625b8c778c2f79dd6a33210e731bb8a662` – `feat(crm): add scoped Novalure Studio navigation profile` |
| Eigener Designbranch | `codex/evelyn-crm-design-concepts` |

Der genannte Hinweis `b0e99c4…` ist damit kein aktueller Deploymentbeleg. Auch `main` und der veröffentlichte Stand sind unterschiedlich. `READY` und die Quell-SHA belegen das gebaute Deployment; sie belegen keinen erfolgreichen produktiven Kundenablauf. Im Rahmen der Designanalyse wurden keine produktiven Kunden- oder CRM-API-Daten abgerufen.

### Technologie, Oberfläche und wiederverwendbare Muster

| Bereich | Befund im CRM-Ausgangsstand | Konsequenz für die Demos |
| --- | --- | --- |
| Framework | Next.js `16.4.0`, React `19.2.8`, Tailwind 4 | Next.js und React in denselben Versionen verwenden; keine zusätzliche UI-Bibliothek notwendig. |
| Schrift | Inter als vorhandene Abhängigkeit; authentifizierte `.crm-app` verwendet Inter. Der globale Seitentext berücksichtigt daneben Figtree. | Inter lokal aus der vorhandenen Schriftabhängigkeit verwenden. |
| Tokens | `src/styles/novalure-tokens.css` definiert Farben, semantische Zustände, Schatten, Fokusdarstellung und Bediengrößen. | Eigene zentrale Konzept-Tokens; Bedeutungen von Erfolg, Warnung und Fehler konsistent halten. |
| Bestehende Palette | Ink `#07080b`, Graphite `#111318`, Mist `#f4f6fa`, Gold `#ffd43b`, Grün `#42d39b` | Anknüpfungspunkte für die spätere Markenabstimmung; die drei Konzepte erhalten eigenständige visuelle Systeme. |
| Bediengrößen | 44 bzw. 50 px Kontrollelemente; 8 px Kartenradien; zentrale Fokusfarben | Gut bedienbare Zielgrößen und erkennbare Fokuszustände übernehmen. |
| Navigation | Profilabhängige Navigation in `src/components/crm-workspace.tsx`; 292 px Sidebar, 76 px eingeklappt; Workspace- und Projektkontext | Bereiche sinnvoll gruppieren, Scope stets sichtbar halten und lokale Unterseiten kontextbezogen anbieten. |
| Studio | Eigenes `novalureStudio`-Profil mit Websiteanfragen und Wissen/KI | Die laufende Studio-Funktion bleibt funktionale Basis der späteren Integration. |
| Mobil | Modaler Navigationsdrawer mit `aria-modal`, Fokusbehandlung und `inert` | Mobile Navigation und Tastaturbedienung von Beginn an berücksichtigen. |
| Dashboard | `dashboard-overview.tsx`: KPI-, Diagramm- und Listenwidgets; react-grid-layout; gespeicherte Tages-, Wochen- und Geschäftsführeransichten | Arbeitszweck und Priorität bestimmen die Informationshierarchie; vorhandene Widgetlogik muss später nicht neu entwickelt werden. |
| Fachkomponenten | Vorhandene Kunden-, Projekt-, Bot-, Wissens- und Unternehmensprofiloberflächen enthalten produktive API-Clients | Für die Demos ausschließlich eigene Präsentationskomponenten und lokale Fixtures verwenden. |

Die Quellcodeanalyse beschreibt die vorhandene authentifizierte Oberfläche. Es wurde kein echter Kundenaccount geöffnet und kein vollständiger produktiver Oberflächenablauf durchgespielt.

## 2. Masterplan und Mandantenmodell

Funktionale Grundlage sind die im Repository `novalure/evelyn` gelesenen Dokumente am Stand `14aecea14e3304bfc187480cd1158febab6ad2b9`: der kanonische Masterplan vom 07.10.2026, die A0-Verfassung, die vorrangige Produktanpassung vom 17.10.2026 im aktuellen Masterplan, der aktuelle Masterprompt, der technische Entwicklungsstand vom 17.10.2026 sowie Roadmap und Entwicklungsstatus. Die bestehende CRM-Grenze bleibt maßgeblich.

Quellen: [kanonischer Masterplan](https://github.com/novalure/evelyn/blob/14aecea14e3304bfc187480cd1158febab6ad2b9/docs/masterplan/CURRENT_CANONICAL_MASTERPLAN_2026-10-07.md), [aktueller Fach- und Produktmasterplan](https://github.com/novalure/evelyn/blob/14aecea14e3304bfc187480cd1158febab6ad2b9/docs/masterplan/evelyn-masterplan-current.md), [aktueller Masterprompt](https://github.com/novalure/evelyn/blob/14aecea14e3304bfc187480cd1158febab6ad2b9/docs/masterplan/evelyn-masterprompt-current.md), [technischer Entwicklungsstand](https://github.com/novalure/evelyn/blob/14aecea14e3304bfc187480cd1158febab6ad2b9/docs/masterplan/technical-development-state-2026-10-17.md), [CRM-Grenze](https://github.com/novalure/evelyn/blob/14aecea14e3304bfc187480cd1158febab6ad2b9/docs/architecture/crm-boundary.md).

Wesentliche Gestaltungsfolgen:

- **Zwei Geschäftslinien:** `novalurestudio.ie` führt allgemeine Websiteleistungen und den Studio-Verkaufsablauf. `novalure.eu` behält den Immobilienfokus. Die Oberfläche macht den jeweiligen Unternehmensbereich sichtbar.
- **Produktreihenfolge:** KI-Webchat zuerst, Telefonie später, danach mögliche Kombipakete. Telefonie erscheint im Konzept ausdrücklich als geplantes Modul.
- **Evelyn ↔ Franz:** Evelyn erhält eine sichtbare, verständliche Assistenzfläche. Ein Demodialog ist kein Beleg für Teams-Anbindung, Modellbetrieb oder ausgeführte Geschäftsaktionen.
- **Gemeinsame Mandantenplattform:** Kunde, Benutzerrolle, gebuchte Leistung, Projekt/Website, Kanal und tatsächlich aktivierte Fähigkeit bleiben unterscheidbar. Ein Mandantenwechsel bleibt jederzeit erkennbar.
- **Self-Service:** Ein geführter Ablauf zeigt Websitequelle → Informationen prüfen → Assistent gestalten → Kanal verbinden → testen. Websitewissen, Widgetinstallation und Telefonanschluss sind unterschiedliche Zustände.
- **Wissensfreigabe:** Importiert, verarbeitet, geprüft, veröffentlicht und tatsächlich aktiv sind getrennte Zustände. Neue oder automatisch erkannte Änderungen ersetzen keine aktive Wissensversion ohne die vorgesehene Administratorfreigabe.
- **Drei Wissensebenen:** Unternehmenswissen des Mandanten, Projekt-/Websitewissen und Wissen eines einzelnen Assistenten. Die Oberfläche zeigt Quelle, Zuordnung, Version, Aktualität und Freigabestatus.
- **Verträge und Abos:** Buchung, Zahlungsstatus, Modulrecht und Bereitstellung benötigen später echte, geprüfte Zuordnungen. Demoumsätze und Demoabonnements sind ausdrücklich synthetisch; es gibt keinen Checkout.
- **Nachvollziehbare Aktivität:** KI-Empfehlung, vorgeschlagene Aufgabe und ausgeführte Aktion erhalten unterschiedliche Begriffe. Eine angezeigte Aktivität suggeriert keine tatsächlich verbundene Abteilung.

Novalure CRM bleibt die operative Business Source of Truth. Evelyn koordiniert und referenziert. SharePoint bleibt die kontrollierte Unternehmens-/Dokumentenquelle, OneDrive der persönliche Arbeitsbereich. Die pausierte BrightBooks-Integration wird durch ein Finanzdiagramm nicht als aktiv dargestellt. Bestehende Roadmap- und Live-Nachweise werden durch die Designarbeit weder verändert noch aufgewertet.

## 3. Untersuchung der fünf Designreferenzen

Alle fünf vom Auftrag genannten URLs antworteten am 19.10.2026 mit HTTP 200 und den erwarteten Seitentiteln. Öffentliche Vorschaubilder der drei Einzelvorlagen wurden zur visuellen Analyse betrachtet. Es wurden keine Vorlagen gekauft und keine geschützten Bilder, Grafiken oder vollständigen Designs in die Demos übernommen.

| Referenz | Tatsächlich beobachtete Merkmale | Nutzbare Inspiration |
| --- | --- | --- |
| [Real Estate Dashboard UI Kit – UMX4LC4](https://elements.envato.com/de/real-estate-dashboard-ui-kit-UMX4LC4) | Schmale helle Sidebar mit Icons/Text; blauer aktiver Menüpunkt; globale Suche; Kaufen/Mieten-Tabs und horizontale Filter; regelmäßiges Immobilienkartenraster mit Bildern, Preisen und Favoriten. Die Beschreibung nennt drei Figma-Ansichten: Anmeldung, Registrierung und Dashboard, 1440 × 1149 px. | Klarer Wechsel zwischen Suchkontext und Ergebnissen; leicht erfassbare Objektkarten; wenige Hauptaktionen. |
| [Real Estate Listing Manager – B78RF6Z](https://elements.envato.com/de/real-estate-listing-manager-dashboard-template-B78RF6Z) | Helle Sidebar, warme Markenakzente, schwarze Hauptaktion; Suchleiste; breiter oberer Informationsbereich; darunter Kartenraster mit Kategorietabs sowie rechte „Most Popular“-Liste. Beschrieben ist eine Desktopansicht, 1440 × 1024 px. | Asymmetrische Aufteilung von Hauptarbeit und ergänzender Übersicht; visuelle Projektkarten und kontextbezogene Filter. |
| [CRM Real Estate Dashboard – 4N2ZQ5Q](https://elements.envato.com/de/crm-real-estate-dashboard-4N2ZQ5Q) | Dunkelblaue Sidebar, heller Arbeitsbereich; Begrüßung und Suche; fünf Pipeline-KPIs; fünfspaltiges Lead-Kanban mit Statuspunkten; darunter Marktkennzahlen und blaues Flächendiagramm. Die Produktbeschreibung nennt drei Bildschirme, Figma und freie Google-Schriften. | Trennung von Kennzahlen, Arbeitsvorrat und Analyse; kompakte Statusübersichten; sichtbare nächste Arbeitsschritte. |
| [Envato CRM-Dashboard-Katalog](https://elements.envato.com/de/graphic-templates/crm+dashboard) | Erreichbarer Katalog mit Kontakt-, Pipeline-, Dokument- und Reportingkonzepten sowie hellen und dunklen Varianten; Filter nach Anwendungen und Formaten. | Unterschiedliche Arbeitszwecke brauchen unterschiedliche Inhaltslayouts; kein einheitliches Vorlagenlayout für alle Module. |
| [Wrapmarket CRM-Dashboard-Katalog](https://wrapmarket.com/web-templates/crm-dashboard) | Der gelesene Katalog nennt 67 Artikelgruppen/76 Treffer. Beschreibungen erwähnen vertikale und horizontale Navigation, dreispaltige Layouts, Tabellen, Diagramme, Kalender, Kanban, responsive Ansichten und Dark Mode. | Modulare Navigationskonzepte vergleichen; Informationsmenge über Gruppen und lokale Navigation steuern. |

Die sichtbaren Einzelvorlagen verwenden kompakte serifenlose UI-Typografie, klare Kartenraster und helle Flächen mit begrenzten Akzenten. Die konkreten Schriftfamilien lassen sich aus den Vorschaubildern nicht zuverlässig bestimmen. Kontraste wurden an den Referenzbildern nicht messtechnisch geprüft.

Die Einzelvorlagen sind statische Figma-Vorschauen. Echte Menüs, Tastaturbedienung, Datenfilter, Kundenprofile und mobile Umbrüche sind daraus nicht verifizierbar. Die Katalogangabe „responsive“ ist eine Anbieterbeschreibung. Die responsive Darstellung der Evelyn-Demos benötigt einen eigenen gezielten Check.

## 4. Drei eigenständige Designrichtungen

| Merkmal | A – Modern Executive | B – Friendly Smart Workspace | C – Evelyn AI Command Center |
| --- | --- | --- | --- |
| Leitbild | Ruhige, professionelle Unternehmensführung | Persönlicher, verständlicher Arbeitsplatz | Zentrale Steuerung von KI und operativer Arbeit |
| Navigation | Dauerhafte helle Sidebar mit Bereichsgruppen | Horizontale Bereichsnavigation und kontextbezogene Wege | Schmale dunkle Leiste, lokale Bereichsnavigation und zentrale Assistenz |
| Informationshierarchie | Unternehmenslage → Kennzahlen → Projekte und Tabellen | Mein Tag → nächste Aktionen → visuelle Arbeitskarten | Evelyn-Briefing → priorisierte Empfehlungen → Abteilungen und Aktivität |
| Visuelle Sprache | Weiß, sanfte Neutralfarben, zurückhaltende Akzente und feine Linien | Warme Grundfläche, harmonische Farben, großzügige gerundete Karten | Dunkle technische Akzente, präzise Statusdarstellung, kompakte Datenmodule |
| Evelyn | Begleitende Zusammenfassung und kontextbezogene Hinweise | Verständliche Hilfe und geführte Einrichtung | Zentrale Eingabe, Empfehlungen und nachvollziehbare Aktivität |
| Kunden und Projekte | Strukturierte Listen, Profil und zugeordnete Leistungen | Visuelle Kunden-/Projektkarten mit klaren nächsten Schritten | Kompakte Übersichten mit Kontext und Systembezug |
| Geeigneter Schwerpunkt | Internes CRM, Führung, Vertrieb und Immobilien | Kundenportal, tägliche Arbeit und Self-Service | Interne KI-Koordination und Automatisierung |

In allen Varianten bleiben die fünf Kernansichten direkt erreichbar. Variante und Ansichtskennung sind getrennt, damit beim Wechsel möglichst dieselbe Ansicht erhalten bleibt. Die zentrale Auswahlseite erleichtert den direkten Dashboardvergleich. Desktop- und mobile Vorschau dienen der Designbeurteilung; eine Geräteumschaltung ersetzt keinen echten Browsercheck.

Für zusätzliche Unternehmensbereiche ist folgende Gruppierung vorgesehen: Geschäft mit Kunden, Vertrieb, Projekten/Websites und Immobilien; KI mit Evelyn, Webchat, später Telefonie und Wissen; Organisation mit Marketing/Social Media, Finanzen, Aufgaben/Kalender und Einstellungen. Die konkrete Darstellung folgt der jeweiligen Navigationsrichtung. Noch nicht gestaltete oder nicht aktive Fähigkeiten müssen als geplant erkennbar bleiben.

Das spätere Kundenportal zeigt eine kleinere Auswahl eigener Arbeitsbereiche. Internes Abteilungsmanagement, globale Kundenlisten und fremde Mandanten gehören nicht zur normalen Kundennavigation. Der Portalmodus einer Demo ist eine visuelle Darstellung und implementiert keine Berechtigungsprüfung.

## 5. Fachlicher Designvergleich

**Die Bewertungen sind fachliche Einschätzungen auf einer Skala von 1 bis 10, keine Ergebnisse von Nutzertests, einer Accessibility-Zertifizierung oder produktiven Messungen.** Sie bewerten die jeweilige Designrichtung für den beschriebenen Evelyn-Anwendungsfall. Sie bleiben als vergleichende Analyse erhalten; die anschließende Nutzerentscheidung legt C als gemeinsame Designrichtung fest.

| Kriterium | A – Executive | B – Friendly | C – Command Center |
| --- | ---: | ---: | ---: |
| Optische Qualität | 9 | 9 | 9 |
| Benutzerfreundlichkeit | 9 | 9 | 8 |
| Übersichtlichkeit | 9 | 9 | 8 |
| Skalierbarkeit | 9 | 8 | 9 |
| KI-Integration | 8 | 9 | 10 |
| Eignung für Immobilienverwaltung | 9 | 8 | 8 |
| Eignung für Kundenportale | 8 | 9 | 7 |
| Mobile Usability | 8 | 9 | 8 |

A bietet eine verlässliche Grundlage für viele Module und datenreiche Ansichten. Die großzügige Struktur benötigt auf kleinen Bildschirmen eine klare Priorisierung der wichtigsten Aktionen. B erleichtert Einstieg, Einrichtung und tägliche Arbeit; bei wachsender Modulzahl müssen Karten und horizontale Ziele konsequent gruppiert werden. C macht Evelyn und Automatisierungen am deutlichsten sichtbar; kompakte Systeminformationen benötigen besonders verständliche Begriffe und eine gute Priorisierung für neue Kunden.

### Gewählte Designrichtung: C für alle Bereiche

**Der Nutzer hat C – Evelyn AI Command Center für das gesamte Design einschließlich der Farben gewählt.** Diese Entscheidung ersetzt die frühere Empfehlung einer Kombination aus A, B und C. Die gemeinsame C-Gestaltung gilt für:

1. Dashboard und Unternehmensübersicht.
2. Kunden, Mandanten und ihre Profile, Projekte und Verträge.
3. Novalure Studio.
4. KI-Assistenten einschließlich Einrichtung, Gesprächen und Nutzung.
5. Wissen einschließlich der drei Wissensebenen, Versionen und Freigaben.

Auch vereinfachte Kundenportalansichten verwenden diese visuelle Grundlage; ihre Inhalte und Navigation richten sich nach dem jeweiligen Arbeitszweck. Die vorhandene C-Ansicht kombiniert eine dunkle Navigationsleiste mit hellen Arbeitsflächen. Der Dark Mode bleibt eine optionale Darstellung.

Die vorhandenen C-Tokens in `app/globals.css` bilden den Ausgangspunkt:

| Verwendung | Bestehende C-Farbe |
| --- | --- |
| Navigationsleiste | Dunkelblau `#171d30` |
| Arbeitsfläche und Karten | `#f7f8fc` und Weiß `#ffffff` |
| Text und Sekundärtext | `#252c40` und `#777e91` |
| Akzent und dezente Akzentfläche | Violettblau `#666ad1` und `#eff0fc` |
| Linien | `#e8eaf1` |
| Evelyn-Briefing | Dunkelblau `#242a42` |
| Optionaler Dark Mode | Hintergrund `#121827`, Karten `#1a2032`, Akzent `#9da6ff` |

Ein gemeinsamer C-Token- und Komponentenvertrag soll Schrift, Abstände, Formularbedienung, Fokus, Statusbegriffe und Mandantenanzeige vereinheitlichen. Die Ausgestaltung muss besonders für neue Kunden verständliche Begriffe und klare Prioritäten bieten. A und B bleiben als Vergleichsstudien erhalten. Die Designwahl ist festgehalten; die produktive Umsetzung steht noch aus.

## 6. Isolation und technische Architektur

`design-concepts/` ist eine eigenständige Next-Anwendung mit eigener `package.json` und eigener Konfiguration. Sie übernimmt die vorhandenen Versionen von Next.js, React und Inter. `output: "export"` erzeugt statische HTML-/CSS-/JavaScript-Dateien; für die veröffentlichte Demo ist keine Anwendungsserver-Runtime erforderlich.

| Grenze | Architektur des Designauftrags |
| --- | --- |
| Daten | Ausschließlich lokale, eigens erfundene Fixtures; Kunden „Atelier Nord“ und „Haven Estates“ sowie `.example`-Domains. Keine Ableitung aus produktiven Datensätzen. |
| Demoaktionen | Lokaler React-Zustand für Menüs, Tabs, Dialoge und Einrichtungsabläufe. Kein produktiver Versand, Upload, Import, KI-Aufruf, Checkout oder Kalenderzugriff. |
| Abhängigkeiten | Kein Import aus produktiven CRM-Services, Datenbankmodulen oder Authentifizierungsclients; keine zusätzlichen Providerbibliotheken. |
| Konfiguration | Keine produktiven Zugangsdaten oder Runtime-Umgebungsvariablen in der Demo; keine Übernahme von CRM-Environment-Dateien. |
| Deployment | Autorisiertes Ziel ist ein getrenntes statisches Preview. Der Onlineversuch ist wegen automatischer Production-Zuordnung blockiert und pausiert (Abschnitt 11). Das bestehende CRM und seine Domains bleiben unberührt. |
| Kennzeichnung | Kunden, Projekte, Umsätze, Abos und KI-Aktivitäten sind Demodaten. Status „geplant“ unterscheidet zukünftige Module von simulierten Abläufen. |
| Mandantenwechsel | Wechselt ausschließlich zwischen synthetischen Beispielen. Die Oberfläche zeigt den aktiven Scope; dies ist kein Nachweis serverseitiger Mandantentrennung. |

Der separate statische Export reduziert die Veröffentlichung auf überprüfbare Präsentationsdateien. Vor einer öffentlichen Preview sind der erzeugte Export, fehlende produktive Endpunkte und fehlende Zugangsdaten gezielt zu prüfen. Ein Vercel-Status `READY` allein bestätigt diese Isolation nicht.

Die bestehende Root-`vercel.json` erhält genau einen zusätzlichen Eintrag: `git.deploymentEnabled["codex/evelyn-crm-design-concepts"] = false`. Er verhindert, dass ein Push dieses Branches automatisch das vollständige CRM mit dessen Projektbindungen baut. Bestehende Branchregeln, Cronjobs und Domains bleiben erhalten. Die Demo wird getrennt als statische Dateien hochgeladen.

## 7. Späterer Integrationsplan

1. **Gewählte C-Richtung konkretisieren:** Navigation, Farben, Tokens und Kernkomponenten aus C für Dashboard, Kunden/Mandanten, Studio, Assistenten und Wissen als gemeinsame Grundlage beschreiben; die Portalwege für ihre Zielgruppe vereinfachen. Bestehende Studio-Arbeiten zuerst gegen den dann aktuellen CRM-Stand abgleichen.
2. **C-Präsentationsschicht extrahieren:** Buttons, Karten, Tabellen, Statusanzeigen, Scope-Anzeige und Assistentenoberfläche als wiederverwendbare Komponenten vorbereiten. Fixture-Daten und Demoereignisse bleiben außerhalb der produktiven Integration.
3. **Bestehende Datenadapter verwenden:** Vorhandene CRM-Contracts auf die neuen Präsentationsmodelle abbilden. Feldnamen oder Layoutanforderungen rechtfertigen keine Datenbankänderung. Geschäftsregeln und bestehende API-Verträge bleiben erhalten.
4. **Serverseitige Zuständigkeit erhalten:** Authentifizierung, RBAC, Mandanten-/Projektprüfung, Audit, Modulrechte und Freigaben bleiben auf den bestehenden vertrauenswürdigen Serverpfaden. Eine UI-Auswahl oder ausgeblendete Navigation erteilt keine Berechtigung.
5. **Schrittweise übernehmen:** Zuerst Shell und Dashboard, anschließend Kunden-/Projektansichten und Studio; danach Assistenten und Wissen. Pro Bereich bestehende Funktionen, Fehlerzustände und Rollen abgleichen. Laufende Studio-Funktionen werden nicht durch Demoimplementierungen ersetzt.
6. **Self-Service an echte Zustände binden:** Quellenimport, Freigabe und Veröffentlichung müssen den vorhandenen beziehungsweise später separat abgenommenen Vorgängen entsprechen. Kalender, Telefonie und Stripe erhalten erst nach ihrer eigenen technischen Abnahme aktive Bedienelemente.
7. **Gezielt verifizieren und zurücknehmen können:** Vor jeder späteren Produktivübernahme relevante Rollen, mindestens zwei Mandanten, Tastatur-/Mobilebedienung und unveränderte Geschäftsvorgänge prüfen; bestehende Releasegates und Rückweg anwenden. Die vereinfachten Demochecks ersetzen diese spätere Produktabnahme nicht.

Für den aktuellen Designauftrag sind keine API-, Datenbank-, Authentifizierungs- oder RBAC-Änderungen erforderlich.

## 8. Additiver Vorschlag für den Design-Backlog

Der gemeinsame Evelyn-Masterplan und dessen Entwicklungsstatus werden durch diesen Bericht nicht bearbeitet. Die folgende Liste ist ein konkreter Vorschlag zur späteren konfliktfreien Übernahme in einen gemeinsamen Dokumentationsbereich. Sie ändert keine Priorität und erklärt keine offene Funktion als abgeschlossen.

| Vorschlag | Ergebnis und Abnahmekriterium | Abhängigkeit |
| --- | --- | --- |
| UX-01 – Designrichtung festgehalten | Nutzerentscheidung dokumentiert: C einschließlich der Farben gilt für alle fünf Bereiche und die visuelle Grundlage des Kundenportals. | Nutzerentscheidung nach Sichtung der Designpreview |
| UX-02 – Gemeinsame C-UI-Grundlage | C-Tokens, Formulare, Tabellen, Karten, Statusbegriffe, Fokus und sichtbare Scope-Anzeige verbindlich beschreiben. | UX-01 |
| UX-03 – Interne Navigation | Geschäft, KI und Organisation gruppieren; Studio und Immobilien klar zuordnen; Mobilewege prüfen. | UX-02 und aktueller CRM-Funktionsstand |
| UX-04 – Kundenportal vereinfachen | Nur eigene Projekte, Assistenten, Wissen, Gespräche/Anfragen, Team und Abrechnung im zulässigen Rollen-/Modulumfang zeigen. | MP1-Contracts und bestehende serverseitige Rechte |
| UX-05 – Assistenteneinrichtung | Website, Unternehmensinformationen, Erscheinungsbild, Kanalverbindung und Test als verständlichen Ablauf gestalten. | MP1; echte Provider-/Installationszustände |
| UX-06 – Wissen und Freigabe | Drei Wissensebenen sowie Entwurf, Freigabe, aktive Version, Änderungen und Fehler verständlich darstellen. | MP1-Wissens- und Versionscontract |
| UX-07 – Evelyn-Arbeitsbereich | Empfehlung, Aufgabe, Entscheidung und ausgeführte Aktion klar unterscheiden; Herkunft und Aktualität anzeigen. | Tatsächlich freigegebene EF-Fähigkeiten |
| UX-08 – Weitere Module vorbereiten | Telefonie als späteren Ausbau, Immobilienansichten und Finanzdarstellung innerhalb belegter Fähigkeiten ergänzen. | VO1 beziehungsweise jeweils eigener Funktionsauftrag |

## 9. Technischer Abschlussstatus

Dieser Abschnitt enthält die belegte Ausgangslage und die tatsächlich ausgeführten Abschlussprüfungen. Die Onlinebereitstellung ist wegen der nachfolgend dokumentierten Providerabweichung nicht freigegeben.

| Punkt | Status |
| --- | --- |
| Repository | `novalure/novalure-crm` |
| Designbranch | `codex/evelyn-crm-design-concepts` |
| Ausgangsrevision | `ea668e625b8c778c2f79dd6a33210e731bb8a662` |
| Aktuelles CRM-Production-Deployment | `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk` auf obiger Ausgangsrevision; nur lesend verifiziert |
| Ergebnis-Commit | Implementierung `43247d29cb292aa7511d0884f9b97743cf5b1b11`; Nachweise und Abschlussbericht im nachfolgenden Dokumentationscommit desselben Branches |
| Design-Preview-Projekt/-Deployment | **BLOCKIERT** – Erstdeployments wurden trotz Preview-Auftrag automatisch Production zugeordnet; beide neuen Demoprojekte sind pausiert (Abschnitt 11) |
| Design-Preview-URL | Private, zugängliche Ergebnisseite mit interaktiver Sandbox-Vorschau: https://chatgpt.com/space/page_c4e8b4f5bddc81919c228c97c0f8ae80 . Die Vercel-Preview bleibt separat blockiert. |
| Frontend-Build | **PASS** – `npm run build`, statischer Export; `npm run typecheck` ebenfalls bestanden |
| Drei Varianten erreichbar | **PASS lokal** – Auswahl, A/B/C sowie Vergleich; keine erfolgreiche Online-Preview-Abnahme |
| Demo-Navigation | **PASS** – 15 Ansichten über Navigation, Varianten-/Vergleichswechsel mit Kontext, sechs Einrichtungsschritte, Tabs und lokale Freigabe |
| Responsive Grunddarstellung | **PASS** – 15 Ansichten bei 1440 px und 390 px, alle drei Dashboards bei 768 px; kein horizontaler Seitenüberlauf |
| Keine produktiven Anwendungsdaten/-aktionen | **PASS** – unabhängige Quellprüfung, statischer Export; Browser: 0 externe oder nicht-GET-Anfragen, 0 JavaScript-Fehler; Preview-Projekt hat 0 Umgebungsvariablen |
| Geänderte Dateien | Vollständige Liste: `CHANGED-FILES.txt`; Anwendung und Nachweise unter `design-concepts/`, eine zusätzliche branchbezogene Deploymentsperre in Root-`vercel.json` |

Für die Designanalyse wurden Repositorydateien und öffentliche Referenzseiten gelesen sowie die drei Einzelreferenzen visuell betrachtet. In diesem Dokumentationsschritt wurden keine Tests ausgeführt. Der geforderte Abschlussumfang besteht aus Frontend-Build, Erreichbarkeit der drei Varianten, Demo-Navigation, responsiver Grunddarstellung und Prüfung der Datentrennung. Weitere Prüfungen sind nur bei einem konkreten Befund oder einem tatsächlich anwendbaren verpflichtenden Gate erforderlich.

Die Designentscheidung ist mit C einschließlich der Farben festgehalten. Offene fachliche Punkte bleiben die konkrete Ausarbeitung der gemeinsamen C-Komponenten, eine spätere Nutzerprüfung, die exakte Portalnavigation nach Rollen und Modulrechten sowie die Integration zukünftiger Fähigkeiten nach deren eigener Abnahme.

## 10. Nachweise der Designprüfung

`verification/summary.json` bindet die Checks an den SHA-256-Quelldigest. `source-manifest.json` und `export-manifest.json` enthalten die Quelldatei- beziehungsweise Exporthashes; `browser-results.json` enthält die Beobachtungen. Die anfangs gefundenen zwei mobilen Überläufe wurden korrigiert und erneut gezielt geprüft. Ein unabhängiger Quellreview fand keine produktiven Datenpfade; seine beiden P2-Befunde zu Vergleichskontext und Dialognamen wurden behoben und im Browser geprüft. Kein Production-, Merge- oder CRM-Regressionstest wurde als ausgeführt behauptet.

## 11. Vercel-Abweichung und verbleibende Bereinigung

**Eine regelkonforme Online-Preview konnte in dieser Sitzung nicht bereitgestellt werden.** Der native Vercel-Aufruf erhielt zuerst ausdrücklich `target: "preview"`. Vercel erzeugte für das neue, vollständig isolierte Projekt `evelyn-crm-design-concepts` dennoch `dpl_6MLXqWM4coUN6N6jKmabxa2ZgtuC` mit `target: "production"`. Ein sofortiger Abbruch wurde mit `deployment_not_canceled` abgewiesen, weil die statische Bereitstellung bereits READY war. Das Projekt wurde daraufhin pausiert.

Die offizielle OpenAPI beschreibt einen ausgelassenen `target` als Preview. Ein Aufruf ohne dieses Feld erzeugte im pausierten Projekt tatsächlich einen Preview-Datensatz (`target: null`, `dpl_5KQur5JArHkyNAaYbQcKa9MYN7Fb`), blieb dort aber BLOCKED. Ein einzelner korrigierter Erstbereitstellungsversuch in `evelyn-crm-design-preview` wurde erneut automatisch Production (`dpl_2Kjy1RBzwMLgcvSBteg4T4tif3Gx`). Auch dieses Projekt wurde sofort pausiert. Weitere Versuche wurden beendet.

Das ist eine Abweichung von der ausdrücklichen Vorgabe „keine Production-Deployments“ und kein erfolgreicher Preview-Nachweis. Beide Projekte enthielten ausschließlich die 54 statischen Exportdateien plus die restriktive Deploymentkonfiguration, keine CRM-Quellen, Funktionen, Umgebungsvariablen oder produktiven Daten. Ihr Zugangsschutz blieb aktiv. Beide Projektabfragen zeigen nach Pausierung `live: false`. Die automatisch erzeugten Vercel-Standarddomains gehören ausschließlich zu diesen neuen Demoprojekten. Bestehende Domains wurden nicht verändert.

Das produktive CRM wurde zum Abschluss erneut gelesen: unverändert `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk` auf `ea668e625b8c778c2f79dd6a33210e731bb8a662`. Kein Production-Deploy, Rollback oder Konfigurationswechsel des bestehenden CRM wurde ausgeführt.

**Offene Bereinigung:** Die zwei neuen, pausierten Projekte können in Vercel gelöscht werden:

- `evelyn-crm-design-concepts` / `prj_byaRLMqSbFzO3Ci3IahHGzpB200p`
- `evelyn-crm-design-preview` / `prj_M9TqVYIDHvU2e2yatO8caEilA1qA`

Die aktuell verfügbaren Vercel-Werkzeuge bieten keine Projekt-/Deployment-Löschung. Ein angemeldeter CLI- oder Browserzugang steht in dieser Cloud-Sitzung ebenfalls nicht zur Verfügung. Die Bereinigung ist deshalb offen, nicht als erledigt markiert. Das portable Vorschaupaket stellt sämtliche interaktiven Ansichten ohne Node-Installation bereit; Python 3 genügt. Eine spätere Onlinebereitstellung benötigt einen nachgewiesenen Preview-Zielpfad, der die automatische Erst-Promotion verhindert.

## 12. Zugängliche Übergabe vom 19. Oktober 2026

Die ursprünglich angegebenen Cloud-Dateipfade waren für den Nutzer nicht als Downloads beziehungsweise Bilder zugänglich. Die Übergabe wurde deshalb in eine private Page verlegt: https://chatgpt.com/space/page_c4e8b4f5bddc81919c228c97c0f8ae80 . Diese enthält die drei großen Dashboardbilder, den Vergleich, eine eingebettete interaktive Vorschau sowie echte Library-Dateianhänge mit bestätigtem Benutzerzugriff.

Zusätzlich liegt `evelyn-crm-interaktiv.html` als einzelne portable Datei vor. Sie enthält die bestehenden UI-Komponenten, React, ReactDOM, Inter, Styles und Lizenzen eingebettet und benötigt keine Installation und keine Netzwerkanfragen. Lokale Kopien der Präsentationskomponenten erhalten einen Speicher-Router und `srcDoc`-Frames; die ursprüngliche Next-Anwendung bleibt unverändert. Der Builder benutzt die bereits vorhandenen Next/SWC/Webpack-Abhängigkeiten.

Die neue Vorschau wurde als `file://` und in einer isolierten Browser-Sandbox mit undurchsichtiger Herkunft (`allow-scripts`, ohne `allow-same-origin`) geprüft. Alle 15 Ansichten und die sechs Einrichtungsschritte bestanden; JavaScriptfehler und HTTP-Anfragen jeweils 0. Variantenwechsel erhalten Ansicht und Demo-Mandant; Mobile-/Vergleichsframes sowie Dark Mode wurden geprüft. Der Quelltext dieses Übergabeadapters und die Beobachtungen stehen unter `scripts/build-shareable-preview.cjs`, `scripts/shareable-entry.tsx` und `verification/shareable-browser-results.json`.

Die automatische Production-Zuordnung bei neuen Vercel-Projekten ist offiziell beschrieben: https://vercel.com/docs/deployments/environments#first-deployment . Die zwei pausierten Demoprojekte werden nicht reaktiviert. Es wurde kein weiterer Vercel-Deploymentversuch unternommen.
