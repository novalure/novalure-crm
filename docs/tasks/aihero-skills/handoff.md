# AIHero-Skill-Paket: Aufgabenübergabe

- Repository: [novalure/novalure-crm](https://github.com/novalure/novalure-crm).
- Branch: `codex/novalure-aihero-skills`; eigene Arbeitskopie, getrennt von der Studio-Webchat-Reparatur.
- Beim Aktualisieren beobachteter Commit: `e5eb25f11071d8f3bea75f0a65e29e8344539e42` ([Implementierungsstand](https://github.com/novalure/novalure-crm/commit/e5eb25f11071d8f3bea75f0a65e29e8344539e42)); die folgende Änderung betrifft nur den Übergabe-/Aufgabenstand.
- Arbeitsstand: Skill-Dateien, Agentenanweisungen und Prüfnachweis sind committed und gepusht; diese Übergabeaktualisierung liegt beim Schreiben noch als eigene Arbeitsänderung vor.

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

Stand: 24.10.2026 11:02 Europe/Vienna. Implementierungscommit gepusht;
[eigener Draft PR #110](https://github.com/novalure/novalure-crm/pull/110) ist offen.
Die vorhandene [CI/Check-Ansicht](https://github.com/novalure/novalure-crm/pull/110/checks)
zeigte beim ersten Abruf laufende Repositorychecks. Für diesen Snapshot ist kein
bestandener vertrauenswürdiger unabhängiger Review-App-Check belegt. Nach jedem
Folgecommit den exakten neuen PR-Head prüfen; alte Checks gelten nicht automatisch.
Kein Merge oder Produktionseingriff. Automatische Git-Preview-Checks sind keine
hier ausgeführte oder abgenommene Nutzerfunktion.

Nächster Schritt: den finalen PR-Head und dessen CI-/unabhängige Reviewnachweise
über den bestehenden Prozess prüfen; anwendbare Befunde innerhalb dieses Scopes
beheben. Diese Übergabe wird im normalen Dokumentations-Folgecommit festgehalten.
Lokale Struktur-/Agentenprüfung ersetzt keinen vertrauenswürdigen Review-App-Check.
Bestehende Freigaben und Produktprioritäten bleiben im jeweiligen gültigen Scope erhalten.

Für die folgende Entwicklungsaufgabe den konkreten Vorschlag im
[Projektkontext](../../../.agents/skills/PROJECT.md) gegen den aktuellen Stand prüfen
und mit `$novalure-spec` begrenzen. Keine Studio-Webchat-Reparatur, Datenbank-,
Kalender-, Telefonanschluss- oder Produktionseinstellungen in diesen Einrichtungsauftrag aufnehmen.
