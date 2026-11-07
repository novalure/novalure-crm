# Paket 3 – eigener nativer Personal-Caller und geprüfter CRM-Vorgänger

Stand: 27.10.2026. Ausgang ist unverändert CRM PR115,
`c64d26dfc8f7257cd831ff25c97f940ec2bd1e02`, einschließlich Paket 1 und 2.
Diese Ergänzung ist ein vorbereiteter Anschluss; eine produktive Teams-Abnahme
oder ein vollständiger Paket-3-Abschluss wird damit nicht behauptet.

## Enger Personal-Caller

Die bestehende persönliche Evelyn läuft im nativen Vercel-Ziel
`franz-personal` mit Systemumgebung `preview`. Der vorhandene CRM-Production-
Verifier akzeptiert ausschließlich Production. Sein bestehender Principal bleibt
`synthetic=true`; weder Subject noch Umgebung, Rollen oder Datenrechte dieses
Principals werden geändert.

`personal-auth.ts` verifiziert deshalb einen getrennten echten RS256-Caller
über den festen Vercel-JWKS-Endpunkt. Zulässig sind ausschließlich:

- Issuer `https://oidc.vercel.com/novalure`;
- Audience `urn:novalure:crm:shared-runtime:franz-personal`;
- Subject `owner:novalure:project:evelyn:environment:franz-personal`;
- Team `team_sjD78IkSicXJK6TAOR1JC7Wv`;
- geschütztes Evelyn-Projekt `prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I`;
- native Environment-ID `env_sue274zKgFxQJiKfw64x7BmEfEwE`;
- passende feste Projekt-/Ownernamen, gültige Pflichtzeiten und UUIDv4-`jti`.

Der ungeprüfte Audiencewert wählt lediglich den festen Verifier. Er gewährt keine
Berechtigung. Das öffentliche Webhook-Projekt, Production-Subjects, fremde
Custom-Environments, Cookies, Origin und frei gewählte Scopes bleiben abgewiesen.
Es gibt keine One-time-JWT- oder neue Replayledger-Zusage. Private Signale besitzen
weiterhin ihre bereits vorhandene Actor-/Event-Idempotenz.

Der CRM-Server muss selbst in Production laufen. Zusätzlich zu
`EVELYN_SHARED_RUNTIME_ENABLED=1` ist
`EVELYN_SHARED_PERSONAL_RUNTIME_ENABLED=1` erforderlich. Beide Anschlüsse bleiben
ohne bewusste Aktivierung geschlossen. Keine Identität, Capability, Quelle,
Freigabe, gemeinsame Veröffentlichung oder Zeitplanung wird automatisch erzeugt.

Eine neue FORCE-RLS-Tabelle `behavior_personal_workload_bindings` speichert genau
einen eigenen, zeitlich begrenzten und widerrufbaren Workloadzugang. Sein privater
Broker-Actor muss im festen internen Workspace aktiv sein. Der alte synthetische
Production-Actor darf nicht wiederverwendet werden. Ein eigener NOLOGIN-Resolver
liefert nur die passende Bindung und hält ihre Sperre bis zum Abschluss.

Der bestehende Capability-Vertrag aus PR115 ordnet anschließend den separaten
Executive-Actor, Bot und dessen ausdrückliche `internal`-Bereichsgrants zu. Auch
eine Finance-Capability derselben Brokerfamilie wird am Personal-Caller abgewiesen.
Der Context-/Signalvertrag, Knowledge-RLS, Projekt-/Quellenfreigaben und private
Signalidentität bleiben erhalten. Kein allgemeiner Broker oder Dispatcher wird
hinzugefügt.

## Tatsächlicher Ausgangspunkt

Der frische, ausschließlich lesende Production-Readback ergab:

- Neon `misty-cloud-70835427`, Branch `br-snowy-fog-aldx77v8`,
  Datenbank `neondb`, PostgreSQL 17.11;
- Ledger mit 68 Einträgen bis `114_customer_workspace_provisioning`;
- überprüfte unveränderte Checksums für 091, 092, 093, 101,
  108 Knowledge-Quota und 114;
