# Evelyn Design System C

Die gemeinsame Gestaltungsgrundlage liegt unter `design-c/`: zentrale Tokens in `styles/tokens.css`, primitive Layout-/Interaktionsregeln in `styles/foundations.css`, Shell-/Dashboard-/Domänenstyles in den jeweiligen CSS-Dateien und React-Bausteine in `components/ui.tsx`. Diese Dateien gehören zur isolierten Designvorschau. Es besteht keine Live-Datenanbindung.

## Herkunft und Farbverwendung

Verbindlich ist **C – Evelyn AI Command Center einschließlich der Farben**. [reference.json](./reference.json) bindet die ausgewählte Page über SHA-256 `c3e29880422ff39dd58c4ecd6d332381ca0445976be98fcbcec3fea0b5db6e27` und den CRM-Konzeptquellstand `02f90ca` ein. Die Palette wird aus `.theme-c`, `.command` und dem zugehörigen Dark-Mode des Concepts-Branches übernommen.

| Verwendung                       | Token                                    | Heller Standard       |
| -------------------------------- | ---------------------------------------- | --------------------- |
| Seitenhintergrund / Karten       | `--dc-canvas` / `--dc-surface`           | `#f7f8fc` / `#ffffff` |
| Haupttext / zurückhaltender Text | `--dc-text` / `--dc-muted`               | `#252c40` / `#636b80` |
| Akzent / weiche Akzentfläche     | `--dc-accent` / `--dc-accent-soft`       | `#666ad1` / `#eff0fc` |
| Akzent als Text / Hover          | `--dc-accent-text` / `--dc-accent-hover` | `#5357b4` / `#565ac0` |
| Trennlinie / Eingabegrenze       | `--dc-line` / `--dc-border`              | `#e8eaf1` / `#858ca0` |
| Navigation / Intelligence-Karte  | `--dc-rail` / `--dc-intelligence`        | `#171d30` / `#242a42` |
| Fokus                            | `--dc-focus`                             | `#5954bc`             |

Die Kernfarben stammen aus C. Für die beabsichtigte WCAG-AA-Lesbarkeit wurde der Referenz-Muted-Wert `#777e91` zu `#636b80` und Rail-Text `#929cb4` zu `#a1abc0` angepasst. Eingabegrenzen verwenden `#858ca0`; semantische Vordergrundfarben sind für ihre weichen Hintergründe abgedunkelt. Diese zielgerichteten Kontrastanpassungen sind in `tokens.css` dokumentiert. Sie ersetzen keinen vollständigen Accessibility-Audit aller Zustände und Kombinationen; konkrete Prüfergebnisse gehören in den Prüfbericht.

Erfolg, Warnung, Fehler, Information, Neutral und Violett haben getrennte `--dc-*-bg`, `--dc-*-text` und gegebenenfalls `--dc-*-border`-Tokens. Farbe unterstützt sichtbaren Statustext und Marker; sie ist kein alleiniger Informationsträger. Fachliche Statusbedeutung kommt aus dem jeweiligen Modul.

## Theme, Namespaces und Maße

Die Wurzelklasse `.design-c` ist der CSS-Namespace. Helle Darstellung ist Standard; `.design-c[data-theme="dark"]` aktiviert die optionale dunkle Darstellung ausdrücklich. Der Preview-Schalter ist ein lokaler Darstellungszustand und keine Rollen- oder Zugriffsänderung. Dark Mode verwendet unter anderem Canvas `#121827`, Surface `#1a2032`, Text `#e1e5f1` und Accent `#9da6ff`.

Die CSS-Adapter für bestehende `--nl-*`-Primitiven werden ausschließlich innerhalb `.design-c` gesetzt. Root-Tokens und die produktive `.crm-app` werden nicht global überschrieben. `app/layout.tsx` lädt die isolierten Styles und die vorhandene lokale Inter-Abhängigkeit; kein externer Fontdienst ist erforderlich.

