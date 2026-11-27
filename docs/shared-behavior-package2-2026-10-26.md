# Paket 2 – begrenzter Lern- und Veröffentlichungszyklus

Auftrag: Franz hat am 26.10.2026 Paket 2 einschließlich der erforderlichen
Entwicklung und Veröffentlichung ausdrücklich freigegeben. Basis ist Paket 1,
PR113, Head9435b682569fc4708dc72c8805b0c81335fd6156. Eigener Branch;
keine Änderung an CEO PR259, EV2 oder deren Produktionsressourcen.

## Implementierung

Vorschlag -> dauerhafter Kandidat -> deterministische Prüfung -> Veröffentlichung.
`runBehaviorLearningCycle` führt genau einen begrenzten Zyklus aus. Es gibt keinen
Cron, keine Modellaufrufe und keinen Anschluss an laufende Assistenten.
Privat erkannte feste Methoden-IDs können als Auswahl übergeben werden; Gesprächs-
oder Dokumenteninhalte, Quellen, Mandanten-/Personenkennungen und freie
Zusatzfelder werden von diesem gemeinsamen Vertrag nicht angenommen.

Kandidaten speichern nur neue interne IDs, feste Methoden und Zielklassen sowie
die erwartete Revision der bisherigen Version. Bewertungen speichern ausschließlich
Hashes und begrenzte numerische Ergebnisse. Die Historie erfasst feste Aktionen,
Versions-/Revisionsnummern und interne Kandidatenreferenzen. Keine Kundendaten
werden global zusammengeführt.

Die Testmatrix umfasst sechs Methodenszenarien für fünf Zielklassen, also30
Abdeckungsprüfungen. Verglichen wird, ob die feste Methode für das jeweilige
Szenario vor bzw. nach der Änderung vorhanden ist. Jede Regression, einschließlich
verlorener Zielklassen, sowie Änderungen ohne zusätzliche Abdeckung werden
abgelehnt. Unveränderliche Sicherheitsgrundregeln bleiben Bestandteil des Compilers.
Suite und Katalogwortlaut gehen in den Evaluatorhash ein. Veröffentlichung prüft
Kandidatenstand, aktuelle Headrevision und gespeicherten Prüfnachweis erneut.

**Grenze:** Das ist eine deterministische Prüfung der Regelabdeckung. Sie ist
kein empirischer Nachweis besserer frei formulierter KI-Gespräche, kein Test von
Modellantworten, keine neue Modellgewichtung und keine Datenschutzgarantie für
noch nicht angeschlossene Laufzeiten. Dafür sind spätere echte Runtime-Evaluationen
mit getrennten synthetischen Dialogen erforderlich.

Ein dedizierter NOLOGIN-Publisher erhält ausschließlich Zugriff auf die
Verhaltenstabellen. Keine produktive Loginidentität, kein Credential und keine
Tenant-/Departmentberechtigung wird eingerichtet. Die Anwendung verlangt einen
expliziten separaten Pool und prüft dessen nichtprivilegierte Rolle; weder
Administrator noch Tenant-Runtime werden als Publisher akzeptiert. Zugriff auf
private Lernsignale und Mitgliedschaften ist ausgeschlossen. FORCE RLS gilt auch
für Kandidaten, Prüfnachweise und Historie. Runtime-Anbindungen bleiben Paket3.

Eine globale Transaktionssperre serialisiert Headänderungen. Revisionsvergleich
verhindert verlorene Updates und ABA-Wiederholungen nach Rücknahme. Kandidaten,
Prüfnachweise, Versionen und Ereignisse sind unveränderlich; Veröffentlichung und
Ereignis entstehen in derselben Transaktion. Rücknahme darf nur auf zuvor
veröffentlichte Versionen oder auf Grundverhalten (Version0) zeigen. Die Revision
steigt auch beim Abschalten; historische Versionen bleiben erhalten.

## Prüfung und Rollout

Ausführbarer Test: `scripts/shared-behavior-lifecycle-tests.ts`, einschließlich
rollengetrennter echter PostgreSQL-Verbindungen, automatischem Zyklus,
Vorschlägen ohne Prüfung, Regression/No-op, konkurrierenden Veröffentlichungen,
stalen/gefälschten Nachweisen, Rücknahme bis Version0 und Unveränderlichkeit.
Zusätzlich laufen die unveränderten Paket1-Prüfungen. Lokales PostgreSQL bleibt
wegen des Root-/Benutzerwechsellimits der Umgebung blockiert; die echte Datenbank-
prüfung erfolgt in isolierter CI mit synthetischen Daten. Der historische <=090-
Fixtureaufbau ersetzt keine Produktionsupgradeprüfung.

Beide Migrationen bleiben unter migrations/staged. Paket2 folgt auf Paket1;
vor Produktionsrollout müssen aktuelle Vorgänger und Migrationsnummern geprüft
werden. Der Branch hat automatisches Vercel-Deployment ausgeschaltet. Kein
Production-Publisher wird aktiviert. Aktuelle CI-Ergebnisse stehen im Draft-PR;
Vorhandensein von Tests oder Workflow ist kein Bestehensnachweis.
