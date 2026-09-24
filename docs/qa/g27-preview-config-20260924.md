# G27 Preview-Konfiguration – 24.09.2026

## Ergebnis

G27 bleibt **OPEN / BLOCKED**. Kein A–F-, Race-/Idempotency- oder finaler Live-Security-PASS wird behauptet. Production Impact: **NONE**.

## Neu verifiziert

- NEXT_PUBLIC_APP_URL wurde als Config gespeichert. Exakter Wert: https://novalure-crm-git-codex-crm-production-readiness-g27-novalure.vercel.app
- Scope ausschließlich Preview / codex/crm-production-readiness-g27. UI und Vercel-API bestätigen alle zehn Branch-Variablen; API-Typ des Config-Eintrags ist encrypted, die neun privaten Einträge sind sensitive.
- Neues CRM-Preview: https://novalure-j4qpxzss8-novalure.vercel.app
- Deployment: dpl_54SK7NS7csBYGVWDHHyAF36n7MDX; READY; OIDC-Environment preview; Source redeploy.
- Commit unverändert c43275b4f520fee4bbad5461126ff0650eac9d12; Projekt prj_R32Okl6AHijTohvuKmryuTLjWMsk.
- Evelyn unverändert READY / preview: dpl_Adbe72F6BsmuCYpiHf322GZ1zAn3, https://evelyn-g0yxclae8-novalure.vercel.app, Commit 1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc.
- READ ONLY SQL mit bestehender CRM-QA-Runtime: Projekt super-block-59791927, Branch br-summer-breeze-awuzinct, DB qa_g27_20260923, Rolle g27_qa_20260923. Kein Superuser, CreateDB, CreateRole oder BypassRLS.
- Neon-UI bestätigt separaten G27-QA-Branch unter dem dedizierten QA-Projekt. Der lokale Runtime-URI wurde nicht ausgegeben. Die sensitive Vercel-DATABASE_URL wurde nicht entschlüsselt; aktuelle Runtime-Bindung ist daher nicht durch eine direkte Deployment-SQL-Abfrage attestiert.
- PR #65 erneut geprüft: OPEN / Draft, HEAD c43275b. Kein Merge.

## Offener Isolations-/Cleanup-Nachweis für Evelyn

Der verfügbare private Evelyn-Zugang wurde ausschließlich lesend geprüft. Er verweist auf Projekt weathered-glade-56322908 (evelyn-phase-2b-preview), Branch br-raspy-sunset-b16zkrmu (main, einziger/default Branch), DB neondb, Rolle evelyn_preview_runtime. SQL bestätigt environment=preview und den gespeicherten Deployment-Scope 74eddc2b-cf70-4540-9305-43fed39be141. Dieser Befund betrifft den privaten Zugang; eine frische direkte Bindung dieses URI an das unveränderliche Evelyn-Deployment ist damit noch nicht bewiesen.

Diese Datenbank ist laut Evelyn-Dokumentation eine frühere, synthetische Preview-Datenbank, keine nachgewiesene Production-Datenbank. Sie ist jedoch kein separat löschbarer G27-Branch. Evelyn migrations/001_preview_approval_bridge.sql schützt audit_events und nonces gegen UPDATE/DELETE/TRUNCATE. preview/persistence.ts bietet Session-Löschung, keinen vollständigen G27-Datenreset. Frühere Test-Auditdaten sollen erhalten bleiben.

Der kombinierte G27-Auftrag verlangt vollständigen Cleanup aller neuen Testdaten. Der spätere Provisionierungsauftrag, Phase 8, verbietet zugleich ein neues Evelyn-Deployment und Repinning. Deshalb wird kein vollständig bereinigbarer Live-Pfad behauptet: **QA_DATABASE_ISOLATION_NOT_PROVEN** für den gesamten CRM↔Evelyn-Lauf; STOP vor neuen Seed-/Live-Writes.

Angefragte konkrete Ausnahme: eigener disposable Evelyn-G27-Branch und neues Preview ausschließlich auf unverändertem Evelyn-Commit 1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc; bestehendes Preview, alte Auditdaten und Production erhalten. Noch nicht ausgeführt, Antwort ausstehend.

## Weiterer Befund im vorhandenen Live-Runner

Die ignorierte qa-g27-live-preview.mjs verlangt für E eine bereits persistierte V2-Contract-Revision mit NEEDS_REVIEW-Snapshot. Der aktuelle Datenbank-Trigger crm_evelyn_contract_revision_financial_guard verlangt bei jeder V2-Revision hingegen VERIFIED/COMPLETE. Ein V1-Altbestand führt im V2-Loader vor der Snapshotprüfung zu EVELYN_CONTRACT_VERSION_MISMATCH. Dieser Preseed-Pfad muss vor Ausführung fachlich korrekt an den realen Legacy-Ablehnungspfad angepasst werden; keine Trigger deaktivieren, keine falschen VERIFIED-Zustände und keinen unmöglichen Datensatz erzwingen. Kein tatsächlicher Live-Fehlschlag oder Evelyn-Contract-Defekt wird daraus behauptet.

## Status und Nebenwirkungen

- A–F: alle NOT RUN. Race/Idempotency: NOT RUN.
- live-access.json / live-preseed-private.json / live-browser-private.json: weiterhin unvollständig bzw. nicht erzeugt. LIVE_RUNNER_PRECONDITION_PASS nicht erreicht.
- Seit c43275b keine Anwendungscodeänderung. Frühere 632/632 Tests bleiben historischer Nachweis, wurden in diesem Konfigurationslauf nicht erneut ausgeführt. Finale Regression und Security-Abnahme nach Live-Lauf offen.
- Remote-Änderungen dieses Laufs: genau ein CRM-Preview-Config-Eintrag, ein CRM-Preview-Redeploy und temporäre Vercel-Tokens. Beide temporären Tokens widerrufen und in der UI als nicht mehr vorhanden bestätigt; Prozesswert verworfen. Kein neuer Neon-Key.
- Keine neuen QA-Seeds, Login-Sessions, Approvals oder Business-Writes in diesem Lauf. Datenbankabfragen ausschließlich READ ONLY.
- Kein Production-Deploy, keine Production-Environment-Änderung, kein Production-Datenzugriff, keine Domain-Promotion, kein Merge.
