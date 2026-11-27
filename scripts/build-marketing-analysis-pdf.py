from pathlib import Path
from html import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/Livelisted-Marketing-Empfehlung-2026-11-04.pdf'
MD = ROOT / 'docs/Livelisted-Marketing-Empfehlung-2026-11-04.md'
QA = ROOT / 'qa/livelisted-marketing-2026-11-04'
OUT.parent.mkdir(parents=True, exist_ok=True)
for name, file in [('Inter', 'arial.ttf'), ('InterBold', 'arialbd.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(Path('C:/Windows/Fonts') / file)))
INK = colors.HexColor('#172B3A')
TEAL = colors.HexColor('#177B78')
MUTED = colors.HexColor('#526574')
LIGHT = colors.HexColor('#EAF4F2')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleN', fontName='InterBold', fontSize=27, leading=32, textColor=INK, spaceAfter=18))
styles.add(ParagraphStyle(name='H1N', fontName='InterBold', fontSize=19, leading=23, textColor=INK, spaceAfter=13))
styles.add(ParagraphStyle(name='H2N', fontName='InterBold', fontSize=12, leading=16, textColor=TEAL, spaceBefore=12, spaceAfter=6))
styles.add(ParagraphStyle(name='BodyN', fontName='Inter', fontSize=10, leading=14.7, textColor=INK, spaceAfter=8))
styles.add(ParagraphStyle(name='SmallN', fontName='Inter', fontSize=8.4, leading=11.7, textColor=MUTED, spaceAfter=6))
styles.add(ParagraphStyle(name='CellN', fontName='Inter', fontSize=8.5, leading=11.6, textColor=INK))
styles.add(ParagraphStyle(name='CellHeadN', fontName='InterBold', fontSize=8.5, leading=11.6, textColor=colors.white))
story, md = [], ['# Livelisted: Marketing und automatischer Lead-Mailimport', '', 'Nachtrag zur CRM-Analyse v2 | 4. November 2026', '']

def p(text, style='BodyN'):
    story.append(Paragraph(text, styles[style]))
    md.extend([text.replace('<b>', '**').replace('</b>', '**'), ''])

def h(text):
    story.append(Paragraph(text, styles['H2N']))
    md.extend(['## '+text, ''])

def page(title):
    if story:
        story.append(PageBreak())
    story.append(Paragraph(title, styles['H1N']))
    md.extend(['# '+title, ''])

def table(headers, rows, widths):
    data = [[Paragraph(escape(t), styles['CellHeadN']) for t in headers]]
    data += [[Paragraph(escape(t), styles['CellN']) for t in row] for row in rows]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0),(-1,0),INK),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor('#F1F6F7'),colors.white]),
        ('LINEBELOW',(0,0),(-1,0),.5,INK),('LINEBELOW',(0,1),(-1,-1),.25,colors.HexColor('#D8E2E6'))]))
    story.append(t)
    md.append('| '+' | '.join(headers)+' |')
    md.append('| '+' | '.join(['---']*len(headers))+' |')
    md.extend(['| '+' | '.join(row)+' |' for row in rows])
    md.append('')

def shot(filename, caption, maxh=560):
    src = QA / filename
    iw, ih = ImageReader(str(src)).getSize()
    scale=min(499/iw,maxh/ih)
    story.append(Image(str(src), width=iw*scale, height=ih*scale, hAlign='LEFT'))
    story.append(Spacer(1,9))
    p(caption,'SmallN')
    md.extend([f'![{caption}](../qa/livelisted-marketing-2026-11-04/{filename})',''])

