# CRM-Veröffentlichung vom 4. November 2026

Diese Veröffentlichung baut auf dem tatsächlich produktiven Commit `d0e75b78486c85be36dca9a398018aabdd75a0cd` auf. Sie ergänzt die lokal abgenommenen Livelisted-/Marketingfunktionen und erhält die bereits veröffentlichten Buchungs-, Wissens-, Wiederherstellungs- und KI-Abrechnungsbereiche.

## Ziel und Umfang

- Vercel-Team/Projekt: `novalure/novalure-crm`, Projekt `prj_R32Okl6AHijTohvuKmryuTLjWMsk`.
- Produktivdomain: `https://www.novalure-crm.app`.
- Geprüfte Datenbankidentität: Neon-Projekt `misty-cloud-70835427`, Branch `br-spring-night-alyu48yp`, Datenbank `neondb`.
- Vorherige aktuelle Anwendung: `dpl_B111efvBoizAQyhuXdrvFnyEd22Q`.
- Sicherung vor Schemaänderungen: `snap-curly-leaf-ald7jcwt`.
- Isolierte Schemaabnahme: `br-lucky-base-alouhuts`; keine ausgehenden Anbieteraufträge im Probelauf.

Marketing umfasst den zentralen Einstieg, Originaltags/Zielgruppen, versionierte DE-/EN-/ES-Vorlagen, Kampagnenquellen/Reports, Flowstarter und gemeinsame Kontaktzeiten, persönlichen inkrementellen Maileingang sowie Exposémedien, Layouts und PDF. Der Funnel-Designer hat eine größere Scrollfläche und eine bildschirmfüllende Vorschau mit Gerätewahl und Rückkehr/Escape. Der zuvor tatsächlich geprüfte öffentliche Eingang speichert Originalkontakt, Lead und Folgeaufgabe atomar.

Alle252 produktiven Änderungspfade, die vom ursprünglichen Marketingzweig nicht bearbeitet wurden, sind erhalten. Die KI-Abrechnung samt146/152/153 und die bestehende Nachrichten-/Buchungsautorisierung bleiben bestehen. Die neue Veröffentlichung verwendet dieselbe Webpack-Buildart wie die lokale Abnahme.

## Datenbank und Altbestand

Der frühere lokale Bereich120–145/147–151 wurde vor der ersten Produktivanwendung auf154–184 verschoben, weil120 im Live-Ledger bereits durch eine andere Funktion belegt ist. Bestehende produktive Versionsnamen und Checksums werden nicht überschrieben. Vollständige Zuordnung und Migrationsregeln stehen in `marketing-release-migrations-2026-11-04.md` und der zugehörigen JSON-Datei.

Es gab zum ersten Bestandsabgleich keine gespeicherten Funnelantworten und einen älteren aktiven Seed-Funnel ohne geprüfte neue Veröffentlichung. Dieser bleibt mit Inhalt, Trackingwerten und Versionshistorie erhalten und erhält einen nachvollziehbaren Entwurfs-/Prüfstatus. Alte Tokens werden nicht automatisch zu neuen Freigaben; erneutes Veröffentlichen erfolgt im aktuellen Designer. Der Cutover stoppt atomar, falls zwischenzeitlich unklassifizierte alte Antworten vorliegen.

## Prüfstand vor Veröffentlichung

Der integrierte Build89610 ist erfolgreich: Next16.4.5, globale TypeScriptprüfung,184 Seiten. Produktionsabhängigkeiten:0 bekannte Auditbefunde. Die neuen Migrations-/Funktionstests werden in den extern gespeicherten Freigabelogs ergänzt. Migrationen laufen ausschließlich über den offiziellen Runner mit sauberem Commit, geprüftem Ziel und jeweils frischem, an Commit/Ledger/Plan gebundenem Plan-Token.

Die Domain wird erst nach erfolgreichem gehostetem Produktionsbuild, geprüftem Datenbankstand und geschützten Endpunktkontrollen auf die neue Fassung umgeschaltet. Das endgültige Deployment, der tatsächlich angewendete Plan und die Nachkontrolle werden außerhalb des unveränderlichen Freigabecommits protokolliert.

## Betriebsgrenzen

Persönliche Google-/Outlook-Konten müssen jeweils ausdrücklich verbunden und für den Worker freigeschaltet werden. Neue Sync-/Kontakt-/Retentioneinstellungen sind standardmäßig ausgeschaltet; die Veröffentlichung allein sendet keine Mail und aktiviert keine Flowversion. Direkte Anzeigenadapter, Portaltransport und optionale Bauträgerbuchhaltung sind getrennte Umfänge.

Der universelle Buchungsdienst unterstützt derzeit DE/EN. Spanische Besucher seiner älteren Ersatzansicht bekommen eine ausdrücklich benannte Sprachauswahl; keine stille Umschaltung. Bereits vorhandene spanische Immobilienansichten und die mehrsprachigen Exposé-/Marketinginhalte bleiben verfügbar.
