# Evelyn Knowledge Center — Arbeitspaket 2.1

Stand: 19.10.2026. Entwicklungsabnahme mit synthetischen Daten. Keine produktive Aktivierung.

## A. Implementierung

Ausgangspunkt ist der tatsächlich verifizierte Paket-2-Branch `codex/knowledge-center-package2-20261019` mit Revision `a04273f37fb3417b180626bd878920ab89f73609`. Dessen Vorgänger `da0a043e50603603fbc59394884d00af270d474e` ist enthalten. Der zuvor genannte Prüfbeleg `qa/knowledge-center-2026-10-19/verification.json` war in dieser Revision nicht vorhanden; die vorliegenden Ergebnisse wurden neu erhoben.

Erweitert wurden die vorhandenen CRM-Quellen, Bereiche, Versionen, Freigaben, privaten Medien und Assistentenzuordnungen. Es gibt keine zweite Wissensdatenbank, Chunk-Engine, Benutzerverwaltung oder Voice-Wissensablage. Evelyn-Masterplan und Masterprompt wurden geprüft; `check:masterplan` im unveränderten Evelyn-Repository bestand.

## B. Dokumentenverarbeitung

- PDF: tatsächliche Textebene mit Seitengrenzen. Fehlende oder nur teilweise vorhandene Textebenen erhalten `needs_ocr`; vorhandener Teiltext bleibt prüfbar und wird nicht freigegeben.
- DOCX: tatsächliche Absätze und Tabellen in Dokumentreihenfolge. Externe Beziehungen, aktive eingebettete Inhalte, XML-Entitäten, unerlaubte Pfade und übermäßige ZIP-Expansion werden abgewiesen.
- TXT, Markdown, CSV und JSON: striktes UTF-8; JSON zusätzlich mit Syntaxprüfung.
- PNG, JPEG und WebP: Formatprüfung und tatsächliches Dekodieren. Keine OCR und keine externe Bildanalyse; der sichtbare Hinweis verlangt eine lesbare Textfassung.

Parser laufen für PDF, DOCX und Bilder in isolierten Node-Workern: 12 Sekunden, 128 MiB JavaScript-Heap und höchstens zwei Parser je Prozess. Grenzen: 10 MiB Eingabe, 100 PDF-Seiten, 150.000 Textzeichen, 512 ZIP-Einträge und 32 MiB entpackte Daten; weitere PDF-Stream-/XML-/Bildgrenzen gelten. Worker-Heapgrenzen sind keine vollständige Betriebssystem-Sandbox; es werden keine Dokumentaktionen ausgeführt oder externen Referenzen geladen. Keine kostenpflichtigen Dienste oder Modellaufrufe sind erforderlich.

Der Upload erzeugt automatisch eine private Quelle beziehungsweise eine neue Dateiversion mit unveränderlichem Hash, Verarbeitungsstatus, Fehlermeldung und Importkennung. Wiederholte identische Anfragen erzeugen keine Doppelversion. Die Extraktion läuft außerhalb einer Datenbanktransaktion; vor dem Speichern werden Rechte, Kontingent, Bereich und Revision erneut geprüft. Erfolgreiche Extraktion bedeutet weiterhin Entwurf. Erst die vorhandene ausdrückliche Freigabe erstellt die freigegebenen Suchabschnitte. Eine ältere Freigabe bleibt bei einem neuen Entwurf aktiv.

## C. Webchat

Bestehendes CRM-Bot-Retrieval und neue Serviceadapter verwenden dieselbe berechtigte Engine. Der External Integration Gateway besitzt einen lesenden Knowledge-Endpunkt, der die gespeicherte Integration, erlaubte Herkunft, aktive Sitzung, Sitzungstoken, Projektbindung und den ausdrücklich zugeordneten Bot prüft. Mandant, Projekt, Assistent und Kanal werden serverseitig bestimmt.

Der separate Studio-Verkaufswebchat wurde nicht produktiv umgestellt. Dessen Client muss den dokumentierten Vertrag mit einer freigegebenen gespeicherten Integration verwenden. Aktuelle Preise und Immobilienverfügbarkeiten bleiben dem autorisierten Live-CRM vorbehalten; statische Dokumente ersetzen diesen Resolver nicht.

## D. Telefonie

Der anbieterneutrale Port führt echte Wissensabfragen aus. Webchat und `voice` besitzen unabhängige Zuordnungen; `telephony` bezeichnet ausschließlich den gespeicherten Kanal `voice`. Ein historischer `telephone`-Grant gewährt keinen Zugriff auf `voice`.

Maschinelle Endpunkte verwenden die vorhandene verifizierte Evelyn-OIDC-Identität und einen gespeicherten CRM-Serviceprincipal mit ausdrücklicher Assistenten-/Kanalbindung. Sie übernehmen die bestehende eng begrenzte Identitätskonfiguration; damit werden keine beliebigen Kundenidentitäten oder Vapi-Zugangsdaten provisioniert. Spätere produktive Kundentelefonie benötigt eine freigegebene technische Identität und native Gateway-/Providerbindung. Der gemeinsame serverseitige Port bleibt mandantenfähig.