story.append(Paragraph('Marketing, das im CRM<br/>zusammenarbeitet', styles['TitleN']))
p('Livelisted erneut geprüft in Edge<br/><b>Empfehlung für Novalure in AT, DE, ES und IE</b>')
p('4. November 2026 | Ergänzung zur ursprünglichen Analyse v2','SmallN')
h('Meine Empfehlung')
p('<b>Ja: Ein zentraler Hauptpunkt Marketing ist sinnvoll.</b> Newsletter, Kampagnen, Formulare, Immobilienwebsites, Flows, Vorlagen und deren Ergebnisse sollen von einem gemeinsamen Arbeitsbereich aus erreichbar sein. Die vorhandenen Kontakte, Leads, Objekte und Freigaben bleiben dabei dieselben.')
p('Jede Karte bekommt eine kurze Erklärung, eine klare nächste Aktion und kleine Tags. Beispiel: <b>Mailings</b> - „Passende Kontakte informieren und den Versand nachvollziehen.“ Darunter: „E-Mail“, „Zielgruppe“ und je nach Zustand etwa „Freigabe nötig“ oder „Geplant“. Zustände müssen aus echten Daten kommen.')
h('Die wichtigste Grenze')
p('Persönliche Google- und Outlook-Mails gehören zusätzlich in <b>Kommunikation und die jeweilige Leadakte</b>. Im Marketing werden deren Einrichtung und die Herkunft von Anfragen sichtbar. Private Postfachinhalte werden dadurch nicht automatisch für das gesamte Marketingteam freigegeben.')
h('Was heute bereits vorhanden ist')
p('Unser CRM besitzt ein Marketingprofil mit einfachem Marketing-Cockpit und zehn einzelnen Bereichen. Ein gemeinsamer Marketing-Einstieg mit Funktionskarten fehlt. Newsletter, neue Automationen, Exposé-Links, PDF-Download, Kundenformulare und Quellenberichte sind angeschlossen. Google-/Microsoft-Mail arbeitet bisher mit bewusstem manuellem Abruf und manueller Zuordnung/Triage.')
h('Was diese Prüfung belegt')
p('Angemeldete Edge-Prüfung der fünf Livelisted-Marketingreiter, des vorhandenen ausgeschalteten Beispiel-Flows, seiner Mail- und Bedingungsdetails, der Mailvorlagen/Variablen, Leadakte, Postfachdialoge und Leadquellenansicht. 16 Screenshots und sichtbare Texte sind gespeichert. Keine Kampagne beauftragt, kein Mailing gesendet und kein reales Postfach verbunden.','SmallN')

page('1. Was Livelisted tatsächlich zeigt')
table(['Bereich','Heute in Edge beobachtet','Konsequenz für Novalure'],[
('Kampagnen','Meta-Angebot ab 150 EUR über Anbieter-Konten, Vorkasse und Freigabe. Google Ads ausdrücklich in Vorbereitung. VIP/Off-Market sind Dienstleistungsanfragen.','Gemeinsame Kampagnenübersicht übernehmen. Anzeigenbetrieb und Agenturleistungen als eigene, noch einzurichtende Fähigkeiten behandeln.'),
('Flows','Organisations-/Projektbezug, sechs Startvorlagen, grafischer Ablauf, Ja/Nein, Wartezeiten, Aufgaben, Mailtexte und Variablen.','Einstieg vereinfachen und bestehende Automation verwenden. Version, Ausführung, Freigabe und Versandstatus sichtbar halten.'),
('Mailings','Projekt/Phase/alle/Auswahl; Empfängerzahl und Ausschlüsse; Test an sich selbst; sofortiger Lauf oder Datum/Uhrzeit; Abmeldung.','Newsletter im Marketing bündeln. Bestehende Einwilligungen und Sperren verbindlich anwenden; Versandvorschau und Planung zeigen.'),
('Vorlagen','PDF-Stil, Logo, eigenes Briefpapier, Kopf/Fuß, Abschnittsreihenfolge und Bildraster. Daneben Vertragstexte und Signatur.','Zentrale Bibliothek nach Vorlagentyp. Unsere Firmen-/Exposévorlagen bestehen; eigene Mailingbibliothek und weitere Layoutoptionen ergänzen.'),
('Reports','Projektwahl, Einheiten/Volumen/Status, Nachfrage, Kanäle, Verkäufe, Reservierungen, Exposénutzung, Druck/PDF und Teilen.','Marketingerfolg und Projekterfolg verknüpfen, Messdefinitionen trennen. Eigene Reports besitzen echte Bestands-/Verkaufszahlen.'),
('Postfach','IMAP/SMTP-Formular; nur Leadbezug laut UI. Outlook-Anmeldung folgt laut Hinweis; Gmail benötigt dort App-Passwort.','Native Google-/Microsoft-Anmeldung bevorzugen. Automatischer Eingang und sichere Zuordnung sind noch zu bauen.')
],[78,210,211])
p('Quellen: heutige Edge-Aufnahmen 01 bis 13. Es waren keine echten Kampagnen- oder Mailinghistorien vorhanden. Die sichtbaren Leistungsbeschreibungen belegen kein erfolgreiches Providerergebnis.','SmallN')

