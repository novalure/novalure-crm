# Funnel-Audit

Stand: 2026-05-11

Scope dieser Datei:
- Schritt 1 ist abgeschlossen.
- Schritt 2 ist abgeschlossen.
- Schritt 3 ist abgeschlossen.
- Es wurde keine Editor-Funktion umgesetzt.

## Schritt 1 - Codebasis verstehen

### Verzeichnisstruktur

Ausgabe ohne `node_modules`, `.git`, `.next`, `out`, `dist`, `build`:

```text
.
|-- AGENTS.md
|-- CLAUDE.md
|-- README.md
|-- dev-server.err.log
|-- dev-server.out.log
|-- docs/
|   `-- funnel-audit.md
|-- eslint.config.mjs
|-- next.config.ts
|-- package-lock.json
|-- package.json
|-- postcss.config.mjs
|-- public/
|   |-- file.svg
|   |-- globe.svg
|   |-- next.svg
|   |-- vercel.svg
|   `-- window.svg
|-- src/
|   |-- app/
|   |   |-- favicon.ico
|   |   |-- globals.css
|   |   |-- layout.tsx
|   |   `-- page.tsx
|   |-- components/
|   |   |-- bot-language-tester.tsx
|   |   |-- calendar-command-center.tsx
|   |   |-- contact-command-center.tsx
|   |   |-- dashboard-overview.tsx
|   |   |-- deal-pipeline-workspace.tsx
|   |   |-- funnel-command-center.tsx
|   |   |-- lead-inbox.tsx
|   |   |-- newsletter-command-center.tsx
|   |   `-- task-command-center.tsx
|   `-- lib/
|       |-- crm-data.ts
|       |-- crm-types.ts
|       `-- i18n.ts
`-- tsconfig.json
```

### Tech-Stack

- Frontend: Next.js App Router, React 19, TypeScript.
- Styling: Tailwind CSS 4 ueber PostCSS.
- Build: `next build`.
- Linting: ESLint 9 mit `eslint-config-next`.
- Datenhaltung aktuell: statische TypeScript-Daten in `src/lib/crm-data.ts` plus lokale React-State-Drafts in Komponenten.
- Backend/API: kein eigener API-Layer sichtbar.
- Datenbank: keine DB-Anbindung sichtbar.
- Persistenz:
  - Funnel-Editor: React-State innerhalb `FunnelCommandCenter`; keine dauerhafte Speicherung sichtbar.
  - Lead Inbox: Session-State fuer lokal erfasste Leads; keine dauerhafte DB-Persistenz sichtbar.
  - Kontakte: teilweise `localStorage` in `ContactCommandCenter`.
- Installierte relevante Pakete:
  - `next`
  - `react`, `react-dom`
  - `react-grid-layout`, `@types/react-grid-layout`
  - `html2canvas`
  - `jspdf`
  - keine sichtbaren Pakete fuer DnD, Rich Text, Emoji Picker, Phone Validation, Form Builder, Schema Validation, DB/ORM.

### App-Entry-Points

- Haupt-Entry: `src/app/page.tsx`
  - Client Component.
  - Haltet globalen CRM-Zustand fuer aktive Rubrik, aktives Projekt, Sprache und Navigation.
  - Importiert CRM-Daten aus `src/lib/crm-data.ts`.
  - Rendert je nach `activeSection` die Command-Center-Komponenten.

- Funnel-Entry im CRM: `src/app/page.tsx`
  - Bei `activeSection === "funnels"` wird `FunnelCommandCenter` gerendert.
  - Props:
    - `funnels={visibleFunnels}`
    - `steps={visibleFunnelSteps}`
    - `leads={visibleLeads}`
    - `projects={projects}`
    - `users={users}`
    - `projectLabel={projectScopeLabel}`
    - `language={language}`

- Funnel-Editor und Design-Editor: `src/components/funnel-command-center.tsx`
  - Zentrale Komponente fuer Funnel-Liste, Funnel-Auswahl, Editor-Tabs, Design-Tab, Steps, Logik, Messages, Tracking, Analyse, Datenschutz, A/B-Tests, CRM-Uebergabe, Workspace und Vorschau.
  - Arbeitet mit internem React-State:
    - `editedFunnels`
    - `editedSteps`
    - `selectedFunnelId`
    - `selectedStepId`
    - `selectedDesignBlockIndex`
    - `draggedDesignBlockIndex`
    - `trackingEvents`
    - `monitor`
    - `previewStepIndex`

- Funnel-Rendering fuer Leads:
  - Kein separater Public-Funnel-Renderer gefunden.
  - Es gibt keine Route wie `/funnel/[id]` oder `/preview/[funnelId]`.
  - Die sichtbare Vorschau lebt aktuell nur innerhalb `FunnelCommandCenter`.

- Lead-Speicherung:
  - Statische Leads: `src/lib/crm-data.ts`, Export `leads`.
  - Lead Inbox UI: `src/components/lead-inbox.tsx`.
  - Neue Leads in Lead Inbox werden als `sessionLeads` in React-State erzeugt.
  - Kein Submit-Endpunkt, keine DB-Insert-Funktion, kein API-Route-Handler sichtbar.

### Funnel-Datenmodell

#### Persistentes Basis-Modell

Quelle: `src/lib/crm-types.ts`

```ts
type Funnel = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  name: string;
  goal: string;
  audience: LeadType;
  entryChannel: FunnelChannel;
  status: "aktiv" | "optimieren" | "entwurf";
  visits: number;
  leads: number;
  conversionRate: number;
  ownerUserId?: ID;
};
```

```ts
type FunnelStep = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  funnelId: ID;
  name: string;
  channel: FunnelChannel;
  status: "aktiv" | "pruefen" | "blockiert" | "entwurf";
  visits: number;
  leads: number;
  conversionRate: number;
  dropOffReason: string;
  nextOptimization: string;
  botRuleId?: ID;
};
```

Basis-Funnel-Daten liegen in `src/lib/crm-data.ts`:
- `funnels`
- `funnelSteps`

#### Editor-Erweiterung im React-State

Quelle: `src/components/funnel-command-center.tsx`

`EditableFunnel` erweitert `Funnel` aktuell um Editor-/Design-/Tracking-Felder:

- Adaptierung:
  - `adaptationBrief`
  - `templateUseCase`
- Branding und Design:
  - `brandPreset`
  - `highlightColor`
  - `customDomain`
  - `mobileFirstMode`
  - `headerMode`
  - `landingPageBlocks`
  - `designerHeroTitle`
  - `designerHeroSubtitle`
  - `designerCtaLabel`
  - `designerLogoText`
  - `designerBackgroundColor`
  - `designerTextColor`
  - `designerBlockText`
  - `designerFontPreset`
  - `designerButtonRadius`
  - `designerBlockRadius`
  - `designerSectionSpacing`
- Booking und Follow-up:
  - `bookingProvider`
  - `leadMagnet`
  - `newsletterSegment`
  - `doubleOptIn`
  - `whatsappInbox`
  - `emailSequence`
  - `messageCondition`
  - `messageDelay`
  - `replySender`
  - `crmStage`
  - `followUp`
  - `leadDestination`
- Tracking:
  - `metaPixelId`
  - `metaCapiToken`
  - `gaMeasurementId`
  - `gtmId`
  - `matomoSiteId`
  - `consentMode`
  - `cookieConsent`
  - `webhookUrl`
- Datenschutz:
  - `dataRetention`
  - `sensitiveMode`
- Testing/Workspace/CRM:
  - `abVariant`
  - `trafficSplit`
  - `winningRule`
  - `workspaceAccess`
  - `statusTemplate`
  - `notificationRecipients`
  - `leadQualityRule`
  - `triggerLeadInbox`
  - `triggerTask`
  - `triggerAppointment`

Wichtige Beobachtung:
- Diese Editor-Felder sind nicht im persistenten `Funnel`-Typ enthalten.
- Sie entstehen in `normalizeFunnel()` und `createFunnel()`.
- Dadurch sind sie aktuell UI-State, aber kein belastbares gespeichertes Funnel-Schema.

#### Step-Erweiterung im React-State

`EditableStep` erweitert `FunnelStep` um:

- `type`
- `question`
- `options`
- `score`
- `required`
- `crmField`
- `condition`
- `target`
- `analyticsEvent`

Auch diese Felder sind nicht im persistenten `FunnelStep`-Typ enthalten.

### Bestehende Funnel-/Block-Typen

#### Step-Typen

Quelle: `stepTypes` in `src/components/funnel-command-center.tsx`

- Landingpage
- Auswahlfrage
- Mehrfachauswahl
- Kontaktformular
- Bot
- Kalender
- Danke-Seite
- Adresse
- Upload
- Video
- Payment
- Loader
- Ergebnisseite

#### Landingpage-Block-Bibliothek

Quelle: `landingPageBlockOptions` in `src/components/funnel-command-center.tsx`

- Hero
- Vorteile
- Projektvideo
- Testimonials
- FAQ
- Countdown
- Kontaktformular
- Kalender

#### Tracking-Event-Typen

Quelle: `defaultTrackingEvents` in `src/components/funnel-command-center.tsx`

- Funnel geladen / Meta `PageView` / GA `page_view`
- Funnel gestartet / Meta `ViewContent` / GA `funnel_start`
- Schritt angesehen / Meta `ViewContent` / GA `funnel_step_view`
- Antwort gewaehlt / Meta `CustomizeProduct` / GA `funnel_answer`
- Lead gesendet / Meta `Lead` / GA `generate_lead`
- Termin gebucht / Meta `Schedule` / GA `book_appointment`

### Aktuelle Editor-Architektur

- Ein einzelner React-Komponenten-Editor in `FunnelCommandCenter`.
- Tabs als `BuilderTab`:
  - Uebersicht
  - Funnel bearbeiten
  - Design
  - Schritte
  - Logik
  - Messages
  - Tracking
  - Analyse
  - Datenschutz
  - A/B-Tests
  - CRM-Uebergabe
  - Workspace
  - Vorschau
- Kein separates Canvas-/Renderer-Modell.
- Kein Section/Row/Column/Element-Baum.
- Keine getrennte Render-Engine fuer Editor und Public Preview.
- Design-Tab verwendet derzeit `landingPageBlocks: string[]` als einfache Block-Reihenfolge.
- Blocks enthalten aktuell keine eigenen Eigenschaften pro Block, ausser globalem `designerBlockText`.

### Aktuelle Live-Vorschau

- Design-Vorschau im Tab `Design`.
  - Nutzt Designer-Felder aus `EditableFunnel`.
  - Zeigt mobile Kartenansicht.
  - Blockauswahl in Vorschau anklickbar.
- Step-Vorschau im Tab `Vorschau`.
  - Nutzt `previewStepIndex`.
  - Zeigt Schritte mit Optionen.
- Keine externe Preview-URL.
- Kein Public-Funnel ohne CRM-Chrome.
- Kein Test-Submit-Modus sichtbar.
- Kein QR-Code.

### Aktuelle Lead-Erfassung

- Kein Funnel-Submit-Endpunkt sichtbar.
- Keine DB-Speicherung aus Funnel-Preview sichtbar.
- `LeadInbox` kann manuell Leads in `sessionLeads` erfassen.
- Funnel-Uebergabe ist konzeptionell im UI vorhanden:
  - Lead Inbox
  - Pipeline
  - Kalender
  - Newsletter Segment
- Es gibt keine technische Verbindung von einem ausgefuellten Funnel-Formular zu Lead-Erzeugung.

### Auffaelligkeiten aus Schritt 1

- Es ist aktuell eine starke CRM-Prototyp-App mit vielen UI-Oberflaechen, aber ohne Backend-Persistenz.
- Der Funnel-Builder ist bereits im CRM integriert.
- Der Designer wurde bereits deutlich erweitert, basiert aber noch auf einem flachen Blocklisten-Modell.
- Das langfristig notwendige Kernmodell fuer einen marktfaehigen Builder fehlt noch:
  - Page
  - Section
  - Row
  - Column
  - Element
  - Field
  - Variant
  - Theme/Brand Kit
  - Submission
  - Preview Session
  - Event Tracking
- Die meisten aktuell sichtbaren Editor-Felder leben nur in React-State und sind nicht Teil eines gespeicherten Schemas.

## Schritt 2 - Gap-Analyse

Bewertungslogik:
- [OK] vorhanden: Im sichtbaren Code als nutzbare Funktion vorhanden.
- [Teilweise] teilweise: UI, Datenfeld oder Prototyp vorhanden, aber ohne vollstaendige Produktlogik, Persistenz oder echte Laufzeitwirkung.
- [Fehlt] fehlt: Im sichtbaren Code nicht gefunden.

### Editor-Architektur

| Feature | Status | Befund im Code |
|---|---:|---|
| Hierarchie Section -> Row -> Column -> Element | [Fehlt] | Kein Builder-Baum sichtbar. `Funnel` und `FunnelStep` sind flach; Design nutzt `landingPageBlocks: string[]`. |
| Nested Layouts | [Fehlt] | Keine Container- oder Layout-Knoten fuer verschachtelte Strukturen. |
| Drag & Drop | [Teilweise] | HTML5-Drag fuer Landingpage-Bloecke vorhanden (`draggedDesignBlockIndex`, `dropDesignBlock()`), aber kein vollwertiges Canvas-DnD fuer Sections/Rows/Elements. |
| Klick-zum-Bearbeiten / WYSIWYG | [Teilweise] | Vorschau-Bloecke sind anklickbar und oeffnen ein Formular, aber keine direkte Inline-Bearbeitung im Canvas. |
| Mobile-First Editor | [Teilweise] | Feld `mobileFirstMode` und mobile Vorschau vorhanden, aber keine echten Breakpoint-spezifischen Werte. |
| Inline-Texteditor Bold/Italic/Link/Farbe/Groesse | [Fehlt] | Texte werden ueber normale Inputs/Textareas bearbeitet. Kein Rich-Text-Editor-Paket sichtbar. |
| Rechtschreibpruefung | [Fehlt] | Keine eigene Pruefung sichtbar; nur Browser-Standard moeglich. |
| KI-Umschreiben | [Fehlt] | Keine KI-Funktion im Funnel-Editor sichtbar. |
| Element duplizieren | [Teilweise] | Steps und Design-Bloecke koennen dupliziert werden. Keine allgemeinen Elemente. |
| Kopieren/Einfuegen ueber Seiten und Funnels | [Fehlt] | Keine Clipboard- oder Cross-Funnel-Logik sichtbar. |
| Universal Elements Header/Footer | [Fehlt] | Header-Modus als Select vorhanden, aber kein globales Universal-Element-System. |
| Tastatur-Shortcuts | [Fehlt] | Keine Shortcut-Handler sichtbar. |
| CMD+K Quick-Menue | [Fehlt] | Nicht sichtbar. |
| Auto-Save | [Teilweise] | UI sagt Entwurf/Save, aber keine echte Persistenz. `saveDraft()` schreibt nur Monitor/Notice. |
| Undo/Redo 50+ Schritte | [Fehlt] | Keine History-Struktur sichtbar. |
| Versionierung | [Fehlt] | Keine Versionen, Snapshots oder Revisionen sichtbar. |
| Echtzeit-Kollaboration | [Fehlt] | Keine Backend-/Realtime-Schicht sichtbar. |
| Custom CSS/JS pro Container | [Fehlt] | Keine Container und kein Code-Editor sichtbar. |
| Info-Tab mit Fehlerpruefung | [Fehlt] | Kein Validierungs-/Issue-Panel sichtbar. |

### Vorschau und Testmodus

| Feature | Status | Befund im Code |
|---|---:|---|
| Inline-Live-Preview im Editor | [Teilweise] | Design-Tab zeigt mobile Vorschau; Vorschau-Tab zeigt Step-Durchlauf. Nicht dieselbe Render-Engine wie ein Public-Funnel. |
| Device-Toggle Desktop/Tablet/Mobile mit echten Breakpoints | [Fehlt] | Nur `mobileFirstMode` als Toggle. Keine Tablet/Desktop-Breakpoints oder breakpoint-spezifischen Styles. |
| Full-Preview-URL `/preview/{funnelId}?token=...` | [Fehlt] | Keine Route in `src/app` gefunden. |
| Preview ohne Editor-Chrome | [Fehlt] | Vorschau liegt innerhalb `FunnelCommandCenter`. |
| Test-Submit ohne DB-Lead | [Teilweise] | Button simuliert Lead-Uebergabe via Monitor/Notice, aber kein echter Testmodus mit Submission-Pipeline. |
| QR-Code fuer Mobile-Test | [Fehlt] | Nicht sichtbar. |
| A/B-Test-Vorschau beider Varianten | [Fehlt] | A/B-Felder vorhanden, aber keine parallele Variantenvorschau. |
| Vorschau entspricht exakt Lead-Ansicht | [Fehlt] | Kein separater Public-Renderer; Editor-Preview ist eine vereinfachte Darstellung. |

### Volle Anpassbarkeit pro Element

| Feature | Status | Befund im Code |
|---|---:|---|
| Rich-Text pro Textelement | [Fehlt] | Keine Element-Texte, nur Plain-Text-Felder. |
| Emoji-Picker in Textfeldern | [Fehlt] | Kein Emoji-Picker-Paket oder UI sichtbar. |
| Bild-Upload | [Fehlt] | Kein Upload-Flow im Funnel-Editor sichtbar. |
| Medienbibliothek mit Ordnern | [Fehlt] | Nicht sichtbar. |
| Massenupload | [Fehlt] | Nicht sichtbar. |
| Unsplash-Integration | [Fehlt] | Nicht sichtbar. |
| Icons8 / Icon-Bibliothek | [Fehlt] | Nicht sichtbar. |
| Eigenes Favicon | [Fehlt] | Globales App-Favicon vorhanden, aber kein Funnel-Favicon-Feld. |
| 48+ Schriften | [Fehlt] | Nur vier Presets im Designer: System, Modern, Editorial, Serif. |
| Eigene Schriften hochladen | [Fehlt] | Nicht sichtbar. |
| Globale Brand-Paletten | [Teilweise] | `brandPreset`, Highlight-, Hintergrund- und Textfarbe vorhanden; kein echtes Brand-Kit-Schema. |
| 1-Klick-Brand-Anwendung | [Teilweise] | Brand-Preset-Feld vorhanden, aber keine Anwendung auf ein strukturiertes Theme sichtbar. |
| Highlight-Farben individuell | [Teilweise] | Global pro Funnel vorhanden, nicht pro Element. |
| Padding/Margin pro Seite und Device | [Fehlt] | Nur globaler `designerSectionSpacing`. |
| Border Width/Color/Style/Radius pro Ecke | [Fehlt] | Nur Button- und Block-Radius global. |
| Hintergrund Farbe/Gradient/Bild/Video | [Teilweise] | Hintergrundfarbe vorhanden; Gradient/Bild/Video nicht als Hintergrundkonfiguration sichtbar. |
| Animationen | [Fehlt] | Keine Animationseinstellungen sichtbar. |
| Konfetti-Moment | [Fehlt] | Nicht sichtbar. |
| Sichtbarkeit pro Device | [Fehlt] | Keine Element-/Block-Visibility-Settings. |
| Conditional Display pro Element | [Fehlt] | Step-Logik-Felder vorhanden, aber keine Elementbedingungen. |

### Kontaktformular-Felder

| Feldtyp | Status | Befund im Code |
|---|---:|---|
| Text Single-line | [Fehlt] | Kein Form-Field-Schema fuer einzelne Kontaktfelder sichtbar. |
| Textarea Multi-line | [Fehlt] | Kein Form-Field-Schema sichtbar. |
| E-Mail mit Validierung + Double Opt-in OTP | [Teilweise] | `doubleOptIn` als Funnel-Flag vorhanden; keine Feldvalidierung/OTP-Logik. |
| Telefon mit Laendervorwahl + echter Nummernvalidierung | [Fehlt] | Keine Phone-Validation-Library sichtbar. |
| URL | [Fehlt] | Nicht sichtbar. |
| Zahl | [Fehlt] | Kein Kontaktfeldtyp; Score nutzt Number-Input im Editor. |
| Datum | [Fehlt] | Nicht sichtbar. |
| Zeit | [Fehlt] | Nicht sichtbar. |
| Single-Choice Radio | [Teilweise] | Step-Typ `Auswahlfrage` mit Optionen vorhanden; keine Feldkonfiguration als Formularfeld. |
| Multi-Choice Checkboxen | [Teilweise] | Step-Typ `Mehrfachauswahl` vorhanden; keine echte Field-Komponente mit Validierung. |
| Dropdown mit Suche | [Fehlt] | Nicht sichtbar. |
| Slider / Range | [Fehlt] | Nicht sichtbar. |
| Rating Sterne | [Fehlt] | Nicht sichtbar. |
| Datei-Upload mit Limit/Typen | [Teilweise] | Step-Typ `Upload` vorhanden, aber keine Upload-Implementierung oder Restrictions. |
| DSGVO-Consent-Checkbox | [Teilweise] | Datenschutz-/Consent-UI vorhanden, aber kein dediziertes Formularfeldschema. |
| Hidden Field fuer UTM | [Fehlt] | UTM wird im Tracking-Text erwaehnt, aber kein Hidden-Field-Modell sichtbar. |
| Custom-Felder | [Teilweise] | `crmField` pro Step vorhanden, aber keine eigene Field-Definition mit Typ/Validation. |

Pro Feld konfigurierbare Eigenschaften:
- [Teilweise] vorhanden: Frage/Label, Optionen, Required, CRM-Feld, Score.
- [Fehlt] fehlt: Placeholder, Default-Value, Validation-Pattern, individuelle Fehlermeldung, Help-Text, echte Feldtypen, Persistenzschema.

### Logik und Pfade

| Feature | Status | Befund im Code |
|---|---:|---|
| Mehrstufige Funnel | [OK] | `EditableStep[]`, Step-Liste, Preview-Step-Index und Step-Typen vorhanden. |
| Verzweigungen je Antwort | [Teilweise] | `condition` und `target` pro Step vorhanden; keine ausgefuehrte Rule Engine sichtbar. |
| Advanced Linking mit AND/OR | [Fehlt] | Keine AND/OR-Logik oder `json-logic` sichtbar. |
| Berechnungen / Scoring | [Teilweise] | `score` pro Step vorhanden; keine berechneten Scores aus Antworten sichtbar. |
| Individuelle Ergebnisseiten je Pfad | [Teilweise] | Step-Typ `Ergebnisseite` vorhanden; keine Pfad-basierte Ergebnislogik sichtbar. |
| URL-Parameter als Platzhalter | [Teilweise] | Platzhalter kommen in Newsletter-Daten vor; nicht als Funnel-Builder-Funktion sichtbar. |
| Wiederverwendung von Lead-Antworten | [Fehlt] | Kein Antwort-State-Modell fuer dynamische Texte sichtbar. |

### Integrationen und Embeds

| Feature | Status | Befund im Code |
|---|---:|---|
| Calendly Embed | [Teilweise] | Booking-Provider-Select enthaelt Calendly; kein Embed-Code sichtbar. |
| Cal.com Embed | [Teilweise] | Provider-Select enthaelt Cal.com; kein Embed-Code sichtbar. |
| HubSpot Meetings Embed | [Teilweise] | Provider-Select enthaelt HubSpot Meetings; kein Embed-Code sichtbar. |
| GHL Calendar Embed | [Fehlt] | Nicht sichtbar. |
| YouTube/Vimeo/Wistia | [Teilweise] | Step-Typ `Video` und Block `Projektvideo`; keine Provider-/URL-Konfiguration sichtbar. |
| Direkter Video-Upload | [Fehlt] | Nicht sichtbar. |
| HTML-Block fuer Drittanbieter | [Fehlt] | Kein HTML-/Embed-Block sichtbar. |
| Webhooks Out bei Submit | [Teilweise] | `webhookUrl` Feld vorhanden; keine Submit-Ausfuehrung sichtbar. |
| CRM-Sync mit Pipeline-Status | [Teilweise] | CRM-Uebergabe-UI vorhanden; keine echte Persistenz/Sync-Schicht sichtbar. |
| E-Mail-Automation visueller Editor | [Teilweise] | `emailSequence` Textarea und Trigger-Felder vorhanden; kein visueller E-Mail-Editor. |
| WhatsApp-Inbox | [Teilweise] | `whatsappInbox` Flag vorhanden; keine echte Inbox-Integration im Funnel sichtbar. |
| Meta Pixel + CAPI | [Teilweise] | Felder fuer Pixel und CAPI plus Event-Monitor vorhanden; kein echtes Senden sichtbar. |
| Google Tag Manager | [Teilweise] | GTM-ID-Feld vorhanden; keine Runtime-Injection sichtbar. |
| TikTok Events API | [Fehlt] | Nicht sichtbar. |
| LinkedIn Insight Tag | [Fehlt] | Nicht sichtbar. |
| Header-Code-Injection | [Fehlt] | Nicht sichtbar. |

### Branding und White-Label

| Feature | Status | Befund im Code |
|---|---:|---|
| Eigene Domain Root-Level | [Teilweise] | `customDomain` Feld vorhanden; keine Domain-Verifikation/Routing sichtbar. |
| Logo im Header anpassbar | [Teilweise] | `designerLogoText` und `headerMode`; kein Logo-Upload sichtbar. |
| White-Label-Modus | [Teilweise] | Workspace-Zugriff hat Option `Agentur White Label`; keine Branding-Ausblendlogik sichtbar. |
| Sub-Accounts / Workspaces | [Teilweise] | Workspace-/Projekt-Kontext vorhanden; keine echte Account-/Mandantenverwaltung sichtbar. |
| Brand-Kit speichern | [Fehlt] | Kein persistentes Brand-Kit-Modell sichtbar. |
| Brand-Kit mit 1 Klick anwenden | [Teilweise] | `brandPreset` als Feld, aber keine strukturierte Anwendung. |

### Performance und Compliance

| Feature | Status | Befund im Code |
|---|---:|---|
| Mobile-Ladezeit < 3 Sekunden | [Fehlt] | Nicht messbar aus Code; keine Performance-Tests sichtbar. |
| Lighthouse Performance > 85 | [Fehlt] | Kein Lighthouse-Setup sichtbar. |
| PWA-Verhalten | [Fehlt] | Kein Manifest/Service Worker sichtbar. |
| Bilder komprimiert + Lazy Loading | [Fehlt] | Kein Bildsystem im Funnel-Editor sichtbar. |
| CDN-Hosting | [Fehlt] | Kein Hosting-/Asset-Konzept im Repo sichtbar. |
| DSGVO-konform | [Teilweise] | Datenschutz-Tab und Consent-Felder vorhanden; keine technische Consent-Gating-/Audit-Log-Schicht sichtbar. |
| EU-Hosting | [Fehlt] | Nicht aus Code belegbar. |
| Cookie-Banner | [Teilweise] | Cookie-Consent-Select vorhanden; kein Banner-Renderer sichtbar. |
| Partial Submission Capture | [Fehlt] | Keine Submission-Persistenz sichtbar. |

### Analytics

| Feature | Status | Befund im Code |
|---|---:|---|
| Conversion-Rate gesamt | [OK] | `conversionRate` am Funnel und KPI-Ausgabe vorhanden. |
| Drop-off pro Step | [Teilweise] | Step-Daten enthalten `dropOffReason`; Analyse zeigt Abbrueche, aber aus statischen Daten. |
| UTM-Quellen-Breakdown | [Fehlt] | Kein UTM-Modell/Auswertung sichtbar. |
| Time-on-Page pro Step | [Fehlt] | Nicht sichtbar. |
| A/B-Test-Ergebnisse mit Konfidenzintervallen | [Fehlt] | A/B-Einstellfelder vorhanden, aber keine Ergebnisrechnung. |
| Maus-Tracking / Heatmaps | [Fehlt] | Nicht sichtbar. |

### Zusammenfassung Schritt 2

#### Staerken

- Funnel-Bereich ist bereits sauber in der CRM-Rubrik `Funnels` integriert.
- Es gibt eine breite Tab-Struktur, die die wichtigsten Funnel-Bereiche abbildet.
- Neue Funnel koennen im CRM angelegt und Projekten zugeordnet werden.
- Viele benoetigte Konzepte sind als UI-Felder oder Prototypen bereits vorbereitet:
  - Design
  - Steps
  - CRM-Uebergabe
  - Tracking
  - Datenschutz
  - A/B-Tests
  - Messages
  - Workspace
- Formularfelder sind optisch bereits Richtung `w-full`, `min-w-0`, `max-w-full` verbessert.
- Tracking-Event-Monitor und Pixel-/GA-/GTM-Felder sind als Bedienoberflaeche vorhanden.

#### Hauptluecken

- Kein persistentes Funnel-Builder-Schema fuer Seiten, Sections, Rows, Columns, Elements und Fields.
- Kein echter Public-Funnel-Renderer, der dieselbe Datenstruktur wie der Editor nutzt.
- Keine Preview-URL, kein QR-Test und kein separater Testmodus.
- Keine echte Submission-Pipeline fuer Leads.
- Kein vollstaendiges Kontaktfeld-System mit den 17 geforderten Feldtypen.
- Keine Rich-Text-, Emoji-, Asset-, Upload- oder Medienbibliothek.
- Keine Rule Engine fuer Conditional Logic, AND/OR-Verzweigungen und dynamische Ergebnisse.
- Keine echte Tracking-Injection oder serverseitige Event-Pipeline.
- Keine Persistenz, Versionierung, Undo/Redo oder Kollaboration.

## Schritt 3 - Priorisierte Verbesserungsliste

Leitlinie:
- P0 baut das Fundament, damit der Funnel-Builder produktiv nutzbar wird.
- P1 bringt den Editor auf Wettbewerbsniveau gegen Perspective, Heyflow, FunnelCockpit und ClickFunnels.
- P2 verbessert Komfort, Skalierung und Differenzierung.

### P0 - Kritisch fuer produktive Nutzung

| Feature | Aktueller Zustand | Soll-Zustand | Aufwand | Refactor-Risiko | Konkreter Tech-Vorschlag |
|---|---|---|---:|---|---|
| Persistentes Funnel-Schema | `Funnel` + `FunnelStep` sind flach; viele Editor-Felder leben nur in React-State. | Zentrales Schema fuer Funnel, Page, Section, Row, Column, Element, Field, Variant, Theme, Submission und TrackingEvent. | XL | Hoch: betrifft Editor, Preview, Datenimport und spaetere Speicherung. | TypeScript Domain-Model in `src/lib/funnel-schema.ts`; Zod fuer Validierung; Migration der aktuellen `EditableFunnel`/`EditableStep`-Daten in `schemaVersion: 1`. |
| Gemeinsame Render-Engine | Editor-Preview und Funnel-Daten sind direkt in `FunnelCommandCenter` gekoppelt. | Ein Renderer, der im Editor, in der Preview und spaeter im Public-Funnel dieselbe Datenstruktur rendert. | XL | Hoch: UI muss aus grosser Komponente herausgeloest werden. | `FunnelRenderer`, `FunnelCanvas`, `renderElement()`; Komponenten pro Elementtyp; Props: `mode: "edit" | "preview" | "live" | "test"`. |
| Public Preview Route | Keine `/preview/{funnelId}` Route ohne CRM-Chrome. | Geschuetzte Preview-URL mit Token, ohne CRM-Navigation, exakt wie Lead-Ansicht. | L | Mittel: braucht Routing und Datenzugriff, kann parallel zum bestehenden CRM entstehen. | Next App Route `src/app/preview/[funnelId]/page.tsx`; Token-Check; FunnelRenderer im `preview` Mode. |
| Test-Submit-Modus | Button simuliert nur Monitor/Notice; kein echter Durchlauf. | Formular komplett ausfuellen, Events testen, aber keine produktiven Leads speichern. | L | Mittel: muss klar von Live-Submit getrennt sein. | `submissionMode: "test" | "live"`; API `POST /api/funnels/[id]/submissions`; Test-Submissions separat speichern oder nur im Monitor loggen. |
| Submission-Pipeline und CRM-Uebergabe | Keine echte technische Verbindung von Funnel-Submit zu Lead Inbox/Pipeline/Kalender. | Submit erzeugt validierten Lead, Kontakt, Aktivitaet, Pipeline-Status, Aufgabe und optional Termin-Trigger. | XL | Hoch: betrifft CRM-Datenmodell und spaetere Persistenz. | Server Action oder Route Handler; `Submission -> Lead -> Contact -> Task`; klare Mapping-Schicht `mapSubmissionToCrm()`. |
| 17 Kontaktformular-Feldtypen | Nur Step-Typen und `crmField`; kein Field-Schema. | Vollstaendiger Form-Builder mit allen 17 Feldtypen und je Feld Label, Placeholder, Default, Required, Validation, Error, Help. | XL | Hoch: Kern des Funnel-Erlebnisses. | `FunnelField` Union-Type; React Hook Form fuer Runtime; Zod fuer Validierung; `react-phone-number-input`; Date/Time native oder `react-day-picker`; searchable Combobox fuer Dropdown. |
| Mobile/Tablet/Desktop Preview | Nur `mobileFirstMode`; keine echten Breakpoints. | Device-Toggle mit Desktop, Tablet, Mobile und separaten Layout-/Spacing-Werten. | L | Mittel: braucht responsive Style-Modell. | `device: "desktop" | "tablet" | "mobile"`; style tokens pro Breakpoint; Preview-Frame mit festen Breiten 390/768/1280. |
| Designer als echter visueller Editor | Aktuell Blockliste + Formularfelder; keine frei editierbaren Elemente. | Kunde kann Texte, Bilder, Buttons, Formularfelder und Bloecke direkt anklicken, verschieben, duplizieren und anpassen. | XL | Hoch: groesster UI-Umbau. | `@dnd-kit/core` + `@dnd-kit/sortable`; Element-Inspector rechts; Canvas-Mitte; Block-/Element-Bibliothek links; Inline-Selection. |
| Tracking Runtime | Pixel-, CAPI-, GA4-, GTM-Felder sind UI-only. | Consent-gesteuerte Client- und Server-Events mit Event-ID-Deduplizierung. | L | Mittel bis hoch: Datenschutz und Live-Tracking duerfen nicht falsch feuern. | `TrackingProvider`; `trackFunnelEvent()`; GTM/GA/Meta Pixel Injection nur nach Consent; Server-Event API fuer Meta CAPI. |
| Datenschutz-Gating | Datenschutz-Tab ist UI, aber keine technische Steuerung. | Pixel, CAPI, Cookies und Webhooks laufen nur nach Consent und Zweckbindung. | L | Hoch: Compliance-Risiko bei falscher Umsetzung. | Consent-State pro Session; Cookie Banner im Renderer; Audit-Log fuer Consent; Events mit `consentGranted` pruefen. |

### P1 - Wichtig fuer Wettbewerbsfaehigkeit

| Feature | Aktueller Zustand | Soll-Zustand | Aufwand | Refactor-Risiko | Konkreter Tech-Vorschlag |
|---|---|---|---:|---|---|
| Rich-Text Inline Editor | Textfelder sind Plain Inputs/Textareas. | Inline-Texteditor mit Bold, Italic, Underline, Link, Farbe, Groesse, Ausrichtung und Listen. | L | Mittel: Textdaten muessen als Rich-Text gespeichert werden. | TipTap mit StarterKit, Link, TextStyle, Color; Speicherung als JSON, nicht HTML als Quelle. |
| Emoji-Picker | Nicht vorhanden. | Emoji in jedem Textfeld und Rich-Text einfuegbar. | S | Niedrig. | `emoji-mart` oder leichte Emoji-Popover-Komponente; Einfuegen an Cursorposition. |
| Medienbibliothek | Keine Uploads/Bibliothek. | Upload, Ordner, Bildauswahl, Favicon, Video- und Dokumentassets. | XL | Mittel bis hoch: braucht Storage und Berechtigungen. | Vercel Blob oder S3-kompatibler Storage; `Asset`-Modell; Upload-API; Image-Kompression clientseitig. |
| Bilder/Icons/Unsplash | Nicht vorhanden. | Bilder suchen/einfuegen, Icons einfuegen, Alt-Texte verwalten. | L | Mittel: externe APIs und Lizenzhinweise. | Asset Picker mit Tabs `Upload`, `Bibliothek`, `Unsplash`, `Icons`; API-Keys nur serverseitig. |
| Undo/Redo und Versionierung | Nicht vorhanden. | Mindestens 50 Undo-Schritte, Versionen und Wiederherstellung. | L | Mittel: State-Struktur muss sauber sein. | History-Reducer oder Zustand Store mit Patch-History; `immer` patches; Version Snapshots pro Save. |
| Auto-Save mit Draft-Status | Save ist aktuell Monitor/Notice. | Automatisches Speichern mit Status `gespeichert`, `ungespeichert`, `Fehler`. | M | Mittel: braucht Persistenz/API. | Debounced save alle 1-2 Sekunden; optimistic UI; `updatedAt`, `draftVersion`, Konfliktmeldung. |
| Rule Engine fuer Logik | `condition` und `target` sind Textfelder. | AND/OR-Regeln, Antwortbedingungen, Scoring, Sprungziele, Ergebnisseiten. | L | Mittel: Preview und Live-Submit muessen dieselbe Logik nutzen. | `json-logic-js`; Rule Builder UI; `evaluateFunnelRules()` shared zwischen Renderer und API. |
| A/B-Test Engine | Felder fuer Variante, Traffic Split, Gewinner-Regel. | Varianten anlegen, Preview nebeneinander, Traffic verteilen, Ergebnisse auswerten. | XL | Hoch: braucht Analytics und Routing. | `FunnelVariant` Modell; deterministic assignment per visitor id; Ergebnisberechnung mit Conversion und Konfidenzintervall. |
| QR-Code Mobile-Test | Nicht vorhanden. | QR-Code fuer Preview-URL auf realem Smartphone. | S | Niedrig. | `qrcode.react`; nutzt Preview-Token-URL. |
| Kalender-Embeds | Provider-Select vorhanden, kein Embed. | Calendly, Cal.com, HubSpot Meetings direkt im Funnel einbetten. | M | Mittel: externe Scripts, Consent und Responsive Embeds. | Provider-spezifische Embed-Komponenten; URL/Meeting-ID pro Element; Fallback-Link. |
| Webhook Out | `webhookUrl` Feld vorhanden, kein Submit-Out. | Webhook bei Submit/TestSubmit mit Retry und Log. | M | Mittel: Fehlerbehandlung wichtig. | Server Route mit signed payload; retry queue spaeter; Webhook-Testbutton. |
| E-Mail-Automation Editor | Textarea fuer Sequenz. | Visueller Sequence-Editor mit Triggern, Delays, Personalisierung und Status. | L | Mittel: beruehrt Newsletter/CRM. | Sequence Model; einfache Cards pro E-Mail; spaeter React Email fuer Templates. |
| Analytics Dashboard | KPI und statische Drop-off-Daten. | Drop-off je Step, Quelle, Geraet, Zeit, UTM und Varianten aus echten Events. | L | Mittel: braucht Event-Datenmodell. | `FunnelEvent` Schema; Aggregation in `funnel-analytics.ts`; Charts mit vorhandener UI oder leichter Chart-Komponente. |
| Info-/Fehlerpruefung | Nicht vorhanden. | Prueft fehlende Pflichtfelder, kaputte Links, fehlende Tracking-IDs, Consent-Konflikte. | M | Niedrig bis mittel. | `validateFunnel(funnel)` mit Issue-Level `error/warning/info`; eigener Tab `Info`. |

### P2 - Komfort, Skalierung und Polish

| Feature | Aktueller Zustand | Soll-Zustand | Aufwand | Refactor-Risiko | Konkreter Tech-Vorschlag |
|---|---|---|---:|---|---|
| CMD+K Quick-Menue | Nicht vorhanden. | Schnell Aktionen ausfuehren: Block hinzufuegen, Seite wechseln, Preview oeffnen, Publish. | M | Niedrig. | `cmdk` oder eigener Command-Palette-Dialog. |
| Tastatur-Shortcuts | Nicht vorhanden. | Duplicate, Delete, Undo, Redo, Save, Preview per Tastatur. | M | Mittel: muss Fokus in Inputs respektieren. | `hotkeys-js` oder eigene Keyboard-Hooks mit Fokus-Guard. |
| Universal Header/Footer | Header-Modus existiert nur als Feld. | Globale Header/Footer-Elemente, die in allen Funnels/Pages synchron bleiben. | L | Mittel. | `UniversalElement` Modell mit References; Renderer loest Referenzen auf. |
| Kollaboration | Nicht vorhanden. | Mehrere Nutzer sehen Cursor, Locking und Live-Aenderungen. | XL | Hoch. | Spaeter Yjs/Liveblocks; erst nach Persistenz und Versionierung sinnvoll. |
| Custom CSS/JS pro Container | Nicht vorhanden. | Fortgeschrittene Nutzer koennen CSS/JS pro Container oder Funnel eintragen. | M | Hoch: Sicherheits- und Preview-Risiko. | Monaco Editor; Sandbox/Allowlist; getrennt nach Header/Footer/Element CSS; nur fuer Admins. |
| White-Label Vertiefung | Option im Workspace-Select. | Kundenzugaenge, Branding entfernen, eigene Domains, Rollenrechte. | L | Mittel. | Rollenmodell; `workspaceAccess`; Brand-Kit; Domain-Konfiguration. |
| PWA und Performance-Budget | Nicht sichtbar. | Public-Funnels schnell, lazy loaded, Lighthouse-Ziel > 85. | M | Niedrig bis mittel. | Next Image, Dynamic Imports, Asset-Kompression, Bundle-Analyse, Lighthouse CI. |
| Heatmaps / Maus-Tracking | Nicht vorhanden. | Optionales Verhaltenstracking fuer Optimierung. | L | Mittel bis hoch wegen Datenschutz. | Nur consent-gesteuert; Sampling; zuerst Event-basierte Analytics bauen. |
| KI-Umschreiben | Nicht vorhanden. | Texte im Editor umschreiben, kuerzen, zielgruppenspezifisch verbessern. | M | Mittel: braucht API und Prompt-Schutz. | Server Action fuer Rewrite; Eingabe mit Funnel-Kontext; klare Review vor Uebernahme. |
| Rechtschreibpruefung | Nur Browser-Standard moeglich. | Editor zeigt Hinweise bei Fehlern. | M | Niedrig. | LanguageTool API oder clientseitige Browser-Spellcheck-Nutzung mit besserem UX. |

### Empfohlene Umsetzungsreihenfolge

1. Funnel-Schema v1 definieren und aktuelle Daten migrieren.
2. Gemeinsame Render-Engine fuer Editor, Preview und Live vorbereiten.
3. Public Preview Route mit Token und Device-Preview bauen.
4. Test-Submit-Modus und Submission-Pipeline einziehen.
5. Kontaktformular-Field-System mit den 17 Pflicht-Typen umsetzen.
6. Designer-Canvas mit Drag & Drop, Element-Inspector und Inline-Auswahl bauen.
7. Tracking Runtime mit Consent-Gating und Event-ID-Deduplizierung anschliessen.
8. Rich-Text, Emoji, Asset-Bibliothek und Medien-Elemente nachziehen.
9. Rule Engine, A/B-Testing und Analytics aus echten Events ausbauen.
10. Komfortfunktionen wie Undo/Redo, Auto-Save, Versionierung, Shortcuts und CMD+K ergaenzen.

### Technische Leitentscheidung

Der groesste Hebel ist nicht ein weiteres Formular im bestehenden `FunnelCommandCenter`, sondern ein eigenes Funnel-Domain-Modell plus gemeinsamer Renderer.

Begruendung:
- Der aktuelle Editor kann optisch verbessert werden, bleibt aber ohne Schema und Renderer ein CRM-Prototyp.
- Public Preview, Testmodus, Tracking, Submit, Analytics und A/B-Tests brauchen dieselbe Datenquelle.
- Ein isolierter Renderer verhindert, dass Editor-UI und Lead-Ansicht auseinanderlaufen.
- Erst danach lohnen sich Rich-Text, Medienbibliothek, Undo/Redo und Kollaboration sauber.

## Naechster Schritt

Schritt 4 waere die Abschlusszusammenfassung mit Entscheidungsvorschlag, welcher P0-Punkt zuerst umgesetzt werden soll.

Status:
- Schritt 1, Schritt 2 und Schritt 3 sind abgeschlossen.
- Es wurde keine Editor-Funktion umgesetzt.

