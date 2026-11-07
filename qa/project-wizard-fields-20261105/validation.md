# Projekt-Wizard: lokaler Korrekturkandidat

Der neue Wizard speichert seine tatsächlich angebotenen Angaben atomar und zeigt sie nach echtem Reload wieder an. Die bisher verlorenen Notizen, Zuständigkeit, Funnel-Auswahl und Pipeline-Auswahl wurden am unveränderten Ausgangsstand `3492729aa8cb48459bad650fca91c9095aa9534e` mit echter lokaler Anmeldung, Next-API und PostgreSQL reproduziert. Dieser Kandidat ist eine gezielte lokale Korrektur; die zentrale Koordination führt Integration und Veröffentlichung.

## Verhalten und Datenvertrag

- Fünf vorhandene Projekttypen werden als stabile Schlüssel gespeichert; ihre vorhandenen übersetzten Anzeigenamen bleiben nutzbar. Bestehende freie Typbezeichnungen und Standardabläufe werden nicht nachträglich umgedeutet.
- Notizen liegen in einer eigenen Tabelle mit FORCE RLS. Nur ihr Ersteller kann sie bei weiterhin bestehendem Projektzugriff lesen. Ein anderer Manager erhält die gemeinsamen Projektdaten, aber keine Erstellernotiz. Notizen gelangen weder in Core, Projektmetadaten, Pipeline-Metadaten, Befehlsbelege noch Audittexte.
- „Zuständig“ benennt einen aktiven, schon entsprechend berechtigten Nutzer desselben Workspaces. Die Auswahl erzeugt keine Projektvollmacht. Fremde, inaktive und fachlich unzulässige Nutzer werden serverseitig abgewiesen. Die geprüfte Nutzerzeile bleibt bis zum Commit gegen gleichzeitigen Entzug gesperrt; ein bereits laufender Entzug wird abgewartet und anschließend frisch geprüft.
- Die optionale Funnel-Referenz bleibt leer, bis sie ausdrücklich gewählt wird. Sie verweist auf einen bereits lesbaren internen Funnel. Sie kopiert, verschiebt oder aktiviert ihn nicht. Beim späteren Lesen ist der Titel nur mit weiterhin gültigem Zugriff auf Ziel- und Quellprojekt sichtbar.
- Die Pipelineauswahl verwendet ausschließlich die tatsächlich vorhandenen, zum Kundentyp und Betriebsmodell passenden Vorlagenschlüssel. Das neu erstellte Projekt erhält eine eigene Pipeline-UUID mit genau den bestehenden Stufen dieser Vorlage. Auch spätere explizite Pipelinezuordnungen müssen zum selben Workspace und Projekt gehören und bleiben bis zum Commit gegen Löschen oder Umhängen gesperrt.
- Der Server prüft den aktuellen Actor erneut. Änderungen der Anmeldung, ungültige Optionen und unvollständige Ladezustände werden vor einer Anlage abgefangen. Die vorhandene Absicherung gegen verspätete Save-Antworten und doppelte Befehle bleibt erhalten.

Migration **197** ergänzt ausschließlich diesen Produktvertrag. Die lokale Rollentestmigration 196 gehört nicht zum Kandidaten und wird nicht angewandt.

## Nachweise

| Prüfung | Tatsächliches Ergebnis | Geltungsbereich |
| --- | --- | --- |
| Historische Beobachtung auf exakt 349 | 5 PASS / 4 FAIL bei 9 Checks | Tatsächlicher Verlust der vier alten Formularangaben |
| Abschließender echter Browserlauf | 15/15 PASS, Exit 0 | Passwort/TOTP, HttpOnly-Session, CSRF, echte API, PostgreSQL, Reload und zweiter Manager |
| Gezielte Datenbankprüfungen | 10/10 PASS, Exit 0 | Neun Unterfälle und ein Elternfall; RLS, Atomizität, Rechte, alle Typen/Vorlagen und beide Sperrreihenfolgen |
| Gesamter Typecheck | Exit 0 | `tsc --noEmit` |
| ESLint | Exit 0 | Zehn geänderte/neue TS-, TSX- und MJS-Dateien, keine Warnungen |
| Diffprüfung | Exit 0 | Produktdiff vor Commit; abschließende Indexprüfung erfolgt separat |

