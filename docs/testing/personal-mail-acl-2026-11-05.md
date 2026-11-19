# Bezugsrechte für private Mailanhänge – enger Folgeabschluss

Basis ist der unveränderte Mailkandidat `7b0aae8038cadcd6af738d6e45cc22d47d607d6d`.
Folgearbeitskopie: `C:/Projects/novalure-crm-personal-mail-acl-20261105`, Branch `codex/personal-mail-acl-20261105`.

Der konkrete Fehler wurde vor der Korrektur mit tatsächlicher Loopback-PostgreSQL-Sitzung reproduziert: Eine manuell zugeordnete Nachricht sowie eine privat abgelegte (`filed`) Nachricht hatten jeweils einen privaten Anhang und noch keinen Versandauftrag. Nach Entzug von `can_read` und `can_edit_deals` ließen dieselben weiterhin gültigen Sitzungen sowohl `personalReplyState` als auch `readPersonalAttachment` erfolgreich durch. Der Rohbeleg ist unverändert komprimiert unter `artifacts/personal-mail-acl/before-fix.tap.gz` erhalten. Zwei fachliche Negativfälle scheiterten; Node zählt zusätzlich den fehlgeschlagenen Elternfall (23Tests,20Pass,3Fail).

Der neue serverseitige Helper `assertPersonalMailboxMessageAccess` prüft zuerst die eigene aktive persönliche Kopie. Tatsächlich gespeicherte manuelle und private `filed`-Zuordnungen werden aus der Datenbank ermittelt und gesperrt; ihre Projekt-IDs stammen niemals aus dem Browser oder aus einem früheren Versandauftrag. Für jeden zugeordneten Projektbezug werden die aktuellen Projektleserechte unter derselben frischen Mitgliedschaft/Sitzung geprüft. Bei widersprüchlichen vorhandenen Bezügen müssen sämtliche Projekte lesbar sein.

Der Helper schützt die neuen Reply-State-/Dateimetadaten und die privaten Downloadbytes. Vor einem zugeordneten Dateiimport prüft er dieselben Bezugsrechte bereits vor Anbieter-I/O und nochmals vor Speicherung. Eine rein persönliche, unzugeordnete Kopie bleibt für ihren authentifizierten Eigentümer lesbar. Das Löschen eigener verschlüsselter Bytes bleibt auch nach Projektentzug möglich und liefert nur den eigenen Löschbeleg. Neue Rollen, Freigaben, Provideraktionen und Rechte für fremde Personen werden nicht eingeführt.

Die gezielten Prüfungen zeigen nach dem Fix:

- Beide zugeordneten Fälle ohne bisherigen Versandauftrag: Metadaten und Bytes nach Entzug mit `PROJECT_FORBIDDEN` gesperrt; anschließend kein Anbieterabruf für einen neuen Dateiimport.
- Unzugeordnete persönliche Kopie: weiterhin eigentümergebundener Zugriff, obwohl ein anderes Projektrecht entzogen wurde.
- Eigentümer kann seine privaten Bytes weiterhin dauerhaft löschen; bestehende Mandanten-, Konten-, Session-, Vorschau-, Idempotenz-, Lost-Ack-, QA-Hostpin- und Neustartfälle bleiben im betroffenen Modul grün.

Ausgeführt: `node --conditions=react-server --import tsx --test --test-reporter=tap scripts/personal-mail-reply-tests.ts` mit23/23Pass,0Fail,0Skip; `npm run typecheck` Exit0; enger ESLint der drei betroffenen Quellen Exit0. Quellen-/Artefakthashes stehen in `artifacts/personal-mail-acl/evidence.json`. Die Rohlogs sind bei Bedarf gzip-komprimiert, ihre entpackten Hashes sind zusätzlich erfasst.

Die43er-Importsuite, fünf Browserprüfungen und der Build im Basisreceipt bleiben historische Nachweise für7b0. Sie werden nicht als auf diesem Folgecommit erneut ausgeführt ausgegeben. Dieser kleine Folgeumfang benötigt vor Übernahme seinen exakten unabhängigen Review; der gemeinsame Integrationsstand muss anschließend seine eigenen erforderlichen Prüfungen binden. Echte App-/Providerabnahme, produktiver Schema-Upgrade-/Restore-Nachweis und native CI/Linux bleiben offen. Keine echte Mail, kein Login, keine Hostkonfiguration und keine Veröffentlichung wurden durch diesen Folgeabschluss ausgeführt.
