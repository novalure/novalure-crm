# Freigabevereinfachung — 28. November 2026

Eigentümerauftrag: Empfehlungen aus „Prüfe Freigabe-Testregeln“ für laufende und künftige CRM-/Evelyn-Arbeit umsetzen und die laufenden Chats informieren. Branch: `codex/release-simplification-20261128`, Basis: `3058d70804fe6e0ca12a76efefadc69814b6dab0`.

Die [verbindliche Regel](../testing/risk-based-test-policy.md) trennt begrenzte Releases von der weiterhin offenen vollständigen CRM-Abnahme, erhält gültige Nachweise und verlangt eine gemeinsame Abschlussliste. Sie gilt als Eigentümeranweisung bereits für laufende Arbeit. Der echte App-Check, Branchschutz und relevante Sicherheits-/Produktionskontrollen bleiben erforderlich.

Die neue CI-Auswahl verwendet ausschließlich den Classifier der unveränderlichen Basis. Nur unkritische Markdown-Dokumentation und das isolierte Visual-QA-CSS ohne aktive Inhalte dürfen die Produktmatrix ausnehmen. Eine sicher belegte Zuordnung normaler Funktionsänderungen zu begrenzten Abnahmen existiert noch nicht; solche Änderungen, alle unbekannten oder geschützten Pfade und manuelle QA behalten deshalb die volle bisherige Matrix. Die erste Einführung läuft selbst vollständig. Produktionsaudit, Secret-Scan und manuelle geschützte QA bleiben unverändert.

| Umfang / Ziel | Pflichtprüfung | Tatsächliches Ergebnis | Nächster Schritt |
| --- | --- | --- | --- |
| Lokale CI-Auswahl und Herkunft | Node-Tests mit realem temporärem Git-Repo, Rename und manipuliertem Kandidat-Classifier | 5/5 bestanden, keine Skips | Keine Wiederholung ohne relevante Änderung |
| Workflow-Vertrag | YAML-Parsing und AST-Abgleich der bisherigen HIGH-Schritte, Jobnamen, Trigger, Produktionsaudit und manuellen QA | Bestanden | Remote-CI am veröffentlichten Kandidaten |
| Geänderte Skripte | Node-Syntax, gezielter ESLint, Git-Whitespace | Bestanden | Unabhängiger Review des finalen Commits |
| Geschützter Merge / technische CI-Aktivierung | Echte erforderliche CI und exakter Trusted-App-Check | Noch nicht ausgeführt / nicht als bestanden behauptet | Regulärer PR mit erhaltenem Branchschutz |
| Vollständige CRM-Live-Abnahme | Bestehende fachliche Abschlussliste | Unverändert offen; dieser Prozessnachtrag prüft keine Kundenabläufe | Beim bestehenden Releasekoordinator weiterführen |

Die risikobasierte Medium-Entscheidung wird im gemeinsamen Reviewer im Evelyn-Repository implementiert und benötigt dessen eigene geprüfte Aktivierung. Keine Migration, Veröffentlichung, Provideränderung oder Produktivwirkung wurde durch diesen lokalen CRM-Stand ausgeführt.
