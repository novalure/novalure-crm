# QA001: lokaler Browsernachweis

Maßgeblich sind ausschließlich `baseline-browser-results.json` / `baseline-browser-run.log` und `browser-results.json` / `browser-run.log` in diesem Verzeichnis. Die beiden letzten Läufe wurden nacheinander ausgeführt, mit demselben unveränderten Harness. Navigation verwendet DOMContentLoaded und 15 Sekunden Startfrist; die engeren fachlichen Zustandsprüfungen blieben erhalten.

| Lauf | Fälle | PASS | FAIL | Prozesscode |
| --- | ---: | ---: | ---: | ---: |
| Unveränderte Basis `94838b983df9cfe61d8367d5f2e1ca316bfb8184` | 107 | 92 | 15 | 1, erwartete rote Regressionen |
| Korrigierter, noch nicht committeter Produktstand auf dieser Basis | 107 | 107 | 0 | 0 |

Alle 15 roten Basisfälle haben einen vollständig gestarteten Komponenten-Zustand. Es gibt in diesem maßgeblichen Basislauf keinen Start-/Reload-Timeout und keinen Fall ohne Zustand. Die 15 Assertions sind keine Behauptung von 15 voneinander unabhängigen Produktfehlern. Direkte B-Links einschließlich echtem Reload, die explizite All-Projekt-History und das bereits nicht verfügbare Projekt im gefilterten Core-200 bestehen schon an der Basis.

Die 107 Fälle gliedern sich in 20 Scope-/Verlaufsfälle, 28 kanonische Bereiche, 22 explizite Nested-Hashes und 37 weitere bestehende Alias-Hashes. Der zusätzliche camelCase-Link `#objectsMandates` liegt bei den 20 Scope-/Verlaufsfällen. Hash-Erwartungen stammen aus den reinen Navigationsdaten der unveränderten Basis und einer expliziten Tabelle der erzeugten Bereichs-Hashes; der getestete Resolver wird nicht als Erwartungsfunktion aufgerufen. Ein jeweils passendes erlaubtes Profil wird gewählt. Hashes erweitern keine Berechtigung.

## Methode und Grenzen

- Echte `CrmWorkspace`-Komponente unter React StrictMode, echte `WorkspaceNavigation` und `WorkspaceSectionTabs`, echter Headless-Chrome-Browser auf Loopback-HTTP.
- Echte `page.goBack()` / `page.goForward()`-Verlaufsschritte. Für unbekannte oder entzogene frühere Ziele wird ein Verlaufseintrag angelegt und anschließend tatsächlich zurück/vorwärts navigiert; es wird kein künstliches `popstate`-Event ausgelöst.
- Testbeobachter liest nur den Komponenten-Zustand und ruft vorhandene Bedienhandler auf. Er fügt keine Produkt-Setter oder Ersatzresolver hinzu.
- Kontrollierte, synthetische Core-Antworten, verzögerte Antworten, 403, falsches `activeWorkspaceId` bei 200 und herausgefilterte Projekte. Alle Core-200 enthalten das reale DTO-Feld `activeWorkspaceId`.
- Synthetische Workspaces sind ausdrücklich `novalure_internal`, der synthetische Produktnutzer ist `platform_admin`. Dies ist für den positiven `aiBillingAdmin`-Fall erforderlich; dessen vorhandene Capability-/Kontextschranke wurde nicht geändert.
- Bei Billing, KI-Abrechnungsadministration und KI-Assistent zeigen sichtbare, testweise eingesetzte Panel-Probes zunächst den gültigen A-Kontext. Während des fremden Zielwechsels sowie bei unbekanntem/entzogenem Ziel müssen diese Probes fehlen.
- Unabhängige Geschäftsbereiche und Next-Router-Primitiven sind ersetzt. Die Serverantworten und serverseitige Autorisierung sind Fixtures. Das ist kein vollständiger Browser→echte API→Datenbank-Nachweis und kein vollständiger Rollentest.
- In beiden maßgeblichen Läufen: keine JavaScript-Browserfehler, keine erfassten externen Netzversuche. Keine Live-, Provider-, Datenbank-, Installations- oder Deployment-Aktion.

## Identität der getesteten Quellen

Beide Ergebnisdateien enthalten denselben Harness-SHA256:

`ed371c9897dda50ea061cce30c5acbe58d974d1d7eb31c00c4fb533db496728a`

