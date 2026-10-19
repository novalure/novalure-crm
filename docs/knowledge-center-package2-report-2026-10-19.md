# Abschlussbericht — Evelyn Knowledge Center, Paket 2/4

Stand: 19.10.2026. Entwicklungsumfang; keine Produktivaktivierung. Der konkrete Implementierungscommit und die finalen Prüfbelege stehen im begleitenden `qa/knowledge-center-2026-10-19/verification.json`.

## A. Implementierung

Entwickelt wurden eine universelle Knowledge-Engine auf den vorhandenen CRM-Quellen/Chunks, Firmen-/Geschäftsbereichs-/Projektbereiche, unveränderliche Versionen, ausdrückliche Assistenten-/Kanalzuordnungen, private Dokumente, modul- und mengenbezogene Zugriffsprüfungen sowie ein heller, responsiver CRM-Bereich. Unternehmen, Benutzer, Mitgliedschaften, Projekte, Bots und Medien verwenden die vorhandenen IDs und Modelle.

Die bisherigen Knowledge-, Chat- und Agentenpfade verwenden das neue berechtigte Retrieval. Ungeprüfte Legacy-Freigabefelder, Demoquellen und erfundene Chunk-/Abdeckungswerte werden dafür nicht übernommen. Gesprächsverläufe sind ebenfalls an den gespeicherten Bot, sein tatsächliches Projekt und den konkreten Kanal gebunden. Frühere Assistentenantworten bleiben im Archiv, werden aber nicht als aktuelle Wissensgrundlage an ein Modell weitergereicht.

## B. Funktionsstatus

Im entwickelten Code lokal geprüft nutzbar:

- Bereiche anlegen, benennen, beschreiben und archivieren; Projekt-/Mandantenzuordnung bleibt unveränderlich.
- Texte, FAQs, strukturierte Fakten, Websitequellen und private Dokumente erstellen; Quellen bearbeiten und archivieren.
- Sieben leere Fachvorlagen für Unternehmen, Kontakt, Öffnungszeiten, Leistungen/Terminregeln, Bauträgerprojekte, Einheiten und Maklerangebote. Kunden bearbeiten beschriftete Felder; bestehende unbekannte/nestierte Werte bleiben erhalten.
- Dokumente bis 10 MB hochladen, versioniert zuordnen und über einen berechtigten Quellenzugriff abrufen. PDF, Bilder, DOCX und geeignete UTF-8-Textformate werden als private Dateien unterstützt. PDF-/DOCX-Textextraktion und OCR sind nicht implementiert; ein Upload behauptet keinen erfolgreichen Wissensimport.
- Konkrete Versionen serverseitig durch berechtigte Administratoren freigeben. Mitarbeiteränderungen bleiben neue Entwürfe; Antworten verwenden weiterhin die zuletzt freigegebene Version.
- Ausdrückliche Bereichszuordnung pro Bot und Kanal, berechtigte Volltextsuche und Versionshistorie.
- Manuelle begrenzte Websiteprüfung mit SSRF-/DNS-/Redirect-/Timeout-/Größenschutz; unveränderte Inhalte erzeugen keinen neuen Entwurf. Abrufe reservieren tarifgebundene Scanmenge und prüfen nach dem Abruf Rechte und Revision erneut.

Vorbereitet: vollständiger Veröffentlichungs-/Wiederherstellungsdialog für Paket 3, regelmäßiger Website-Scheduler, persistente Pflegevorschläge und deren Oberfläche. Die deterministische Pflegeanalyse erkennt fehlende/veraltete/widersprüchliche Angaben anhand autorisierter Snapshots und konfigurierter Regeln. Sie erzeugt versionsgebundene Vorschläge mit drei Prüfklassen; Inhaltsveröffentlichung bleibt administrativ. Diese Analyse schreibt nichts und aktiviert keinen Job.

## C. Datenbank und Sicherheit

Vorbereitete Migration: `101_knowledge_center.sql`. Sie erweitert `knowledge_sources` und `knowledge_chunks`; neue Tabellen sind `knowledge_areas`, `knowledge_source_versions`, `knowledge_area_grants`, `knowledge_center_entitlements` und `knowledge_query_usage`.

Die Migration richtet RLS/FORCE RLS für Quellen, Chunks, Bereiche, Versionen, Zuordnungen, Vertragsrechte, Verbrauch und die bestehenden Bot-Gesprächs-/Nachrichten-/Tooltabellen ein. Datenbanktrigger sichern unveränderliche Kontexte, genehmigte Veröffentlichungszeiger, tatsächliche Freigeber und dauerhaft private Knowledge-Medien. Allgemeine Medienlisten, Dateipfade und öffentliche Freigaben können Knowledge-Dateien einschließlich älterer Versionen nicht umgehen. Skalare Verbrauchszähler erfassen den gesamten Mandanten trotz eingeschränkter Projektsicht und zählen auch noch nicht zugeordnete Uploads. Diese Schutzregeln sind lokal geprüft; die produktive Datenbank wurde nicht damit verändert.

