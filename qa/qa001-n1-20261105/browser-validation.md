# QA001 N1: enger Browsernachweis für veraltete Auswahlrückrufe

Ausgangsstand ist `a942049c967009f6df09bf2eb905f8d5ba5e5ac8`. Anlass sind Finding N1 und die unabhängige Gegenprobe unter `C:/Projects/crm-live-acceptance-20261104/reviews/navigation-a942049c-independent.json` beziehungsweise `navigation-a942049c-stale-selection.mjs`.

Der neue Harness übernimmt deren tatsächliche React-Shell und bestehenden Handler als Prüfpunkt. Er entfernt das für N1 nicht benötigte Hash-Inventar und verwendet für jeden der vier Fälle einen eigenen frischen Browserkontext. Baseline und Fix wurden nacheinander mit demselben unveränderten Harness ausgeführt. Die Baseline liest sowohl Shell als auch Guard unmittelbar aus dem Git-Objekt des oben genannten Commits; der Producer-Fixlauf liest den eingefrorenen Arbeitsstand.

| Fall | Unverändertes a942 | Korrigierter Arbeitsstand |
| --- | --- | --- |
| Alter A-Handler während aktuellem B→C-Wechsel: kein Cancel und keine Scope-/URL-Änderung; C muss anschließend angenommen werden | FAIL; C wird verworfen, B bleibt mit A-Scope/-URL | PASS |
| Echte aktuelle B-Projektauswahl während C aussteht: C abbrechen, B und ausdrücklich alle Projekte behalten | PASS | PASS |
| Alter B-Handler nach bereits akzeptiertem C: Scope und URL unverändert lassen | FAIL | PASS |
| Handler einer beendeten React-Identitätsinstanz: aktuelle All-Projekt-URL in demselben Workspace nicht überschreiben | FAIL | PASS |
| **Gesamt** | **1 PASS / 3 FAIL, Exit 1** | **4 PASS / 0 FAIL, Exit 0** |

Die drei roten Assertions sind eng verwandte Grenzfälle, keine Behauptung dreier unabhängig neu eingeführter Produktfehler. Die neue N1-Zuschreibung betrifft insbesondere den verlorenen C-Wechsel. Andere veraltete Scope-/URL-Schreibvorgänge können bereits vor der geprüften Navigationserweiterung bestanden haben.

Die Ergebnisdateien enthalten Vorher-/Nachher-Zustände, den Ausgang des verzögerten C-Wechsels, vollständige lokale Scope-URLs und die synthetischen Core-Anfragen. Der erste Basisfall erreicht seinen abschließenden Zustand: `newestSwitchCompleted=false`, aktives Dataset B, Scope/URL A und gesperrter Geschäftsbereich. Am Fix bleiben während desselben alten Rückrufs sämtliche beobachteten Navigationswerte unverändert; anschließend gilt gültiger Scope C mit `newestSwitchCompleted=true`. Die aktuelle B-Auswahl darf dagegen weiterhin abbrechen.

Maßgebliche Dateien sind `baseline-results.json`, `baseline-run.log`, `results.json` und `run.log`. Beide Ergebnisdateien weisen denselben Harness-SHA256 aus:

`58627134f3c5178036f6cefb21124c1ba4b5546dd471e25f06d274f6a7160c15`

Quellhashes sind mit auf LF normalisierten Zeilenenden im jeweiligen Ergebnis enthalten und wurden nach Abschluss gegen den unveränderten Arbeitsstand abgeglichen. Gezieltes ESLint des neuen Scripts: Exit 0, keine Warnungen. Alle vier Kontexte beider Läufe melden keine JavaScript-Browserfehler und keine erfassten externen Netzversuche. Beide Browserprozesse sind beendet.

## Grenzen

Es laufen die echte `CrmWorkspace`-Komponente, React StrictMode und ihre vorhandenen Auswahl-/Wechselhandler. Ein eingefangener Handler modelliert den durch Quellprüfung belegten verspäteten Fortsetzungspunkt von `handlePrepareProject`. Der vollständige Ablauf Projektformular→POST→Dialog schließen wird nicht ausgeführt. Unabhängige Kindbereiche und Next-Router-Primitiven sind ersetzt; Workspaces, Core-Antworten und Serverautorisierung sind synthetisch. Der Identitätsfall prüft die beendete React-/Guard-Lebensdauer bei neuem Komponenten-Key, keinen echten Login-, Cookie- oder Rechteentzugsablauf.

Es gab keine Live-, Provider-, Datenbank-, Installations- oder Deployment-Aktion. Die früheren 107 Browser-, sieben Refresh- und 29 Vertragsfälle wurden für dieses enge N1-Delta nicht erneut ausgeführt. Ihre unveränderten, quellengebundenen Altnachweise bleiben historisch und werden separat eingeordnet.

## Lokale Ausführung und unabhängiger Commitlauf

- Standard: `node scripts/qa001-stale-selection-tests.mjs` prüft die aktuellen Arbeitsdateien und schreibt nach `qa/qa001-n1-20261105/`.
- `CRM_QA_N1_BASELINE=1` prüft stattdessen die unveränderliche a942-Baseline und schreibt `baseline-results.json`.
- `CRM_QA_N1_REVISION=<Commit-SHA>` hat Vorrang vor der Baseline-Option. Der SHA wird auf einen vollständigen Commit aufgelöst; Shell und Guard werden beide genau daraus gelesen. Die Ergebnisdatei enthält angeforderten und aufgelösten SHA sowie die tatsächlich gebündelten Quellhashes.
- `CRM_QA_N1_OUTPUT=<lokales Verzeichnis>` legt alle Ergebnisse separat ab. Damit kann ein Reviewer denselben engen Viererbestand nach dem Commit außerhalb des Worktrees ausführen, ohne Producerbelege zu überschreiben. Netzfreigabepfade sind als Ausgabe abgewiesen.

Die vier Assertions und synthetischen Fixtures ändern sich durch diese Teststeuerung nicht. Der Producerlauf ist noch kein unabhängiger Reviewer-Nachweis eines späteren Commits.
