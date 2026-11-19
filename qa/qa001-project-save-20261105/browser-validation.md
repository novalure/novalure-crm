# Projekt-Save: tatsächliches Formular, POST und spätere Fortsetzung

Ausgangsstand ist `a9df44d5900f25659c7a2f153277eaa2755f9bf7`. Der enge Nachweis erweitert die frühere reine Rückruf-Gegenprobe um das tatsächlich bediente Projektformular. Alle Fälle verwenden einen eigenen frischen Browserkontext, die echte `CrmWorkspace`-Shell, den inline definierten `ModalShell`, seine Eingabefelder sowie den echten `salesFetch`-/CSRF-Clientcode.

Die maßgeblichen seriellen Producerläufe verwenden denselben unveränderten Harness:

| Lauf | Fälle | PASS | FAIL | Exit |
| --- | ---: | ---: | ---: | ---: |
| Unveränderter a9df-Stand | 11 | 3 | 8 | 1 |
| Korrigierter Arbeitsstand | 11 | 11 | 0 | 0 |

Die acht roten Erwartungen der Basis sind **keine acht unabhängig belegten Produktfehler**. Sieben erreichen die jeweilige beanstandete Fortsetzung. Beim Overlap-Fall verhindert das alte globale Busy bereits die neue B-Speicherung; dieser rote Vorbedingungsbefund ist mit `overlapPrerequisiteBlocked=true` markiert und belegt auf der Basis keine ausgeführte alte `finally`-Überlappung. Der korrigierte Lauf erreicht diese Überlappung vollständig und besteht sie.

## Ausgeführte Fälle

| Fall | a9df | Korrektur |
| --- | --- | --- |
| A-POST erfolgreich, Dialog tatsächlich geschlossen, A→B, neuer B-Text | FAIL | PASS |
| Dasselbe mit endgültiger 400-Ablehnung | FAIL | PASS |
| A-POST erfolgreich nach A→B→A, neuer Text | FAIL | PASS |
| Dasselbe mit 400-Ablehnung | FAIL | PASS |
| A-Erfolg nach echtem React-Key-/Identitätswechsel und neuem Dialog | FAIL | PASS |
| A-400 nach demselben Identitätswechsel | PASS | PASS |
| Aktuelle erfolgreiche Speicherung | PASS | PASS |
| Aktuelle 400-Ablehnung | PASS | PASS |
| Alte unklare A-Fortsetzung während ausdrücklich neuer B-Speicherung | Vorbedingung gesperrt | PASS |
| Fortsetzung veraltet erst während ihres eigenen verzögerten Core-GETs: Close/Reopen und neue Eingaben | FAIL | PASS |
| Vollständiges 200 mit fremdem Workspace-Projekt; UNKNOWN-Abgleich und identischer UI-Retry | FAIL vor Retry | PASS |

Jeder gewöhnliche Fall startet genau einen tatsächlichen Projekt-Create-POST. Im Overlap-Fall sind es genau ein A- und ein ausdrücklich anderer B-Create mit getrennten Schlüsseln; kein unklarer A-Create wird wiederholt. Die A-Netzantwort wird dort verworfen, der echte Transport führt genau einen schreibfreien Reconcile-Abgleich mit `UNKNOWN` aus. Nachdem die alte A-Promise einschließlich `finally` beendet ist, müssen Bs laufendes Saving, Eingaben, Notice, Scope und URL unverändert bleiben. Erst danach wird B bestätigt und erfolgreich abgeschlossen.

Beim widersprüchlichen 200 stimmen übrige DTO-Felder, aber das zurückgegebene Projekt gehört zu B statt zum angefragten A. Am Fix bleibt der Vorgang unbestätigt: ein Create, anschließend zwei Reconcile-Abfragen einschließlich des tatsächlich geklickten identischen UI-Retry. Beide Abfragen verwenden den ursprünglichen Idempotenzschlüssel und denselben eingefrorenen Body. Es erfolgt kein zweiter Create. Auf der Basis wird die falsche Antwort zuvor als Erfolg übernommen; der Retryteil wird dort bewusst nicht mehr ausgeführt.

Die positive aktuelle Speicherprobe führt bestätigte Projekte auch im synthetischen Serverbestand. Nachfolgende Core- und Workspace-Listen-Antworten liefern das Projekt beziehungsweise den passenden Zähler weiter. DTOs enthalten `persisted:true`, UUID, Workspace, Name, Typ, Status, positive Version, `leads`, `revenue` und `defaultPipelineId`. Dadurch wird kein eigener Fixture-Rückschritt als Produktregression fehlinterpretiert.

## Beobachtung und belegter Basisfehler

Die real geklickte Save-Schaltfläche ruft weiterhin den tatsächlichen `handlePrepareProject` auf. Ein testseitiger Wrapper speichert ausschließlich dessen zurückgegebene Promise; damit kann die Prüfung das Ende der alten Fortsetzung und ihres `finally` exakt abwarten. Er ruft keine zweite Speicherung auf und verändert keinen Produkt-State. Ein zusätzlicher lesender Layout-Beobachter erfasst tatsächlich committete Projektdaten, Counter und Editorzustände; er ersetzt keinen Resolver und keinen Save-Pfad.

