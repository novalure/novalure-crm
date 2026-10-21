# CRM UX, Text und Sprache — Prüfinventar

Stand: 21. Oktober 2026. Ausgangsrevision: `86a09f04ef01614c5236d20f36b8cf4fb4569853`. Dieses Dokument ist die gemeinsame, fortgeschriebene Prüfliste. Ein Quellbefund ist keine Browserabnahme; bestehende historische Prüfergebnisse werden nicht als neue Läufe ausgegeben.

## Zugang und Prüfgrenzen

- Der tatsächliche App-Browser ist erreichbar. Die kanonische Adresse ist `https://www.novalure-crm.app`; die regulär angemeldete Anwendung wurde vom Hauptagenten gesehen.
- Beobachteter Kontext: Novalure Growth, Novalure Eigenakquise und Novalure Studio. Der beobachtete administrative Zugriff belegt keine Kundenrolle.
- Production-Sichtprüfung durch den Hauptagenten: Deutsch, Desktop 1440 × 900, alle zwölf sichtbaren Studio-Navigationseinträge; außerdem die standardmäßige mobile Navigation. Anfragen, Wissen, Kontakte, Pipeline, Aufgaben und Kalender wurden ausdrücklich geöffnet. Die Formularansicht benötigt nach beobachtetem Laden noch einen abschließenden Besuch. Englisch wurde zunächst an der Pipeline geprüft; dort blieben die Prioritätsoptionen deutsch. Weitere Sprachen, Größen und Zustände stehen unten noch offen.
- Production dient Navigation, Lesen und erlaubter Sprachwahl. Schreib-, Validierungs-, Lösch- und Fehlerprüfungen erfolgen ausschließlich mit synthetischen Daten in einer isolierten Umgebung. Zugangsdaten und personenbezogene Screenshots werden nicht in diesen Bericht übernommen.

## Einmaliges Ansichteninventar

Die authentifizierte Root-Seite verwendet `CrmWorkspace` mit Hashnavigation und vorhandenen Rollen-/Projektfiltern. Die nachstehende Zuordnung beschreibt tatsächlich vorhandenen Quellcode; sie behauptet keine Erreichbarkeit für jede Rolle.

Der erste ergänzende isolierte App-Lauf vom 21.10.2026, 19:31:45 UTC, hat inzwischen **300 tatsächliche Ansichtenkombinationen** besucht: je Sprache DE/EN und Breite 1440/390 insgesamt 43 verschiedene Navigationseinträge für den internen Operator, 17 für `customer_owner` und 15 für den lesenden `viewer`. Diese Konten wurden mit normalen Passwörtern und der jeweils tatsächlich geforderten MFA angemeldet; fremde Workspaces blieben für Kunden und Viewer gesperrt. Weitere 36 Zeilen verweisen ausdrücklich auf denselben bereits besuchten Abschnitt unter einem anderen Darstellungsprofil; acht Profileinträge waren nicht verfügbar. Ein Darstellungsprofil ist weiterhin kein Rollenwechsel. Der Lauf verwendete den damaligen lokalen Build und erfasste noch nicht für jeden Abschnitt einen Screenshot; die vollständige Bilddokumentation folgt separat. Die Tabelle bleibt das gemeinsame Inventar, die detaillierte Rollen-/Sprachen-/Breitenzuordnung steht im lokalen Laufbericht.

| Ansichten / Komponenten | Aktueller Prüfumfang | Noch erforderlich |
| --- | --- | --- |
| Shell, Suche, Arbeitsbereich-/Projekt-/Profilwechsel, mobile Navigation | Production DE Desktop und mobile Navigation gesehen; Quellen geprüft | EN, Tastatur, schmale Ansichten, lange Namen, Kundenrolle |
| Übersicht / Command Center und konfigurierbares Dashboard | Production DE: wiederholter Kontext und technische Erklärungstexte beobachtet; Quellen geprüft | DE/EN Desktop/Mobil, Lade-/Leer-/Fehlerzustände, Widgets |
| Anfragen / Website-Anfragen, Kontakte, Unternehmen / Kundenverwaltung, Managed Service, Onboarding, Customer Success | Routen-/Komponentenbestand erfasst | Erreichbare Ansichten DE/EN, Details, synthetische Formulare und Kundenrollen |
| Pipeline, Angebote / Aufträge, Aufgaben, Tagesansicht, Kalender | Vorhandene Controller erfasst | DE/EN, Tabellen/Details, Dialoge, leere und fehlerhafte Quellen |
| Kommunikation, Datenpflege, Sequenzen, Analyse / Auswertungen | Vorhandene, teils verfügbarkeitsabhängige Ansichten erfasst | Tatsächliche Verfügbarkeit und verständliche Meldungen |
| Projekte, Immobilien / Mandate, Einheiten, Reservierungen | Vorhandene Immobilienkomponenten erfasst | Makler-/Bauträgeransicht, DE/EN, breite Tabellen und Dialoge |
| Assistenten, Wissen, Dateien, Funnels, Formulare, Newsletter | Vorhandene Controller und Design-C-Anschluss erfasst | DE/EN, lange Inhalte, Entwurf/Prüfung/Freigabe/Veröffentlichung getrennt, sichere Fehlerzustände |
| Kundenportal | Bestehende Kundenrolle nutzt gefilterte Root-Anwendung; keine separate Portalroute | Normale synthetische Kundenrolle, erlaubte Navigation und serverseitige Grenzen |
| Profil und Einstellungen einschließlich Sprache | Quellen geprüft; Sprachpersistenz wird gesondert korrigiert | Konto-/Geräte-/Loginfälle, Speicherfehler, ungespeicherte Eingaben |
| Öffentliche Anmeldung, Passwortzurücksetzung, Rechtstexte, Buchungs-/Formularseiten | Routenbestand erfasst | Betroffene Sprachübergänge gezielt; keine neue umfassende öffentliche Websiteabnahme |