- Schrift: `--dc-font`, Inter Variable; Textskala von `--dc-type-xs` bis `--dc-type-display`, mit fließender Displaygröße über `clamp()`.
- Abstände: `--dc-space-1` bis `--dc-space-7` entsprechen 4, 8, 12, 16, 24, 32 und 48 px bei 16 px Root-Schriftgröße.
- Radien: klein 8 px, Standard 12 px, groß 16 px; Schatten über `--dc-shadow` und `--dc-shadow-raised`.
- Bedienhöhen: Standardtoken 46 px, kompakt 44 px; Wrapper-Buttons haben mindestens 44 × 44 px. Shell-spezifische Maße stehen in `shell.css`; die Desktoprail verwendet dort 240 px ausgeklappt und 84 px eingeklappt.
- Tabellen: 560 px Mindestbreite, 44 px Headerhöhe; der eigene Bereich ist horizontal scrollbar und per Tastatur fokussierbar.

Breakpoints stehen als dokumentierende Tokens und als **literale Werte** in Media Queries: 1100 px für Tablet-Anpassungen, 720 px für mobile Navigation und einspaltige Karten, 390 px für eine einzelne KPI-Spalte. Die Shell verdichtet zusätzlich bei 1250 px; das Dashboard passt seine Zusammensetzung bei 1450, 1250 und 1000 px an. CSS Custom Properties können nicht als `var()` in diesen Viewport-Media-Query-Bedingungen verwendet werden; bei Änderungen müssen Dokumentation, Tokens und betreffende Literale gemeinsam aktualisiert werden.

## Komponenten-API

`components/ui.tsx` importiert die vorhandenen Produktionsprimitiven aus `src/components/ui/`. Buttons, Surfaces, Status, Felder und Zustandsdarstellung behalten ihre nativen Schnittstellen; C ergänzt scoped Klassen und Tokens. Es wird keine zweite grundlegende Button-/Field-Bibliothek eingeführt.

| Baustein | Öffentliche Props / Verwendung |
| --- | --- |
| `Button`, `IconButton` | Vorhandene native Props und Refs; Varianten `primary`, `secondary`, `ghost`, `danger`. Iconbuttons verlangen `aria-label`. |
| `Field`, `Input`, `Select`, `Textarea` | Vorhandene Primitiven; Label-ID, Fehler-ID und ARIA-Beschreibungen setzt der Consumer. |
| `Notice` | Semantische Meldung mit `tone` und optionalem Live-Announcement. |
| `Card` | `title?`, `eyebrow?`, `actions?`, `children`, `className?`; verwendet `Surface`. |
| `Badge` | `tone?`: neutral, info, success, warning, danger, violet; `children`. |
| `MetricCard` | `label`, `value`, `detail?`, `icon?`. |
| `PageHeading` | `eyebrow?`, `title`, `description?`, `actions?`. |
| `Tabs` | `items`, `value`, `onChange`, `label`; Abschnittsschalter mit `aria-pressed`, Pfeiltasten, Home und End. |
| `DataTable` | `caption`, `columns`, `rows`, `emptyMessage?`; Zeilen mit `id`, `cells`, `search`, `status?`, `sortValues?`. Suche, Filter, Sortierung und Pagination mit sechs Zeilen je Seite. |
| `Dialog` | `open`, `title`, `onClose`, `children`; natives modales `dialog`, Escape und Fokuswiederherstellung. |
| `EmptyState`, `LoadingState` | `title`, `children?`; nur Inline-Text als Beschreibung übergeben, da das vorhandene Primitive einen Absatz erzeugt. |
| `Icon` | `name`, `size?`, `className?`; dekorativ mit `aria-hidden`. Die Aktion benötigt einen eigenen zugänglichen Namen. |