Die historischen neun und die neuen fünfzehn Browserchecks prüfen unterschiedliche Datenverträge. Sie werden weder als identischer Rot-/Grün-Bestand noch als vollständige CRM-Abnahme addiert. Der frühe Datenbanklauf vor der Pipeline-Sperrkorrektur bleibt erhalten; maßgeblich ist `backend-tests.txt`. Eine nachträgliche reine Typannotation im Test ist in `backend-validation.json` mit identischer erzeugter JavaScript-Ausgabe ausdrücklich ausgewiesen.

`browser-validation.md`, `browser-source-bindings.json`, `backend-validation.json` und `validation.json` binden die Läufe an Quellen, Helfer, Migrationen und Belege. Die acht Produktdateien des eingefrorenen Browserstands sowie sämtliche 852 erfassten App-Eingaben stimmen mit dem geprüften Arbeitsstand überein. Der unabhängige Review des späteren Commitobjekts wird außerhalb dieses Kandidaten in einem eigenen Nachweisverzeichnis erfasst; dieser Bericht behauptet dessen Ergebnis nicht vorab.

Die Vorproben bleiben unter `preflight/` und `early-loopback-pre-freeze/` erhalten und gelten nicht als zusätzliche Produktfehler. Darunter fallen Aufbau-/Auswahlprobleme sowie eine später korrigierte, nicht vereinbarte Annahme über `Core.project.wizard` und ein ungeeigneter generischer Receipt-Filter. Im finalen Lauf ist ein Command-Receipt über den tatsächlichen Idempotenzschlüssel und die zurückgegebenen Befehls-/Auditreferenzen gebunden; sein privater Textmarker fehlt ebenso in drei zugehörigen Auditzeilen.

`fixed/failure.png` ist ein unverändert erhaltener Rest der ausgeschlossenen Core-Annahme-Vorprobe von 00:38 UTC. Er gehört trotz seines Pfads nicht zum erfolgreichen finalen Lauf ab 00:42 UTC. Sein SHA256 ist `3e83da10e5a2541bcead93051ce5111db5904a27bf226e76c18b602df55e8884`; er zeigt ausschließlich synthetische lokale Testdaten und keine Anmeldegeheimnisse. Die beiden finalen Nach-Reload-Bilder heißen `creator-reloaded-summary.png` und `assigned-manager-reloaded-summary.png`.

## Grenzen und noch offene Produktentscheidungen

Die vorhandenen vier Pipelinekataloge sind `managed_customer_pipeline`, `developer_project_pipeline`, `novalure_sales_pipeline` und `broker_seller_pipeline`. Eigene Käufer-/Investment-Vorlagen sind fachlich noch nicht definiert. Neue Stufen, Preis- oder Kauf-/Mietvollmachten werden deshalb nicht erfunden. Eine echte Funnel-Vorlagenkopie ist ein eigener optionaler Produktauftrag; dieser Kandidat liefert die ausdrücklich vereinbarte interne Referenz.

Alle Geschäftsdaten stammen aus frischen lokalen Testinstanzen. Die echte Anwendung verwendet eine eingeschränkte Runtime-Rolle ohne Superuser- oder BYPASSRLS-Rechte. Die historische Sales-Schemafixture enthält dokumentierte Auslassungen und eine lokale Anpassung einer optionalen Vector-Spalte. Dieser Lauf ersetzt keine produktionsnahe vollständige Migrationsprobe, Rollenmatrix, Providerzustellung, Live-Abnahme oder Veröffentlichung. Die früheren umfangreichen Suiten wurden nicht pauschal wiederholt.

Der unveränderte Node-Netzwerkguard meldet im finalen Browserlauf **zwei verhinderte, nicht näher klassifizierte Verbindungsversuche**. Er erfasst keine Ziele oder zeitliche Zuordnung zum Wizard. Daraus wird keine Versand-/Funnelaktion und kein Nullzähler abgeleitet. Externe Browserrequests: null. Kein Remotezugriff wurde durch die geschützte Anwendung zugelassen. Browser, Next und die eigene PostgreSQL-Instanz sind beendet; der PostgreSQL-Listener ist nachweislich geschlossen. Die eigenen ignorierten Testverzeichnisse bleiben als Nachweis erhalten.

Es gab für diesen Kandidaten keine Cloudänderung, kostenpflichtige Aktion, Produktionsmigration, Push-, CI- oder Deploymentausführung.
