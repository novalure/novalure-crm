# Marketingrelease: Migrationen und sichere Anwendung

Stand: 4. November 2026. Dieser Nachweis gilt ausschließlich für den Release-Checkout `marketing-release-source-20261104`. Historische Screenshots, PDF-Berichte und damalige QA-Ergebnisse werden nicht umgeschrieben.

## Warum die Nummern angepasst werden

Die tatsächliche Produktion besitzt bereits `120_shared_behavior_package4` sowie146/152/153. Die bisher lokal geprüften Livelisted-Dateien120–145 und147–151 waren dort noch nicht angewendet. Eine zweite, fachlich andere Migration120 würde der offizielle Runner ausdrücklich ablehnen. Deshalb erhält der neue zusammenhängende Block die freien Nummern154–184. Die vier bereits produktiven SQL-Dateien bleiben bytegleich. Das JSON daneben enthält Original-/Release-Dateinamen, Originalhash, Releasehash und normalisierten Ledgerchecksum.

Bis auf181 sind die31 SQL-Inhalte unverändert; neue Namen bedeuten keine zweite Ausführung derselben bereits produktiven Migration. Die lokale Funktionsfamilie136 heißt im Release beispielsweise170, die persönliche Automatik149 heißt182. Historische Modulbezeichnungen sind anhand dieser Tabelle zu lesen.

| Ursprünglicher lokaler Name | Kanonischer Release-Name |
| --- | --- |
| 120_automation_graph.sql | 154_automation_graph.sql |
| 121_web_expose.sql | 155_web_expose.sql |
| 122_property_portal_exports.sql | 156_property_portal_exports.sql |
| 123_newsletter_workspace.sql | 157_newsletter_workspace.sql |
| 124_web_expose_retention.sql | 158_web_expose_retention.sql |
| 125_lead_qualification.sql | 159_lead_qualification.sql |
| 126_project_sales_report_settings.sql | 160_project_sales_report_settings.sql |
| 127_crm_notification_preferences.sql | 161_crm_notification_preferences.sql |
| 128_lead_customer_requests.sql | 162_lead_customer_requests.sql |
| 129_web_expose_resources.sql | 163_web_expose_resources.sql |
| 130_crm_onboarding_examples.sql | 164_crm_onboarding_examples.sql |
| 131_automation_mail.sql | 165_automation_mail.sql |
| 132_web_expose_live_inventory.sql | 166_web_expose_live_inventory.sql |
| 133_crm_partner_cooperation.sql | 167_crm_partner_cooperation.sql |
| 134_crm_integrations.sql | 168_crm_integrations.sql |
| 135_property_meeting_context.sql | 169_property_meeting_context.sql |
| 136_crm_personal_mailbox.sql | 170_crm_personal_mailbox.sql |
| 137_property_inquiry_assignments.sql | 171_property_inquiry_assignments.sql |
| 138_property_portal_release_checks.sql | 172_property_portal_release_checks.sql |
| 139_property_creation_drafts.sql | 173_property_creation_drafts.sql |
| 140_lead_qualification_plan.sql | 174_lead_qualification_plan.sql |
| 141_web_expose_templates.sql | 175_web_expose_templates.sql |
| 142_newsletter_schedules.sql | 176_newsletter_schedules.sql |
| 143_crm_notification_email.sql | 177_crm_notification_email.sql |
| 144_personal_mailbox_triage.sql | 178_personal_mailbox_triage.sql |
| 145_lead_proof_retention.sql | 179_lead_proof_retention.sql |
| 147_marketing_data.sql | 180_marketing_data.sql |
| 148_funnel_live_templates.sql | 181_funnel_live_templates.sql |
| 149_personal_mailbox_sync.sql | 182_personal_mailbox_sync.sql |
| 150_marketing_contact_policy.sql | 183_marketing_contact_policy.sql |
| 151_web_expose_brand_layout.sql | 184_web_expose_brand_layout.sql |

## Zusätzliche Cutoverhärtung in181

Vor neu erzwungener RLS prüft181 vorhandene Funnelantworten auf bereits ausdrücklich geprüfte Klassifikation, Zweck und Originalbindung an Workspace/Projekt/Funnel. Unklassifizierter oder nicht eindeutig zugeordneter Altbestand stoppt die gesamte181-Transaktion, statt anschließend im CRM unsichtbar zu werden. Es gibt keinen automatischen Produktions-Backfill und keine gelockerte RLS. Der zuletzt vom Hauptagenten lesend geprüfte Produktionsbestand hatte null Funnelantworten; der Guard schützt auch einen zwischenzeitlich veränderten Bestand.

