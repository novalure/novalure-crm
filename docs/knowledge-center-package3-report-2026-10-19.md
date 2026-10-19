# Evelyn Knowledge Center — Paket 3

Stand: 19.10.2026. Implementiert und mit synthetischen Daten auf Entwicklungsebene abgenommen. Keine produktive Aktivierung.

## A. Implementierung und verifizierte Grundlage

Repository: `novalure/novalure-crm`. PR #88 wurde auf `aa6b329942ab19c165bc610822f03ed5874af189` verifiziert; sein direkter Vorgänger ist `b908c0e445739e9665e4fb0912c101f1a575fa79`. Die fünf Paket-2.1-Commits und die unveränderten Migrationen `migrations/101_knowledge_center.sql`, `102_knowledge_document_processing.sql` und `103_knowledge_assistant_service.sql` sind enthalten. Der letzte Paket-2.1-Commit ergänzt Nachweise und den Browserharness.

Die ursprüngliche GitHub-CI war fehlgeschlagen: Verkaufstests luden `server-only` ohne `react-server`-Bedingung. Der Testaufruf wurde korrigiert. Eine anschließend sichtbare historische Maschinenidentitäts-Fixture wird jetzt korrekt vor Migration 092 auf Stand 090 begrenzt; deren feste RLS-Inventarprüfung wurde nicht verändert.

Die vorhandenen Quellen, Versionen, Chunks, Bereiche, Berechtigungen, privaten Dokumente, Assistentenzuordnungen und Entitlements werden weiterverwendet. Es gibt keine zweite Knowledge-Engine oder branchenspezifische Wissensablage. Globale Layouts und fremde Branches wurden nicht verändert.

## B. Versionierung, Freigabe und Wiederherstellung

Der neue Ablauf lautet: Entwurf → eingereicht → geprüft → freigegeben → veröffentlicht. Rollen, Mandant, Projekt, konkrete Version und aktuelle Quellrevision werden serverseitig und durch Datenbankregeln geprüft. Veröffentlichung, Suchabschnitte, aktive Versionszuordnung, Audit und internes Ereignis werden atomar gespeichert. Bei Entwurfsänderungen bleibt die vorherige Veröffentlichung aktiv.

Historie, Autoren, Freigabeidentitäten, Zeitpunkte, Gründe und Herkunft bleiben nachvollziehbar. Frühere Inhalte werden nach ausdrücklicher Aktualitäts- und Rechtsprüfung als neue Entwurfsversion kopiert; auch die unveränderlichen Dokument-Verarbeitungsnachweise bleiben erhalten. Ältere, nicht aktive Versionen werden im Verlauf als archiviert gekennzeichnet. Quellenarchivierung entzieht die gesamte Quelle; sie erzeugt keine neue Freigabe.

Veröffentlichungen können auch bei gleichzeitig vorhandenem Entwurf zurückgezogen werden. Der bestehende administrative Veröffentlichungsvertrag bleibt kompatibel; eingereichte, noch nicht freigegebene Versionen können ihn nicht als Abkürzung verwenden.

## C. Websiteüberwachung und Scheduler

Manuelle, tägliche, wöchentliche und monatliche Prüfungen sind implementiert. Regelmäßige Intervalle benötigen das Monitoring-Merkmal und eine ausdrückliche Intervallfreigabe im vertrauenswürdigen Vertrag; der neue Standard ist ausschließlich manuell.

Gespeichert werden nächste Fälligkeit, letzte Prüfung, letzter Erfolg, Fehler, Verbrauch und Laufhistorie. Persistente Leases verhindern parallele Abrufe. Ein Lauf reserviert sein Kontingent einmal und besitzt höchstens drei Versuche. Der vorhandene Scanner behält DNS-/IP-/Redirect-/SSRF-Schutz, Zeit- und Größenlimits. Nach dem Abruf werden Identität, Vertrag, Projekt, Quelle, Konfiguration und Lease erneut geprüft.

Eine Änderung erzeugt einen deduplizierten Vorschlag; unveränderte Inhalte erzeugen keine Version. Vorhandene Entwürfe und Veröffentlichungen werden beim Scan nicht überschrieben. `runKnowledgeMonitoringBatch` führt tatsächlich gespeicherte, mandanten- und benutzergebundene Jobs aus. Der Host muss deren technische Identität vertrauenswürdig wiederherstellen. Es wurde kein produktiver Cron aktiviert.