Gemeinsame Basis: `src/components/ui/*`, Design-C-Primitiven, `crm-theme.css`, `evelyn-design-c.css`, `evelyn-domain-panels.css`; Übersetzungen und Formatierung in `src/lib/i18n.ts`. Maßgeblich bleiben die vorhandenen Daten-, Authentifizierungs-, CSRF-, RLS- und Rollenverträge.

## Befunde und Bearbeitung

| ID | Befund / Quelle | Änderung / Status | Nachweis |
| --- | --- | --- | --- |
| UX-01 | Wiederholte Kontextabzeichen und Breadcrumb-Angaben überladen den sichtbaren Einstieg | Gezielte Bereinigung im Shell-/Command-Center-Bereich in Arbeit | Production DE gesehen; erneute Browserprüfung offen |
| UX-02 | Interne Profilnamen und Serverrechte-Erklärungen im normalen Einstieg | Verständliche Bezeichnungen, notwendige Freigabe-/Versandhinweise bleiben erhalten | Production DE und Quellcode; Prüfung offen |
| UX-03 | Lange Tagesansicht-Beschreibung mit „Hot Leads“, „SLAs“ und „mobiler Queue“; erklärende CRM-Modell-/Roadmaptexte | Kürzere DE/EN-Texte für Tagesansicht, Anfragen, Kontakte, Pipeline, Aufgaben, Kalender und Newsletter umgesetzt. Sicherheits-/Versandfolgen erhalten | Quellcode; neue Browserprüfung offen |
| UX-04 | Dashboard-Widgettitel/-beschreibung werden auf zwei Zeilen gekürzt; Bedienleiste beansprucht bei schmalen Karten viel Platz | Vollständige Texte, umbrechende Bedienleiste und benannte Ansichtsauswahl umgesetzt | Quellcode; synthetische Geometrieprüfung offen |
| UX-05 | Gemeinsame Domänenaktionen erlauben beliebige Worttrennung; lange Labels können einzelne Buchstaben umbrechen | Normale Wortumbrüche, ausreichend breite mobile Aktionsgruppen und begrenzte gemeinsame Buttons umgesetzt | Quellcode; DE/EN-Stressprüfung offen |
| LANG-01 | Unterschiedliche Geo-/Browser-/Speicher-Fallbacks, keine maßgebliche persönliche Kontoeinstellung | Gemeinsame Konto-/Automatiklogik in Arbeit | Kontrollierte Länder-, Konto- und Browserprüfungen offen |
| UX-06 | Pipeline schien während eines Zwischenzustands horizontal überzulaufen | Ursache unbestätigt; kein pauschales Abschneiden eingeführt. Geladener Desktopstand hatte Dokumentbreite 1425 bei 1440 Viewport | Production durch Hauptagenten; mobile Prüfung offen |
| LANG-02 | Pipeline-Prioritätsoptionen in englischer Ansicht bleiben deutsch | Gezielte Korrektur durch Domänenagent in Arbeit | Production EN Desktop gesehen |
| UX-07 | Gesperrter Browserspeicher kann das konfigurierbare Dashboard beim Lesen der letzten Ansicht abbrechen | Fehlertolerantes Lesen/Schreiben mit nutzbarer aktueller Ansicht umgesetzt | Quellcode; Browserfall mit gesperrtem Speicher offen |
| UX-08 | Sehr langes deutsches Aktionswort bei 320 px und 200 % Text passt auch nach Stapeln nicht in einen vollständigen Button | Sprachabhängige Silbentrennung; als begrenzter Fallback nur bis 390 px Notumbruch in Aktionsbuttons, keine globale Textregel | Isolierte Stylesheet-Prüfung zunächst 11/12, nach Korrektur 12/12 |
| UX-09 | Cookie-Auswahl greift beim Login ungeschützt auf gesperrten Browserspeicher zu | Lesen und Schreiben abgesichert; vorhandenes Cookie und bestehendes Auswahlereignis bleiben maßgeblich | Im lokalen Browser als Fehler beobachtet; zwei gezielte Verhaltenstests bestanden, neuer Build-/Browsernachlauf offen |
| QA-01 | Frühe Prüfheuristik meldete sechs unbenannte Funnel-Buttons | Prüfheuristik korrigiert: tatsächliche beschriftete Buttons lagen in geschlossenem `details`; `checkVisibility` ist false. Keine Produktänderung hierfür | Separater echter DOM-Nachlauf 2/2 bestanden; ursprünglicher Bericht bleibt erhalten |