Geprüft wurden ein vom Runtime-Benutzer getrennter Migrationseigentümer ohne Superuser/BYPASSRLS, direkte SQL-Angriffsversuche, Manipulation von Tenant-/Projekt-/Bot-/Kanalangaben, entzogene Rollen/Projektfreigaben, unberechtigte Veröffentlichungen, Dateizugriffe, konkurrierende letzte Kontingentplätze und atomare Audit-Rollbacks.

Zusätzlich lief die unveränderte Kette `091–096 → 100 → 101` in einer wegwerfbaren lokalen PostgreSQL-18-Datenbank. Migration 101 samt Ledger-Eintrag wurde zunächst zurückgerollt und danach mit ihrem tatsächlichen Checksum atomar übernommen. Normale Medienlöschung und der Studio-Dateischutz bleiben kompatibel. Diese Prüfung ist kein Neon-Produktionsklon: Die historische optionale Vector-Spalte/der Vector-Index werden im portablen Testharness ersetzt, die manuelle historische Migration 062 bleibt dort ausgenommen; 097–099 werden nicht erfunden. Der Dateilöschungsbeleg dieses Vorgängertests verwendet eine bestätigende Testfunktion statt Blob-Zugriff.

Es wurde keine produktive Migration ausgeführt. Legacy-Quellen erhalten keine stillschweigende neue Bot-Zuordnung oder neue Freigabe.

## D. CRM und Paket 1

Die tatsächliche frühere Produktionsrevision ist `b0e99c4cedc23a24ba3b9d4e67a59423f7b54f92`. Die geprüfte neuere Produktionsbasis mit Paket 1 ist `ea668e625b8c778c2f79dd6a33210e731bb8a662`. Dieser Branch erhält die Studio-Navigation und Migration 100; er führt keinen fremden Branch zusammen und ersetzt weder CRM- noch Immobilienverwaltung. Das universelle Knowledge Center ist auch aus dem Studio-Profil erreichbar.

Zwei bereits in Paket 1 vorhandene veraltete Navigations-Testannahmen wurden anhand eines isolierten Archivs dieser exakten Basis reproduziert und an das bestehende Studio-Profil und dessen benutzergebundenen Präferenzschlüssel angepasst. Die Berechtigungsprüfungen wurden dafür nicht gelockert.

## E. KI-Anbindung

Die vorhandenen CRM-Chat-/Agentenrouten und Bot-Evaluationen verwenden gespeicherte Bot-/Projekt-/Kanalbindungen und freigegebene zugeordnete Versionen. Ein Gespräch von Bot B kann nicht als Verlauf für Bot A wiederverwendet werden. Evaluationen prüfen ausdrücklich den konfigurierten Kanal. Quellenwiderruf und Modulabschaltung werden nicht durch alte Assistentenantworten umgangen.

Der externe Studio-Verkaufswebchat im separaten Website-Repository wurde hier nicht live an diese Engine angeschlossen. Externe Webhooks benötigen eine echte, zugeordnete technische Identität; die bestehende Platzhalteridentität ist kein Ersatz. Der interne Servicevertrag und die CRM-Integration bilden die Grundlage für diese Anbindung.

Ein lesender Adapter für aktuelle kanonische CRM-Immobilienfakten und ein anbieterneutraler Voice-/Vapi-Vertrag sind vorbereitet. Bis Bot und konkrete Einheit über den autorisierten Live-Resolver gebunden sind, übergeben Preis-/Verfügbarkeitsfragen konservativ an einen Menschen; das gilt derzeit auch für allgemeine Preisfragen. Preislisten lassen sich speichern, sind dadurch aber noch keine nutzbare Bot-Preisauskunft. Alte Dokumente werden nicht als Live-Daten behandelt. Keine Rufnummer, kostenpflichtige Vapi-Aktion oder produktive Telefonie wurde aktiviert.

## F. SaaS und Stripe

RBAC, Modulschalter, Vertragsentitlements und Nutzungsmengen sind getrennt. Verträge bleiben standardmäßig deaktiviert; normale Kunden-/Administratorenrouten können sie nicht selbst provisionieren. Quellen-, Bereichs-, Website-, Speicher-, Monatsabfrage- und Scanlimits werden serverseitig geprüft. Die Begriffe zusätzliche Benutzer/Assistenten und Monitoring/erweiterte Pflege sind im Vertragsmodell vorbereitet; deren allgemeine Provisionierung beziehungsweise laufende Dienste sind noch nicht umgesetzt.

