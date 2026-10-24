# AIHero-Skill-Paket: Aufgabenübergabe

- Repository: [novalure/novalure-crm](https://github.com/novalure/novalure-crm).
- Branch: `codex/novalure-aihero-skills`; eigene Arbeitskopie, getrennt von der Studio-Webchat-Reparatur.
- Beim Schreiben beobachteter Commit: `93f442853483862712451aeeb0b6e3f0ffcfec41` (Ausgangsstand vor dem Einrichtungscommit).
- Arbeitsstand: neue `.agents/skills/`-Dateien, knappe Agentenanweisungen und diese Aufgabenablage; bei Evelyn zusätzlich ein isolierter Einrichtungsdatensatz im Entwicklungszustand. Fremde Änderungen nicht übernommen.

## Erledigt und geprüft

Vier lokale Skills und Aufrufbeispiele: [Paket](../../../.agents/skills/README.md).
[Projektkontext](../../../.agents/skills/PROJECT.md) verweist auf vorhandene Anforderungen,
Befehle und unabhängige Reviewregeln. [Quellstand und Lizenz](../../../.agents/skills/UPSTREAM.md)
sind festgehalten. Der Auftrag richtet nur Entwicklungsanweisungen ein.

[Prüfnachweis](verification.json): Struktur, Pflichtmetadaten, Verweise, vorhandene
Befehle, unveränderte MIT-Lizenz und Erhalt ursprünglicher Anweisungen. Die echte
Skill-Erkennung ist mit dem verfügbaren Codex-CLI-Loader überprüft: alle vier
Skills sind `repo`, aktiviert, ohne Parserfehler. Der Nachweis nennt Datei-Hashes
und die konkrete Methode. Desktop-Auswahlmenü und implizite Modellauswahl wurden
nicht geprüft. Anwendungstests und echte Providerabläufe wurden hier nicht ausgeführt.

## Veröffentlichung, offene Punkte und Fortsetzung

Stand bei dieser Aufzeichnung: lokal vorbereitet, noch kein Implementierungscommit
oder PR. Kein Merge, Deployment oder Produktionseingriff.

Nächster Schritt: Einrichtungsänderungen committen, eigenen Draft PR anlegen und
dessen exakte CI-/unabhängige Reviewnachweise über den bestehenden Prozess verfolgen.
Lokale Struktur-/Agentenprüfung ersetzt keinen vertrauenswürdigen Review-App-Check.
Bestehende Freigaben und Produktprioritäten bleiben im jeweiligen gültigen Scope erhalten.

Für die folgende Entwicklungsaufgabe den konkreten Vorschlag im
[Projektkontext](../../../.agents/skills/PROJECT.md) gegen den aktuellen Stand prüfen
und mit `$novalure-spec` begrenzen. Keine Studio-Webchat-Reparatur, Datenbank-,
Kalender-, Telefonanschluss- oder Produktionseinstellungen in diesen Einrichtungsauftrag aufnehmen.
