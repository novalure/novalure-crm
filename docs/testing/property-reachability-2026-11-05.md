# Immobilien: lokal nachgewiesene Mietpreis- und PDF-Formatkorrektur

Basis: `954763a6d6c0a6df94eb8c8e564304a879a9560a`, eigene Arbeitskopie
`C:/Projects/novalure-crm-property-reachability-20261105`, Branch
`codex/property-reachability-20261105`. Die parallelen CRM- und Evelyn-Arbeitskopien
wurden nicht verändert. Es gab keinen Push, Online-PR, Merge oder Deploy.

## Ergebnis und tatsächlicher Fehlerpfad

Der fiktive eingefrorene Fall ES-RENT-01 wurde über den originalen
`POST /api/crm/properties` mit einer in PostgreSQL gespeicherten synthetischen
Testsitzung und gültigem CSRF-Schutz angelegt. Die Wiederholung erzeugte denselben
Datensatz mit genau einem Command-Receipt. Die tatsächlich gespeicherten Beträge
waren `target/public = 31500000` Cent und `rent = 174321` Cent. Website und Web-PDF
verwendeten korrekt die Bruttomiete; das separate Immobilien-PDF zeigte hingegen
`Alquiler: 315.000,00 EUR / mes`. Nach der Korrektur zeigt es `1743,21 EUR / mes`.

Das ist ein bestätigter Prioritätsfehler bei der Auswahl gespeicherter Preisfelder.
Der zurückgezogene historische Verdacht zu einem Canonical-Alias bleibt
zurückgezogen. Anlage, gespeicherter Public-Price-Fallback und bestehende Daten
wurden nicht umgeschrieben. Bei Miete gilt ausschließlich bekannte Bruttomiete;
fehlende Bruttomiete wird weder durch Kaufpreis noch private Nettomiete ersetzt.
Bekannte Null und die aktuelle passende Bauträger-Preisbestätigung bleiben getrennte
Voraussetzungen. Kaufpreis-Overrides funktionieren weiter.

Der zweite bestätigte Pfad betrifft ein tatsächlich gespeichertes Profil
`Land ES / Inhalt es / Zahlenformat en-IE`: Die separate PDF-Quellenprojektion
verlor das Zahlenformat. Nun werden die freigegebenen Geografie-Felder explizit
projiziert, strikt validiert und als optionales Zahlenformat bis zum Renderer
erhalten. Beschriftungen und PDF-Sprachmetadaten folgen weiterhin DE/EN/ES.
Alte DTOs ohne Profil behalten ihren bisherigen Format-Fallback.

## Ausgeführte Prüfungen

| Umfang | Ergebnis | Einordnung |
| --- | --- | --- |
| Neue Preisprüfungen | 8/8 Node-Tests, darin 7 Fachuntertests | Originale Handler, echte lokale PostgreSQL-Datenbank, tatsächliche PDF-Bytes |
| Neue Ausgabeprüfungen | 10/10 Node-Tests, darin 9 Fachuntertests | Gespeichertes Profil, private Felder, Adresse, PDF-Sprache, Fingerprint und aktuelle Preissichtbarkeit |
| Bestehende gezielte Regressionen | 19/19 | Länderregeln, Nullpreis/Bestätigung, öffentliche Details und Kosten, öffentliche PDF-Sicherheit/Medien/Widerruf |
| Typprüfung und gezieltes ESLint | erfolgreich | Abschließender Stand einschließlich der neuen HTTP-Prüfwerkzeuge |
| Tatsächliches lokales Next-HTTP | erfolgreich | 401 ohne Sitzung, 403 ohne CSRF; Anlage, vollständiges Lesen, Vorschau, lokale Testversion, anonyme HTML- und PDF-Antwort jeweils 200 |

Die 18 neuen Node-Tests enthalten zwei übergeordnete Test-Wrapper; es sind
16 Fachuntertests. Die zusätzliche HTTP-Prüfung wird nicht nochmals in diese
Testanzahl hineingezählt. Die unveränderte OpenImmo-XSD-Prüfung wurde durch den
ausdrücklichen Namensfilter nicht ausgeführt und erhält keinen PASS.

