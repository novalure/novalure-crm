# Integration von Evelyn Design C

Design C wird als isolierte, statisch exportierbare Next.js-Präsentationsapp unter `design-c/` entwickelt. Sie verwendet die vorhandenen Root-Abhängigkeiten, lokale synthetische Daten und eigenen UI-Zustand. Authentifizierung, APIs, Datenbank, RLS, Migrationen und fachliche Geschäftslogik bleiben bei den bestehenden und parallelen Implementierungen. Der aktuelle Produktivstand und die Quellgrenzen sind in [ANALYSIS.md](./ANALYSIS.md) dokumentiert.

## Gemeinsame Präsentationsschnittstelle

Die UI wird in zwei Schichten integriert: Die bestehenden Controller liefern autorisierte, bereits auf Scope und Produktrolle begrenzte Daten. C-Komponenten rendern diese Daten und melden Nutzerabsichten über typisierte Callbacks zurück. Workspacewahl, Rollenableitung, CSRF, Speichern und Publizieren bleiben vollständig beim bisherigen Controller. Darstellungsattribute wie `portal` oder `kind` gewähren keine Berechtigung.

Die isolierte App verwendet `design-c/lib/types.ts` für `DesignView`, `DemoWorkspace`, `DomainViewProps` und `PreviewAction`. Diese Typen sind ausdrücklich Demo-Typen und werden nicht als produktiver Session-/Grantvertrag verwendet. Für den späteren Einbau empfiehlt sich ein separater Adaptervertrag nach folgendem Muster; dies ist ein Vorschlag, keine neu eingeführte API:

```ts
type DataState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; retry?: () => void }
  | { status: "empty"; message: string }
  | { status: "ready"; value: T; completeness: "complete" | "limited" };

type PresentationScope = Readonly<{
  workspaceLabel: string;
  projectLabel: string;
  valid: boolean;
}>;

type NavigationItem<Id extends string> = Readonly<{
  id: Id;
  label: string;
  icon: string;
  availability: "available" | "planned";
}>;

type ShellProps<Id extends string> = Readonly<{
  scope: PresentationScope;
  items: readonly NavigationItem<Id>[]; // vom Controller vorgefiltert
  activeId: Id;
  onNavigate: (id: Id) => void;
  children: React.ReactNode;
}>;

type MutationControl = Readonly<{
  visible: boolean;
  enabled: boolean;
  pending: boolean;
  reason?: string;
}>;
```

Der Adapter setzt `ready`/`empty` erst nach erfolgreichem Modul-Laden. `moduleSources`, `moduleErrors` und `collectionCompleteness` aus `CoreCrmDataResult` bleiben erkennbar; Fallback wird nicht zu einem erfolgreichen leeren Bestand normalisiert. DTOs werden nicht durch frei editierbare Designobjekte ersetzt. Konkrete ID-/Versionsfelder für spätere Mutationen kommen aus dem zuständigen Fachvertrag.

## Übergabe pro Arbeitspaket

| Paket                                         | C-Bausteine und Anschlussstelle                                                                                                                                                                 | Was der funktionale Owner liefert                                                                                             | Erhaltungs-/Abnahmepunkte                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 – Studio-Unternehmensprofil                 | Shell, Kontextzeile, Dashboard-/Projektkarten, Studioansicht, Websiteanfragen; Anschluss an `crm-workspace.tsx`, `studio-navigation.ts`, `company-profile-settings.tsx`, `StudioEnquiryContent` | Bestehende erlaubte Navigationseinträge, autorisierte Projektliste, Unternehmensprofil-DTO, bestehende Handlers               | Studio-Preset/Hashes, Sprachwahl, Modulfilter, erlaubten Projektwechsel und Trennung synthetischer Anfragen erhalten. Intake, Dateizugriff und Release-Bindung bleiben unverändert.                                           |
| 2 – Mandantenfähige Wissensverwaltung         | Quellenliste, Wissensebenen, Kontext-/Zuweisungschips, Detail-/Leerezustände; visuelle Nachfolge für Teile der `knowledge-command-center.tsx`                                                   | Endgültige Wissens-DTOs, Quellen-/Kontext-/Zuweisungsmodell, zulässige Ziele und Aktionen; Scope vom existierenden Controller | Keine universelle Zuordnung aus `projectId` erfinden. Unternehmens-, Website-, Projekt- und Assistentenwissen nur mit fachlich geliefertem Zusammenhang anzeigen; Fremdmandantenfälle in der funktionalen Integration prüfen. |
| 3 – Entwürfe, Versionierung, Veröffentlichung | Versionstimeline, Diff-/Reviewdarstellung, Prüfstatus, Bestätigungsdialog, Lade-/Fehler-/Konfliktzustände                                                                                       | Verbindliche Versions-/Digestfelder, Statusmaschine, Rechte und bestehende Review-/Publish-/Rollback-Callbacks                | CTA zeigt konkrete Version und Wirkung; nach Fehler kein Erfolg. Die Designvorschau verändert nur lokalen Zustand und kann keine Veröffentlichung bestätigen.                                                                 |
| 4 – Migrationen und technische Integration    | DTO-zu-ViewModel-Adapter und semantische Lade-/Fehleranzeige; bestehende Loader-/API-Controller speisen C-Props                                                                                 | Abgenommene Daten-/API-Verträge sowie Migrations-/Runtime-Evidenz; Auth-/Grantprüfung bleibt serverseitig                     | Keine SQL-, Schema-, Session-, RLS-, Fetch- oder Endpointänderung aus dem Designpaket. Paket 4 entscheidet die endgültige technische Zuordnung und führt eigene Integrationstests aus.                                        |

