---
name: novalure-review
description: "Prüft Novalure-Änderungen gegen Projektstandards und beauftragte Anforderungen und nennt den tatsächlichen Prüfstand. Für Branches, PRs sowie ausdrücklich einbezogene staged, unstaged und untracked Arbeitsänderungen."
---

# Novalure Review

1. Lies geltende Anweisungen, den [Projektkontext](../PROJECT.md) und die maßgebliche Aufgabe/Spezifikation. Ermittle den beauftragten Vergleich; nutze eine vorhandene eindeutige Basis, sonst kläre die fehlende Basis. Löse Referenzen zu SHAs auf und notiere Repository, Branch, Basis, Merge-Base und geprüften HEAD. Prüfe den tatsächlichen Diff und betroffenen Kontext.
2. Benenne den Umfang ausdrücklich: Commit-/PR-Review oder Arbeitsänderungen. Für Commit-Änderungen kann `git diff <basis>...HEAD` dienen. Bei einem WIP-Review zusätzlich `git status --short`, `git diff --cached`, `git diff` und den relevanten Inhalt ungetrackter Dateien erfassen. Ein HEAD-Diff allein erfasst diese Arbeitsänderungen nicht. Verändere, stash oder verwerfe sie nicht.
3. Binde einen WIP-Befund an einen nachvollziehbaren Snapshot (z. B. Patch und Inhalts-Hashes der einbezogenen Dateien, einschließlich Löschungen); halte sensible Inhalte aus allgemeinen Artefakten fern. Änderungen nach dem Snapshot machen die betroffenen Befunde veraltet. Leerer Diff oder fehlende Quellen werden als solche benannt.
4. Prüfe zwei Blickwinkel getrennt: **Projektstandards** (geltende Architektur-, Sicherheits- und Arbeitsregeln) und **Anforderungen** (Ergebnis, Abnahme, Scope). Prüfe relevante Folgewirkungen wie Rechte, Datenfluss, Fehler-/Retryverhalten, UI oder Schnittstellen nach Art der Änderung. Keine pauschale neue Smell- oder Volltestpflicht; vorhandene Prüfergebnisse gezielt nutzen.
5. Melde nur begründete, handlungsrelevante Befunde mit Schweregrad, Datei/Stelle, konkreter Auswirkung und Quelle. Trenne belegte Fehler von Unsicherheiten; nenne tatsächlich ausgeführte Checks und ungeprüfte Bereiche. Ohne Spezifikation ist der Anforderungsabgleich entsprechend begrenzt.
6. Erhalte den bestehenden unabhängigen Review-Prozess und seine exakte Revisionsbindung. Diese Analyse ersetzt weder den vorgeschriebenen unabhängigen Reviewer noch CI, Review-App-Check oder Freigaben. Ein WIP-Review ist keine Attestierung eines späteren Commits. Bei Bedarf Ergebnis unter `docs/tasks/<task-id>/review.md` speichern und vorhandene PR-/Check-Nachweise verlinken.

Keine Zugangsdaten oder personenbezogenen Kundendaten in allgemeine Review-Dokumente übernehmen.

Adaptiert aus `code-review`; [Quellstand und MIT-Lizenz](../UPSTREAM.md).