page('2. So sollte unser Marketing aufgebaut sein')
p('Ein Hauptpunkt <b>Marketing</b> mit gemeinsamem Projekt-/Länderfilter. Als klare Reiter: <b>Übersicht, Kampagnen, Mailings, Flows, Inhalte &amp; Vorlagen, Reports</b>. Auf der Übersicht führen Karten direkt in die bestehenden Werkzeuge. Formulare und Leadquellen werden dort mitgeführt; Kontakte bleiben zentral im CRM.')
table(['Funktionskarte','Kurze Erklärung unter dem Titel','Tags und direkte Aktion'],[
('Kampagnen & Leadquellen','Woher kommen Anfragen, welchem Vorhaben gehören sie und was folgt daraus?','Website | Portal | E-Mail | Verbindung fehlt. Aktion: Quelle einrichten / Vorhaben öffnen.'),
('Mailings & Newsletter','Kontakte passend auswählen, Nachricht prüfen und Versand planen.','Zielgruppe | Entwurf | Freigabe | Geplant. Aktion: Mailing erstellen.'),
('Flows','Nach einer Anfrage oder Kundenaktion den nächsten Schritt vorbereiten.','Auslöser | Warten | Manuelle Prüfung | Aktiv. Aktion: Flow öffnen.'),
('Websites & Formulare','Objekte teilen und strukturierte Anfragen entgegennehmen.','Exposé | PDF | Suchprofil | Live/Entwurf. Aktion: Objekt oder Formular öffnen.'),
('Zielgruppen','Kontakte nach Interesse, Land, Sprache und zulässiger Ansprache auswählen.','AT/DE/ES/IE | Projekt | Einwilligung. Aktion: Empfängervorschau.'),
('Inhalte & Vorlagen','Wiederverwendbare Mailtexte und Exposégestaltung verwalten.','Mail | PDF | Website | Version. Aktion: passenden Vorlagentyp bearbeiten.')
],[105,204,190])
h('Darunter: Jetzt prüfen')
p('Nur tatsächliche Aufgaben: Mailing wartet auf Freigabe, Flow gestoppt, Verbindung unterbrochen, Veröffentlichung veraltet, Versandresultat unklar. Jeder Eintrag öffnet den Originalvorgang. Keine zweite Aufgabenliste mit kopierten Zuständen.')
h('Reports bleiben direkt erreichbar')
p('Die Übersicht zeigt wenige nachvollziehbare Kennzahlen mit Zeitraum und Projektbezug. Tiefergehende Auswertung öffnet den Reports-Reiter. Die operative Leadakte und persönliche Kommunikation bleiben von jedem relevanten Vorgang aus erreichbar.')

