# Novalure AIHero – lokale Entwicklungsskills

Vier kurze Adaptionen der ausgewählten Matt-Pocock-Vorlagen für dieses Repository. Maßgeblich bleiben der konkrete Auftrag, vorhandene Anforderungen/Entscheidungen/Freigaben und die geltenden Projekt- und Review-Regeln. Der [Projektkontext](PROJECT.md) nennt ausschließlich hier vorhandene Befehle und Dokumente.

| Skill | Einsatz |
| --- | --- |
| [novalure-spec](novalure-spec/SKILL.md) | Aufgabe proportional beschreiben, beobachtbare Abnahme festlegen |
| [novalure-diagnose](novalure-diagnose/SKILL.md) | Konkretes Fehlersignal aufbauen, Ursache prüfen, Korrektur belegen |
| [novalure-review](novalure-review/SKILL.md) | Anforderungen und Projektstandards am tatsächlich benannten Stand prüfen |
| [novalure-handoff](novalure-handoff/SKILL.md) | Dauerhafte Übergabe getrennt pro Aufgabe speichern |

## Verwendung

Öffne Codex in dieser Arbeitskopie oder einem Unterverzeichnis. Wähle den Skill über `/skills` oder nenne ihn ausdrücklich, zum Beispiel:

```text
$novalure-spec Beschreibe <Aufgabe> anhand der bestehenden Entscheidungen.
$novalure-diagnose Untersuche <konkretes Soll/Ist> in <Revision/Umgebung>.
$novalure-review Prüfe <Basis> bis <HEAD>; beziehe meine Arbeitsänderungen ein.
$novalure-handoff Übergib <task-id> für <nächsten Schritt>.
```

Die Beschreibung ermöglicht auch implizite Auswahl. Laut [offizieller Codex-Dokumentation](https://developers.openai.com/codex/skills/) entdeckt Codex `.agents/skills/` vom Arbeitsverzeichnis bis zur Git-Wurzel. Bei ausbleibender Aktualisierung Client neu starten. Dieses Paket verwendet nur die erforderlichen Metadaten `name` und `description`; optionale UI-/Abhängigkeitsmetadaten sind nicht nötig. Keine globale Installation, keine Setup-Skills oder weiteren Vorlagen.

Aufgaben beginnen in vorhandenen passenden Dokumenten oder `docs/tasks/<task-id>/`; Spezifikation, optionale Diagnose/Review und `handoff.md` gehören zur selben Aufgabe. Eine andere Aufgabe erhält eine andere Kennung. Verweise ersetzen Kopien vorhandener Belege. Keine automatischen Issues oder Labels. Keine Zugangsdaten oder personenbezogenen Kundendaten in allgemeinen Entwicklungsdokumenten.

## Einrichtung und Nachweis

[Quellstand, Originalpfade, Prüfsummen und Anpassungen](UPSTREAM.md), vollständige [MIT-Lizenz](LICENSE). Der [Einrichtungs-Handoff](../../docs/tasks/aihero-skills/handoff.md) hält den tatsächlichen Prüf- und Veröffentlichungsstand fest.

Der Einrichtungsauftrag betrifft Entwicklungsanweisungen. Die parallel laufende Studio-Webchat-Reparatur sowie Kundenchat, Datenbanken, Kalender, Telefonieanschlüsse und Produktionseinstellungen gehören nicht zu dieser Änderung. Für spätere Entwicklungsaufgaben gilt jeweils deren eigener autorisierter Umfang.