Alte aktive/eingebaute Funnels ohne gültig geformte neue `livePublication` werden ausdrücklich zum Entwurf mit `tracking.publicationReview`. Bestehende Trackingwerte einschließlich alter Tokens und unveränderte Versionshistorie bleiben erhalten; nur der aktuelle bearbeitbare Status wird angeglichen. Es entsteht ein technischer Auditbeleg mit `actor_user_id=NULL`, Migrationsname und ursprünglichem Status. Der Auditbeleg enthält keine Linktokens und behauptet keine Benutzerfreigabe. Vorherige Links werden nicht ungeprüft als neue Publikation aktiviert. Eine bereits geformte neue Veröffentlichung bleibt unverändert.

Diese Zustandsänderung wird im Release offengelegt. Eine erneute Veröffentlichung erfolgt über den aktuellen Prüf-/Publishweg. Die dafür kurzzeitig benötigten eigentümergebundenen Migrationspolicies werden innerhalb derselben Transaktion wieder entfernt; RLS bleibt eingeschaltet. Der Hauptagent hat einen aktiven älteren Seed-Funnel ohne neue Publikation festgestellt. Dieser benötigt nach dem Cutover eine einmalige bewusste Prüfung; es wurden keine tatsächlichen Funnelantworten festgestellt.

## Abhängigkeiten und Standardzustände

- 154 ist die Automationgrundlage;155 die Exposégrundlage.157 wird vor180 benötigt.163/175 werden vor184 benötigt.170 wird vor182 benötigt;178 ergänzt die Triage.165 muss vor183 installiert sein, damit der eng begrenzte vor Anbieteraufruf liegende `deferred`-Zustand derselben Versandtabelle unterstützt wird. Die vollständige aufsteigende Kette erfüllt diese Abhängigkeiten.
- 146/152/153 bleiben der bestehende, bereits produktive KI-Abrechnungsbestand.153 hält dessen direkte Runtime-ACLs eng; keine erneute Ausführung und keine Änderung an diesen historischen Checksums.
- Neue Mail-Synceinstellungen sind standardmäßig aus; außerdem braucht182 die geschlossene Hostliste `NOVALURE_MAILBOX_SYNC_SCOPES` und persönliche Aktivierung. Keine echte Anbieterabfrage entsteht allein durch Migration oder Deployment.
- Flowversionen werden nicht durch Migration aktiviert. Newsletterzeitpläne, persönliche Hinweismails und Nachweisaufbewahrung benötigen weiterhin ausdrücklich gespeicherte persönliche bzw. fachliche Freigaben und passende Hostumfänge. Die gemeinsame Kontaktregel183 ist zunächst aus. Firmenassets184 sind zunächst nicht freigegeben.
- Die Migrationen passen zum transaktionalen offiziellen Runner: keine Concurrent-Indexes und keine eigenständigen äußeren Commits. Einige neue Indizes und bestehende Tabellenänderungen benötigen kurzzeitig Schreib-/Schemalocks. Der Runner begrenzt Lockwartezeit auf fünf Sekunden und rollt die jeweilige fehlgeschlagene Datei vollständig zurück.

## Exakter offizieller Ablauf

Dies sind Befehlsvorlagen, keine Behauptung einer erfolgten Produktionsänderung. Der Hauptagent stellt die tatsächlichen Zugangsdaten ausschließlich im Prozessspeicher bereit; `.env.local` wird dafür nicht geändert. `MIGRATION_TARGET=prod`, `MIGRATION_DATABASE_URL` und sämtliche tatsächlichen Produktions-Projekt-/Branch-/Datenbank-/Rollen- und Hostdeklarationen müssen vorher korrekt im Prozess stehen. Der Runner verlangt die direkte Neonverbindung und mindestens PostgreSQL17. Keine gepoolte Runtimeverbindung als Migrationszugang verwenden.

Voraussetzung für `dry-run`/`up`: ein geprüfter, vollständig sauberer Releasecommit. Alle SQL-Dateien müssen getrackt sein und exakt HEAD entsprechen. Der Runner verifiziert zusätzlich Zielserver/Fingerprints, Ledger und alle bekannten historischen Checksums. Kein Umgehen dieser Prüfungen.