`DataTable` sucht im expliziten `row.search`. `row.sortValues` liefert rohe Zahlen oder vergleichbare Strings für fachlich korrekte Sortierung, beispielsweise `total: 8400` neben der Darstellung `€ 8.400`. Zwei numerische Werte werden arithmetisch verglichen; sonst dient deutscher Textvergleich mit numerischer Vergleichsoption als Fallback. Geld- und Flächenwerte der Vorschau verwenden rohe Sortierwerte. Eine große Sammlung benötigt weiterhin den bestehenden serverseitigen Controller für autorisierte Suche und Pagination; lokale Paginierung lädt keine fehlenden Datensätze nach.

## Motion und Accessibility

`--dc-duration-fast` (160 ms), `--dc-duration-standard` (240 ms) und `--dc-easing` beschreiben zurückhaltende Interaktionen. Aktuell nutzt der Buttonwrapper die schnelle Transition. `prefers-reduced-motion: reduce` deaktiviert Animationen, Transitions und sanftes Scrollen im Namespace. Keine fachliche Information hängt von Bewegung ab.

Die Grundlagen enthalten sichtbare 3-px-Fokusringe, native Bedienelemente, Screenreader-Hilfstext, Text neben Statusfarben, beschriftete Tabellen und sortierbare Spalten mit `aria-sort`. Paginierungsresultate werden höflich angekündigt. Die Preview-Shell bietet Skip-Link und fokussierbaren Hauptinhalt; mobile Navigation verwendet den gemeinsamen modalen Dialog. Formvalidierung in der Komponentengalerie ist ein lokales Beispiel und keine fachliche oder serverseitige Validierung.

Neue Consumer müssen die Verantwortung für eindeutige Feld-IDs, verständliche Labels, passende Headinghierarchie, Fokusziel nach Navigation und korrektes Fehler-/Lade-/Leer-Verhalten übernehmen. Tastatur-, Screenreader-, Zoom-, Mobil- und Kontrastprüfung gelten jeweils für die konkrete Zusammensetzung; das Vorhandensein der Primitiven allein belegt keine vollständige WCAG-2.2-AA-Konformität.

## Präsentationsdaten und Integrationsgrenze

Die UI-Primitiven können bereits durch übergebene Darstellungsobjekte gespeist werden: beispielsweise autorisierte, bereits begrenzte CRM-DTOs auf `DataTableRow[]` projizieren und Ergebnisse über `Button.onClick` an den bestehenden Controller zurückgeben. Die Komponenten implementieren weder Authentifizierung noch Fetch-/Persistenz- oder Tenantwechsel. Lade-/Fehler-/Fallback-/unvollständige Daten bleiben explizite Zustände; Beispiele und empfohlene Verträge stehen in [INTEGRATION.md](./INTEGRATION.md).

Die aktuellen `CustomersView`, `TenantsView`, `StudioView`, `PropertiesView`, `AssistantsView`, `KnowledgeView`, `PortalOverview` und `CommandDashboard` sind **zusammengesetzte Mock-Vorschauen**. Sie nutzen `DemoWorkspace`, lokale Fixtures und `onPreviewAction`. Gleiches gilt für Evelyn-Briefing, Empfehlungen, Aktivitätsfeed, Freigabe-/Aufgabenkarten und Chat: Der Chat antwortet mit festem lokalem Beispieltext und ruft kein Modell auf. Diese Kompositionen sind keine fertig angeschlossenen oder vollständig DTO-gesteuerten Live-Adapter.

Für die spätere autorisierte Integration werden die Domänenkompositionen in reine View-Props und bestehende Controller geteilt. Produktrolle, Rechtefilterung, echte Workspace-/Projektauswahl, Quellenzuordnung, Versionsprüfung und Veröffentlichung bleiben bei den fachlichen Paketen. Der lokale Portal-Schalter und die in der Preview berechnete Navigationsprojektion sind Darstellungsmuster; sie begründen keine produktiven Berechtigungen. Produktive Routen, Datenbank und Authentifizierung werden durch dieses Designsystem nicht geändert.