- noch keine Shared-Behavior-Tabellen, Resolver oder Publisherrollen;
- vorhandener Production-OIDC-Principal aktiv, weiterhin synthetisch;
- CRM-Deployment `dpl_9GuPwTVKb3kPsJgG6tQAH1RkX3Ra`,
  SHA `761e7edf3b070b044fea507871ac9ae4c61c7eb2`.

PR113–115 sind weiterhin gestapelte Draft-PRs. Keine dieser Implementierungen
wurde durch ihren bloßen CI-Erfolg produktiv migriert oder angeschlossen.
Die 13 Rollen-IDs belegen keine laufenden Abteilungen. Die vorhandenen Bot-
Datensätze waren sechs Mal inaktiv und zwei Mal Draft; der Website-Gateway hatte
drei aktive Konfigurationen und jüngere Sessions. Das ist kein Nachweis einer
gemeinsamen Methodenversion oder einer erfolgreichen KI-Antwort. Webchat und
Agent-Routen enthalten im geprüften Stand noch keine Shared-Behavior-Injektion.
Telefonie bleibt ein vorbereiteter Vertrag ohne Provideraktivierung.

## Lesender Preflight

`node scripts/shared-behavior-preflight.mjs --sql` erzeugt ausschließlich eine
Metadatenabfrage für den exakten Production-Vorgänger. Das Script akzeptiert keine
Datenbank-Credentials. Die Abfrage kann über den vorhandenen sicheren Datenbankweg
ausgeführt und ihr JSON-Ergebnis anschließend mit
`--verify-readback <metadata-json>` fail closed ausgewertet werden.

Die zehn Prüfungen umfassen Zielidentität, echten 114-Ledger und seine bekannten
Checksums, produktiv noch freie registrierte Migrationsnummern, noch nicht installierte Pakete,
FORCE-RLS der Knowledge-/Bot-Tabellen, sichere bestehende Runtime-Rollen sowie die
vorhandenen zusammengesetzten eindeutigen FK-Zielindizes. Membership- und
Workspace-Registrytabellen sind im tatsächlichen Vorgänger keine FORCE-RLS-
Tabellen; sie werden nicht ohne Architekturgrund zu einer neuen Gatebedingung
erklärt.

Ergebnis am 27.10.: `PASS_PRE_MIGRATION_ONLY`, zehn von zehn Prüfungen.
Dieser Nachweis ist ausdrücklich kein Upgrade-, Auth-, Deployment- oder
Aktivierungsnachweis.

## Migrations- und Rücknahmeweg

Regulär vorbereitete Reihenfolge nach tatsächlichem 114:

1. `115_shared_behavior_foundation.sql`;
2. `116_shared_behavior_package2.sql`;
3. `117_shared_behavior_package3.sql`;
4. `118_shared_behavior_personal_runtime.sql`.

Die vier Dateien sind byteidentische Kopien ihrer gestagten Quellen. Die
unveränderten SQL-Checksums stimmen mit der bereits ausgeführten actual114-
QA-Ledgerprobe überein; die Datenbankprüfung wurde für diese Kopien nicht
wiederholt. Ein frischer Remote-/Production-Abgleich bestätigte PR115 unverändert
und Production weiterhin auf 114 ohne Einträge für 115–118. Die lokale
Registrierung ersetzt noch keine Remote-Veröffentlichung oder Revisionsfreigabe.

`config/shared-behavior-migration-contract.json` bindet rohe Source-Hashes,
normierte SQL-Checksums, den tatsächlichen 114-Vorgänger und die vorhandene
QA-Referenz. `node scripts/shared-behavior-migration-contract.mjs --qa-ledger
qa/shared-behavior-package3-personal-2026-10-27/actual-qa-migration-ledger.json`
prüft diese Quellen und den vorhandenen Nachweis ausschließlich lesend. Drift
einer Kopie, gleichzeitige Drift beider Kopien, falscher Vorgänger, doppelte Nummern
und veränderte QA-Checksums werden abgewiesen.

Der reguläre Runner klassifiziert alle vier Schritte als manuelle Cutovers.
Standard-up wählt keinen davon aus. Jeder Schritt benötigt seine einzeln
checksummed Vorgängerversion, ausdrückliches `--only` und
`--allow-manual-cutover`; die bestehenden Commit-/Plan-/Zielgates gelten weiter.
Source-Vertrag und vier neue Runner-/Referenztests sowie die 37 unveränderten
Runner-Governancefälle bestanden zusammen 41/41. Der historische allgemeine
Salesfixture überspringt diese tatsächlich auf 114 angewiesenen Schritte; ihre
ausdrücklichen Runtime-Tests und der echte Schema-Vorgängernachweis bleiben
autoritativ. CI-Pfadtrigger berücksichtigen auch die regulären Migrationen.

