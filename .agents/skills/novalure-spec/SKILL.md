---
name: novalure-spec
description: "Erstellt im aktuellen Novalure-Projekt eine angemessene Spezifikation aus vorhandenem Auftrag, Anforderungen und Entscheidungen. Für neue Features, klar abzugrenzende Änderungen und Entwicklungsaufgaben vor der Umsetzung."
---

# Novalure Spec

1. Lies die geltenden Agentenanweisungen und den [Projektkontext](../PROJECT.md). Prüfe Repository, Branch, Arbeitsänderungen und die für diese Aufgabe relevanten Anforderungen, Entscheidungen und Freigaben. Nutze vorhandene Spezifikationen und ADRs; erfinde keine neue Entscheidung oder Freigaberunde.
2. Beschreibe das konkrete Nutzerproblem, das gewünschte Ergebnis, den betroffenen Umfang und die Abgrenzung. Eine kleine Korrektur braucht nur wenige Absätze; größere Änderungen erhalten passende Abläufe, Schnittstellen und Abhängigkeiten. Keine künstlich lange User-Story-Liste.
3. Formuliere beobachtbare Akzeptanzkriterien und den kleinsten geeigneten Prüfansatz an vorhandenen Schnittstellen. Berücksichtige betroffene Mandanten-/Rollenrechte, Fehlerfälle und externe Wirkungen, soweit relevant. Verlinke vorhandene Nachweise; unveränderte Prüfungen nicht ohne Grund wiederholen. Bestehende Pflichtgates bleiben maßgeblich.
4. Halte bestätigte Entscheidungen, Annahmen und tatsächlich offene Fragen getrennt. Frage nur nach einer fehlenden Entscheidung, wenn davon Arbeit abhängt; nutze gültige vorhandene Freigaben im jeweiligen Scope weiter.
5. Ergänze die bestehende Aufgabendatei oder speichere unter `docs/tasks/<task-id>/spec.md` ab Repository-Wurzel. Verwende eine eindeutige Aufgabenkennung und relative Links auf maßgebliche Quellen. Veröffentliche Issues oder Labels nur bei gesondertem Auftrag, niemals automatisch aufgrund dieses Skills.

Ergebnis: kurze, umsetzbare Aufgabenbeschreibung mit Problem/Ziel, Scope, Entscheidungen/Quellen, Abnahme/Prüfung, offenen Punkten und nächstem Schritt. Keine Zugangsdaten oder personenbezogenen Kundendaten in allgemeinen Entwicklungsdokumenten.

Adaptiert aus `to-spec`; [Quellstand und MIT-Lizenz](../UPSTREAM.md).
