# CRM UX, Text und Sprache — Prüfinventar und Ergebnis

Stand: 21. Oktober 2026. Ausgangsrevision: `86a09f04ef01614c5236d20f36b8cf4fb4569853`, beim Start tatsächliche Production und `origin/main`. Branch: `codex/crm-ux-i18n-polish`. Später eingetroffene Änderungen aus `main` bis `4c0b460` (PR #94) wurden übernommen und erhalten. Dies ist die einmal angelegte und fortgeschriebene Prüfliste.

## Tatsächlicher Zugang und Prüfgrenzen

Der ausdrücklich verlangte App-Browser war erreichbar. Die kanonische Adresse `https://www.novalure-crm.app` zeigte eine regulär angemeldete Anwendung mit Novalure Growth, Novalure Eigenakquise und Profil Novalure Studio. Diese Administratoransicht ist kein Kundenrollen-Nachweis. Production wurde nur lesend, durch Navigation und erlaubte Sprachwahl geprüft. Keine echten Geschäftsdaten wurden bearbeitet, Nachrichten versandt, Rechte geändert oder Zugangsdaten aus dem Benutzerbrowser gelesen/exportiert.

Production-Sichtprüfung im App-Browser: alle zwölf sichtbaren Studio-Einträge DE auf 1440 × 900, abschließend auch die geladene Formularansicht. EN gezielt an Übersicht, Anfragen, Kontakten und Pipeline. Mobile Kontakte und Bauträger-Projektübersicht wurden bei 390 × 844 betrachtet. Studio, Deutsch und Übersicht wurden wiederhergestellt. Öffentliche Website-, Rechts- und Buchungsseiten sind keine vollständige neue Abnahme dieses Auftrags; betroffen waren die Sprachübergänge von Anmeldung und Passwortseiten.

Die veränderte Anwendung läuft zusätzlich als echter Next.js-Build mit regulärer Passwortanmeldung, erforderlicher MFA und erzwungener PostgreSQL-RLS in der vorhandenen wegwerfbaren Loopback-Prüfumgebung. Sie enthält ausschließlich synthetische Daten und keine `.env`-Datei. Ein regulärer synthetischer Leser wurde auch im App-Browser geprüft. Zusätzliche automatisierte Browserkontexte übernehmen keine Benutzersitzung und ergänzen die Sichtprüfung. Production-Bilder mit Geschäftsinhalten werden nicht geteilt; sämtliche veröffentlichten Bilder stammen aus synthetischer QA.

## Einmaliges Ansichteninventar

Die authentifizierte Root-Seite verwendet `CrmWorkspace` mit vorhandener Hashnavigation und Rollen-/Projektfiltern. Profile verändern die Navigation, nicht die serverseitigen Rechte. Die Tests folgen tatsächlich angebotenen Navigationseinträgen.

| Bereich | Vorhandene Ansichten / Umfang |
| --- | --- |
| Einstieg und Shell | Übersicht, konfigurierbares Dashboard, Suche, Arbeitsbereich, Projektfilter, Profile, mobile Navigation, Kontextdetails |
| Kunden und Geschäft | Kontakte, Unternehmen/Kundenverwaltung, Käuferprofile, Käufer-/Verkäufer-/Bauträger-Leads, Website-Anfragen |
| Vertrieb | Pipeline, Projektpipeline, eingebettete Angebote/Aufträge, Aufgaben, Tagesansicht, Kalender |
| Immobilien | Projekte, Projektübersicht, Projektanalyse, Immobilien/Mandate, Einheiten, Reservierungen |
| Kommunikation und Marketing | Kommunikation, Funnels, Formulare, Newsletter, Analyse-Assistent, Analytik, Datenpflege |
| Wissen und Assistenten | Bots, Wissen, Studio Wissen & KI; vorhandene Publikations-, Monitoring-, Datei- und Governance-Komponenten |
| Verwaltung | Einstellungen und Sprache, Arbeitsbereiche, Benutzer/Rollen, Audit, Releases, Governance/Compliance |
| Kundenportal | Gefilterte Root-Anwendung mit echten synthetischen Rollen `customer_owner` und `viewer`; keine eigenständige Portalroute |

Erster vollständiger lokaler Browserlauf: **300 tatsächlich besuchte Ansichtenkombinationen**, DE/EN jeweils 1440 × 900 und 390 × 844: je Kombination 43 Einträge intern einschließlich Studio-/Makler-/Bauträgerkontext, 17 Kunde und 15 Leser. Weitere 36 Zeilen sind ausdrücklich Profilaliase bereits besuchter Einträge; acht Profilangebote waren nicht verfügbar. Insgesamt enthält der Bericht 344 Zeilen, **nicht 344 unabhängige Seitenabnahmen**. Reguläre Kunden-/Leseranmeldungen und deren Ablehnung eines fremden Arbeitsbereichs wurden separat geprüft.

Nicht jede Ansicht besitzt Daten für jeden Fachzustand. Normal-, Leer- und deaktivierte Zustände hängen von tatsächlicher Verfügbarkeit ab; fehlende Integrationen wurden als solche betrachtet. Schreibende Fachabläufe werden durch bestehende isolierte Vertriebs-/Wissensregression und gezielte Komponenten-/DB-Tests belegt, nicht durch Testeingaben in Production. Eine vollständige neue Integrationabnahme sämtlicher Publikations-, Telefonie-, Kalenderanbieter- oder Versandabläufe wird nicht behauptet. Die Grundmatrix ist eine DOM-/Geometrieprüfung; tatsächlich betrachtete Bilder und deren Grenzen werden gesondert genannt.

## Konkrete Korrekturen

| Element | Ursache | Korrektur |
| --- | --- | --- |
| Arbeitskontext | Breadcrumb und fünf Abzeichen wiederholten denselben Kontext, besonders hoch auf Mobil | Breadcrumb bleibt sichtbar; weitere Angaben unter „Details zum Arbeitsbereich“ |
| Gemeinsame Aktionen | Beliebige Worttrennung und schmale mobile Gruppen | Normale Wortgrenzen, stabile Symbole, passende Mindestbreiten und gestapelte Aktionen; begrenzter Notumbruch nur bei schmalen Aktionsbuttons |
| Dashboard | Titel/Beschreibungen gekürzt, starre Bedienleiste | Vollständige Texte, umbrechende Bedienleiste, benannte Ansichtsauswahl |
| Einführungstexte | Roadmap-, Architektur- und Werbesprache im täglichen CRM | Kürzere DE/EN-Texte; Folgen, Einwilligungen und Freigaben erhalten |
| Rollen und Projekte | Interne Rollenbezeichner und Pipeline-UUID | Verständliche Rollen und vorhandener Pipeline-Name bzw. ehrlicher Zuordnungsstatus |
| Kontosprache | Widersprüchliche Browser-/URL-/Geo-/Speicherregeln | Eine serverseitige persönliche Präferenz `auto/de/en`, gemeinsamer Umschalter und Einstellungen-Karte |
| Vertrieb | Angebote/Immobilienworkflow und Prioritäten trotz EN deutsch | Systemtexte in bestehender i18n-Datei, lokalisierte Status und Darstellung; gespeicherte Inhalte unverändert |
| Pipeline | Doppelte fehlende Budgetangabe, breite technische Feldspalten | Korrekte offene Budgetgrenzen, mobile Feldkarten und lokalisierte Labels; technische Zuordnung nur in aufklappbaren Details |
| Dialoge und Rückmeldung | Deutscher Schließname in EN, rohe Fehler, unklare Bestätigung nach Refreshfehler | Benannte Steuerungen, Fokus/Escape, sichere verständliche Fehler; gespeichert und unbestätigt getrennt |
| Verwaltung/Immobilien | Rollen, Verwendungen, Historie, Lizenzhinweise und Optionen teilweise roh/einsprachig | DE/EN-Anzeige mit unveränderten Enum-Werten und erhaltenen Lizenz-/Freigabeanforderungen |
| Marketing/Wissen | Providerfehler, fremdsprachige Fehlermeldungen und technische Blocker | Lokalisierte Fehler und bekannte Blocker, unbekannter Fall bleibt explizit gesperrt; benannte Formatierung |
| Leserechte | Leerer Wissensbereich forderte Leser zum Erstellen auf | Tatsächlich passende Nur-Lese-Rückmeldung |
| Browserspeicher | Ungeschützte Zugriffe in Navigation, Dashboard und Cookieauswahl | Fehlertolerante Zugriffe; vorhandener Cookiepfad bleibt nutzbar; keine Übernahme alter Kontosprache |
| Reservierung | Fehlende verknüpfte Einheit zeigte UUID | „Einheit nicht verfügbar“ / „Unit unavailable“, gespeicherte Zuordnung unverändert |

Vorher-/Nachherbeispiele ohne Kundendaten:

| Vorher | Nachher |
| --- | --- |
| „Hot Leads, überfällige SLAs, Termine und Aufgaben in einer mobilen Queue.“ | Kurze Tagesprioritäten statt technischer Ablaufbeschreibung |
| EN-Pipeline mit „Hoch / Mittel / Normal“ | „High / Medium / Normal“ |
| „Warum besser als HubSpot“ im Formulareditor | „Vor der Veröffentlichung“ / „Before publishing“ mit konkreten Prüfhinweisen |
| `customer_owner` oder Pipeline-UUID | Lokalisierte Rolle bzw. Pipeline-Name |
| Browserlokale Wahl „Deutsch / English“ | Kontoweite Wahl „Automatisch (Standort) / Deutsch / English“ |

## Sprachregel und Schutzgrenzen

Kontrollierte, ausdrücklich **simulierte** Geo-Inputs prüfen AT, DE, CH, LU und LI → Deutsch; FR, IE, US, ES, PT und GB sowie fehlende/ungültige Codes → Englisch. LU und LI sind getrennte Fälle. Manuell EN in AT und manuell DE in IE haben Vorrang. Nur `x-vercel-ip-country` in tatsächlicher Vercel-Laufzeit wird akzeptiert; keine Browser-Sprachregel, GPS-Abfrage, Zusatzdienste oder gespeicherte IP-/Länderinformation. Lokal fehlte Geo tatsächlich und Automatisch ergab Englisch. Kein realer VPN-/Länderlauf wird behauptet.

Der Wert hängt an der bestehenden zentralen Authentifizierungsidentität. Migration 107 ergänzt nur diese kleine Tabelle; bisher gab es keine kontoweite UI-Präferenz. Erzwungene RLS beschränkt Zugriff auf die eigene Identität einer aktiven Mitgliedschaft. Speichern verlangt bestehende Sitzung, CSRF und erwartete aktuelle Benutzer-ID; Präferenz und begrenztes Auditereignis werden gemeinsam bestätigt. Keine automatische Migration. **107 wurde nur in wegwerfbarer lokaler QA angewendet, nicht auf Preview/Production.**

Reguläre synthetische Browserprüfungen belegen Wechsel, Reload, eigenen Arbeitsbereich-/Profilwechsel, Reset auf `auto`, Logout/Login, neue separat angemeldete Browserumgebung ohne kopierten Authzustand und Erhalt von Kontaktentwurf, Suche und Scope. Die neue Browserumgebung simuliert ein weiteres Gerät; kein physisches Zweitgerät wurde benutzt. Kontrollierter 503-Speicherfehler behielt die alte Wahl ohne Erfolgsmeldung. Kontoisolation, neue Sitzungen und RLS werden zusätzlich gegen echtes lokales PostgreSQL geprüft.

## Ausgeführte Verifikation und Zwischenstände

Abschlussstand nach Übernahme von PR #94: Unit **245/245**, neue UX-/Sprach-/Verwaltungs-/Marketing-/Pipelineprüfungen **27/27**, zusätzlich echter Forced-RLS-DB-Test **1/1**. Bereits ausgeführte relevante Regression am UX-Arbeitsstand: Design C/Kundenzugriff **28/28**, Vertrieb **101/101**, Wissen **190/190**, Wissen Paket 3 **54/54**. Diese früheren Ergebnisse werden nicht rückwirkend als Test sämtlicher späteren PR-94-Änderungen bezeichnet. ESLint, Typecheck und optimierter Build sind am abschließenden Produktstand bestanden. Die nachträglich übernommenen Knowledge-Änderungen wurden zusätzlich mit 31 tatsächlichen lokalen DB-Tests und vier UI-Fällen mit ausdrücklich simuliertem HTTP geprüft; alle bestanden. Produktionsabhängigkeitsaudit: **0 bekannte Schwachstellen**. Reguläre exakte Remote-CI bleibt ein eigenes Gate.

Gemeinsame Stylesheet-Stressprüfung: DE/EN bei 320, 390, 768, 1366 und 1440 px, zusätzlich 320 px mit 200 % Text; **12/12** nach Korrektur eines langen deutschen Aktionsworts (zuerst 11/12). Tatsächliche gemeinsame CSS-Regeln, lange synthetische Inhalte und Aktionsflächen; keine authentifizierte Fachabnahme. Tastatur, Escape und Fokusrückgabe wurden am lokalen Suchdialog geprüft. Virtuelle mobile Größen sind keine Hardware-/Bildschirmtastaturabnahme.

Der erste vollständige Browserbericht bleibt unverändert: `.npm-cache/qa/crm-ux-language/run-2026-10-21T19-31-45-062Z/result.json`. Insgesamt **FAIL**, trotz geometrisch unauffälliger 300 Besuche: ein mobiler Auswahlfehler im Testhelfer und ein echter Cookiefehler bei verweigertem Speicher. Beide Ursachen wurden korrigiert; gezielter Nachlauf separat. Sechs zunächst gemeldete unbenannte Funnel-Steuerungen lagen in geschlossenen `details` und waren nicht sichtbar; die falsche Sichtbarkeitsannahme des Tests wurde korrigiert. Keine erfundenen Produktlabels.

Der unabhängige interne Agent prüfte Produktrevision `d3ed5abe5753d0e6de53237784920e5326d41781` gegen `4c0b460`: offen **C0/H0/M0/L0**, 22 unabhängige gezielte Prüfungen bestanden. Dabei wurde ein echter Verdrahtungsfehler behoben: Einstellungen übersetzten zunächst nur den React-Key statt des sichtbaren Prüftexts. Ein Test rendert jetzt fünf tatsächliche Warnungen/Blocker in EN. Dies ist kein vertrauenswürdiges GitHub-App-Attest und keine gehostete Abnahme.

Rohlogs, private Fixturekontexte und alle synthetischen Bildserien bleiben lokal unter `.npm-cache/qa`. Quellenfingerprint und tatsächlich gebaute Bytes werden in den neuen Läufen getrennt erfasst. Die erste Bildserie umfasste Kernansichten; vollständige ergänzende Bilder und gezielte Nachläufe sind im nachstehenden Abschlussstand erfasst. Eine fehlende frühere Buildbindung wird nicht nachträglich erfunden.

## Abschließender lokaler Stand

Produktrevision: `d690b9c80221942c74e640b952ae2eb20ce5fc79`. Die bei der ersten Übergabe laufende lokale Preview war `http://127.0.0.1:56068`; sie war keine von anderen Rechnern erreichbare gehostete Preview. Der App-Browser erhielt eine regulär angemeldete eigene synthetische Leseransicht. Dokumentation und Prüfharness können im PR einen späteren Head haben; die Produktquellen bleiben gegenüber dieser gebauten Revision identisch. Die lokale Instanz wurde für die nachstehende erneute CI-Fehlerprüfung regulär beendet.

- Nach dem vollständigen Bildlauf wurden die tatsächlichen Bildfehler gezielt behoben: Immobilien-Detailbreite, Einladungsformular, Namensspalten, Newsletter-Kennzahlen, deutsche EN-Beschriftungen, Prozentwertumbruch und der fehlende Sprachparameter im eingebetteten Lead-Verkauf. Der Nachlauf auf `c73c662` erfasste **107 betroffene Ansichten**; ein darin noch sichtbares deutsches Immobilien-Abzeichen wurde anschließend korrigiert und mit **12 Immobilienansichten** auf `d89a9a1` bestätigt.
- Leser können Aufgaben, Termine und Pipeline weiterhin ansehen und filtern; nicht erlaubte Schreibaktionen sind nachvollziehbar deaktiviert. Kalenderverwaltung, Synchronisierung, Termine und Benachrichtigungen verwenden getrennt die bereits geltenden Serverberechtigungen. Die Pipeline verwendet die tatsächlichen Berechtigungen der gewählten Mitgliedschaft. Erlaubte verwaltete Arbeitsbereiche und die bestehende Growth-Ausnahme bleiben erhalten. Die Serverregeln wurden nicht verändert.
- Der Speicher-/Benutzerwechselnachlauf bestand **7/7**. Die echte abschließende Firmenprofil-Navigation erfasste alle neun Reiter DE/EN bei 1440/390: **32 Reiterzustände bestanden direkt**, vier Freigabereiter meldeten ausschließlich einen zu engen Testselektor. Der unveränderte Fehlbericht bleibt erhalten. Ein separater präziser Nachlauf bestand **5/5**, darunter genau diese vier Reiter; der tatsächliche Status-Selektor ist jeweils **44 px** hoch. Die deutschen Felder heißen jetzt „Sitz“ und „Datenschutzkontakt“, die Datenquelle „Standardwerte“ / „Default values“.
- Alle vier finalen Freigabeaufnahmen, alle 32 zusätzlichen Profilreiteraufnahmen, die relevanten Immobilien-/Pipeline-/Newsletter-/Bot-/Wissensaufnahmen und weitere allgemeine Seiten wurden von den Agenten tatsächlich angesehen. Kontaktblätter ergänzen diese Einzelbilder; deren kleine obere Ausschnitte sind keine vollständige Textabnahme jeder langen Seite. Die Reiter zeigen eigene synthetische Standardwerte, keine bestätigte Unternehmensprofil-Persistenz oder rechtliche Freigabe. Leere Einheiten/Reservierungen sowie nicht angebundene Formulare/Kommunikation bleiben ausdrücklich begrenzte Zustände.
- Der unabhängige interne Reviewer prüfte die Revisionen `c73c662`, `d89a9a1` und abschließend `d690b9c`; offen **C0/H0/M0/L0**. Zwei zwischenzeitlich gefundene zu grobe UI-Berechtigungsschranken wurden vor dem letzten Build korrigiert. Die eigenständigen Prüfungen bestanden: 36 beim größeren letzten Produktdelta, danach 10 bzw. 7 bei den kleinen Anzeigeänderungen. Dies erzeugt kein vertrauenswürdiges GitHub-App-Attest.
- Alle finalen gezielten Browserläufe: **0 beobachtete JavaScriptfehler, unerwartete 5xx, externe Requests oder Business-Schreibzugriffe**. Kein physisches Zweitgerät, kein realer Länder-/Providerlauf und keine Produktionsabnahme werden daraus abgeleitet.

Die maschinenlesbare [Verifikation](crm-ux-i18n-evidence.json) enthält die getrennten Quellen-/Build-Fingerprints und die unveränderten historischen Ergebnisse. Wenige echte synthetische Bildbeispiele: [Freigabe vorher](crm-ux-i18n-images/approval-before-de.png), [Freigabe nachher](crm-ux-i18n-images/approval-after-de.png), [Immobilien EN nachher](crm-ux-i18n-images/properties-after-en.png). Die Vorheraufnahme zeigt den überhohen Status-Selektor und „Fallback“, die Nachheraufnahme die normale Höhe und verständliche „Standardwerte“. Keine Production-Bilder oder Authentifizierungsdaten wurden dafür veröffentlicht.

## Preview und echte Abschlussgrenze

Eine neue gehostete UX-Preview ist **blockiert**: Die sichere bestehende Paket-4-Preview verwendet 65 branchspezifische Überschreibungen globaler Preview-Variablen. Der neue Branch würde sie nicht automatisch erben. Die verfügbaren Providerwerkzeuge bieten keinen verifizierten geheimnisfreien Klonpfad für diese Konfiguration. Ein isoliertes Neon-Ziel existiert, dessen Bindung an diesen neuen App-Branch aber nicht nachgewiesen ist. Paket 4 und Production werden nicht geändert.

Automatisches Vercel-Deployment dieses Branches ist daher in `vercel.json` deaktiviert. Erforderlich sind eine verifizierte eigene Nichtproduktionsbindung einschließlich Migration 107 und danach reguläre Anmeldung/Abnahme auf genau dieser Preview. Ein alter Paket-4-Link wird nicht als UX-Preview ausgegeben. Bei der ersten Übergabe fehlte die Vercel CLI; ihre spätere Installation ist unten erfasst. Die Installation allein bestätigt keine sichere Bindung.

Die erste Übergabe umfasste Draft-PR und tatsächlich laufende lokale Preview. Exakte GitHub-Checks und unabhängiger SHA-Review bleiben getrennte Gates. Kein Merge oder Production-Deployment; frühere Paket-4-Freigabe wird nicht erweitert. Wegen der gehosteten Preview-Grenze war dies kein uneingeschränkt vollständig abgeschlossener Auftrag.

## Folgeauftrag: Livegang und CI-Fehlerprüfung

Die anschließende ausdrückliche Nutzeranweisung, diese Korrekturen live zu setzen, erteilt die bisher fehlende aktuelle Production-Autorität. Technische Gates und Geheimnisgrenzen bleiben verbindlich. Der native Anbieterread zeigte zu diesem Zeitpunkt Production auf `4c0b460fd487cf5a6de94e2ee6e9e47d6639bf7e`, Deployment `dpl_9z1phwE3AE1SeQDSXrjVHcS3cYbd`.

Der automatische Quality-Lauf von PR #95 auf `79fb3ed` scheiterte im Vertriebs-Browsertest: Der Test erwartete die rohen Enum-Werte `SCHEDULED` und `STOPPED`, während die deutsche Oberfläche zutreffend „Geplant“ und „Gestoppt“ zeigt. Der Test prüft jetzt die sichtbaren deutschen Rückmeldungen **und** die unveränderten persistenten Enum-Werte durch einen eigenen authentifizierten, arbeitsbereichsgebundenen GET. Die Kundenannahme muss weiterhin atomar das Nachfassen stoppen. Keine Produktregel oder Schutzprüfung wurde abgeschwächt.

Der anschließend frisch gestartete isolierte Vertriebs-E2E-Lauf bestand **20/20**: reguläre Passwort-/TOTP-Anmeldung, negative Authfälle, Logout/Wiederanmeldung, Angebotsfreigabe, manueller Beleg ohne tatsächlichen Versand, Nachfassen, Kundenannahme, Immobilienprozess und Rollen-/CSRF-Grenzen. Ein vorausgehender direkter Testversuch gegen die ältere optimierte Loopback-Instanz meldete nach der MFA-Anmeldung HTTP 401 im API-Testclient (4/5 bis zum Abbruch); dies wird nicht nachträglich als PASS bezeichnet. Der erfolgreiche neue Lauf besitzt eine frische eigene Instanz und einen getrennten Bericht. Syntax, gezieltes Lint und Whitespaceprüfung bestanden.

Die Vercel CLI wurde auf Version 65.0.0 installiert und die bereits vorhandene Anmeldung sowie das bestehende Projekt `novalure/novalure-crm` nativ bestätigt. Das allein ist kein Nachweis einer sicheren QA-Bindung oder einer Migration. Weiter offen sind die erfolgreiche exakte Folge-CI, der geschützte Vercel-/manuelle QA-Nachweis, das vertrauenswürdige unabhängige App-Attest und die betroffenen Production-Gates einschließlich Migration 107. Die aktuelle Liveanweisung hebt keine dieser fehlenden Prüfungen auf.

Der anschließende CI-Lauf auf `dd2b9c8` erreichte die kombinierte Browserabnahme und fand weitere veraltete Wissensselektoren. Genau diese Testbeschriftungen wurden an „Die Wissensverwaltung ist nicht freigeschaltet.“ und „Assistenten“ angepasst. Die zwei verbliebenen deutschsprachigen Anmeldehelfer wählen Deutsch nun bewusst mit `languagePreference=de`, statt nur die alte Darstellungsquery zu setzen. MFA, Freigabe, veröffentlichte Version, Mandantentrennung und Schreibablehnung bleiben unverändert verpflichtend. Der lokale Integrationshelfer protokolliert Fehler nur noch als Nachricht, damit ein Playwright-Fehlerobjekt keinen MFA-DOM-Snapshot ausgibt.

Die tatsächlichen gezielten Nachläufe auf derselben unveränderten optimierten Produktquelle bestanden **Design C 50/50**, **Wissen 13/13** und **kombinierte Browserabläufe 13/13**. Sie beinhalten echte lokale Anmeldung/MFA, synthetische PDF-/DOCX-Dateien, explizite Veröffentlichung, getrennten Webchat-/Voice-Widerruf, unveröffentlichte Entwürfe, fremde Mandanten und Leserablehnungen. Der Website-Scanner verwendet dabei ausdrücklich synthetische DNS-/HTTP-Serviceports. Kein echter Provider- oder Produktionsbetrieb wird daraus abgeleitet; keine vollständige neue Migrations-/Restoreübung wurde manuell gestartet. Der gleichlautende Selektor im bestehenden Hosted-Helfer wurde ebenfalls korrigiert, aber dieser Hosted-Helfer wurde nicht ausgeführt. Die vorherigen Fehler bleiben getrennte Ergebnisse: zuerst fehlender bzw. auf Windows nicht startbarer lokaler Testbrowser, danach ein MFA-Selektor mit noch englischer Gastanmeldung; nach Wahl des vorhandenen Chrome und explizitem Deutsch bestanden die genannten Läufe.

Franz hat separat ausschließlich den UX-Branch für die bestehende geschützte GitHub-Umgebung `novalure-qa-candidate` autorisiert. Genau eine Branchpolicy wurde ergänzt; nativer Vorher-/Nachhervergleich bestätigt unveränderte Reviewer, Schutzregeln und alle bisherigen Branchpolicies. Keine Secret-/Variablenwerte wurden geändert. Der erste geschützte Lauf auf `dd2b9c8` wurde nach dessen bekanntem CI-Fehler gestoppt; das ist kein QA-PASS. Der Folgelauf muss die finale Revision tatsächlich prüfen und die bestehende Owner-Umgebungsfreigabe erhalten.

Eine unabhängige native Neon-Prüfung bestätigte die vorhandene Production-Branch `misty-cloud-70835427` / `br-snowy-fog-aldx77v8`, PostgreSQL 17.11 und tatsächliche Verbindung als `novalure_app`: keine erhöhten Rollenrechte, Tenant-Mitgliedschaft vorhanden, keine eigenen/geerbten RLS-Tabellen. Genau eine Katalog-SELECT-Abfrage bestätigte, dass Tabelle und Ledgerzeile 107 noch fehlen. Keine Geschäftsdaten-/Authabfrage oder Änderung. Dies beweist die abgefragte Rolle und Branch, noch nicht die konsumierte Vercel-Kandidatenbindung oder alle acht Production-Gates.