Ergebnisse: höchstens fünf Auszüge, für Voice drei, je 600 Zeichen und insgesamt 1.800 Zeichen. SQL-/Lock-Limit: 1.500 ms; nach zwei Sekunden abgeschlossene Retrieval-Ergebnisse werden verworfen. Das ist keine garantierte gesamte HTTP-Antwortzeit einschließlich Verbindung, Authentifizierung und Netz. Fehlendes Wissen liefert eine sichere Übergabeantwort. Details: [Servicevertrag](knowledge-assistant-service.md).

Keine Telefonnummer, kein Vapi-Aufruf, keine Telefonieaktivierung und keine Zahlung wurden ausgeführt.

## E. Kundenportal

„Mein Unternehmenswissen“ verwendet die bestehende Designsprache mit Datei-, Website- und Texteingabe, verständlichem Verarbeitungsstatus, vollständiger Inhaltsprüfung, Dateiersatz, Historie, Freigabe des konkret geprüften Stands und getrennten Webchat-/Telefoniezuordnungen. Die Freigabe erfordert eine neue Prüfbestätigung je Version. Deutsch, Englisch und Spanisch sind enthalten. Serverseitige Rechte bleiben maßgeblich.

## F. Datenbank

Migration 101 bleibt unverändert. Vorbereitet sind:

- `102_knowledge_document_processing.sql`: unveränderliche Extraktionsnachweise, Import-Idempotenz, Freigabesperren und Volltextindex.
- `103_knowledge_assistant_service.sql`: technische Assistenten-/Kanalbindungen mit FORCE RLS und enger lesender Funktion; keine Runtime-Provisionierung und keine initialen Bindungen.

Die tatsächliche Vorgängerkette `091–096 → 100 → 101 → 102 → 103` wurde lokal mit exakten Migrationschecksummen geprüft. Der bestehende portable Harness ersetzt die optionale Vector-Spalte/-Indexierung und lässt die historische manuelle Migration 062 aus; dies ist kein Neon-Produktionsklon. Keine produktive Migration oder Änderung von Kundendaten wurde ausgeführt.

## G. Sicherheit

Geprüft werden Mandanten-/Projektgrenzen, gespeicherte Bot-/Kanalzuordnungen, Rollenwiderruf, Entitlements, Mengenlimits, unveröffentlichte Versionen, archivierte Quellen, private Dateizugriffe, direkte SQL-Freigabeversuche, OIDC-/Principalbindung und Gateway-Sitzungen. Quellinhalte bleiben nicht vertrauenswürdige Daten und erhalten keine Systemprompt-Rechte. Unabhängiger Review und genaue Revision stehen im Prüfbeleg.

## H. Tests

Die finalen ausgeführten Kommandos, Ergebnisse und Grenzen werden in `qa/knowledge-center-completion-2026-10-19/verification.json` festgehalten. Nur tatsächlich bestandene Prüfungen werden dort als bestanden ausgewiesen.

## I. Branch und Deployment

- Branch: `codex/knowledge-center-completion-20261019`.
- Implementierungsrevision: siehe Prüfbeleg.
- Gehostete Preview-URL: nicht erstellt.
- Deployment-ID: nicht vorhanden.

Für eine gehostete geschützte Preview fehlen isolierte entfernte Datenbank-/Speicher-/Identitätsbindungen. Produktionsverbindungen werden dafür nicht verwendet. Automatische Vercel-Deployments sind für diesen Entwicklungsbranch ausdrücklich deaktiviert. Die lokale Browserabnahme verwendet regulären Passwort-/TOTP-Login und eine ausschließlich synthetische Loopback-Datenbank.

## J. Nächste Schritte bis zum Go-live

1. Migrationen und private Speicherung auf einer isolierten geschützten Preview mit echten Runtime-Rollen abnehmen. Auf Vercel muss die Infrastrukturgrenze für HTTP-Uploads gesondert berücksichtigt werden; die Anwendungsgrenze von 10 MiB hebt keine Plattformgrenze auf.
2. Den externen Studio-Client an seine freigegebene Gateway-Konfiguration und den gespeicherten Wissensassistenten anbinden.
3. Für Vapi eine ausdrücklich freigegebene technische Identität und native Provider-/Toolbindung provisionieren; zunächst ohne produktive Rufnummer testen.
4. OCR bei Bedarf als gesondert freigegebene Verarbeitung ergänzen. Produktive Leistungsabnahme und betriebliche Überwachung der Importfehler/Verbindungslaufzeiten durchführen.
5. Erst im gesonderten Releaseprozess die produktive Migration, Verträge und Assistentenaktivierung durchführen. Paket 3 erweitert Veröffentlichungsverwaltung und regelmäßige Pflege; Stripe bleibt eine eigene Integration.