Die erste vollständige A→B-Erfolgs-Gegenprobe zeigt an der Basis nach dem tatsächlichen UI-POST und Dialogschließen: neue B-Eingaben werden geleert, das A-Projekt gelangt neben B in `liveCoreData.projects`, zwischenzeitlich wird Bs Counter erhöht, eine A-Erfolgsnotice erscheint in B und die Ansicht wechselt zum Dashboard. N1 verhindert zwar die direkte falsche Scope-Auswahl, schützt diese übrigen Fortsetzungen aber noch nicht. Die JSON-Dateien enthalten vor/nach dem POST sowie nach allen kritischen Fortsetzungen die Scope-/URL-, Formular-, Notice-, Saving-, Projekt- und Counterwerte. Der korrigierte Lauf hält neue Kontexte frei von diesen alten Schreibvorgängen.

## Quellen und maßgebliche Dateien

Maßgeblich: `baseline-results.json`, `baseline-run.log`, `results.json`, `run.log`. Beide Ergebnisse enthalten denselben Harness-SHA256:

`c7af275446e87ad20263820b0f6ff0664a532d2f8c6f061a1dfe07a9bb6371b0`

Die Baseline liest **alle fünf gebündelten Runtimequellen** unmittelbar aus a9df: Shell, Request-Guard, Sales-Client, Safe-Client und CSRF-Client. Die neue Transportvalidierung aus dem Arbeitsstand kann daher nicht die historische Baseline beeinflussen. Die Fix-Ergebnisdatei bindet nach LF-Normalisierung diese Quellen:

| Quelle | SHA256 |
| --- | --- |
| `src/components/crm-workspace.tsx` | `6472eaade25d1982e0e913c4e83ddb127b110135403553680e6d4fde38dfeb03` |
| `src/lib/crm-core-request-guard.ts` | `d7e88bacb1b0a810c17c993993cd27b23aea16141832b6482132fd8f7a44b452` |
| `src/lib/security/crm-sales-client.ts` | `22bc79692db73902f2d9e359c6554e6d6cfdc21e6d68d2cd5756ee4f7edee920` |
| `src/lib/security/crm-safe-client.ts` | `eedc706602952265147b2bf9520511bb073fd3ec6bc5049f4c282dc109163f2f` |
| `src/lib/security/csrf-client.ts` | `4921a72f8436dbfcdec2c7d7f24a392bdfcab817f2abe4c912200db320e5dcbf` |

Quell-, Harness- und Ergebniskonsistenz wurden nach beiden Läufen geprüft. Gezieltes ESLint des neuen Scripts: Exit 0, keine Warnungen. Beide Browserprozesse sind beendet. Alle elf Fälle beider Läufe melden keine JavaScript-Browserfehler und keine erfassten externen Netzversuche.

## Grenzen und Reproduktion

HTTP-Antworten, Berechtigungen, CSRF-Token, Projekte und Serverbestand sind synthetisch. Die Prüfung belegt echte Komponenten-/Clientfortsetzungen, **keinen echten Cookie-/CSRF-Server-, Rollen-, API-/Datenbank- oder Provider-Roundtrip**. Der Identitätswechsel remountet per React-Key; er ist kein tatsächlicher Login-/Rechteentzugsnachweis. Es gab keine Live-, Provider-, Datenbank-, Installations- oder Deployment-Aktion. Die früheren 107/7/29-Suiten wurden nicht erneut ausgeführt.

`smoke/`, `preliminary-eight/` und `preliminary-ten/` dokumentieren den Aufbau und kleinere Vorbestände. Die zwei `unqualified-*`-Selector-Proben dort erreichen den vollständigen Ablauf noch nicht und sind keine Produktfehlernachweise. `before-busy-lifecycle-lint/` erhält den ersten grünen 11er-Stand vor der abschließenden guardgebundenen Busy-Lifecycle-Korrektur. Danach wurde ausschließlich der Fix-11er mit demselben Harness erneut ausgeführt: wiederum 11/11, Exit 0, am oben gebundenen endgültigen Shell-Hash. Baseline und Assertions wurden nicht verändert. Maßgeblich ist ausschließlich das oben bezeichnete 11er-Paar im Hauptverzeichnis.

Standardausführung: `node scripts/qa001-project-save-tests.mjs`. `CRM_QA_PROJECT_SAVE_BASELINE=1` wählt a9df. `CRM_QA_PROJECT_SAVE_REVISION=<Commit-SHA>` hat Vorrang und liest alle fünf Runtimequellen genau aus dem aufgelösten Commit. `CRM_QA_PROJECT_SAVE_OUTPUT=<lokales Verzeichnis>` erlaubt einen getrennten unabhängigen Reviewer-Nachweis ohne Überschreiben der Producerdateien. `CRM_QA_PROJECT_SAVE_SMOKE=1` führt nur die erste Aufbauprobe aus und ist nicht der maßgebliche 11er-Bestand.