page('3. Tags: Erklärung und echte Zielgruppen trennen')
h('A. Funktions-Tags unter den Karten - kleiner Aufwand')
p('„E-Mail“, „PDF“, „Website“, „Automatisch“, „Manuelle Freigabe“ erklären die Funktion. „Nicht eingerichtet“, „Entwurf“, „Bereit“, „Geplant“, „Aktiv“, „Gestoppt“ erklären den aktuellen Zustand. Ein Tooltip oder eine kurze Zeile sagt, was als Nächstes nötig ist. Bedeutung immer als Text zeigen, nicht nur über Farbe.')
h('B. Kontakt-/Lead-Tags - eigener Ausbau')
p('Beispiele: „Kapitalanlage“, „Eigennutzung“, „Spanien-Interesse“, „Deutschsprachig“, „Projekt Seeblick“. Solche Tags werden einmal am Originalkontakt bzw. an seinem fachlichen Interesse gepflegt und in Filtern wiederverwendet. Änderungen brauchen Herkunft und Verantwortlichkeit; automatisch abgeleitete Tags müssen nachvollziehbar bleiben.')
p('<b>Heutige Grenze:</b> Formular-Tags sind bereits Metadaten eines Formulars. Sie sind noch keine angeschlossene allgemeine Kontakt-/Leadtagverwaltung. Frei kombinierbare Zielgruppenregeln sind im Newsletter derzeit bewusst begrenzt. Das muss als eigener vollständiger Ablauf erweitert werden.')
h('C. Verbindliche Felder bleiben eigene Felder')
p('Land, bevorzugte Sprache, Projektzuständigkeit, Einwilligung, Abmeldung und Sperre dürfen nicht nur als frei änderbare Tags existieren. Ein Interesse-Tag darf keine Versandsperre aufheben. Länder- und Sprachfilter müssen unabhängig funktionieren: Ein Interessent in Österreich kann ein Objekt in Spanien suchen und Englisch bevorzugen.')
h('Ein sinnvoller Standardablauf')
p('<b>Quelle → Anfrage → Leadakte → nächste Aufgabe → passendes Exposé → Termin → Ergebnis.</b> Das Marketingvorhaben referenziert diese Originaldatensätze. Ein Newsletter, ein Flow oder eine Landingpage erhält keine eigene Kopie desselben Kontakts.')
h('Woran die Umsetzung abgenommen wird')
p('Eine Änderung am Lead ist überall sichtbar. Abmeldung wirkt auch nach einem Tagwechsel. Projektgrenzen gelten in jeder Vorschau. Eine Kampagne öffnet genau die zugeordneten Anfragen. Karten zeigen keine erfundenen Empfänger-, Kosten- oder Erfolgszahlen.')

page('4. Flows: Was übernehmen, was verbessern?')
h('Guter Ansatz bei Livelisted')
p('Der geprüfte „Makler Standard“ verbindet fehlende Kontaktdaten, Formularanforderung, drei Tage Warten, Exposé-Mail, Öffnungsbedingung, Nachweisanfrage und Terminmail. Pluspunkte: verständliche Knoten, Plus auf einer Verbindung, Organisations-/Projektwahl und Stoppen bei persönlichem Kontakt. Der Flow war ausgeschaltet und hatte keine versendeten Mails.')
p('Sichtbare Startereignisse: neuer Lead, Suchprofil ausgefüllt, Exposé geöffnet, Termin gebucht, Phase geändert, Nachweis hochgeladen und neuer Treffer ab 80 Prozent. Bedingungen umfassen Antwort, Telefonnummer, Termin, Nachweis, Suchprofil, Treffer, Anfragetext und Phase. Bei der Wartedauer steht im Beispiel „nächste Geschäftsstunde“.')
h('Was wir bereits nutzen können')
p('Unser neuer Graph speichert Versionen, Kanten, Ja/Nein, Wartezeiten und Stopps. Kundenlinks, Qualifizierung, Matching und Besichtigungsquellen sind angeschlossen. Der Providerauftrag hat einen eigenen Prüf-/Versandweg. Diese Grundlage im Marketing öffnen, statt noch einen Floweditor mit eigener Datenhaltung einzuführen.')
p('Zusätzlich geprüft: elf mitgelieferte Mailvorlagen, laut Oberfläche auf Deutsch, Englisch und Französisch. Eigene projektbezogene Textvariablen bieten DE/EN/FR-Fallbacks. Für unsere Zielländer ist eine freigegebene spanische Version besonders wichtig; fehlende Pflichtvariablen sollten wir sichtbar melden, statt unbemerkt Text wegzulassen.')
h('Wo wir besser werden sollten')
p('<b>Vor Aktivierung:</b> Ablauf verständlich prüfen, Variablen mit Beispieldaten anzeigen, fehlende Verbindungen und Freigaben nennen. <b>Im Betrieb:</b> pro Lead den aktuellen Schritt, nächsten Zeitpunkt und Stopgrund zeigen. Simulation, gespeicherte Version und tatsächlich ausgeführte Aktion klar unterscheiden.')
p('Kontaktzeiten, lokale Zeitzone, Feiertagsregeln und ein kontaktübergreifendes Frequenzlimit sind sinnvolle zusätzliche Arbeit. Bei einer echten Antwort, Abmeldung oder Übernahme durch einen Mitarbeiter muss die konkrete betroffene Strecke zuverlässig stoppen. Nicht nur ein grünes „aktiv“-Label anzeigen.')
h('Exposé-Signale richtig verwenden')
p('Aufruf, aktive Abschnittszeit, Klick und Download können Hinweise auf Interesse geben. Sie beweisen weder, dass ein Text gelesen/verstanden wurde, noch dass die angeschriebene Person selbst vor dem Bildschirm sitzt. Fehlende Statistik oder abgelehnte Messung darf nicht automatisch als Desinteresse gelten. Keine automatische Wohnungs-/Finanzierungsentscheidung aus Nutzungsstatistik.')