## D. Evelyn-Automatisierung und Benachrichtigungen

Die bestehende deterministische Analyse erzeugt persistente Hinweise zu fehlenden Pflichtangaben und Prüfmetadaten, veralteten oder abgelaufenen Inhalten, widersprüchlichen Fakten und Websiteänderungen. Unternehmen und Immobilienprojekte verwenden konfigurierbare Regeln. Die Analyse verarbeitet nur Quellen mit passenden Schreibrechten; lesbare fremde Projektbereiche blockieren die übrige Analyse nicht.

Pro Bereich lässt sich eine tägliche automatische Prüfung ausdrücklich aktivieren und wieder abschalten. `runKnowledgeMaintenanceBatch` führt fällige konfigurierte Prüfungen über denselben berechtigten Vertrag aus. Fehlende Merkmale, deaktivierte Module und entzogene Rechte verhindern weitere Verarbeitung.

Stufe 1 dokumentiert interne Hinweise. Inhaltliche Vorschläge benötigen Kundenprüfung, sensible und unbekannte Änderungen Administratorprüfung; jede Veröffentlichung bleibt administrativ. Es gibt keine allgemeine automatische Inhaltsfreigabe. Vorschläge lassen sich vergleichen, bearbeiten, annehmen, ablehnen und zurückstellen. Annahme erzeugt einen Entwurf; jede referenzierte Version wird erneut geprüft. Interne Ereignisse und vorhandene Audit-Protokolle versorgen die Portalbenachrichtigungen. E-Mail-, Teams-, Modell- und andere externe Aufrufe wurden nicht aktiviert.

## E. KI-Assistenten

Die echten bestehenden Webchat- und anbieterneutralen Voice-Ports wurden mit der neu veröffentlichten Version abgefragt. Getrennte Kanalzuordnungen, Vertragsmerkmale und sofortiger Quellen-/Kanalwiderruf wurden geprüft. Frühere Versionen bleiben historisch vorhanden, werden nach Widerruf aber nicht mehr ausgeliefert. Preise und Immobilienverfügbarkeit bleiben dem autorisierten Live-CRM vorbehalten. Kein Studio-Produktivchat und keine Vapi-/Telefonieverbindung wurde umgestellt.

## F. Kundenportal

Nutzbar sind Inhaltsprüfung, getrennte Freigabe und Veröffentlichung, Versionsvergleich und Wiederherstellung, Vorschlagsvergleich und Entscheidungen, interne Benachrichtigungen, Prüfregeln, Automatisierungsschalter sowie Scanplanung mit Verlauf und Verbrauch. Betroffene Assistenten und unabhängige Webchat-/Voice-Zuordnungen sind sichtbar. Dateiimporte aus Paket 2.1 bleiben nutzbar. Texte liegen auf Deutsch, Englisch und Spanisch vor; Desktop und 390-Pixel-Mobilansicht wurden geprüft.

## G. Datenbank

Vorbereitet wurden ausschließlich additive Migrationen:

- `104_knowledge_publication_workflow.sql`: unveränderliche Herkunft/Gründe, Freigabeverläufe, Vorschläge, interne Ereignisse und Prüfkonfigurationen.
- `105_knowledge_website_monitoring.sql`: ausdrückliche Vertragsintervalle, Überwachungskonfiguration und Scanläufe mit Reservierung und Datenbankregeln.

Alle neuen Tabellen besitzen RLS und FORCE RLS. Die tatsächliche Kette `091–096 → 100 → 101–105`, Checksum-Ledger und transaktionaler Rücklauf wurden lokal geprüft. Der portable historische Harness ersetzt weiterhin die optionale Vector-Spalte/-Indexierung und lässt die separate manuelle Migration 062 aus. Das ist kein Neon-Produktionsklon. Keine entfernte Datenbank wurde migriert.

## H. Sicherheit und unabhängiger Review

Geprüft wurden zwei Mandanten, Projekt-Lese-/Schreibgrenzen, aktuelle Mitgliedschaften, unberechtigte Freigaben, direkte SQL-Manipulationen, alle Vorschlagsreferenzen, unveränderliche Ereignisse, Parsernachweise, Audit-Rollbacks, Scan-Identitätsfälschung, parallele Läufe, Mengenlimits, Konfigurations-/Modul-/Rollenwiderruf während Abrufen und sofortiger Entzug für beide Assistentenkanäle. Normale Runtime und separater Migrationseigentümer liefen ohne Superuser/BYPASSRLS.

