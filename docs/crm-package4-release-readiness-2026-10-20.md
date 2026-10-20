# Evelyn CRM — Paket 4: Gesamtintegration und Releasebereitschaft

Stand: 20.10.2026. **Gesamtstatus BLOCKIERT; keine Produktivfreigabe und keine Freigabeanfrage.**
Die begrenzten Previewprüfungen sowie der vollständige QA-Datenbank-/Privatdateienrestore sind **PASS**.
Der offene Credential-Ausgabevorfall verhindert die Gesamtfreigabe.
Implementierung: `c291e21288903e2807b108bba852a597f77b777a`, [Draft-PR #92](https://github.com/novalure/novalure-crm/pull/92).
Recovery-Tooling: `5f7bed6578d8c29631745f6627bbec1bf605f3c8`; ausschließlich Typfix und gezielter echter PG-Test.
[Source-Bindung](../qa/package4-integration-2026-10-20/source-binding.json),
[Verifikation](../qa/package4-integration-2026-10-20/verification.json) und
[Infrastruktur](../qa/package4-integration-2026-10-20/infrastructure.json) trennen aktuelle und historische Belege.

## A. Git und Integration

Branch: `codex/evelyn-crm-package4-integration`. PR #91 (`ee26bbd…`) und PR #89 (`b019a16…`)
sind über ihre gemeinsame Basis `aa6b329…` integriert; Merge `d3c1cbe…` hat beide als Eltern.
Paket 1/2/2.1, Design C, Paket 3 und die vier Operational-Reader einschließlich Migration 106 bleiben enthalten.
`main` und der separate MFA-Update-Branch wurden nicht übernommen oder verändert.
[Git-Eingänge](../qa/package4-integration-2026-10-20/git-inputs.json) und Source-Bindung enthalten die exakten Revisionen.

## B. Design C

Navigation, Karten, Farben, Tokens und vorhandene Knowledge-Komponenten bilden eine gemeinsame Oberfläche.
Lokale gemeinsame Browserabnahme: **50/50 Design C, 13/13 Knowledge und 13/13 Paket 4**.
Die echte geschützte Preview bestand später **18/18** auf `196f0da…`, einschließlich Desktop/Mobil.
Für `c291e21…` werden nur unveränderte Runtime-/UI-Komponenten daraus wiederverwendet;
der gesondert geprüfte Auth-Delta erhielt zusätzlich **5/5** tatsächliche Kompatibilitätsprüfungen.
Das ist keine erneute Ausführung aller 18 Szenarien auf dem neueren Deployment.

## C. CRM und normale Benutzer

Login mit echtem Passwort und zuvor eingerichteter TOTP/MFA, Mandanten-/Projektgrenzen,
Kunden, Studio, Immobilien, Assistenten, Freigaben und Kalender-Leseadapter sind lokal/CI geprüft.
Die gehostete Basis belegt reale synthetische Mandantendaten und reguläre Sitzungen;
der neue Kompatibilitätssmoke bestätigt Login/MFA, datenbankgestützten CRM-Core und verborgene Systemdiagnostik.
Zusätzlich bestätigt er private veröffentlichte PDF-v1-Bytes, getrennten v2-Entwurf und beide Benutzerkanäle.
[Kompatibilitätsbeleg](../qa/package4-hosted-2026-10-20/auth-compatibility-c291e21.json): keine Sitzungsinjektion,
Uploads, Veröffentlichungen oder Konfigurationsänderungen; zwei normale Query-Usage-/Auditvorgänge.

## D. Knowledge Center und technische Anschlüsse

Bereiche, Firmen-/Projekt-/Websitewissen, private Dokumente, Entwurf, Prüfung, Freigabe,
Veröffentlichung, Historie, Wiederherstellungsentwurf und Monitoring verwenden dieselbe Engine.
Die 18er-Abnahme umfasst echte PDF/DOCX/UTF-8-Uploads, Roundtrips nahe 10 MiB, Deduplizierung,
unveränderliche private Historie, echten externen HTTPS-Scan und manuellen gehosteten Batch.
Websiteänderungen bleiben Vorschläge; erst Annahme und Veröffentlichung ändern beide Kanäle.
Bilder und PDFs ohne ausreichende Textebene bleiben ehrlich `needs_ocr`; es gibt keine OCR.
Der separate opt-in [QA-Workloadvertrag](knowledge-machine-qa-profile.md) wurde mit echtem Evelyn-Preview-OIDC
und gespeicherter nativer Customer-QA-Identität geprüft: **40 Requests, fünf Phasen, alle erwarteten Ergebnisse PASS**.
Fünf veröffentlichte v1-Retrievals und 35 Anwendungsablehnungen belegen fehlenden/falschen Bearer,
unabhängigen Voice-Widerruf, Wiederfreigabe, Principal-Deaktivierung und endgültigen Widerruf.
20 unterschiedliche Custom-JTI-Hashes, richtige Quellen-/Versionsbindung und Ausschluss des v2-Entwurfs sind belegt.
[Machine-Abnahme](../qa/package4-hosted-2026-10-20/machine-qa-acceptance-c291e21.json).
Der unveränderte Production-only-Verifier erhielt dadurch keinen positiven Productionnachweis.
OIDC signiert Projekt/Owner/Umgebung/Subject/Audience; Caller-Deployment und Quellbytes sind separat nativ/artifaktgebunden.
Webchat/Voice verlangen getrennte gespeicherte Grants, aktuelle Mitgliedschaft, Projekt-/Bot-/Bereichsrechte,
veröffentlichtes Wissen, Modul, Vertragsmerkmale und Kontingent. Runtime provisioniert keine Principals oder Bindings.
Externer Studio-Webchat folgt dem [Servicevertrag](knowledge-assistant-service.md): aktive Integration/Origin/Session,
`configuration.knowledgeAssistantId`, Feature- und Bereichsgrants; keine freie Mandanten-/Botwahl durch Clientparameter.
Produktive Studio-Umstellung, Vapi/Telefonie, Stripe und neue Provideraktivierungen wurden nicht durchgeführt.
Der echte manuelle Batch installiert keinen Timer; ein wiederkehrender Scheduler benötigt separat gespeicherte Actor-Scopes.

## E. Datenbank und Recovery

Lokale kombinierte Migrationen und Rollback: **20/20 PASS**; [Originalbelege](../qa/package4-integration-2026-10-20/migrations.json).
Die eigene leere Free-QA-Neon-Umgebung ist tatsächlich provisioniert: 60 Ledgerzeilen, 13 Quellchecksummen und 94 FORCE-RLS-Tabellen.
Die QA-Augmentierung bewahrt alle 233 bestehenden Publicfunktionen einschließlich Owner/effectiver ACLs.
Drei bestehende Checkprädikate bleiben wortgleich; jedes lässt zusätzlich nur dasselbe eng fixierte QA-Tuple zu.
Ein separater QA-Reader wurde außerhalb kanonischer Migrationen ergänzt.
Der dedizierte Agent hat nur `crm.projects.read`, gespeicherte Bot-/Kanalbindungen und eine Stunde Principal-TTL.
[Native QA-Zusammenfassung](../qa/package4-hosted-2026-10-20/machine-qa-native-c291e21.json).

Originaler Neon-COW-Vergleich: **FAIL**, ausschließlich neun zusätzliche Provider-Defaultgrants; Daten-/Ledgerhashes gleich.
Zwei SQL-TEMPLATE-Versuche bleiben **FAIL 55006** wegen Provider-Worker-Verbindungen; niemand beendete diese.
Separater exakt gepinnter Providerbaseline-DB-only-Drill: **PASS**, 279608 ms, normale Runtimeänderung und exakter Restore.
Er umfasst alle Katalogkategorien, DB-Metadaten, Ledger und Daten; Providerdefaults wurden nicht normalisiert.
[DB-only-Beleg](../qa/package4-hosted-2026-10-20/neon-provider-database-recovery.json).
Vollständiger Post-Hosted-DB-/Privatdateienrestore: **PASS**, Abschluss 09:03:31 UTC, letzte Completion 347199 ms.
Frische Baseline: 20 Katalogklassen/DB-Metadaten, 167 Tabellen/793 Zeilen, 60 Ledgerchecksummen,
17 private Dateien mit 41.950.560 Bytes; Root hat Baseline und Ergebnis unabhängig nachgerechnet.
Strenge Source-/Restored-Gleichheit vor funktionalen Writes, ursprünglicher normaler Working-Taskcommit erhalten;
alle Dateigrößen/SHA256 und anonyme 403 geprüft, Historien-/Versionsbindung und vollständige Inventare bestätigt.
Acht bereits nachgewiesene Zielobjekte blieben erhalten; ausschließlich neun fehlende wurden einmal angelegt, keine Überschreibung/Löschung.
Fünf tatsächliche Appprüfungen liefen mit regulären Cookies und `novalure_app` gegen Restored und den echten privaten Zielstore.
Sie verwendeten den Kandidaten-Code im Prozess; ein zweites gehostetes Restored-Deployment wurde nicht geprüft.
Source-Daten/Dateien blieben unverändert; vier Pools geschlossen, alle drei Endpoints beim Abschluss disabled/idle.
Der Drill war **kein einzelner unterbrechungsfreier Lauf** und kein nativer pg_dump-/Cross-Project-Restore.
Erhaltene Fehler: erster Capture **FAIL 42883** (`text=uuid`, null Archivbytes/DB-/Storagewrites/Branches),
danach R2-NeonWS-Prozessabbruch **FAIL** (altes RUNNING-Artefakt bleibt kein PASS; genaue Ursache unbewiesen),
erste Same-Branch-Fortsetzung **FAIL** nach 445876 ms: DB bereits gleich, achter 10-MiB-Blob zunächst mit leerem SDK-Body gelesen.
Unabhängige Rekonstruktion bestätigte acht korrekte Objekte und neun fehlende; erst die separate Completion schloss alles ab.
[Full-Recovery](../qa/package4-hosted-2026-10-20/neon-database-and-private-files-recovery.json),
[Lifecycle](../qa/package4-hosted-2026-10-20/neon-full-recovery-lifecycle.json),
[Rootreview](../qa/package4-hosted-2026-10-20/neon-full-recovery-root-review.json),
[WebSocket-FAIL](../qa/package4-hosted-2026-10-20/neon-full-recovery-websocket-failure.json),
[Dateiread-FAIL](../qa/package4-hosted-2026-10-20/neon-full-recovery-file-read-failure.json) und
[8/9-Rekonstruktion](../qa/package4-hosted-2026-10-20/neon-full-recovery-partial-files-reconciliation.json).
QA: PostgreSQL 18.6/vector 0.8.6; Production: 17.11/vector 0.8.0. Statische SQL-Prüfung ersetzt keine Versionsparität.

## F. Sicherheit und offener Vorfall

Mandanten-/Projekt-/Dokumentgrenzen, Rollen, Veröffentlichung, Widerruf, Vertrags-/Quotaentscheidungen,
SSRF, private Storebindung und failclosed Maschine sind quellengebunden geprüft; Runtime ist kein Owner/Superuser/BYPASSRLS.
Gezielte unabhängige Code- und Artefaktreviews meldeten keine offenen Codebefunde; keine Trusted-App-Attestierung.
**Securitygate BLOCKED:** Beim Hosting-Metadatenread erschien versehentlich ein bestehendes projektweites
Automationcredential im Tooloutput. Der wertfreie [Incidentbeleg](../qa/package4-hosted-2026-10-20/credential-output-incident.json)
meldet keine Kopie in Git oder öffentliche Receipts. Ein pauschales „keine Secrets ausgegeben“ wäre falsch.
Eng autorisiert abgeschlossen: genau **ein Ersatz erzeugt und einmal als Future-Build-Default gewählt** (zwei Credentialwrites).
Drei feste Production-GETs ohne App-Bearer/Cookie: erster 302-Klassifizierungsversuch bleibt FAIL; korrigierte SSO-302-Baseline PASS;
neues Credential erreicht exakt JSON-403/no-store der App: PASS für Plattformzugang, kein HTTP-200-Health-/Consumer-Cutovernachweis.
Native unabhängige Prüfung: zwei aktive Keys, Ersatz Default; Productiondeployment, Schutzpolicy und alle 37 Envmetadaten unverändert.
**Nutzerentscheidung: „Alten Schlüssel vorerst aktiv lassen“. Kein Revoke; Vorfall und Securitygate bleiben BLOCKED.**
Die frühere Ein-Key-Baseline ist historisch. Bestehende Deployment-Envkopien werden durch Defaultwahl nicht aktualisiert.
[Rotationsfortschritt](../qa/package4-hosted-2026-10-20/credential-rotation-progress.json),
[Behalteentscheidung](../qa/package4-hosted-2026-10-20/credential-retention-decision.json) und [unabhängiger Zustand](../qa/package4-hosted-2026-10-20/independent-rotation-native-state.json).
Das [statische Inventar](../qa/package4-hosted-2026-10-20/evelyn-credential-consumer-inventory.json) umfasst 13 Quellvarianten;
tatsächlich konfigurierte/externe Verbraucher bleiben UNKNOWN. Verbraucher/Owner klären, Cutover validieren und erst nach neuer
expliziter Alt-Widerrufsentscheidung weitergehen; keine CRM-Deployment-/DB-/Domain-/MFA-/Cronänderung aus dieser Ausnahme.

## G. Tests und erhaltene Fehler

[CI am exakten c291-Kandidaten](../qa/package4-hosted-2026-10-20/ci-c291e21.json): erforderliche Quality-/Build-/Audit-
und Secretsworkflows **PASS**; manuell auszulösender Job **SKIPPED**; kein AusführungsPASS.
[CI des separaten Tooling-Heads 5f7bed6](../qa/package4-hosted-2026-10-20/ci-5f7bed6.json): erforderliche Workflows **PASS**;
die fünf zusätzlichen Typregressions-PG-Tests sind gezielt lokal belegt und werden nicht als CI-Ausführung ausgegeben.
[Berichtsstand 7dd97c8](../qa/package4-hosted-2026-10-20/ci-7dd97c8.json): automatische Quality/Secrets PASS;
required Vercel MISSING, required manueller QA-Job SKIPPED. Mergechecks damit offen; Gitdeploy deaktiviert.
[Lokale Einzelläufe](../qa/package4-integration-2026-10-20/local-checks.json) behalten ihre damaligen Revisionen und überlappenden Zählungen.
Historische Fehler bleiben erhalten: fehlendes Chrome, erster Design-C-Lauf 48/50, zwei lokale Zusatz-Harnessfehler,
Hosted-Upload-Busy/Transport-FAIL und Hosted-Suche-Escape-FAIL. Korrekturen schwächten keine App-/Tenant-/Quotaassertion ab.
Zwei belegte Source-SHA256-Scanner-Falsepositives erhielten nur exakte historische Ignorefingerprints;
[Beleg](../qa/package4-hosted-2026-10-20/secret-scan-false-positives.json). Der spätere echte Ausgabevorfall bleibt davon unabhängig.
Ein akzeptierter Trust-PATCH lieferte eine partielle Antwort; ursprünglicher FAIL bleibt erhalten,
der Zustand wurde ausschließlich lesend rekonstruiert, nicht durch einen zweiten Apply-PATCH.

## H. Geschützte Preview und Cleanup

CRM: [novalure-5j7pionbs-novalure.vercel.app](https://novalure-5j7pionbs-novalure.vercel.app),
Deployment `dpl_CJuybvc8rn275Ypvwv5bK4bFYvko`, Implementierung `c291e21…`.
[Deployment](../qa/package4-hosted-2026-10-20/deployment-c291e21.json): anonym geschützt, regulärer Login/MFA erforderlich.
Eigene QA-Neon-Branch `br-sweet-surf-ba6iahut`, private QA-Stores und frische Auth-Secrets; keine Productiondatenkopie.
Nach vollständigem Recoveryabschluss wurde ausschließlich Source separat wieder aktiviert: fünf tatsächliche lesende
Appprüfungen mit vorhandenen normalen Cookies, ohne Login/Sitzungserzeugung/Sourcewrites, plus drei HTTP-Schutzprüfungen **PASS**.
[Finale Source-Verfügbarkeit](../qa/package4-hosted-2026-10-20/neon-full-recovery-source-availability.json):
nativer Readback 09:06:04 UTC Source active, Working/Restored weiterhin disabled/idle; kein neues Deployment/Hosted-Gesamtlauf.
Alle 65 geerbten CRM-Previewkeys wurden branchspezifisch überschrieben; Production-/globale Metadaten blieben erhalten.
Der separate Caller lief im bestehenden Evelyn-Previewprojekt; echte Runtime prüfte exakt 15 geerbte Projekt-Appkeys leer.
Providerverwaltete Systemvariablen sind davon getrennt; ihre vollständige Neutralisierung ist nicht belegt.
Die Fixture liest/forwardet das providerverwaltete Automationcredential nicht.
[Caller-Retirement](../qa/package4-hosted-2026-10-20/evelyn-caller-retirement-c291e21.json): einmaliger DELETE, unabhängiger nativer GET 404;
Preview tatsächlich DELETED, Production unverändert. Keine sofortige dauerhafte Bitlöschung behauptet.
[Caller-Artefakt](../qa/package4-hosted-2026-10-20/evelyn-caller-artifact-c291e21.json) und
[Caller-Deployment](../qa/package4-hosted-2026-10-20/evelyn-caller-deployment-c291e21.json) binden Quellstand und Ausgabe.
[Cleanup](../qa/package4-hosted-2026-10-20/machine-qa-cleanup-c291e21.json): nativer Principal und beide Bindings widerrufen,
temporäres Preview-Trustpaar entfernt, zwei neue Branchkeys gelöscht (173→171; 74 Production/65 global unverändert),
frisches deploymentbezogenes Caller-Zugriffscredential widerrufen. Bestehende Deployments werden dadurch nicht neu gebaut;
deren unveränderliche Envwerte ersetzen keinen tatsächlichen Identitäts-/Trustwiderruf.

## I. Release-Gates

| Gate | Status | Geltungsbereich und verbleibende Grenze |
| --- | --- | --- |
| A Integration | PASS | Eltern/Merge und exakte c291-Runtime-/SQL-Bindung |
| B Build/CI | BLOCKED | Automatische c291/5f/7dd Quality/Secrets PASS; required Vercel MISSING, required Manual SKIPPED |
| C Datenbank/Restore | PASS | Strenger Same-Project-COW/17 Dateien/5 Appprüfungen; historische FAILs und Versions-/DR-Grenzen erhalten |
| D Sicherheit | BLOCKED | Ersatz erzeugt/Default/Plattformzugang validiert; offengelegter Alt-Key bleibt auf Nutzerwunsch aktiv |
| E Funktionen | PASS | Gehostete Basis 18/18, begrenzte Wiederverwendung + Compat5 + reale QA-Machine40/5 |
| F Preview | PASS | Begrenzte 18er-Wiederverwendung + Compat5 + Machine40/5; finale Source5/HTTP3 und nativer aktiver Source-Readback |
| G Produktion | BLOCKED | Keine Freigabe; Plan DRAFT_NOT_APPROVABLE_OLD_EXPOSED_CREDENTIAL_RETAINED |

## J. Reviewbarer Produktions- und Betriebsplan

[Releaseplan](../qa/package4-hosted-2026-10-20/production-release-plan.json) und
[Runnerplan](../qa/package4-hosted-2026-10-20/production-runner-plan.json) bleiben **DRAFT**, keine Ausführung/Freigabeanfrage.
Aktuelles Productiondeployment `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk`/`ea668e6…`, Neon `misty-cloud-70835427`/`br-snowy-fog-aldx77v8`;
54 Ledgerzeilen, ausschließlich die sechs Originalmigrationen 101→102→103→104→105→106 fehlen.
Privater Productionstore ist providerseitig zugeordnet; konsumierter Token/Runtime-Store muss am eigenen Productionartefakt geprüft werden.
Erst nach konkreter Freigabe und Credentialremediation: neuer konsistenter DB-/Dateienrestorepunkt → sechs Migrationen →
separater Productionbuild mit Productionbindungen und `--prod --skip-domain` → eigene Artefaktdiagnose → exakter Promote → Smoke/Beobachtung.
Bereits `--prod --skip-domain` kann Schedulerwirkungen haben; es garantiert nur fehlendes automatisches Domain-Aliasing.
Vier bestehende Cronjobs bleiben mit unveränderten Pfaden/Schedules im späteren Freigabeumfang aktiv:
`google-alerts` (`9,24,39,54 * * * *`), `meeting-reminders` (`2 * * * *`),
`property-reservations` (`7 * * * *`), `teams-alerts` (`4,19,34,49 * * * *`), jeweils unter `/api/cron/`.
Kein Knowledge-Timer, neuer Job, manueller Cron-/Providerpositivaufruf oder QA-Preview-Promote nach Production.

Rollback A: fehlgeschlagene Migration samt Ledger in ihrer Transaktion zurückrollen; frühere Datei-Commits bleiben bestehen.
Rollback B: eigenes schema-kompatibles Appdeployment zurücksetzen, mögliche Cronrücknahme mitprüfen; Daten bleiben separat.
Recovery C: committete DB-/Dateiänderungen nur aus dem neu genehmigten konsistenten Restorepunkt mit exakten Pfaden/Hashes wiederherstellen.
Vorschlag: Novalure-Projektowner entscheidet Freigabe/Incident, Codex führt im freigegebenen Fenster aus;
Vertreter, Meldeweg sowie konkrete Fehler-/Latenzgrenzen vor Production festlegen.
Baseline und Beobachtung bei 0/5/15/30 Minuten: 5xx/Latenz, Login/MFA, Rollen/RLS, private Downloads/Uploads,
Reservierungs-/Extraktionsfehler, Veröffentlichungs-/Queryaudit und Scanleases; keine privaten Quelltexte in Monitoring exportieren.
Bei Fremdzugriff, Fingerprint-/Ledger-/Dateihashabweichung oder Credentialoutput sofort stoppen und passenden A/B/C-Pfad wählen.

## K. Nächste Phase: Universal Booking Engine

Tenant-/Projekt-/Rollenverträge, OAuth-Verbindungen, CRM-Termine und getrennte Provideradapter sind vorhanden.
`CalendarConnections` liefert sichere Verbindungsmetadaten, keine buchbare Verfügbarkeit und keine Ereignisschreiboperation.
Es fehlen gemeinsame autorisierte Free/Busy-/Ressourcenadapter, Zeitzonen-/Dauer-/Pufferregeln,
idempotente Holds mit Konkurrenz/Expiry, atomare Bestätigung, Provider-Reconciliation sowie Storno-/Umbuchungs-/Auditverträge.
Paket 4 implementiert diese Engine nicht und aktiviert keine produktive Telefonie oder Buchungsprovider.
