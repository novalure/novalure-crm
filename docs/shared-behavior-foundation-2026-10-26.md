# Gemeinsame Wissens- und Lernplattform – Grundlagenpaket 1

## Verbindlicher Auftrag

Franz hat am 26.10.2026 die Entwicklung autorisiert. Evelyn als CEO, alle 13
Abteilungen, Kunden-Webchatbots, KI-Agenten und später Telefonassistenten sollen
gemeinsam bessere Methoden und Gesprächsführung nutzen. Vertrauliches Wissen
bleibt je Mandant und innerhalb des Unternehmens gemäß den jeweiligen Rechten
getrennt. Gemeinsames Lernen darf keine zusätzlichen Wissens- oder Aktionsrechte
verleihen. Es handelt sich zunächst um versioniertes Verhalten, nicht um das
Training gemeinsamer Modellgewichte mit Kundengesprächen.

## Vorgefundene Grundlage und Abgrenzung

- Basis ist CRM `761e7edf3b070b044fea507871ac9ae4c61c7eb2`, der am Remote von
  PR111 bestätigte Head. Main `93f4428` ist nicht diese weiterentwickelte Basis.
- Bestehende Knowledge-Center-Quellen, freigegebene Versionen, Projektgrants,
  Assistenten-/Kanalzuordnungen und Live-Immobilienfakten bleiben autoritativ.
- Evelyn PR259, persönliche Teams-Runtime, EV2-Reviewer, Kalender, Buchung,
  bestehende Zeitpläne, Providerberechtigungen und Produktionsdaten werden
  durch dieses Paket nicht verändert.
- Eigener Branch `codex/shared-behavior-foundation-20261026`; sein automatisches
  Vercel-Deployment ist explizit ausgeschaltet. Nur dieser zusätzliche Eintrag
  wird in der Hostingkonfiguration ergänzt; bestehende Einträge bleiben erhalten.

## Implementierter Kern

`src/lib/shared-behavior/catalog.ts` definiert drei unveränderliche Grundregeln
(Vertraulichkeit, belegte Aussagen, bestehende Handlungsrechte) und sechs feste
Methoden: Zielklärung, Korrekturverständnis, Themenwechsel, Sprachwahl,
Menschenübergabe und nächster Schritt. CEO, Abteilung, Webchat, Agent und Telefonie
sind unterstützte Zielklassen; die Klasse `department` umfasst alle Abteilungen.
Das ist noch kein Nachweis eines Anschlusses an eine dieser Runtimes.

Das gemeinsame Format erlaubt ausschließlich bekannte Regel-IDs, Zielklassen und
eine Versionsnummer. Es akzeptiert keine frei formulierten Lerntexte, Namen,
Dokumente, Gesprächsverläufe, Zusammenfassungen, Kundenkennungen oder Quellen.
Zusätzliche Felder werden abgewiesen. Die eigentlichen Formulierungen stehen im
Codekatalog; neue Formulierungen erfordern eine überprüfte Codeänderung.

Die serverseitige Repository-Schnittstelle verwendet die vorhandene erneute
Mitgliedschaftsprüfung und Tenant-Transaktion. Private Signale bestehen aus einer
Ereignis-ID, einer festen Fehlerkategorie und pass/fail. Workspace und Actor werden
aus der serverseitig überprüften Mitgliedschaft bestimmt. Der gleiche Actor kann
das Ereignis identisch wiederholen, aber nicht mit geändertem Inhalt überschreiben.
Fremde Mandanten und andere Actors desselben Mandanten sehen diese Signale nicht.
Dies ist Actor-Isolation für Lernsignale; es ersetzt keine Department-ACL für
Dokumente oder gemeinsame Serviceidentitäten.

Mindestens drei Fehlersignale derselben Kategorie innerhalb von 30 Tagen schlagen
eine feste Methoden-ID vor. Der ausgehende Vorschlag enthält weder Zähler noch
Ereignis-, Actor- oder Mandantenkennungen. Das ist eine Heuristik für Kandidaten,
kein Wirksamkeitsnachweis. Sie veröffentlicht oder verändert kein Live-Verhalten.
Die 30 Tage sind ein Abfragefenster, keine implementierte Löschfrist.

