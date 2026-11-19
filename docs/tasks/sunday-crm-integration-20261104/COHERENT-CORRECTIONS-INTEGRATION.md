# Kohärenter lokaler CRM-Korrekturstand

Runtime-/Testquellfreeze: **19af886e81362b6acd3cbd463e428b2c678f2236**, Basis **80de72a4fb92befa73128aaa7d801adc35c7fd1d**. Dieser Stand ist unveröffentlicht. Der nachfolgende Dokumentations-/Evidencecommit verändert diese Runtimequellen nicht.

Die elf fehlenden Donorcommits sind jeweils mit `cherry-pick -x` in Abhängigkeitsreihenfolge übernommen: Server6678c1b →858c45d →b161297; Client0eafd700 →6bca6f8 →933a546 →050d58a →8723554; Outputs985b3a6 →82a3246 →5026cc6. Die bereits enthaltenen6b9/2a,189 und191 werden nicht nochmals importiert.6330,3a28,8939 und0bb wurden nicht zusätzlich übernommen. Die vollständigen lokalen Commitbindungen stehen im maschinenlesbaren Abschluss.

Ein echter Konflikt lag in `crm-workspace.tsx`: Der aktuelle URL-Restore hatte den Workspacewechsel bereits in einen `useCallback` vorgezogen;050d ergänzte Schutzregeln in der älteren Funktion. Der einzige vereinte Handler behält den autorisierten URL-Workspace, ausdrücklich `null` für „Alle Projekte“ und `replaceHistory`. Er erhält `beginSwitch`/`completeSwitch`/`failSwitch` und die Guardabhängigkeit. State-/Historyeffekte folgen erst dem angenommenen Ticket. Die872-Layoutbereinigung und der RAM-Draftstore bleiben erhalten. Ein zusätzlicher tatsächlicher Parentbrowserfall prüft genau den vereinten URL-/All-Pfad.

## Tatsächlich auf dem gemeinsamen Kandidaten geprüft

| Gruppe | Ergebnis | Nachweisgrenze |
|---|---|---|
| Server/Writer, sechs betroffene Dateien |34/34,0Fail/Skip| eigene neue Loopback-PostgreSQL-Cluster, synthetische Mandanten, Cookie/CSRF, Replay/Konkurrenz, aktuelle Rechte, Aliasnegative, optionales Unknown/0 und Auditrollback |
| Native Zahlen, Store/Lifecycle, Kosten |15/15,0Fail/Skip| lokale Funktionen plus echter nativer Browser-DOM |
| Tatsächliche Property-Komponente |18/18, keine Browserfehler| StrictMode, synthetisches HTTP; einschließlich Unmount/Remount, unveränderlicher Request und Late Response |
| Tatsächlicher CRM-Parent |7/7, keine Browserfehler| reale Parent-/Property-Komponenten, synthetisches HTTP; sechs Donorfälle plus vereinter URL-/All-Fall |
| Öffentliche Outputs und SourceSQL→PDF |21/21,0Fail/Skip| aktuelle SQL-Projektionen, beide PDFpfade, HTML, Länder/Energie/Adressredaktion, bekannte Null und getrennte Developer-Preisautorität |
| Medien189/191 und Webchat-/Partnerkompatibilität |15/15,0Fail/Skip| tatsächliche092–096/121/189/191-SQL-Vorgänger, separaterNOINHERIT-Definer, RLS und enges Prädikat-EXECUTE |
| Vollständiger lokaler Nextbuild |Exit0| Next16.4.5, TypeScript,188 statische Seiten |
| Separater Typecheck und betroffener ESLint |Exit0| exakte gemeinsame Quellen, keine Warnungen |
| Diff-/Secretprüfung |Exit0,0Secretbefunde| Gitleaks8.30.1 auf zwölf Quellcommits und neuen Evidenceartefakten |