Die Änderungen legen Tabellen, NOLOGIN-Rollen, Funktionen und restriktive Policies
an. Paket 3 schränkt Knowledgezugriffe ausschließlich für ausdrücklich gebundene
Runtime-Actors ein. Ein widerrufenes Runtime-Binding bleibt bestehen; Löschen ist
kein zulässiger Widerrufsweg. Der Personalzugang besitzt einen eigenen
Aktivierungs- und Widerrufsweg. Keine bestehende Quelle erhält neue Grants.

Die erste Rücknahme schließt die Personal-/Runtime-Enableflags und widerruft die
Workload-/Runtime-Bindung. Gemeinsames Verhalten kann über den vorhandenen
unveränderlichen Versionszeiger auf eine zuvor veröffentlichte Version oder
Grundversion 0 zurückgenommen werden. Kein Downgrade löscht private Signale,
Historie oder sicherheitsrelevante Actor-Klassifikation. Vor einer echten
Aktivierung braucht es außerdem einen überprüften vorherigen Deploymentstand und
eine tatsächliche Upgrade-/Rollbackprobe des konkreten Vorgängers.

## Prüfung und Grenzen

Der bestehende PR115-Head hatte erfolgreiche Isolation-, Lint-/Typecheck-/Test-/
Build-, Audit- und Secret-Scan-CI. Der manuelle Trusted-Candidate-QA-Lauf war
regulär übersprungen. Diese Ergebnisse werden nicht als unabhängiger Trusted-
App-Review oder produktive Abnahme ausgegeben.

Die neue lokale Prüfung verwendet echte synthetische RS256-Signaturen und echtes
wegwerfbares PostgreSQL. Sie prüft den festen nativen Caller, Pflichtclaims,
fremde Claims/Signaturen, Default-off, falsche Serverumgebung, eigene veröffentlichte
Quellen, abgewiesene Abteilungsbereiche, private Signalpersistenz und Wiederholung,
Grantentzug, Broker-Sperre, Ablauf, Widerruf, atomare neue DDL sowie den
unveränderten alten Production-Principal. Der Test besitzt nur einen injizierbaren
synthetischen Schlüsselresolver; der produktive Aufruf verwendet feste JWKS.

Neue und bestehende Runtime-Prüfungen: 14/14 bestanden. Nach der zusätzlichen
JTI-Härtung: neue Prüfung erneut 6/6, gezieltes ESLint und TypeScript bestanden.
Der bisherige historische <=090-Testbootstrap bleibt als synthetische
Funktionsprüfung gekennzeichnet und ersetzt kein tatsächliches Productionupgrade.

Ein vollständiger reiner Schemaexport wurde ohne Geschäftszeilen erstellt.
Der lokale exakte Import scheiterte am fehlenden pgvector-Binary. Für die
Vorgängerprobe wurde deshalb im bestehenden PG17-QA-Projekt
`weathered-term-98273025`, Branch `br-lucky-heart-alrm9dlw`, ausschließlich eine
eigene leere Datenbank `package3_schema114_20261027` vorbereitet. Kein Projekt,
Branch, Tarif oder Compute wurde neu angelegt. Der unveränderte CRM-Public-
Schemaexport enthält die tatsächliche vector-/pgcrypto-DDL, kein managed
NeonAuth-Restore. Seine SHA256 ist
`d169eee0a695677beab47d2887a6ead03ff6bafad1e38d4f70c80a85d4786acd`.

Der erste unveränderte atomare Import scheiterte an einer Providerberechtigung:
`ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin` darf der QA-Owner nicht ausführen.
Vor jedem Folgeschritt wurden leerer bekannter Public-Stand, beendete Restore-
Session und keine unbekannte Transaktion geprüft. Fehler- und Timeoutbelege
bleiben neben den späteren Ergebnissen erhalten.