page('5. Google und Outlook: So sollen Lead-Mails ankommen')
p('<b>Ziel:</b> Neue passende Nachrichten erscheinen automatisch beim richtigen Lead, samt Herkunft und Verlauf. Die persönliche Inbox bleibt geschützt. Der Nutzer sieht Verbindung, letzten erfolgreichen Abgleich, Fehler und offene Zuordnungen.')
table(['Schritt','Empfohlener Ablauf'],[
('1. Verbinden','Persönliche Anmeldung bei Google bzw. Microsoft mit separaten Mailrechten. Leserecht und späteres Senderecht getrennt erklären; keine Kalenderberechtigung als Mailberechtigung behandeln.'),
('2. Eingang abgleichen','Schon im ersten Ausbau regelmäßiger inkrementeller Abgleich mit Gmail History bzw. Microsoft Graph Delta und dauerhaftem Fortschritt. Push-Benachrichtigungen später als Beschleuniger derselben Pipeline.'),
('3. Eindeutig zuordnen','Bekannter bestätigter Verlauf bzw. eine kontrollierte Projekt-Empfangsadresse ist stärker als ein Betreff. Exakte Mailadresse kann Kandidaten liefern; mehrere Leads/Projekte oder private Inhalte erfordern Prüfung.'),
('4. Sichtbarkeit steuern','Private Kopie und gemeinsam freigegebene Leadkorrespondenz getrennt. Einmalige nachvollziehbare Freigaberegel statt automatischer Veröffentlichung der gesamten privaten Inbox.'),
('5. Neue Leads','Eindeutige Portalanfrage über geprüfte Quellregel kann einen neuen Lead vorbereiten oder nach ausdrücklich aktivierter Regel anlegen. Unbekannte normale Mails nicht pauschal zu Leads machen.'),
('6. Anhänge und Antworten','Anhänge zuerst nur Metadaten; Download/Dateiprüfung und bewusste Zuordnung später. Antwortentwurf und tatsächlicher Versand sind eigene Schritte; keine automatische Antwort im ersten Ausbau.')
],[104,395])
h('Heutiger Stand und wirklicher Rest')
p('Die vorhandenen Module 136/144 bieten getrenntes persönliches OAuth, begrenzten manuellen Leseimport, bestätigte Zuordnung und manuelle Triage. <b>Automatischer Hintergrundempfang ist noch nicht fertig.</b> Den bisherigen Abruf der letzten fünf Mails nur regelmäßig aufzurufen wäre bei vielen Eingängen unvollständig. Dauerhafte inkrementelle Synczustände, Worker, Wiederanlauf und sichere Zuordnung sind zusätzliche Softwarearbeit.')
p('Gmail unterstützt Push über Cloud Pub/Sub und History; Watches müssen erneuert werden. Graph bietet Änderungsabonnements; Delta holt Änderungen nach, bei Nachrichten pro Ordner. Erneuerung, verpasste Ereignisse und Wiederherstellung sind Teil des Produkts, nicht bloß ein zusätzlicher Knopf. [G1/G2/M1/M2/M3]','SmallN')
p('Für einen öffentlichen Google-Anschluss gehört die Anbieterprüfung zur Planung: gmail.readonly ist ein eingeschränkter Zugriffsumfang. Für serverseitige Verarbeitung können Verifizierung und Sicherheitsprüfung erforderlich sein; Ausnahmen etwa für interne Nutzung sind anhand des tatsächlichen Appmodells zu prüfen. Das ist mehr als ein API-Schlüssel. [G3/G4]','SmallN')