Die neuen direkten Handlerprüfungen sind keine HTTP- oder Browserprüfung. Die
zusätzliche Wire-Prüfung verwendete einen echten Next-Custom-Server auf Loopback,
echte Datenbankspeicherung und originale Routen. Sie las JSON/HTML als Antworten und
erzeugte das öffentliche PDF über dessen HTTP-Endpunkt. Ein interaktiver Browser
wurde nicht ausgeführt. Das HTML hat einen englischen Seitenrahmen und korrekt
`lang="es"` am Immobilienbereich. Die Netzwerkbegrenzung verzeichnete zwei
abgewiesene Aufrufe; dies ist keine Behauptung von null Verbindungsversuchen oder
eine Paketaufzeichnung. Provider-Zugangsdaten wurden nicht weitergereicht.

Private Notizen, Verkäufer- und Katastermarker wurden nachweislich gespeichert
und blieben aus den geprüften öffentlichen Projektionen ausgeschlossen. Die
Adressprüfung enthält positive und negative Kontrollen. Bewusst eingegebene
öffentliche Preistexte bleiben eine gesonderte Beobachtung: Strukturierte Preise
und Kosten werden bei engerer Sichtbarkeit unterdrückt; ein allgemeiner
Freitext-DLP-Schutz wird nicht behauptet. Nicht über einen Originalpfad erreichte
Medienbeschriftungen erhalten keinen zusätzlichen Abnahmenachweis.

## Gesicherte Ausgaben und Grenzen

Alle sieben erfolgreichen PDF-Referenzen wurden gerendert und ihre insgesamt
14 Seiten in Kontaktbögen visuell geöffnet: Web- und separates PDF des ES-Mietfalls
(2 + 3 Seiten), DE/EN/ES mit gespeichertem en-IE-Format (je 2 Seiten), Legacy-Fallback
(1 Seite) und das echte öffentliche HTTP-PDF (2 Seiten). Keine Überlagerung,
abgeschnittenen Inhalte oder fehlenden Zeichen wurden beobachtet. Zusätzlich
wurden die beiden ursprünglichen Miet-PDFs mit fünf Seiten als Gegenbeleg geöffnet.
Weitere PDFs aus den 19 bestehenden Tests wurden maschinell geprüft, nicht als
zusätzliche Sichtprüfung gezählt. HTML wurde als Quellantwort gelesen.

Stabile lokale Kopien liegen unter
`.npm-cache/qa/property-reachability-final/output/pdf/`. Die Originalbytes aller
neun PDFs, Rohprotokolle, Ausgangstest und wesentliche Receipts sind zusätzlich im
Git-gespeicherten [Byte-Transport](evidence/property-reachability-20261105/evidence-transports.json)
enthalten. Gewöhnliche Artefakte als Base64 dekodieren. Die explizit markierte
Prüfsummenliste `ordered-source-sha256-json-v1` aus den geordneten Einträgen als
`{kind: manifestKind, inputs: Object.fromEntries(entries.map(e => [e.path, e.sha256]))}`
mit `JSON.stringify(..., null, 2)` und einem abschließenden LF wiederherstellen;
doppelte Pfade und andere als 64-stellige Hex-Prüfsummen zurückweisen. Immer die
ursprüngliche Bytezahl und SHA256 prüfen, nicht Transport-JSON oder umgewandelte
Zeilenendungsbytes hashen. Die lesbare
[Verifikation](evidence/property-reachability-20261105/verification.json) bindet
alle elf geänderten/neuen Code-Dateien und die unveränderte Lockdatei an SHA256.