Ein unabhängiger lokaler KI-Agent hat den tatsächlichen Diff und die Korrekturen bis exakt `ef86c66ae274a62081aa1e836abfec23b47b02d4` geprüft: keine offenen Befunde. Der Schreibbereichsfehler wurde gegen den ursprünglichen Commit isoliert reproduziert und korrigiert. Der Review ist keine GitHub-App-Attestation oder produktive Betriebsfreigabe.

## I. Tatsächlich ausgeführte Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Paket 3 | 43 Backend- und 3 UI-Prüfungen bestanden; darin alle 18 geforderten Abnahmeszenarien |
| Bestehendes Knowledge Center | 121 Backend- und 11 UI-Prüfungen bestanden |
| CRM-Unit-Tests | 240 bestanden |
| Verkaufsprozesse | 93 bestanden |
| Abschließende CRM-Vertragstests | 55 bestanden |
| Sicherheits-/Scope-Integration | 17 bestanden |
| Browser | 13 Abläufe bestanden, keine Browserfehler; regulärer Passwort-/TOTP-Login |
| TypeScript, vollständiges ESLint, Produktionsbuild | bestanden |
| Produktionsabhängigkeiten | 0 bekannte Schwachstellen |

Die Zahlen verschiedener Befehle überschneiden sich und werden nicht zu einer eindeutigen Gesamtzahl addiert. Der Browser prüfte optimierte Build-Artefakte über den vorhandenen ausschließlich lokalen Entwicklungs-Datenbanktransport. Eine gehostete oder produktive Abnahme wird damit nicht behauptet. Befehle, tatsächliche Ausgaben, Grenzen, Checksummen und Screenshots: [Prüfbeleg](../qa/knowledge-center-package3-2026-10-19/verification.json), [Browser](../qa/knowledge-center-package3-2026-10-19/browser-result.json), [Desktop](../qa/knowledge-center-package3-2026-10-19/desktop.png), [Mobil](../qa/knowledge-center-package3-2026-10-19/mobile.png).

## J. Branch und Deployment

- Branch: `codex/knowledge-center-package3-20261019`.
- Implementierungs-/Reviewrevision: `ef86c66ae274a62081aa1e836abfec23b47b02d4`.
- Draft-PR: [#89](https://github.com/novalure/novalure-crm/pull/89), auf dem Paket-2.1-Branch gestapelt.
- Gehostete Preview-URL: nicht erstellt; isolierte entfernte Testbindungen fehlen.
- Deployment-ID: nicht vorhanden.

Automatische Vercel-Deployments dieses Branches sind deaktiviert. GitHub-CI ist gesondert am aktuellen PR-Head abzulesen; lokale Ergebnisse sind kein entfernter CI-Nachweis. Nach der Implementierungsrevision folgen ausschließlich Bericht und Prüfnachweise.

## K. Konkrete Schritte für Paket 4

1. Paket 2, PR #88 und PR #89 in kontrollierter Reihenfolge mit Design C und den parallel entwickelten Modulen integrieren; finale Revision und CI erneut prüfen.
2. Migrationen 101–105, private Speicherung und echte Runtime-Rollen auf einer isolierten geschützten Preview abnehmen; getrennte Testmandanten und normale Benutzer verwenden.
3. Gespeicherte technische Scheduler-Identitäten und deren vertrauenswürdige Wiederherstellung bereitstellen; erst im gesonderten Integrationsprozess den Zeitgeber aktivieren.
4. Den Studio-Client und später den Voice-Provider über freigegebene Integrationen, gespeicherte Assistenten und Kanalbindungen anschließen. Live-CRM-Fakten unabhängig abnehmen.
5. Vertrags-/Stripe-Provisionierung, bei Bedarf OCR sowie externe Benachrichtigungsadapter gesondert integrieren; vorhandene Kontroll- und Kostenverträge beibehalten.
6. Erst nach den jeweiligen Releaseprüfungen produktive Migration, Assistenten und Jobs aktivieren. Dieses Paket führt keine dieser Aktivierungen aus.