page('6. Was ist einfach - und was braucht mehr Arbeit?')
p('Relative Einschätzung nach Quellprüfung: <b>S</b> nutzt vorwiegend vorhandene Ansichten, <b>M</b> erweitert einen durchgängigen Ablauf, <b>L</b> benötigt mehrere neue Betriebs-/Anbieterbausteine. Keine belastbare Tages- oder Preiszusage ohne konkretes Zielsystem und Abnahmeumfang.')
table(['Priorität / Umfang','Arbeit','Abnahme'],[
('P1 · S bis M','Marketing-Einstieg, Karten mit Kurzinfos/Tags, gemeinsame Filter, direkte Verweise auf bestehende Werkzeuge.','Keine Rechteausweitung, korrekte Originalvorgänge, echte Statusleser, mobile und leere Zustände.'),
('P1 · M bis L','Automatischer Google-/Outlook-Eingang mit dauerhaftem Fortschritt, Wiederholungsschutz und Prüfliste.','Beide realen Provider: neue Mail, bekannte Antwort, Dublette, Ausfall/Nachholen, Widerruf und mehrdeutige Zuordnung.'),
('P2 · M','Gespeicherte Mailingvorlagen mit Variablenvorschau und DE/EN/ES-Versionen.','Vorlage speichern/laden, Revision einfrieren, fehlende Variable blockiert fehlerhaften Versand.'),
('P2 · M','Kontakt-/Lead-Tags und verständliche Zielgruppenregeln.','Vorschau entspricht Versand; aktuelle Einwilligung, Sperren und Projektgrenzen bleiben verbindlich.'),
('P2 · M','Vorhaben, UTM-/Quellbezug und einfacher gemeinsamer Ergebnisbericht.','Erstanfrage und Folgekontakt unterscheiden. Gewonnene Deals nur über tatsächliche Zuordnung zählen.'),
('P2 · M','Exposégestaltung: eigenes Logo, Bildraster/Briefpapier und mehr Layoutwahl.','Sichere Assets, lesbares PDF, eingefrorene Version und Vorschau. Keine Freigabe privater Dokumente.'),
('P3 · L','Meta-/Google-Anzeigen direkt steuern; Kosten, Leads und Zustellung abgleichen.','Eigene Geschäftskonten, Budgets/Freigaben, Zielanbieter und reale API-/Webhook-/Abrechnungsabnahme nötig.')
],[93,206,200])
h('Vorher gezielt bereinigen')
p('Der ältere allgemeine Funnelpfad hat neben der Datenbank noch einen lokalen Dateifallback und abweichende Restore-/Submissionpfade. Vor einer Zusage „Landingpages vollständig live“ den gesamten Weg Veröffentlichung → Formular → richtiger Mandant/Lead gezielt abnehmen. Der neue Exposé-Anfrageweg ist separat geprüft.')