Die Outputprüfung erzeugte24 PDFs mit54 textuell ausgewerteten Seiten und12 HTML-Ausgaben. Der zusätzliche Developer-Zero-Fall prüft wirkliche SourceSQL→PDF-Bytes für Asking/Public/Rent mit unbestätigten, passenden und abweichenden Bestätigungen sowie Hidden-/Nondeveloper-Kontrollen. Dies ist keine neue unabhängige visuelle PDF-Layoutabnahme.

Die Servergruppe begann noch aufb58071ac und wurde während der ausschließlich zusätzlichen Parentbrowser-Prüfung19af886 fertig. Ihre Server-/Testquellen sind durch19af unverändert; dieser Beleg wird für denselben Scope weiterverwendet und nicht als zweiter Lauf ausgegeben. Alle übrigen aktuellen Prüfungen begannen nach dem19af-Quellfreeze.

Alle Prüfkinder erhielten nur eine Plattform-Umgebungsallowlist, keine geerbten Provider- oder Datenbankcredentials. Zusätzlich war ein Node-Socketpreload vererbt; die Fixtures verwenden eigene Loopback-Testserver/Cluster und synthetisches Browser-HTTP. Dies ist kein Nachweis einer Betriebssystem-Netzwerkisolation. Die partiellen historischen Schemafixtures bleiben partiell: Die Outputfixture106+155/163/166/190 und die Medienkombination sind keine vollständige Produktionsupgrade-Probe.

Unabhängiger Root-Quellreview des exakten Deltas80de..19af: **C0/H0/M0/L0**, gebunden im erhaltenen [Reviewreceipt](../../../artifacts/sunday-crm-integration-20261104/root-independent-review-19af886e.json). Dieser Review ist kein genuine-App-, Native-CI-, vollständiger Sicherheits- oder Produktivnachweis.

## Erhalt und verbleibende Grenzen

Produktiver PR129-Einladungscode samt Message-Fences, aktuellebb8-Assistant-/Billing-/Navigationsquellen und188, Medien189/Ownerfix191 sowie atomare Workspace-Einstellungen sind erhalten. Paketdateien/Lock, Vercel und Workflows sind gegenüber80de unverändert. Neue190- und Writer-/Clientnachfolger sind nun enthalten.

Die früheren SRC05-Quellbefunde zu Pending-Ref/Remount und spätem Parentrefresh sind im begrenzten lokalen Scope durch die übernommenen Korrekturen und18+7 Browserfälle abgedeckt. Daraus folgt keine pauschale Live-/SRC05-/Geschäftsablaufabnahme. Alle ursprünglichen FAILs, Donorprotokolle und der historische8/9-Stringtest bleiben unverändert und werden nicht als bestanden umetikettiert. In diesem aktuellen Kandidatennachlauf gab es keine fehlgeschlagene Prüfung.

Offen bleiben genuine App und nativeCI, aktuelle Produktionsziel-/Schema-/Rollen-/Identitäts- und alle sonstigen anwendbaren Releasegates, vollständige Geschäftsablauf-/Liveabnahme, die historische offene Live-QA-Matrix/Residuen und konkrete kommerzielle/finanzielle Autoritäten. Bestehende veröffentlichte PDF-/Websnapshots werden nicht rückwirkend repariert; sie benötigen den unterstützten Review-/Republish-/Revokeweg.189/190/191 wurden nicht produktiv angewendet.

Keine Provider-/Modell-/Appaufrufe, keine Verbindung zu einer bestehenden Produktivdatenbank, keine Kundendatenänderung, kein Push/PR/Deployment und keine Budgetänderung.

Aktuelle Quellhashes, einzelne Loghashes und unveränderte verlustfreie Logtransporte, Browserberichte sowie PDF-/HTML-Dateihashes: [Abschluss](../../../artifacts/sunday-crm-integration-20261104/coherent-final/completion.json). Die dort kopierte Outputfixture nennt ihre historische Basis11c; der aktuelle Ausführungsstand ist ausdrücklich19af886. Root-Beleg `media-integration-root.json` und die fremden synthetischen Marketing-QA-Dateien wurden nicht verändert oder mitgestaged.