```text
node --use-system-ca scripts/db-migrate.mjs status
node --use-system-ca scripts/db-migrate.mjs dry-run --plan-token-file=<absoluter-neuer-Dateipfad-ausserhalb-des-Repositories>
node --use-system-ca scripts/db-migrate.mjs up --plan-token-file=<derselbe-Dateipfad>
```

Vor `up` muss der ausgegebene Plan genau die31 neuen Versionen154–184 in aufsteigender Reihenfolge enthalten. Zusätzliche oder fehlende Vorgänger, unbekannte Zielidentität, ein historischer Checksumkonflikt oder ein anderer bestehender Datenbankstand erfordern erneute Prüfung. Ein bewusst einzeln angewendeter Schritt verwendet `--only=154_automation_graph` beziehungsweise den jeweiligen vollständigen Versionsnamen bei **beiden** Plan- und Upbefehlen. Jeder weitere veränderte Ledgerstand benötigt einen passenden neuen Dry-run-Plan.

Der Plan-Token ist an Commit, Ziel, gesamten damaligen Ledger und geordnete SQL-Checksums gebunden. Die Datei muss neu sein und außerhalb des Repositories liegen. Nach Commit-/Ledger-/Planänderung passt ein alter Token nicht mehr. Der Runner führt jede Datei samt Ledgerzeile in einer eigenen Transaktion aus und serialisiert Schemaänderungen über seinen globalen Advisorylock. Nach einem späteren Fehler bleiben zuvor erfolgreich protokollierte Dateien erhalten; den nächsten verbleibenden Plan frisch prüfen. Keine Tabellen manuell löschen, historischen Ledgerzeilen umschreiben oder RLS abschalten.

## Reihenfolge von Anwendung und Rückweg

1. Exaktes Produktionsziel, bestehenden Ledger, Rollen/ACLs und akzeptierten Wiederherstellungspunkt feststellen; die neuen Dateinummern dürfen mit keinem vorhandenen Eintrag kollidieren.
2. Den exakten SQL-Plan auf einem isolierten Abbild des tatsächlichen Produktionsschemas prüfen. Lokale synthetische Datenbanktests ersetzen diesen Kompatibilitätsnachweis nicht. Providerzugänge und ausgehende Worker dort ausgeschaltet halten.
3. Im vorgesehenen Wartungsfenster neue Worker zunächst pausiert bzw. ohne freigegebene Umfänge halten; Schema154–184 anwenden und Ledger/Objekte/RLS/ACLs prüfen. Alte aktive Funnelzustände müssen nachvollziehbar in Prüfung gehen.
4. Den geprüften Releasebuild mit derselben Revision bereitstellen, persönliche Anmeldung, Projektgrenzen, Marketing-/Funnel-/Exposé-/PDF-Abläufe und unveränderte bestehende Bereiche prüfen. Erst dann den Release freischalten und ausdrücklich eingerichtete Worker wieder zulassen.
5. Die Datenbankänderungen bleiben bei einem Anwendungsrückweg grundsätzlich additiv stehen. Einen alten Build nur nach bestätigter Kompatibilität mit neuen Datenformaten und öffentlicher Funnel-RLS verwenden. Eine alte ungeprüfte Funnelaktivierung oder ein Dateifallback ist kein geeigneter Rückweg. Bei nachträglich erstellten Layout-/Kontakt-/Versanddaten bevorzugt vorwärts korrigieren und betroffene Funktion bis zur Prüfung halten.

Ein Wiederherstellen der gesamten Datenbank würde zwischenzeitlich neu eingegangene Anfragen betreffen und ist kein automatischer Rollbackschritt. Den vom Hauptagenten gesicherten Wiederherstellungspunkt und die reale Wiederherstellungsentscheidung getrennt dokumentieren.

## Neuer gezielter Nachweis

`scripts/marketing-release-migrations-tests.ts` prüft die vollständige neue Kette154–184 mit bestehendem153-Abrechnungsbestand, unveränderte historische Ledgerzeilen, installierte Kernobjekte und ausgeschaltete neue Standardeinstellungen. Die zweite Prüfung belegt den atomaren Stopp bei unklassifizierter historischer Funnelantwort, deren Erhalt nach ausdrücklicher Prüfung sowie transparente Legacy-Entwurfsumstellung mit tokenfreiem technischen Audit und ohne verbleibende temporäre Policies. Weitere gezielte Funktionssuiten werden vom Hauptagenten im endgültigen Release-Nachweis protokolliert.