page('7. Vier Länder und nachvollziehbare Reports')
h('AT, DE, ES, IE sind mehr als vier Flaggen')
p('Objektland, Kontaktland, bevorzugte Sprache und Zeitzone getrennt führen. Texte und Vorlagen je Sprache freigeben. Länderabhängige Objekt-/Energiedaten und Pflichttexte im bestehenden Länderregelwerk prüfen. Absender, Anbieterangaben, Einwilligungsnachweise und Aufbewahrungsregeln benötigen im Zielbetrieb eine fachlich geprüfte Konfiguration.')
p('Ein einziges Landfeld oder ein frei gesetzter „ES“-Tag ersetzt diese Unterscheidung nicht. Einwilligung pro Zweck und Kanal nachvollziehbar halten; eine Anfrage bzw. ein importierter Kontakt darf nicht still als allgemeines Newsletterabonnement gelten. Das ist eine Produktanforderung, keine Behauptung einer vollständigen Rechtsprüfung aller vier Länder.')
h('Was ein Marketingreport zeigen sollte')
p('Anfragen nach Quelle und Vorhaben, Bearbeitungszeit, vereinbarte Termine, zugeordnete Reservierungen und gewonnene Vorgänge. Zusätzlich gemessene Exposébesuche, aktive Abschnittszeiten und Aktionen. Zeitraum, Definition, Filter und Messabdeckung müssen sichtbar sein.')
p('<b>Getrennte Ereignisse:</b> Versand vorbereitet, Provider hat angenommen, zugestellt, gebounced, geklickt, Exposé besucht, Anfrage eingegangen, Termin gebucht, Verkauf bestätigt. Eine Providerannahme ist keine Zustellung. Ein Klick ist keine Besichtigung. Ein unbekannter Wert wird nicht als Null oder als geschätzter Erfolg ausgegeben.')
h('Kosten und Attribution')
p('Ohne echte Anzeigenkosten und saubere Kampagnenzuordnung keinen ROAS ausweisen. Zunächst transparente Herkunftszuordnung: direkte Quelle, kontrollierter Link/UTM und zugehörige Anfrage. Mehrere Kontakte und Weiterleitungen erklären, statt vollständige Werbewirkung zu suggerieren. Projektverkaufsberichte bleiben auch ohne Werbeanbieter nützlich.')
h('Meine Entscheidungsempfehlung')
p('<b>Jetzt den vorhandenen Funktionsumfang verständlich unter Marketing zusammenführen und automatischen Lead-Mail-Eingang priorisieren.</b> Danach Mailingvorlagen, echte Tags/Zielgruppen und gemeinsame Auswertung vervollständigen. Direkten Anzeigenkauf erst nach dieser Grundlage und mit bestätigten Geschäftskonten anbinden.')
p('Dieser Nachtrag empfiehlt die neue Marketingstruktur; er behauptet keine bereits durchgeführte Umsetzung des Hubs, der Tagverwaltung oder des automatischen Mailimports. Der bestehende lokale Implementierungsstand wird separat dokumentiert.','SmallN')

page('8. Quellen und Grenzen der erneuten Prüfung')
h('Angemeldete Produktprüfung in Edge')
p('Livelisted: Marketing / Kampagnen, Flows mit vorhandenem „Makler Standard“, Mailings, Vorlagen und Reports. Verbindungen / persönliches Postfach mit den Optionen Outlook und Gmail. Projekt / Portale &amp; Kampagnen und Leadquelle verbinden. Aufnahmen unter qa/livelisted-marketing-2026-11-04; Originaldateien bleiben unverändert.')
p('Beim Beispielobjekt führte „Meta-Kampagne starten“ zur Objektseite, ohne dass ein Kampagnenformular angezeigt wurde. „Leadquelle verbinden“ verlangte ein reguläres Projekt, obwohl das Beispielprojekt existiert. Diese Wege sind daher nicht bis zu einem ausführbaren Auftrag belegt. Es wurde dafür kein echtes Objekt angelegt und nichts veröffentlicht.')
p('Keine laufende Kampagne, kein Mailingverlauf, keine tatsächliche Zustellung und keine verbundene private Mailbox waren vorhanden. Nach einer vorübergehenden Edge-Unterbrechung wurden auch Leadakte, persönlicher Exposé-Bezug, elf Mailvorlagen und eigene Variablen geprüft. Beim Beispiel-Lead standen null Exposéaufrufe und kein Leseverlauf; echte gelesene Seiten konnten deshalb nicht erneut nachgewiesen werden.')
h('Quellprüfung unseres CRM')
p('Marketinginventur, Mailbox 136, Triage 144, Newsletter 123/134/142, Automationen 120/131, Kundenformulare 128, Termine 135, Qualifikation 140 und Exposé/Firmenvorlagen 121/129/132/141. Neue Empfehlung und bestehende lokale Implementierung werden ausdrücklich getrennt. Kein Produktivrollout und keine echten Mails durch diese Recherche.')
h('Offizielle technische Quellen, abgerufen am 04.11.2026')
sources=[
('G1','Gmail Push / Cloud Pub/Sub / Watch-Erneuerung','https://developers.google.com/workspace/gmail/api/guides/push'),
('G2','Gmail vollständiger und inkrementeller Abgleich','https://developers.google.com/workspace/gmail/api/guides/sync'),
('G3','Gmail-Berechtigungen und eingeschränkte Zugriffsumfänge','https://developers.google.com/workspace/gmail/api/auth/scopes'),
('G4','Google-Anbieterprüfung und Ausnahmen nach Appmodell','https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification'),
('M1','Microsoft Graph: Outlook-Änderungsbenachrichtigungen','https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview'),
('M2','Microsoft Graph: inkrementelle Nachrichtenänderungen','https://learn.microsoft.com/en-us/graph/delta-query-messages'),
('M3','Microsoft Graph: Lifecycle und verpasste Benachrichtigungen','https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events')]
for key,title,url in sources:
    p(f'<b>[{key}] {escape(title)}</b><br/><link href="{url}" color="#177B78">{url}</link>','SmallN')

