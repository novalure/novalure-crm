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

Nachtrag zum geprüften PR-Head `38fe1b610875312c31c6a6d853f48237217b60c0`:
Der [Production-Abhängigkeitsaudit](https://github.com/novalure/novalure-crm/actions/runs/40080431637/job/120832697449)
ist fehlgeschlagen. `npm run security:production` meldete acht Befunde
(drei moderate, fünf high), unter anderem für `undici` und `zod`.
`package.json` und `package-lock.json` sind gegenüber der PR-Basis
`93f442853483862712451aeeb0b6e3f0ffcfec41` bytegleich; dieser Auftrag ändert keine
Abhängigkeiten. Der [Secret-Scan](https://github.com/novalure/novalure-crm/actions/runs/40080431657/job/120832651105)
bestand auf diesem Head; die weitere Repository-CI lief beim Abruf noch.
Der Auditbefund bleibt als bestehender Merge-Blocker offen. Als getrennte nächste
Entwicklungsaufgabe eignet sich `$novalure-diagnose`: den unveränderten Auditfehler
reproduzieren und einen begrenzten, verträglichen Korrekturscope bestimmen.

Für die folgende Entwicklungsaufgabe den konkreten Vorschlag im
[Projektkontext](../../../.agents/skills/PROJECT.md) gegen den aktuellen Stand prüfen
und mit `$novalure-spec` begrenzen. Keine Studio-Webchat-Reparatur, Datenbank-,
Kalender-, Telefonanschluss- oder Produktionseinstellungen in diesen Einrichtungsauftrag aufnehmen.

## Fortsetzung: reguläre Integration vom 24.10.2026

Der Folgeauftrag erlaubt die konkret festgestellten Integrationshindernisse und
den regulären Merge nach den bestehenden Gates. Die begrenzte
[Abhängigkeitsdiagnose](../crm-audit-compat/diagnosis.md) wurde auf dem getrennten
Zweig `codex/crm-audit-compat` bearbeitet und als Paketkorrektur in diesen
Skill-Branch übernommen (beim Schreiben beobachteter integrierter Commit
`64f624ce22852e865bad3816d6c4b2566d580afd`; den tatsächlichen aktuellen PR-Head
über den PR lesen). Vorhandene Paketarbeit aus PR #109 wurde abgeglichen und
wiederverwendet, ohne dessen Kontakt-/Webchatänderungen zu übernehmen.

[Gezielte Prüfnachweise](../crm-audit-compat/verification.json) zeigen einen
Production-Audit ohne Befunde und kompatible getrennte Undici-Hauptversionen
für Blob und AI-Provider-Utils. Die eingebettete Zod-Kopie in CLI-Config bleibt
als Nachweisgrenze dokumentiert. Die historischen Audit-FAILs oben bleiben
erhalten; sie werden nicht als heutiger PASS umbenannt.

Offen vor Merge: vollständige CI auf dem endgültigen integrierten Head sowie
der echte exakte Check von App `5228093`. Der derzeitige live bereitgestellte
Reviewer unterstützt #110 noch nicht als festes Prüfziel; die notwendige additive
Routingkorrektur wird getrennt vom Skill-Branch vorbereitet. Kein lokaler Bericht
ersetzt diese Prüfung. Nächster Schritt: finalen Head pushen, reguläre CI und
Review-App-Prüfung verfolgen und erst nach allen anwendbaren Gates normal mergen.