Der serverseitige Stripe-Adapter prüft rohe Webhookbytes, HMAC und Zeitfenster, löst den Mandanten über eine vertrauenswürdige Kundenzuordnung auf und verlangt einen atomaren idempotenten, protokollierten Ereignisport. Persistente Stripe-Kunden-/Katalogzuordnung, Ereignisspeicher, Provisionierungswriter, Checkout und realer Provider-Endpunkt fehlen noch. Es wurden keine Preise, Produkte, Zahlungen oder Abonnements angelegt oder verändert.

## G. Prüfungen und Nachweisgrenzen

Bestanden: **85 gezielte Knowledge-/Integrationsprüfungen**, **240 CRM-Unit-Tests**, TypeScript, vollständiges ESLint ohne Warnungen, Next-Produktionsbuild und Produktionsabhängigkeits-Audit mit **0 Schwachstellen**. Der unabhängige Review der Implementierungsrevision meldet keine offenen P0/P1/P2-Befunde im geprüften Diff. Kommandos und Bindungen stehen im maschinenlesbaren Prüfbeleg.

Der Browserablauf bestand auf der exakten Implementierungsrevision mit **7/7 Fällen** und normalem Passwort-/TOTP-Login. Daten und Verträge waren ausschließlich synthetisch in einer wegwerfbaren lokalen Datenbank. Desktop, 390-Pixel-Mobilansicht, Beschriftungen, fehlender horizontaler Überlauf und mindestens 44-Pixel-Bedienflächen wurden geprüft. Unabhängig erneut ausgeführt wurden auf derselben Revision 13 Runtime- und 6 Bot-Komponentenprüfungen, jeweils ohne Fehler oder Auslassung.

Der lokale Linux-Harness benötigte ICU 60 für das vorhandene eingebettete PostgreSQL; die Bibliothek wurde außerhalb des Repositories isoliert bereitgestellt. Beispiel für diese Umgebung: `LD_LIBRARY_PATH=/workspace/scratch/libicu60/usr/lib/x86_64-linux-gnu npm run test:knowledge-center`. Reproduktion des Browserablaufs: lokalen `qa:sales:server` starten, danach `npm run qa:knowledge:browser`; dieser Ablauf akzeptiert nur dessen synthetische Loopback-Datenbank und erzeugt seinen Login regulär.

Der unabhängige Review ist ein tatsächlicher lokaler KI-Agentenreview der genannten Commit-Revision. Er ersetzt keinen noch nicht ausgeführten GitHub-App-Check, keine entfernte CI und keine produktive Endabnahme. Keine ungetestete Aktion wird als PASS dargestellt.

## H. Branch und Deployment

- Branch: `codex/knowledge-center-package2-20261019`.
- Finaler Implementierungscommit: `da0a043e50603603fbc59394884d00af270d474e`.
- Knowledge-Preview-URL / Deployment-ID: nicht vorhanden.
- Produktion: unverändert; keine Schema-/Kundendaten-/Deploymentänderung dieses Pakets.

Automatische Vercel-Deployments dieses Branches sind deaktiviert. Eine gehostete geschützte Preview wurde nicht erstellt, weil in dieser Ausführungsumgebung keine isolierte entfernte Datenbank-/Credentialbindung bereitsteht. Vorhandene Produktionsbindungen werden dafür nicht verwendet. Der lokale Testserver wurde beendet; die beiden mitgelieferten Bildschirmaufnahmen zeigen ausschließlich den synthetischen Test.

Bildnachweise: [Desktop](qa/knowledge-center-2026-10-19/desktop.png) und [Mobil](qa/knowledge-center-2026-10-19/mobile.png).

## I. Konkrete nächste Schritte für Paket 3

1. Auf den vorhandenen Versionen den vollständigen Administratordialog für Prüfung, Kommentare, Wiederherstellung als neuen Entwurf und konkrete Veröffentlichung aufbauen.
2. Gültigkeit/Provenienz und Pflegevorschläge persistent anschließen; Websiteintervalle, Mengen, Fehler-/Entfernungszustände und überlappende Läufe konfigurieren und prüfen. Keine aktive Version automatisch überschreiben.
3. Bei Bedarf PDF-/DOCX-Extraktion und OCR mit Dateiprüfung, Sandboxing, Mandanten-/Projektbindung und eigenen Limits ergänzen.
4. Den externen Studio-/späteren Vapi-Zugriff über verifizierte technische Identitäten und ausdrückliche Bot-/Kanalrechte anbinden; den Live-CRM-Resolver mit realen Testeinheiten abnehmen.
5. Isolierte geschützte Preview bereitstellen, Migration 101 dort mit normalen Testnutzern prüfen und erst anschließend gesondert den produktiven Migrations-/Releaseprozess durchführen. Stripe, Telefonie und vollständige MP1-Kundenfreigabe bleiben eigene nachweispflichtige Integrationen.