page('Bildbeleg A: Kampagnen und Leistungs-Tags')
shot('01-kampagnen.png','Edge, 04.11.2026: fünf Marketingreiter; Meta als betreute Leistung, Google als Vorbereitung. Leistungs-Tags erklären den Umfang.',550)
p('Übernehmen: verständliche Karten und kurze Stichwörter. Besser machen: echte Betriebszustände, Originalvorgänge und erkennbare Voraussetzungen ergänzen. Eine angefragte Dienstleistung darf nicht wie eine bereits aktive Softwareintegration aussehen.')

page('Bildbeleg B: Flows und ihr Editor')
shot('02-flows.png','Organisations-/Projektbezug und sechs verständliche Startvorlagen. Vorhandener Beispiel-Flow ausgeschaltet.',278)
shot('03-flow-editor.png','Grafischer Maklerablauf mit Verzweigungen, Formularanforderung, Exposé, Aufgaben und Terminvorschlag.',342)

page('Bildbeleg C: Mailings')
shot('06-mailings.png','Empfängergruppen, Zahl/Ausschlüsse, Text, eigener Test, Versandplanung und Abmeldehinweis. Kein Mailing versendet.',565)
p('Unser Newsletter hat bereits Revisionen, Freigaben und geplante Versandclaims. Der wesentliche Ausbau liegt in einer verständlichen gemeinsamen Oberfläche, einer gespeicherten Mailingvorlagenbibliothek und weitergehenden Zielgruppenregeln.')

page('Bildbeleg D: Outlook und Gmail')
shot('11-outlook-verbindung.png','Outlook-Dialog: Anbieterwahl und ausdrücklicher Hinweis, dass die Microsoft-Anmeldung folgt.',280)
shot('12-google-verbindung.png','Gmail-Dialog: App-Passwort-Hinweis; gleiche IMAP-/SMTP-Grundmaske. Keine Anmeldedaten eingegeben.',280)
p('Verbesserung für Novalure: native Anbieteranmeldung, verlässlicher automatischer Abgleich und nachvollziehbare Zuordnung; der aktuelle manuelle Import ist dafür die Grundlage.')

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#CDDBDF'))
    canvas.line(48,42,547,42)
    canvas.setFont('Inter',8)
    canvas.setFillColor(MUTED)
    canvas.drawString(48,28,'NOVALURE | Livelisted Marketing-Nachtrag | 04.11.2026')
    canvas.drawRightString(547,28,str(doc.page))
    canvas.restoreState()

doc=SimpleDocTemplate(str(OUT),pagesize=(595.28,841.89),rightMargin=48,leftMargin=48,topMargin=46,bottomMargin=56,title='Livelisted: Marketing und Lead-Mailimport - Empfehlung für Novalure',author='Novalure CRM Analyse')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
MD.write_text('\n'.join(md),encoding='utf-8')
print(OUT)