Die anschließend freigegebene Probe restauriert das tatsächliche operator-eigene
CRM-Public-Schema einschließlich aller vorhandenen Objekt-ACLs, Owners, RLS-
Policies, vector/pgcrypto und neondb_owner-Default-ACLs. Aus dem unveränderten
Custom-Archiv wurden über das TOC ausschließlich zwei cloud_admin-Default-ACLs
für künftig durch cloud_admin erstellte Tabellen und Sequenzen separat gehalten.
Sie gewähren neon_superuser Rechte mit Grant Option. Diese Defaults verändern
keine bestehenden Objekt-ACLs und wirken nicht auf die durch neondb_owner bzw.
Resolver erstellten Paketobjekte. Der erhaltene Snapshot wurde danach erneut mit
Production abgeglichen und blieb identisch. Alle anderen TOC-Zeilen blieben
byteinhaltlich erhalten; es wurden null Table-Data-Items exportiert.

Custom-Archiv-SHA256:
`d375879d19ccb08237dada45bc6b1a84770c13ab00a4599eaac2c7dc8e8d8656`.
Dieser Umfang ist ein **app-spezifischer Public-Schema-/Migrationsnachweis** und
kein vollständiger Provider- oder managed-NeonAuth-Restore-Nachweis.

Auf diesem tatsächlichen PG17.11-/vector0.8.0-Vorgänger bestanden atomarer
Rollback aller vier neuen Paket-DDLs und anschließende Anwendung mit gebundenen
Checksums ausschließlich in der eigenen QA-Datenbank. Vor dem synthetischen Test
waren die Geschäfts- und Wissensdaten leer; nur Schema-Ledgermetadaten wurden
übernommen. Keine Workload-, Runtime- oder Release-Head-Zeile wurde durch eine
Migration erzeugt. Vorhandene globale QA-Rollenattribute und bestehende
Memberships blieben exakt erhalten. Neu entstanden ausschließlich die drei
vorgesehenen nichtprivilegierten NOLOGIN-Rollen customer_provisioner, publisher
und resolver sowie deren notwendige neue Membership-Kanten.

Danach bestanden fünf Prüfungen über getrennte echte Owner-/novalure_app-
Verbindungen auf diesem Schema: synthetische reale RS256-Signaturen, eigenes
freigegebenes Wissen, Scope-/Abteilungsabwehr, private Signalpersistenz und
Wiederholung sowie Grantentzug, Broker-Sperre, Ablauf und Widerruf. Es wurde kein
historischer Bootstrap erneut ausgeführt. Diese Signaturen sind keine realen
Vercel-Provider- oder Teams-Nachweise. Alle acht Behavior-Tabellen besitzen
FORCE RLS. Ein privates synthetisches Signal blieb erhalten; die zwei synthetischen
Runtime-Bindings und der Workloadzugang wurden danach deaktiviert. Der
Release-Head blieb leer. Die eigene QA-Datenbank bleibt zur Überprüfung und
koordinierten späteren Bereinigung erhalten.

Rohschema, private Prozessdiagnostik und Credentials gelangen nicht in das Git-
Repository oder gemeinsame Methoden. Der CLI-Credentialweg blieb ausschließlich
im Hostprozess und in kurzlebiger Kindprozessumgebung; modellseitig wurden nur
Hashes und Metadaten ausgegeben.

## Noch erforderliche echte Abnahme

Vor einer Fertigmeldung fehlen Remote-Veröffentlichung und genaue Releasegates,
eigene ausdrücklich gewährte CEO-Quelle,
Workload-/Runtime-Bindung und Capability, bewusst veröffentlichte gemeinsame
Methodenversion sowie der echte Teams-Ablauf mit Quellen und privatem Signal.
Version 0 ist nur das feste Grundverhalten und kein Nachweis freigegebener
gelernter Methoden. Die vorhandenen Aufgaben-, Kalender- und Reviewerläufe sowie
sämtliche Zeitpläne müssen erhalten bleiben.

Danach sind die tatsächlich laufenden Department-/Webchat-/Agent-Runtimes über
denselben geschlossenen Vertrag anzuschließen und einzeln live zu belegen.
Verwaltungsoberfläche, regelmäßige Lernläufe, Aufbewahrung/Löschung und operative
Übersicht bleiben Paket 4.
