# CRM Sunday integration — lokaler Sammelkandidat

**Aktueller Nachfolger:** Der kohärente Quellfreeze19af886 enthält nun190, die optionalen Serverpreise und die vollständigen Client-/Parentnachfolger; aktuelle gezielte Kandidatenprüfungen und Build sind bestanden. Siehe [COHERENT-CORRECTIONS-INTEGRATION.md](COHERENT-CORRECTIONS-INTEGRATION.md). Die folgenden SRC05-/Fehlstellen- und Testergebnisse beschreiben die ausdrücklich erhaltenen früheren Quellenstände, keine nachträglich umetikettierten Prüfungen.

**Aktuelle Assistantquelle enthalten; nicht veröffentlicht und kein vollständiger Gate-PASS.**

**SRC05 bleibt wegen eines neuen QA-Peerbefunds offen:** Bei Navigation aus dem Immobilienbereich verliert der Unmount den Pending-Ref. Die folgende QA-Korrektur mit bestehendem RAM-Draftstore sowie Unmount-/Remount-/Late-Response-Fällen ist noch nicht enthalten. Die bisherigen9 Browserfälle bestehen, decken diesen Befund jedoch nicht ab. Dies ist kein Teil des alten8/9-Stringtestfehlers.

**Neuer lokaler Property-/Assistantnachfolger:** Backendserie bis `8d94b6b2` zuerst, danach Direkterfassung `6b9b38c5`; zusätzlich neue öffentliche Assistantquelle `bb8bbaa9` regulär integriert und gezielter UI-Nachfolger `2a7ac7f2` ohne doppelte Helferkopie übernommen. Quellenabschluss `5416515a38cb30bc5f8e3389de5cb124fe0e470e`. Die tatsächlichen32/8-Property- und25-Assistantfälle sowie vollständigen Builds behalten ihre exakten Prüfstände; die letzte UI-Fortsetzung hat einen eigenen engen Nachweis. Einzelheiten und offene189/190-/Releaseanschlüsse stehen in [PROPERTY-INTEGRATION.md](PROPERTY-INTEGRATION.md), maschinenlesbare Belege in [property-integration.json](property-integration.json). Die nachfolgenden historischen Ergebnisse bleiben ihrem damaligen Stand zugeordnet.

Arbeitskopie `C:/Projects/novalure-crm-sunday-integration-20261104`, Branch `codex/sunday-crm-integration-20261104`. Ursprüngliche Basis: exakt `fa234f226c41def89f038ee7b1c52e838b90cb4f`. Die inzwischen von Root übergebene führende Assistantrevision `11c4384c0c5a360e448f441c822edc1057d9fe17` ist jetzt regulärer Mergevorfahr. Quellenabschluss vor dieser Dokumentation: `ce88252342042c59481747f6cabe6b04c51b36a3`. Eine neuere Production wird nicht auf den ursprünglichen fa234-Stand zurückgesetzt.

## Zusammenführung und Migrationslinie

- CRM128 `f2cda017` über `b5c9df5`: Kundenportal, kundengemeinsame synthetische Quote, bestätigter Testzahlungsbezug. Trainings-/Synthetic-only-Grenze und Production-Sperren bleiben bestehen.
- CRM131 `99379e44` über `c7eafb7`: erneute signierte Autorisierung derselben angenommenen Studio-Anfrage. PR129/`10bbabfb` bleibt Vorfahr; aktuelle Einladungs-, Änderungs- und Stornierungsfences bleiben erhalten.
- CRM130 `d9f6cd43` über selektive Closure `cd55892`: zwölf Dateien mit identischen Gitblobs sowie aktueller Pakettestbefehl. Kein pauschales Zurückholen alter CI-, Vercel- oder Lockstände. Der dedizierte Workload erzeugt seine Route; kein neuer CRM-Appcron.
- QA `a7be3876` über `ba5144d`: atomare Workspace-Einstellung/Audit/RLS-Projektzählung. QA `1ed6b08d` über `0bd5039`: autorisierter URL-Workspace nach Reload.
- Aktueller Assistant `11c4384c` über `c7c67264`: neue Funktionen, Kunden-/Billingoberfläche, Navigation und **Migration188** erhalten. Nur `crm-workspace.tsx` ist bewusst mit der URL-QA-Korrektur vereinigt; die übrigen Assistant-/Billing-/Navigationsquellen sind bytegleich.

Der reale Schemakonflikt betraf `crm_project_access`: isoliertes121 erweitert Teammitglieder; veröffentlichte167 schließt externe Partner aus.121 erhält den kumulativen Partnerausschluss auch beim späten Upgrade. Die eigene kompatible Folgefunktion liegt jetzt in **191_webchat_partner_access_compatibility.sql** und setzt beide Grenzen nach den realen Vorgängern zusammen. Der ursprüngliche Slot188 und seine Logs bleiben als Herkunft in Git erhalten;188 gehört jetzt dem Assistant. **189/190 sind für die aktive QA-Arbeit reserviert und wurden nicht verwendet oder übernommen.**