Die Basis liest sowohl Shell als auch Request-Guard direkt über `git show` aus dem oben genannten Commit. Der korrigierte Lauf liest beide Arbeitsdateien beim Start. Die folgenden SHA256 beziehen sich auf mit LF normalisierten Quelltext; sie wurden nach Abschluss nochmals gegen den unveränderten Arbeitsstand abgeglichen:

| Quelle | Basis | Korrigierter Lauf |
| --- | --- | --- |
| `src/components/crm-workspace.tsx` | `0edf19c0b815e4acfc9888faec062470eb9520d92545c688d45742552513d682` | `07567fb384ef6715619b194564e5115ef9531e41143b9ef6caaf45f41344b4fc` |
| `src/lib/crm-core-request-guard.ts` | `3be5eb824e2ca50a1f8e7d5d6a3308beb462a0dc4ddb5e4c8054a087ca297c7e` | `1567e96d815f77545f33832a32aa1c02361af11970647fc5e6479a6a864aaf97` |

Gezieltes ESLint für `scripts/qa001-history-browser-tests.mjs` und `scripts/crm-core-refresh-ui-tests.mjs`: Exit 0, keine Warnungen. Der bestehende Refresh-Harness enthält neben dem Core-DTO-Feld nun die unten erläuterte Fixture-Isolierung und deaktivierbare Trace-Beobachtung. Der Browsernachweis enthält keine Aussage über einen späteren Commit oder eine Veröffentlichung.

## Abschließender Refresh-Kontrolllauf

Nach dem ersten grünen 107er-Lauf zeigte der bestehende sieben Fälle umfassende Refresh-Harness einen zwischenzeitlichen Fehlschlag. Die separate Diagnose liegt unter `refresh-investigation/diagnosis.md`; der rote Root-Lauf ist unverändert als `refresh-ui-final-attempt-failed.txt` / `.json` erhalten. Der bisherige Einstieg öffnete einen Inline-Verwaltungsbereich mit eigenen, identischen Core-GETs, die mit der für Parent-Refreshs bestimmten Fixture-Plankette konkurrierten. Die Fixture startet nun durchgehend in `#properties`; die sieben bisherigen fachlichen Assertions sind unverändert.

Der abschließende isolierte Refresh-Lauf besteht **7/7, Exit 0**, dokumentiert durch `refresh-ui.txt` und `refresh-ui-results.json`. Erst nach dessen Prozessende wurde der maßgebliche 107er-Fixlauf am oben genannten finalen Quellenstand ausgeführt: erneut **107/107, Exit 0**. Die vorherigen grünen 107er-Belege vor den drei Erstlader-Sicherungen liegen unter `before-initial-loader-guards/`. Die unveränderte rote 107er-Basis wurde nicht nochmals ausgeführt.

Die zusätzlichen Erstlader-Sicherungen verwenden beim späteren Workspace-Listenabschluss den synchron akzeptierten Workspace, erlauben Metadatenmerge nur bei gleicher Workspace-ID und erledigen eine ältere initiale Restore-Absicht bei gültigem manuellem Switch. Diese spezifische Zeitfolge wurde nicht separat erzwungen oder reproduziert; sie bleibt quellgeprüfte Vorsorge mit allgemeiner Regressionstestabdeckung.

## Ausgeschlossene Vorläufe

`unqualified-preflight/` bewahrt frühere Logs und die vorläufigen 106er-JSON-Dateien auf. Diese Vorläufe sind nicht maßgeblich. Beim Harness-Aufbau wurden unter anderem die fehlende neue Dokumentnavigation bei identischer URL, unvollständige Profilinventarisierung und der notwendige interne Kontext für `aiBillingAdmin` korrigiert. Ein früher paralleler 104er-Lauf hatte zusätzlich Start-/Unterbrechungstimeouts bei zu kurzer Standard-Navigationsfrist. Diese Infrastrukturfehler werden nicht als Produktfehler gezählt. Nach Ergänzung der letzten Vertragsfälle wurden die beiden oben genannten vollständigen 107er-Läufe seriell wiederholt.

Reproduktion: `CRM_QA_HISTORY_BASELINE=1` für den Basislauf setzen und `node scripts/qa001-history-browser-tests.mjs` ausführen; danach die Variable entfernen und denselben Befehl für den korrigierten Arbeitsstand ausführen. Ausschließlich im isolierten Worktree starten.
