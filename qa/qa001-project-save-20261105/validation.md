# Projektformular: veraltete Speicherfortsetzung

Basis: `a9df44d5900f25659c7a2f153277eaa2755f9bf7`. Gleiche isolierte Arbeitskopie und Branch `codex/qa001-history-scope-20261105`. Zentrale Integration und Veröffentlichung erfolgen getrennt.

Der tatsächliche Ablauf Projektformular → Anlage-POST → Dialog schließen → Workspacewechsel ist erreichbar. Eine späte erfolgreiche A-Antwort konnte neue B-Eingaben leeren, A-Projektdaten in den aktuellen Datenbestand mischen, Bs Projektzähler und Hinweis verändern und zum Dashboard navigieren. N1 sperrte bereits die falsche Projektauswahl, aber nicht diese davor/danach liegenden Fortsetzungen. Auch Fehlerantworten und die zweite Wartephase beim anschließenden Core-Refresh konnten einen inzwischen neuen Kontext verändern.

Ein gemeinsamer projektbezogener Revisionszähler wird jetzt bei Workspace-/History-Absichten, Öffnen/Schließen, Eingabeänderungen und Ende der Guard-Lebensdauer synchron erneuert. Der Save erfasst diese Revision, den ursprünglichen Guard/Workspace, den Entwurfsstand und die URL. Nach jeder Wartephase und vor Fehler-/Navigationseffekten muss diese Bindung weiterhin stimmen. Eigene Scope-Änderungen aktualisieren nur die erwartete URL. Funktionale Daten-/Zähler-/Entwurfsupdater prüfen den Editor und den erwarteten Entwurf, nicht einen inzwischen regulär freigegebenen Busy-Besitzer oder die eigene Dashboard-URL.

Ein synchroner Operationsbesitzer verhindert parallele Doppelstarts desselben UI-Saves. Sein `finally` darf nur seinen eigenen Busy-Zustand lösen. Beim bewussten Wechsel oder neuen Dialog wird die UI-Bindung gelöst; eine ausdrücklich neue B-Speicherung darf beginnen, ohne dass die alte A-Fortsetzung sie entsperrt oder überschreibt. Der Busy-Status ist zusätzlich an den Guard gebunden. Der Layout-Cleanup verändert nur Referenzen und löst keinen State-Schreibzugriff im Effect aus.

Die aktuelle Projektspeicherung verlangt einen bestätigten, zum ursprünglichen Request passenden Projektdatensatz: Workspace, UUID, Name, Typ, Status, positive Version und die benötigten Projektfelder. Ein optionaler Validator verwendet den vorhandenen Sales-Transport mit Idempotenzschlüssel und schreibfreiem Receipt-Lookup. Fachlich falsche 200-Antworten oder falsche Lookup-Belege löschen den ungeklärten Vorgang nicht. Unveränderte spätere Prüfungen bleiben Lookup; ein geänderter Folgeauftrag am noch ungeklärten Ziel wird blockiert. Andere Aufrufer erhalten keinen neuen fachlichen Validator.

## Gezielter Nachweis

Das maßgebliche Paar verwendet denselben unveränderten Harness und alle fünf gebundenen Runtimequellen: **a9df: 3/11 bestanden, 8 fehlgeschlagen; Korrektur: 11/11 bestanden**. Es werden echte Dialogfelder, Save- und Close-Klicks sowie die echte CSRF-/Sales-Clientfortsetzung unter React StrictMode benutzt. Frischer Browserkontext je Fall. Fälle umfassen Erfolg/400 nach A→B, A→B→A und React-Identitätswechsel, aktuelle Erfolg-/Fehlerkontrollen, alte unbekannte Fortsetzung während neuer B-Speicherung, Veralten während des Save-eigenen Core-GETs sowie widersprüchliches 200 mit ausschließlich Lookup beim identischen UI-Retry.

Die acht roten Erwartungen sind kein Nachweis acht unabhängiger Fehler. Der alte globale Busy blockiert bei einem Basisfall bereits die B-Startvorbedingung; dort wird keine ausgeführte alte `finally`-Überlappung behauptet. Der korrigierte Fall erreicht sie vollständig. Pro ursprünglichem Auftrag genau eine Anlage-POST; die Überlappung enthält zusätzlich eine ausdrücklich andere B-Anlage, keinen A-Retry. Ungeklärte oder widersprüchliche Ergebnisse führen ausschließlich zu Reconcile-Abfragen mit Originalbody und Originalkennungen.

**6/6 Transportfälle bestanden**: vier vorhandene Testkörper unverändert, zwei gezielte Validatorfälle ergänzt. Sie prüfen auch eine später gültige COMMITTED-Antwort sowie weiterhin ungültige Receipts, unveränderte Schlüssel/Body und genau eine Anlage. Typecheck und ESLint aller fünf neuen/geänderten Quellen/Tests bestehen mit null Warnungen. Maßgebliche Hashbindungen und Befehle stehen in `validation.json`; Methodik und Vorläufe in `browser-validation.md`.

`evidence-reuse.json` verifiziert 29 relevante alte Quellen und neun Nachweisdateien. Die drei Produktdateien und der ergänzte Transporttest sind als geändert ausgewiesen. Alte 107/7/29- und N1-Ergebnisse bleiben ihrem früheren Source zugeordnet; sie werden nicht als neue Gesamtabnahme ausgegeben. Der unabhängige Nachlauf des fertigen Commits wird separat außerhalb der Arbeitskopie festgehalten.

## Verbleibende Grenze

Der Schutz verwirft ausschließlich veraltete Clientfortsetzungen. Ein bereits serverseitig gespeichertes A-Projekt bleibt in A bestehen; es wird weder rückgängig gemacht noch automatisch erneut angelegt. Ein späteres reguläres Laden zeigt den tatsächlichen Bestand. Der vorhandene ungeklärte Transportzustand ist RAM-/Tab-lokal; Reload-/Mehrtab- oder dauerhafte Wiederaufnahme wird nicht neu zugesichert.

HTTP, Projekte, Serverbestand und Berechtigungen sind synthetisch. Der React-Key-Wechsel ersetzt keinen tatsächlichen Login-/Rechteentzug. Kein echter Cookie-/CSRF-Server-, API-/Datenbank- oder Provider-Nachweis und keine allgemeine Prüfung aller Projektfelder. Keine Live-Daten, externen Aufrufe, Migration, Kosten, Push, Online-PR, CI, Bereitstellung oder Integration.

Die ursprüngliche Linterausgabe bleibt bytegenau in `lint-product-initial.transport.json` als Base64 mit SHA256 erhalten. Ihr zusätzlicher abschließender Leerabsatz wird so als Originalbeleg gespeichert, ohne die Diff-Whitespaceprüfung zu lockern.