Relevante Linie:121 →146/152/153 →167 →185/186/187 →188(Assistant) → gegebenenfalls189/190(QA, hier noch nicht enthalten) →191(Kompatibilität).191 erzeugt keine Konten, Grants, Preise, Quoten oder Aktivierung.

## Tatsächliche lokale Ergebnisse

| Umfang | Ergebnis | Grenze |
|---|---|---|
| Backup-/Warnungs-/Provideradapter |84/84,0Skip| lokale synthetische Ports; kein echter Backup |
| Erste Webchat-/Studio-Session-/Portalabnahme |23/23,0Skip| eigene Loopback-Datenbanken und Modellattrappen |
| Ursprüngliche SQL-Kompatibilität im damaligen Slot188 |5/5,0Skip| tatsächlicher historischer Umfang erhalten |
| Produkt/Partner/Workspace-Folgegruppe |20PASS/1FAIL| generischer Fixturepfad traf den strengen Vorgängerguard; Original erhalten |
| Genau betroffener Workspace-Nachlauf nach Fixturekorrektur |6/6,0Skip| Cookie/CSRF, Auditrollback, Mitgliedschaft und Projektzählung |
| URL-/Scopegruppe |8/9,Exit1| geerbter breiter Stringtest trifft `projects[0]?.workspaceId`, keinen Projekt-ID-Default; nicht abgeschwächt |
| Assistant-/Guard-/191-Kompatibilitätsgruppe |24/24,0Skip| Fakeprovider, private echte lokale SQL-Belege, aktuelles188 vor191 |
| Typecheck und betroffener Lint vor Assistantmerge |Exit0| dokumentierte damalige Inputs |
| Vereinter Assistant-/Workspace-/Fixture-Lint |Exit0| aktueller kombinierter Scope |
| Nextbuild nach beiden QA-Fixes |Exit0,187 statische Seiten| damaliger Appscope vor Assistantmerge |
| Neuester Nextbuild einschließlich Assistant |Exit0, TypeScript und188 statische Seiten| aktueller vereinter Appscope; keine Providercredentials |
| Gitleaks Quellenhistorie bis aktuellem Sourcefreeze |Exit0,0Befunde| keine Behauptung eines Dependency-Audits |

Kein grüner Ganzlauf wird behauptet. Die Originale der fehlgeschlagenen Versuche und des8/9-Scopes bleiben in `artifacts/sunday-crm-integration-20261104/`. Der generische Salesfixture lässt121/191 aus, weil seine öffentlichen Chatvorgänger bewusst fehlen; die dedizierten Produkt-/Kompatibilitätsfälle wenden tatsächliche SQL-Vorgänger an. Native CI, vollständige anwendbare Abschlussregression, exakte unabhängige Prüfung und genuine App sind nicht ausgeführt.

## Erhalt und nächste reale Anschlüsse

Release-Lock, Laufzeitabhängigkeiten, `vercel.json`, Workflows, neue AI-Credit-Billingquellen sowie146/152/153 und185–187 bleiben gegenüber dem Ausgangsrelease erhalten. Abhängigkeiten wurden ausschließlich offline aus vorhandenem Cache installiert, ohne Installationsskripte oder Registryanfrage. Node24.18.0; verwendetes npm11.16.0 unterscheidet sich vom nativen CI-Pin11.9.0. Ein Toolchain-CI-PASS wird nicht abgeleitet. Übernommene historische QA-Logs und drei EOF-Formatbeobachtungen der unveränderten aktuellen Assistantquelle werden nicht heimlich neu geschrieben.

Die isolierte128-Testabrechnung ersetzt die realen AI-Credits nicht. Eine echte kommerzielle Website-Rechnungs-/Checkout-/Providerzuordnung und die fachliche Rechnungsautorität bleiben separat. Kein zweites aktives Abrechnungssystem und keine neue Plattform werden erzeugt. Die alte130-Backupclosure unter neueren Releaseabhängigkeiten ist nur mit lokalen Mockports geprüft; eine reale Provider-/Deploymentabnahme und Deckung folgen daraus nicht. Die finale189/190-QA-Übergabe und alle anwendbaren echten Release-/Ziel-/Kosten-/Betriebsgates bleiben offen.

**Keine Provider-, Modell- oder Revieweraufrufe; kein Push, Online-PR, Main-Merge, Deployment, Produktionsschemaeingriff, echter Zahlungsvorgang, Mailing, Kundendatenänderung oder Chatversand.** Aktive QA-, Assistant- und Property-Arbeitskopien wurden nicht geändert.

Maschinenlesbare Quellen-/Blobbindungen, tatsächliche Loghashes und Grenzen: [completion.json](completion.json).
