# G27 – lokale Bereinigung abgeschlossen

Stand: 06.10.2026. A–F, Race/Idempotency, unabhängiger Security-Review, Cloud-Cleanup und die lokale Abwesenheitsprüfung sind PASS. **G27 ist CLOSED.**

Abschlussprüfung 06.10.2026: Alle zwölf exakt benannten privaten QA-Artefakte wurden ausschließlich über ihre Literalpfade auf Existenz geprüft. Keiner der zwölf Pfade war vorhanden. Es wurden keine Artefaktinhalte gelesen und während der Prüfung keine Dateien gelöscht, verschoben oder verändert. Die value-free Evidence ist in [g27-local-cleanup-absence-evidence-20261006.json](g27-local-cleanup-absence-evidence-20261006.json) festgehalten.

Statusabgleich 02.10.2026: Autonomie- und Zugriffsrahmen `2.0.0` löst den früheren reinen Freigabevorbehalt für die eng begrenzte Entfernung dieser eindeutig zugeordneten lokalen QA-Artefakte. Er erzeugt jedoch weder Löschung noch Evidenz: In dieser Governance-Aktualisierung wurde keine der zwölf Dateien entfernt oder auf Abwesenheit geprüft. G27 bleibt deshalb `OPEN`. Eine Fortsetzung muss zuerst die exakten Pfade und den disposable QA-Bezug lesend bestätigen, darf keine unbekannte Datei oder Geschäftsdaten erfassen und muss anschließend die Abwesenheit nachweisen. Sicherheits- oder Ausführungsblockaden dürfen nicht umgangen werden.

Die automatische Ausführungsprüfung hat sowohl einen auf das QA-Verzeichnis begrenzten rekursiven Löschbefehl als auch einen engeren, nicht-rekursiven Befehl mit zwölf expliziten Dateinamen abgelehnt. Rückgabe jeweils: `rejected: blocked by policy`. Eine nähere Begründung wurde nicht geliefert. Die Befehle wurden nicht ausgeführt. Ein Wechsel auf ein anderes Löschwerkzeug zur Umgehung dieser Ablehnung erfolgt nicht.

## Abgeschlossene eng begrenzte Aktion

Im Windows-Explorer dieses Verzeichnis öffnen:

```text
C:\Users\Franz\Documents\Codex\2026-05-11\ich-verwende-hubspot-starter-kannst-du\novalure-crm\.codex-worktrees\g27-production-readiness\.npm-cache\g27
```

Die folgenden zwölf relativen Pfade wurden am 06.10.2026 als nicht vorhanden bestätigt:

1. `preview-private.json`
2. `preview-secrets-private.json`
3. `neon-bootstrap-private.json`
4. `preview.env`
5. `old-preview.env`
6. `neon-bootstrap-20260923/runtime-private.json`
7. `neon-bootstrap-20260923/g27-full.dump`
8. `recovery-probe-20260924/full.dump`
9. `recovery-verify-20260924-v2/full.dump`
10. `private-live/live-access.json`
11. `private-live/live-browser-private.json`
12. `private-live/live-preseed-private.json`

Keine Dateien öffnen oder Inhalte in eine Nachricht kopieren. Die allgemeine `.env.local`, Repository-Dateien, CLI-Anmeldedaten und andere Projektverzeichnisse gehören nicht zu dieser Liste.

Die Abwesenheitsprüfung ist PASS. Die bereits bestandenen Live-Tests wurden nach dem absichtlichen Entfernen der QA-Umgebung nicht gegen eine andere Umgebung wiederholt.

## Gesicherter Wiederaufnahmepunkt

- CRM-Live-Commit: `5058b06d71d3e48716249bd484a544b4244e6a4c`.
- Evelyn-Live-Commit: `1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc`.
- Live-Lauf: 24.09.2026, 13:41:31–13:42:45 UTC, 220/220 Assertions.
- Lokale Regression: 666/666 Tests; Typecheck/Lint/Build/Audit/Secret-Scan PASS.
- Security-Review: 0 Critical / 0 High.
- Beide disposable Datenbankbranches und alle zugehörigen QA-Previews/branchgebundenen Variablen sind entfernt.
- Temporärer Vercel-Metadaten-Token widerrufen; Evelyns private QA-Dateien entfernt.
- PR #65 bleibt Draft. Kein Merge. Kein Production-Deploy. `PRODUCTION IMPACT = NONE`.

`CONTROL | RESULT | EVIDENCE`

`G27 | CLOSED | PASS_ALL_TWELVE_ABSENT; docs/qa/g27-local-cleanup-absence-evidence-20261006.json`