Paket 1 ist im Ausgangsstand als Studio-Navigationsprofil nachweisbar. Für Pakete 2–4 wurde kein eindeutig zugeordneter erreichbarer Ergebnisstand belegt. Die Übergabeverträge oben bereiten Zusammenarbeit vor; sie behaupten keine Umsetzung oder Abnahme dieser Pakete.

## Empfohlene Komponentenaufteilung

- **Shell und Kontext:** vorhandenen Controller in `crm-workspace.tsx` beibehalten; Rail, mobile Navigation, Header und Kontextdarstellung erhalten `items`, Scope-Labels und Callbacks. Die Liste wird nach bestehender Rechte-/Modulprüfung übergeben. `onWorkspaceChange` wird nur mit der bereits autorisierten Auswahl verbunden.
- **Dashboard:** C-KPI-/Chart-/Prioritätskarten zeigen fertig berechnete Daten an. Bestehende Betrags-/Provisions-/Periodenberechnungen aus `dashboard-overview.tsx` werden nicht durch synthetische Demo-Formeln ersetzt. Fehlende oder unvollständige Werte erhalten einen eigenen Zustand.
- **Domänenkarten und Listen:** Kunden-, Studio-, Immobilien-, Assistenten- und Wissenszeilen erhalten nur benötigte DTO-Felder als `Readonly`-Props. Suche, Filter und lokale Ansichten können Präsentationszustand sein; Datenänderungen bleiben Fachcallbacks.
- **Review und Aktionen:** Buttons erhalten sichtbaren/enabled/pending-Zustand und erklärbaren Sperrgrund. Bestehende Validierung, Actionversion, Idempotenz und Serverentscheidung bleiben beim Fachcontroller. Erfolgsmeldungen folgen dessen Ergebnis.
- **Status und Historie:** semantische Statuswerte werden zentral auf Farbe **und** Text/Icon abgebildet. Ein Aktivitätsfeed bekommt autorisierte Ereigniszeilen; er implementiert keinen neuen Audit-Store. Portal-/Adminansichten erhalten getrennte, vorgefilterte Navigation und Daten.
- **Primitiven:** bestehende nativen Schnittstellen aus `src/components/ui/` als Vorbild für Buttons, Felder, Dialoge und Zustände verwenden. C-Farben, Typografie, Abstände, Radius, Schatten und Fokus bleiben zentral im isolierten Designsystem.

## Integrationsreihenfolge ohne Branchkonflikte

1. Isolierte C-Demo und Komponenten mit synthetischen Fixtures lokal abnehmen; geänderte Dateien auf `design-c/` begrenzen.
2. Mit jedem Paket dessen **konkrete aktuelle Revision**, DTOs und Controller-Anschluss bestätigen. Keine fehlenden Versionen oder Status aus einem alten Branch ableiten.
3. Zuerst Primitiven und Shell-Darstellung in einem eigenen Integrationsschritt anbinden. Den bestehenden zustandsbehafteten Shellcontroller erhalten; keine vollständige Ersetzung der großen `crm-workspace.tsx` aus dem Designbranch.
4. Pro Domäne einen kleinen Adapter und Komponentenanschluss reviewen. Die funktionalen Paketowner behalten ihre Datenmodelle und Geschäftsregeln. Keine unkontrollierten Merges oder Übernahme von Demo-Fixtures in operative Loader.
5. Im integrierten Stand bestehende Rechte-/Scope-/Intake-Prüfungen sowie betroffene normale Benutzerabläufe ausführen. Separat Desktop/Mobil, Tastatur, Fokusführung, Dialogrückkehr, lange Texte, leere/ladende/fehlerhafte Daten und reduzierte Bewegung prüfen.
6. Eine geschützte Preview nur mit konkreter Deployment-/Revisionsevidenz als bereitgestellt melden. Die lokale statische App und die Quellcodeintegration allein belegen kein Deployment oder CRM-Go-live.

## Erkennbar simulierte Abläufe

Die Demo kann Navigation, Suche/Filter, lokale Entwürfe, Dialoge, Mandantenbeispiele, Portalmodus und vorbereitete Assistenten-/Wissensansichten zeigen. Formulierungen und Status bleiben als Demo erkennbar. Es werden keine echten Assistenten aktiviert, Quellen importiert, Dateien übertragen, Kunden eingeladen, Entwürfe veröffentlicht, E-Mails versendet, Kalendertermine gebucht oder Telefonanschlüsse hergestellt. Produktive Funktionen können erst die entsprechenden fachlichen Controller und ihre tatsächlich geprüften Verträge bereitstellen.