## Laufende Verifikation

Zielmatrix: jeder erreichbare Seitentyp DE/EN auf 1440 × 900 und 390 × 844. Gemeinsame Komponenten zusätzlich gezielt bei 1366 × 768, 768 × 1024 und 320 CSS-Pixeln, 200 % Text, vergrößerten Textabständen und Tastaturbedienung. Lange synthetische Firmen-/Kontakt-/Projekt-/Dateinamen, E-Mail, große Zahlen und mehrzeilige Meldungen gehören in die isolierten Prüfungen.

Neue lokale Prüfungen am Arbeitsstand: relevante ESLint-Regeln für Dashboard und zentrale Übersetzungen bestanden; Designgrundlagen, Klickziele und bestehende Copyregressionen **22/22 bestanden**. Der erste i18n-Lauf bestand **9/10**; ein alter Quelltexttest erwartet die gerade ersetzte lokale Sprachpersistenz und wird mit den Verhaltensprüfungen der Kontoeinstellung aktualisiert. Diese Quell-/Komponentenprüfungen sind keine Browserabnahme und kein Produktionsnachweis. Ergebnisse, Grenzen und verbleibende Probleme werden nach tatsächlicher Ausführung hier ergänzt.

Zusätzlicher isolierter Browsercheck der tatsächlichen gemeinsamen Stylesheets mit synthetischem HTML: **12/12 bestanden**, DE/EN bei 320, 390, 768, 1366 und 1440 px sowie 320 px mit 200 % Text. Geprüft wurden vollständige Aktionslabels, mindestens 44 px Buttonhöhe, lange Auswahlwerte und kontrollierter Dateinamenumbruch; DE-320-Screenshot tatsächlich angesehen. Der erste Lauf bestand 11/12 und zeigte ein überlanges deutsches Aktionswort bei 200 %. Nach dem begrenzten schmalen Notumbruch bestand auch dieser Fall. Diese Hilfsprüfung verwendet keine authentifizierte CRM-Seite, beweist keine Formularfunktion oder Kundenrolle und ersetzt die App-Matrix nicht. Lokale synthetische Artefakte: `.npm-cache/qa/ui-reflow-result.json`, `ui-reflow-de-320.png`, `ui-reflow-en-320.png`.

Ergänzender authentifizierter App-Lauf `run-2026-10-21T19-31-45-062Z`: **14/15 gezielte Prüfungen bestanden**, 300 besuchte Ansichtenkombinationen ohne beobachteten Dokumentüberlauf oder tatsächlich sichtbare unbenannte Symbolbuttons. Manuelle Kontosprache über Reload, normale Wiederanmeldung, autorisierten Workspace-/Profilwechsel und einen separat normal angemeldeten Browserkontext blieb erhalten. „Automatisch“ wurde als eigener Modus gespeichert und ergab ohne lokale Geo-Information Englisch. Ein tatsächlich abgefangener Speicherausfall behielt die alte Auswahl ohne Erfolgsmeldung. Ein Kontaktentwurf, Suchtext und URL-Scope blieben beim Sprachwechsel erhalten. Der Suchdialog wurde per Tastatur geöffnet/geschlossen; Browser-Chrome im nativen Tabzyklus wurde von Hintergrundfokus unterschieden. Ein verzögerter tatsächlicher Knowledge-GET zeigte zunächst Laden und anschließend den kontrollierten Fehlerzustand.

Dieser Lauf ist **insgesamt kein PASS**: Der Benutzerwechseltest traf am Ende der mobilen Matrix auf einen ungeeigneten Testselektor; zusätzlich trat der echte Cookie-Storagefehler UX-09 auf. Beide wurden gezielt korrigiert und benötigen den nachfolgenden Lauf. Der Bericht bleibt unverändert erhalten: `.npm-cache/qa/crm-ux-language/run-2026-10-21T19-31-45-062Z/result.json`. Es gab keine beobachteten unerwarteten 5xx, externen Browserrequests oder versuchten Business-API-Schreibzugriffe. Der zweite Browserkontext ist ausdrücklich ein simuliertes weiteres Gerät und kein physisches Zweitgerät. Quellen-/Build-Fingerprints werden ab dem folgenden Lauf getrennt festgehalten; eine fehlende frühere Bindung wird nicht nachträglich erfunden.