Die vorbereitete Datenbankschicht speichert private Signale und gemeinsame
Methodenauswahlen in getrennten Tabellen. FORCE RLS sowie eingeschränkte ACLs
verbieten dem Tenant-Runtime-Konto gemeinsame Veröffentlichungen und Änderungen
an bestehenden Signalen. Nur die veröffentlichte Version ist lesbar. Versionen
sind unveränderlich; ein Rollback bewegt den Versionszeiger. Es gibt bewusst
noch keine veröffentlichende Identität oder automatische Freigabefunktion.

## Tests und tatsächliche Grenzen

Lokaler Katalogtest: 7/7 bestanden; TypeScript und gezieltes ESLint bestanden.
Lokale Toolchain: Node24.22.1/npm11.9.0; Repository verlangt Node24.14.0.
Die vorhandenen, wiederverwendeten lokalen Dependencies stammen aus der
separaten Audit-Arbeitskopie; dies ersetzt keine frische Lockfile-Installation.

Die ausführbare PostgreSQL-Prüfung verwendet den vorhandenen historischen
<=090-Testaufbau, dann die unveränderte neue Staging-Migration. Sie prüft
Persistenz, Wiederholungen, zwei Mandanten, zwei Actors im selben Mandanten,
RLS-Negativfälle, fehlende Veröffentlichungsrechte, feste gemeinsame Ausgaben,
Mitgliedschaftsentzug und Rollback. Der historische Aufbau lässt wie bisher
optionales pgvector und manuelle Cutovers aus; er ist kein Produktionsupgrade.

In dieser lokalen Ausführungsumgebung ist ein Wechsel zu einem unprivilegierten
Betriebssystembenutzer nicht möglich. Deshalb kann das echte PostgreSQL hier
nicht gestartet werden. Der tatsächliche Testaufruf endet beim Start mit
`initdb: error: cannot be run as root`; die Datenbankfälle wurden nicht ausgeführt.
Ein Datenbank-PASS wird lokal nicht behauptet. Der neue
isolierte GitHub-Workflow führt dieselbe Prüfung mit frischer Lockfile-Installation
unter dem regulären unprivilegierten Linux-Runner aus. Dessen Ergebnis ist separat
zu lesen, nicht aus dem Vorhandensein des Workflows abzuleiten.

Der erste Upload wurde von der automatischen Freigabeprüfung wegen fehlender
ausdrücklicher Exportfreigabe abgelehnt. Franz erteilte danach am 26.10.2026 alle
Freigaben für das konkret benannte Paket, den Upload nach `novalure/novalure-crm`
und den Draft-PR mit Datenbankprüfung. Diese Freigabe gilt für die Fortsetzung;
der tatsächliche Veröffentlichungs- und CI-Stand wird getrennt nachgewiesen.

Maschinenlesbarer lokaler Prüfstand:
`qa/shared-behavior-foundation-2026-10-26/verification.json`.

## Nächste Entwicklungspakete

1. **Prüfen und veröffentlichen:** persistente Kandidaten, synthetische
   Gesprächsszenarien, Vergleich zur aktiven Version, Datenschutz-/Rechteprüfung,
   nachvollziehbare Auswertung, dedizierte enge Publisher-Identität, atomare
   Veröffentlichung und Rücknahme. Zunächst nur feste Regeln automatisch auswählen;
   neue freie Regeln bleiben überprüfte Katalogänderungen.
2. **Assistenten anschließen:** serverseitig bestimmte Identitäten für CEO und
   Departments sowie Webchat/Agenten anbinden; Toolrechte und private
   Wissensabfragen getrennt halten. Department-/Projekt-/Assistentenrechte auch bei
   gemeinsamen Serviceidentitäten nachweisen. Telefonie erhält später denselben
   Vertrag, ohne einen Telefonprovider zu aktivieren.
3. **Verwaltung und Betrieb:** zentrale Übersicht, private lokale Nachweise,
   Rollen, Historie, begrenzte Automatik, Aufbewahrung/Löschung und überwachte
   Rücknahme. Die bestehende Kunden-Wissensverwaltung wird weiterverwendet.

Vor einer Aktivierung: aktuellen Produktivstand erneut abgleichen, normale
Migrationsnummer reservieren, Staging-Migration gegen diesen echten Vorgänger
prüfen, Datenbank- und Betriebsnachweise erbringen. Kein öffentliches Endpoint,
kein Cron und kein Modellaufruf wird durch dieses Grundlagenpaket installiert.