Die erste Geheimnissuche markierte 19 Werte der ursprünglichen Pfad-zu-Prüfsumme-
Liste als mögliche API-Schlüssel. Alle 19 sind nachweislich reproduzierte
Datei-SHA256-Werte; es gab keinen unklassifizierten Treffer. Die Liste wird deshalb
als geordnete, explizit mit `path` und `sha256` beschriftete Einträge transportiert.
Alle Werte bleiben lesbar, die ursprünglichen Bytes sind identisch rekonstruierbar,
und der unveränderte Detektor findet in dieser Darstellung keinen Treffer. Es wurde
keine Scannerregel abgeschwächt oder Ausnahmeliste ergänzt. Der fehlgeschlagene
erste Suchlauf und seine Klassifizierung bleiben als Belege erhalten.

Die frühere Nullpreis-Substring-Prüfung war zu schwach; ihr unveränderter
Ausgangstest bleibt erhalten. Die gespeicherten Beträge belegen den alten Fehler,
und der finale Test vergleicht den vollständigen Betrag. Die fünf fehlgeschlagenen
Ausgabe-Untertests am Ausgangsstand umfassen drei Sprach-/Formatfälle, den
Format-Fingerprint und einen synthetischen Renderer-Grenztest; sie sind keine fünf
unabhängigen Produktfehler. Fehlgeschlagene Datenbank-/HTTP-Testaufbauten bleiben
als solche erhalten und zählen nicht als Produktnachweis.

Das zusätzliche Geografie-Feld verändert konservativ auch den Quellenhash älterer
PDF-Versionen, gegebenenfalls bei einem Null-Profil. Bestehende PDF-Bytes werden
nicht umformatiert oder automatisch ersetzt/aktiviert. Alte Versionsmetadaten
bleiben erhalten und können als veraltet erscheinen. Die dazu verwendete
historische Registry/Asset-Zeile ist ausdrücklich eine synthetische Metadatenprobe;
sie beweist keinen historischen Upload oder Download gespeicherter Backend-Bytes.
Bereits erzeugte PDFs benötigen für die korrigierte Darstellung eine Neuerzeugung.

Die Tests verwenden die vorhandene isolierte Feature-Test-Schemahilfe mit deren
historischen Migrations-/Vektor-Ausnahmen. Das ist keine vollständige
Produktions-Datenbankprobe. Eigene Testinstanzen wurden nach aktueller
SQL-Identitätsprüfung mit nativer Instanzsteuerung geordnet beendet; finale HTTP-
und Datenbank-Listener sind geschlossen. Frühere fehlgeschlagene Aufbauten und
deren begrenzte eigene Wiederherstellung sind separat dokumentiert.

## Übergabe und Fortsetzung

Die unveränderten vorhandenen Evelyn-/Linux-/Datenbank-/Recovery-Nachweise wurden
nicht nochmals ausgeführt und durch dieses CRM-Paket nicht zu Live-Belegen
aufgewertet. Der geschützte Department-CRM-Lesehost, echte kundenseitige
Berechtigungs-/Faktenbindung, native CI, Trusted-App-Attestierung und Produktion
sind durch diese lokalen Tests nicht abgenommen. Keine neue fachliche Bindung
aller inventarisierten Immobilienfelder wurde erzwungen.

Nächster Schritt ist die Übernahme dieses lokal geprüften Kandidaten durch die
zuständige CRM-Koordination nach deren exakter Integrationsprüfung. Danach bleiben
geschützter Lesehost und reale Integrationsabnahme getrennte Arbeiten. Online-CI
und App dürfen erst nach dem für den konkreten Kandidaten tatsächlich gedeckten
Prüf-/Kostenweg ausgelöst werden. Ein lokaler Agentenreview ersetzt diese Gates
nicht. Es gab keine externe Veröffentlichung, Zugriffe auf echte Kundendaten oder
geschäftswirksamen Preisänderungen, Reservierungen oder weiteren Geschäftswirkungen.

Der unabhängige Abschlussreview wird außerhalb des Git-Selbstbezugs unter
`.npm-cache/qa/property-reachability-final/independent-review.json` mit dem exakten
finalen Commit aufgezeichnet. Dieser Pfad ist kein vorweggenommener PASS; der
abschließende Übergabestatus muss dessen tatsächliches Ergebnis und Commit prüfen.
