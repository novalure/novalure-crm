# G27 – verbleibende lokale Bereinigung

Stand: 24.09.2026. A–F, Race/Idempotency, unabhängiger Security-Review und Cloud-Cleanup sind PASS. Die lokale Entfernung der folgenden privaten QA-Dateien ist noch offen.

Die automatische Ausführungsprüfung hat sowohl einen auf das QA-Verzeichnis begrenzten rekursiven Löschbefehl als auch einen engeren, nicht-rekursiven Befehl mit zwölf expliziten Dateinamen abgelehnt. Rückgabe jeweils: `rejected: blocked by policy`. Eine nähere Begründung wurde nicht geliefert. Die Befehle wurden nicht ausgeführt. Ein Wechsel auf ein anderes Löschwerkzeug zur Umgehung dieser Ablehnung erfolgt nicht.

## Erforderliche manuelle Aktion

Im Windows-Explorer dieses Verzeichnis öffnen:

```text
C:\Users\Franz\Documents\Codex\2026-05-11\ich-verwende-hubspot-starter-kannst-du\novalure-crm\.codex-worktrees\g27-production-readiness\.npm-cache\g27
```

Nur diese zwölf Dateien entfernen; Pfade sind relativ zum obigen Verzeichnis:

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

Anschließend „lokale QA-Dateien gelöscht“ melden. Codex prüft ihre Abwesenheit lesend und aktualisiert erst danach den G27-Abschlussstatus. Bereits bestandene Live-Tests dürfen nach dem absichtlichen Entfernen der QA-Umgebung nicht gegen eine andere Umgebung wiederholt werden.

## Gesicherter Wiederaufnahmepunkt

- CRM-Live-Commit: `5058b06d71d3e48716249bd484a544b4244e6a4c`.
- Evelyn-Live-Commit: `1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc`.
- Live-Lauf: 24.09.2026, 13:41:31–13:42:45 UTC, 220/220 Assertions.
- Lokale Regression: 666/666 Tests; Typecheck/Lint/Build/Audit/Secret-Scan PASS.
- Security-Review: 0 Critical / 0 High.
- Beide disposable Datenbankbranches und alle zugehörigen QA-Previews/branchgebundenen Variablen sind entfernt.
- Temporärer Vercel-Metadaten-Token widerrufen; Evelyns private QA-Dateien entfernt.
- PR #65 bleibt Draft. Kein Merge. Kein Production-Deploy. `PRODUCTION IMPACT = NONE`.

`BLOCKER | BENÖTIGTE RESSOURCE | WO SIE ERWARTET WIRD | WARUM NICHT VERFÜGBAR | EXAKTE AKTION`

`LOCAL_QA_CLEANUP_POLICY_BLOCKED | Entfernung der zwölf lokalen QA-Dateien | oben genanntes .npm-cache/g27 | automatische Ausführungsprüfung lehnt beide Löschvarianten ab | zwölf benannte Dateien manuell löschen und Abwesenheit lesend bestätigen lassen`
