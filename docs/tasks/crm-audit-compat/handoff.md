# CRM-Audit: Aufgabenübergabe

- Repository: [novalure/novalure-crm](https://github.com/novalure/novalure-crm).
- Arbeitszweig: `codex/crm-audit-compat`; getrennte Arbeitskopie.
- Beim Schreiben beobachteter Commit: `93f442853483862712451aeeb0b6e3f0ffcfec41`;
  die Korrektur liegt bis zum folgenden eigenen Commit als Paket-/Lockfile- und
  aufgabenbezogene Dokumentationsänderung vor.
- Erledigt: konkrete Auditdiagnose, Abgleich vorhandener Korrektur in PR #109,
  Verbraucher mit unterschiedlichen Undici-Anforderungen getrennt aufgelöst und
  vorhandene Zod-Auflösung wiederverwendet. Einzelheiten: [Diagnose](diagnosis.md).
- Prüfungen: [maschinenlesbarer Nachweis](verification.json) mit Ergebnis und
  Paketdatei-Hashes; vorhandene Prüfpflichten bleiben bestehen.
- Veröffentlichung: zur Integration in [Skill-PR #110](https://github.com/novalure/novalure-crm/pull/110)
  vorbereitet. Kein Merge, Deployment, Provider-/Datenbank- oder Kundenchat-Eingriff.
- Offen: exakte CI und vertrauenswürdiger Review-App-Check des endgültigen
  integrierten Heads. Lokale Prüfungen ersetzen diese nicht. Die dokumentierte
  Herstellerbundle-Grenze bei CLI-Config bleibt ausdrücklich erhalten.
- Nächster Schritt: den abgegrenzten Korrekturcommit in den bestehenden Skill-PR
  übernehmen, dessen finalen Head prüfen und ausschließlich nach den regulären
  erfolgreichen Gates in `main` integrieren; parallele Kontakt-/Webchatänderungen
  in ihrem bestehenden Zweig erhalten.
