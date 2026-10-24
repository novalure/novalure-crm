---
name: novalure-handoff
description: "Speichert eine kurze, dauerhafte und aufgabenbezogene Novalure-Übergabe, damit die nächste Sitzung zuverlässig fortsetzen kann. Für Sitzungsende, Agentenwechsel oder Unterbrechungen einer Entwicklungsaufgabe."
---

# Novalure Handoff

1. Lies geltende Anweisungen und den [Projektkontext](../PROJECT.md). Prüfe den tatsächlichen Repository-/Branch-/Commit- und Arbeitsstand, statt ihn aus der Unterhaltung zu raten.
2. Ergänze die Übergabe dieser Aufgabe unter `docs/tasks/<task-id>/handoff.md` ab Repository-Wurzel; nutze für eine andere Aufgabe eine andere Kennung. Bestehende aufgabenspezifische Ablage kann weiterverwendet werden. Kein ausschließlich temporäres Verzeichnis und kein gemeinsames überschriebenes Latest-Dokument.
3. Halte knapp diese Felder fest:
   - Repository (Name/URL), Branch, beim Schreiben beobachteter vollständiger Commit-SHA und relevante staged/unstaged/untracked Änderungen.
   - Erledigte Arbeit und maßgebliche Anforderungen/Entscheidungen als Links.
   - Tatsächlich ausgeführte Prüfungen mit Ergebnis, Revision, Umgebung und vorhandenen Nachweisen; fehlende oder berichtete Nachweise getrennt kennzeichnen.
   - Veröffentlichungsstand: lokal/committed/gepusht, PR und Review-/CI-Stand; Merge, Preview, Deployment oder Produktion nur soweit belegt.
   - Offene Punkte, verbleibende Grenzen/Blocker und vorhandene gültige Freigaben mit ihrem Scope.
   - Genau nächster ausführbarer Schritt mit Einstieg und gegebenenfalls passendem `$novalure-spec`, `$novalure-diagnose` oder `$novalure-review`.
4. Verlinke Spezifikation, Diagnose, ADR, Commit, PR und Testbeleg statt deren Inhalt erneut zu kopieren. Ein beobachteter SHA ist ein Snapshot; die Übergabedatei kann ihren eigenen zukünftigen Commit-SHA nicht enthalten. Kennzeichne nachträgliche Arbeitsänderungen ehrlich.
5. Speichere die Datei tatsächlich und nenne ihren Pfad. Beziehe sie in den üblichen Commit-/PR-Prozess ein; prüfe vor Veröffentlichung auf Zugangsdaten und personenbezogene Kundendaten. Fremde Änderungen erhalten. Ein Handoff erweitert keine Rechte und ersetzt keine unabhängige Prüfung.

Adaptiert aus `handoff`; [Quellstand und MIT-Lizenz](../UPSTREAM.md).
