# CRM G08 Final Live Verification

**CRM G08 FINAL LIVE VERIFICATION: PASS. G08 STATUS: CLOSED. Stand: 2026-09-17, isolierter synthetischer Preview-Umfang.** Die tatsächliche CRM-Vercel-Preview hat die gepinnte Evelyn-Preview mit ihrer eigenen verifizierten Dienstidentität erreicht. Der vollständige Live-Lauf bestand **21/21** Prüfungen; der gesonderte schreibgeschützte Datenbankabgleich bestand **50/50**. Lokal: **501/501** CRM-Tests; separat **27/27** signierte Evelyn-Policytests. Abschließender unabhängiger Sicherheitsreview **PASS**, **18/18 High-Gaps geschlossen**, **0 Critical / 0 High / 8 Medium offen** im dokumentierten Umfang.

Alle folgenden Live-Ergebnisse beziehen sich auf Codecommit `137c796534d60cd0c5be69097632076c817295ee`, nicht auf einen späteren reinen Dokumentationscommit. PR #63 ist nach bestätigter vollständiger Abnahme auf **Ready for Review** gesetzt. Kein Evelyn-Vertragsfehler wurde im geprüften Umfang gefunden. Keine Production-Änderung, kein Merge. Der [bereinigte portable Abschlussnachweis](../../qa/g08-final-live-evidence.json) enthält die konkreten Live-/HTTP-/DB-/Auditprüfungen, Infrastruktur- und CI-Ergebnisse sowie den unabhängigen Review mit gebundenen Quelldigests und Evidenzhashes.

## Verbindliche Identität und Umfang

| Feld | Nachgewiesener Stand |
| --- | --- |
| CRM Repository / Branch | `novalure/novalure-crm` / `codex/crm-sales-readiness-high-gaps` |
| CRM PR | [#63](https://github.com/novalure/novalure-crm/pull/63), **Ready for Review**; kein Merge |
| CRM Ausgangscommit | `071ce1d2e93279487f56864a0125048676f7bd58` |
| CRM Implementierungscommit | `137c796534d60cd0c5be69097632076c817295ee` — gepusht, lokal und live geprüft. Vorheriger Live-Harness-Stand `461f42bdea91fce2406fe9ade162a8fd06f9aab1`; erste Implementierung `cd1f2f1dbc84a192eeeb09733017f1a9de1dec24`. |
| CRM Preview-Branchalias | [CRM QA-Preview](https://novalure-crm-git-codex-crm-sales-readiness-high-gaps-novalure.vercel.app), tatsächlicher authentifizierter Live-Lauf PASS |
| CRM finale Deployment-ID / tatsächlicher Runtime-Commit | `dpl_G9XNizikjr2hmwr4VX4FCaurQebP`, **READY**, `target=null`, Runtime-Commit `137c796534d60cd0c5be69097632076c817295ee`; [unveränderliche Deployment-URL](https://novalure-1h0rjkzj2-novalure.vercel.app) |
| Erwartetes CRM Vercel Project | `prj_R32Okl6AHijTohvuKmryuTLjWMsk` |
| Erwartetes Novalure Team | `team_sjD78IkSicXJK6TAOR1JC7Wv` |
| Evelyn Vertrag | [PR #4](https://github.com/novalure/evelyn/pull/4), Branch `feat/phase-2b-approval-bridge`, Commit `56e26c2b063319813076a3bc181473f484b1d490`; ausschließlich gelesen |
| Evelyn Preview | [Gepinnte Evelyn-Preview](https://evelyn-hrc1fof30-novalure.vercel.app/) |
| Evelyn Deployment / Runtime | `dpl_3QqVWDeuP5Y2xJLtfAij1jVYupX9`, **READY**, `target=null`, Runtime-Commit `2a74334e418fb1da346f7b033fc4e94cce303a1c`; unverändert |
| Erlaubte Wirkung | Eine serverseitig freigegebene, persistierte `SYNTHETIC_CONTRACT_SEND`-Ausführung; keine Vertragszustellung und keine Zahlung |
| Production DB geändert | **NEIN** |
| Production CRM deployed | **NEIN** |
| Production Evelyn aktiviert | **NEIN** |

Die Implementierung folgt dem vorhandenen Dynamic Approval Request-, Verify-, Service-Authentication-, Environment-/Project-Binding-, Hash-/Versions- und Auditvertrag. Es wurde keine zweite Evelyn-API eingeführt. Das Verify-Body enthält genau `approvalReference`, `tenantId`, `actionId`, `actionType`, `resourceId`, `actionVersion`, `actionHash`, `correlationId`. Das Environment wird nicht im Verify-Body übergeben.

Der gepinnte Evelyn-Quellstand `56e26c2` ist nicht der Buildcommit der bestehenden Preview. Der unabhängige abschließende Read-only-Abgleich bestätigt identische Runtimequellen zwischen `2a74334` und `56e26c2`; unterschiedlich sind exakt `README.md`, `docs/README.md`, `docs/testing/evidence/phase-2b1-infrastructure.json`, `docs/testing/evidence/phase-2b1-live-preview.json`, `docs/testing/evidence/phase-2b1-local.json` und `docs/testing/phase-2b-results.md`. Das Evelyn-Repository blieb sauber und unverändert; es gab kein Evelyn-Redeployment und keine Änderung an PR #4.

## Umsetzung und tatsächliche lokale Nachweise

- [Serverclient](../../../src/lib/evelyn-approval-client.ts): ausschließlich Approval Request und Verify; live ausschließlich Vercel Preview mit gepinntem Project/Team. Service Identity und Deployment Protection werden getrennt behandelt. CRM kann keinen der beiden Owner-Schritte auslösen. Der Client akzeptiert zur Ausführung ausschließlich eine streng gebundene `VALID`-Antwort.
- [CRM-API](../../../src/app/api/crm/evelyn-contracts/route.ts): persistierte authentifizierte Workspace-Session, Schreibcapability und CSRF; strikte Felder, Preview-/Project-Gate und `no-store`. Gefälschte Owner-Header oder Dienst-Bearer ersetzen keine CRM-Benutzersession.
- [Repository](../../../src/lib/db/evelyn-contract-repositories.ts) und [Migration 086](../../../migrations/086_crm_evelyn_preview_contract.sql): leere, ausdrücklich zu registrierende QA-Allowlist; identische CRM-Workspace- und Evelyn-Tenant-ID; keine freie Tenant-Umschreibung. Quelle ist eine kanonische angenommene, aktuell freigegebene synthetische CRM-Angebotsrevision mit zugehörigem Annahme-Auditbeleg.
- Eine Angebotsquelle erhält genau eine Vertragsaktionslinie. Eine deterministische Action-/Resource-ID sowie `UNIQUE(workspace_id,offer_id)` verhindern zusätzliche Ausführungen über neue Idempotency-Keys. Betragsänderungen erzeugen unveränderliche neue Revisionen; die alte ApprovalReference wird nicht übernommen.
- Der externe Request/Verify läuft außerhalb der Datenbanktransaktion. Vor einer Wirkung werden Actionversion, Actionhash, Quellangebotversion, Angebotsrevision, Freigabe und Contentdigest unter Datenbanklocks erneut geprüft. Wirkung, Audit und Receipt committen atomar. Wiederholungen liefern das autorisierte gespeicherte Ergebnis; unterschiedliche Payloads mit derselben Idempotenzidentität werden abgewiesen.
- Der Betrag wird aus den Angebotspositionen abgeleitet: **990.000 + 3 × 349.000 = 2.037.000 Cent = 20.370 EUR netto**. Eine freigegebene Vertragsvorlage wird nicht erfunden: `approvedTemplate=false`. Die lokale Vertragsprüfung erwartet zwei Freigabeschritte.

Die neuen DB-Tests führen echte PostgreSQL-Transaktionen und den echten CRM-Angebotsablauf bis zur Annahme aus. Ihr Evelyn-Transport ist ausdrücklich injiziert und simuliert. Dieser Testpfad ist nur mit `NODE_ENV=test`, explizitem Pool, Loopback-Datenbank und ohne Vercel-Umgebung erreichbar. Die bestehende lokale Approval-Simulation aus Migration 085 wurde nicht zu einer Live-Autorität umgewidmet.

## Lokale Tests und Qualitätsgates

**501/501 PASS, 0 fehlgeschlagen, 0 übersprungen, 0 abgebrochen im aktuellen lokalen Teststand nach dem Cookie-Fix.** Ausgeführt mit Node **24.14.0** und npm **11.9.0**. Die komplette bestehende G24-Baseline von **450/450** wurde nach dem Fix nochmals ausgeführt. Zusätzlich: **26 Client-/Vertragstests, 12 DB-Tests und 13 HTTP-Boundary-/Cookie-/Securitytests**. Eltern von Node-Untertests sind entsprechend der vorhandenen Baseline mitgezählt; die folgenden Kategorien sind disjunkt. Der zuvor dokumentierte 493er-Lauf bleibt ein früherer lokaler Stand.

| Kategorie | Bestehende Baseline | G08 zusätzlich | Ergebnis |
| --- | ---: | ---: | ---: |
| Unit | 236 | 0 | **236/236 PASS** |
| Integration | 25 | 0 | **25/25 PASS** |
| Migration/DB | 34 | 12 | **46/46 PASS** |
| RBAC/Security | 74 | 13 | **87/87 PASS** |
| Workflow | 61 | 0 | **61/61 PASS** |
| Contract | 0 | 26 | **26/26 PASS** |
| E2E, lokal | 20 | 0 | **20/20 PASS** |
| **Total** | **450** | **51** | **501/501 PASS** |

Die Rohsuites der 450er-Baseline sind `test:unit` 232, `test:integration` 15, `test:sales` 90, `test:sales:final` 50, `test:protected-preview-access` 17, `test:sales:migrations` 15, `test:neon:061` 11 und `qa:sales:e2e` 20. `test:g08` enthält die 51 neuen Prüfungen. Die Umordnung in fachliche Kategorien zählt keinen Test doppelt.

Zusätzlicher unabhängiger kryptografischer Nachweis, **gesondert von den 501 CRM-Tests gezählt: 27/27 PASS**, 0 fehlgeschlagen/übersprungen/abgebrochen. Die unveränderte archivierte Evelyn-Testdatei `tests/bridge-security/crm-preview-auth.test.ts` und ihre Quellen stammen exakt aus Commit `56e26c2b063319813076a3bc181473f484b1d490`; das ursprüngliche Evelyn-Repository blieb unverändert. Dieser separate Lauf verwendete **Node 24.18.0**, kurzlebige lokale RS256-Testschlüssel und injizierte lokale JWKS, mit Netzwerk-, Dateischreib- und Subprozesssperren. Es wurden **keine echten Vercel-Tokens**, keine geerbten Credentials, kein Netzwerk und keine Production verwendet.

Die 27 Evelyn-Tests prüfen unter anderem signierte Project-/Team-/Issuer-/Audience-/Environmentbindungen, Ablauf und Zeitfenster, manipulierte Signaturen, Tenantbindung und Request-/Routennonces. Die signierten Identitätsnegativfälle betreffen `approvals:create`; positive Quellidentität und die getrennten Routendomänen decken Create und Verify ab. Das ist ein lokaler Signatur-/Policy-Nachweis und weiterhin **kein Live-Vercel-Identity-Nachweis**. Bereinigte Evidenz: `.npm-cache/g08/evelyn-local-crypto-evidence.json`.

Die Clienttests vergleichen Hash und Route-JTI mit dem gepinnten Evelyn-Vertrag. Geprüft sind die acht Verify-Felder; Betrags-/Empfänger-/Inhalts-/Tenant-/Resource-/Versionsänderung; PENDING, EXPIRED, REJECTED, VERSION_MISMATCH, ACTION_MISMATCH, TENANT_MISMATCH; HTTP 400/401/403/409/429/5xx; Timeout, Nichterreichbarkeit, ungültiges JSON, HTML/Protection-Antwort, zu große Antwort, falsche Bindung und gescheiterter Identitätsbezug. Diese Antworten sind lokale Transportfixtures.

Die zusätzlichen DB-Tests prüfen fehlende QA-Freigabe, falsches Tenantmapping, fehlende Angebotsannahme, parallele Erstellung mit verschiedenen Keys, identischen Replay, doppelte Requests, identische Correlation, fehlende Projektbefugnis, PENDING ohne Wirkung, frisches doppeltes Verify, parallele Ausführung genau einmal, Betragänderung mit alter Referenz, Änderungen während des externen Aufrufs, Auditrollback und Unveränderlichkeit/RLS. Der Dispatcher wird auf den tatsächlichen Audit-Operationsnamen geprüft. Die API-Boundarytests verweigern lokale, fremde Preview- und Production-Kontexte einschließlich gefälschter HTTP-Identitätsheader.

| Qualitätsgate | Ergebnis / Grenze |
| --- | --- |
| Typecheck | **PASS** |
| Lint, ohne Warnungen | **PASS** |
| Build | **PASS**, lokaler Build; kein Deployment-Nachweis |
| Dependency Audit | **PASS**, vollständiger Audit: 0 Critical/High/Moderate/Low; Dependencies und auditierter Lockfile beim Cookie-Fix unverändert |
| Secret Scan | **PASS**, aktueller Dateistand sowie 133 Commits; sechs bestehende exakte historische False-Positive-Ausnahmen unverändert, keine neue Ausnahme |
| Unabhängiger finaler Security-Review | **PASS**, geprüfter Codecommit und stabile Live-/DB-Evidenz stimmen überein; keine verbleibenden bestätigten High-/Critical-Befunde im dokumentierten Umfang |
| GitHub CI auf `137c796` | **PASS**, [Secret scan](https://github.com/novalure/novalure-crm/actions/runs/35269720280) und [Go-live quality gates](https://github.com/novalure/novalure-crm/actions/runs/35269720455), beide `completed/success` |

Bereinigte lokale Rohlogs liegen ignoriert unter `.npm-cache/g08/`: `local-gates.json`, `baseline-*.log`, `client-tests.log`, `db-tests.log`, `route-boundary-tests.log`, `typecheck.log`, `lint.log`, `build.log`, `dependency-audit.json`, `secret-scan-staged.json`, `secret-scan-history.json`. Credentials, Protection-Werte und private QA-Dateien gehören nicht zum Bericht oder PR.

Die erneuten Nachweise nach der Cookie-Korrektur stehen gesondert in `baseline-*-cookie-fix.log`, `g08-client-db-cookie-fix.log`, `route-boundary-cookie-fix.log`, `typecheck-cookie-fix.log`, `lint-cookie-fix.log`, `build-cookie-fix.log`, `secret-scan-cookie-fix.json` und `secret-scan-cookie-fix-history.json`. Typecheck, Lint, Build und Secret Scan bestanden auch auf diesem korrigierten Stand; unabhängiger Review des eng begrenzten Fixes: PASS.

Das aktuelle Quellmanifest `.npm-cache/g08/source-manifest.json` bindet **505 Dateien** an Codecommit `137c796534d60cd0c5be69097632076c817295ee`; Gesamtdigest: `706a5bc30877a8ad4a634dad7d9ee0335795d587ee697add1f022e1e1eb99295`. Dieser Commit stimmt mit lokalem Gatebericht, beiden CI-Läufen und dem tatsächlich geprüften READY-Deployment überein.

Der unabhängige finale Reviewer hat dieses **505-Dateien-Manifest vollständig gegen den Checkout und den geprüften Commit abgeglichen**. Sein eigener, getrennt definierter 504-Dateien/LF-Digest lautet `feb09fe36f382115d788681b7179f83c1adf438483b80f96a3fd00bfec908bdf`; die unterschiedlichen Dateimengen und Algorithmen werden nicht gleichgesetzt. Das stabile Reviewartefakt hat SHA-256 `5296c527eabaa0305d6bdd6e3f3be257396d97d3037a8c95b191dab179357a3a`. Es bindet den finalen Livebericht sowie den Read-only-DB-Bericht über deren tatsächliche Dateihashes und ordnet alle 18 ursprünglichen High-Gaps mit konkreten Nachweisen und Grenzen ein. Geprüft sind insbesondere Dienstidentität, Spoofing, Server-only-Secrets, Protection, Environment/Tenant, Hash/Version, Replay/Idempotenz, Fail Closed und Audit. Keine bestätigten verbleibenden Critical-/High-Befunde; keine Merge- oder Productionfreigabe.

Frühere Fehlversuche bleiben Fehler: Der erste G08-DB-Start scheiterte an Windows-Sandbox-/PostgreSQL-Prozessrechten. Beim anschließenden echten Lauf wurden fehlende Lockberechtigungen der ausschließlich lesbaren Allowlist und eine Mikrosekunden-/Millisekunden-Grenze in der synthetischen Versandbeleg-Fixture sichtbar. Der eng begrenzte Allowlist-Lockhelper und die Fixture wurden korrigiert; der finale DB-Lauf bestand 12/12. Frühere lokale Test-/Harnessfehler sind weder Previewfehler noch nachträglich als PASS deklarierte Durchläufe.

## Live-Gates und Preview-Flows

| Angefordertes Feld | Aktueller Ergebnisstatus |
| --- | --- |
| LIVE CRM→EVELYN | **PASS**, echte Cross-Project-Requests aus dem CRM-Previewserver |
| REAL CRM VERCEL IDENTITY | **PASS**, Evelyn-Auditactor `crm-preview`, geprüftes CRM-Quellprojekt; Owner-Session/ungültiger Bearer live mit 401 verweigert |
| EXPECTED CRM PROJECT | **PASS**, `prj_R32Okl6AHijTohvuKmryuTLjWMsk` in beiden Evelyn-Auditketten |
| PREVIEW ENVIRONMENT | **PASS**, tatsächliches CRM-Previewdeployment und Preview-only Trust; Production-Negativtests lokal signiert |
| DEPLOYMENT PROTECTION | **PASS**, beide geschützten Previews erreichbar; SSO/Protection unverändert, nur Preview→Preview-Trust ergänzt |
| EVELYN SERVICE AUTH | **PASS**, echte verifizierte CRM-Workload; unabhängige Owner-Session ist kein Dienstauthersatz |
| DYNAMIC APPROVAL REQUEST | **PASS**, HTTP 200/PENDING, `requiredSteps=2`, Request-Replay gleiche Referenz |
| CONTRACT.SEND 20370 EUR | **PASS**, vollständige 2.037.000-Cent-Aktion; exakt eine synthetische DB-Wirkung nach frischem VALID |
| STEP 1 ONLY | **DENIED PASS**, CRM HTTP 409 `EVELYN_PENDING`, keine Wirkung |
| STEP 1 + STEP 2 | **VALID PASS**, getrennte Owner-Reauthentifizierungen und Entscheidungen; anschließendes frisches CRM-Verify HTTP 200/VALID |
| ACTION IMMUTABILITY | **PASS**, 20.370,00 → 20.371,00 EUR, Revision 2/neuer Hash; alte Referenz und neue noch nicht freigegebene Aktion blockiert |
| TENANT BINDING | **PASS**, registrierte QA-Workspace-ID entspricht Evelyn-Tenant; Body-Overrides und fremder Scope live verweigert, Persistenz unabhängig geprüft |
| REPLAY PROTECTION | **PASS**, alte Referenz und zweite Ausführungsidentität verweigert; signierte Routennonce zusätzlich lokal geprüft |
| IDEMPOTENCY | **PASS**, Request-/Verify-/Ausführungswiederholungen und Payloadkonflikt; DB bestätigt genau eine Wirkung |
| FAIL CLOSED | **PASS**, tatsächlich ausgeführte Live-Negativfälle plus gesonderte lokale Fehler-/Signaturmatrix unten |
| CROSS-SYSTEM AUDIT | **PASS**, zwei Correlationketten mit verifiziertem CRM-Quellprojekt, Owner-Schritten, Verify und persistiertem CRM-Audit |
| FLOW A PREVIEW | **PASS**, Accepted und Rejected einschließlich gestopptem Follow-up; Accepted bis synthetischem contract.send mit realem Evelyn-Two-Step |
| FLOW B PREVIEW | **PASS**, Qualifizierung/Priorisierung/Handover/Besichtigung/Reservierung/Verkauf; Unit `sold`, jeweils ein Handover, abgeschlossene Besichtigung und Sale |

Der tatsächliche Live-Lauf dauerte von `2026-09-17T20:17:24.554Z` bis `2026-09-17T20:27:01.001Z`. Der CRM-Browser absolvierte Passwort und MFA; die Session war opak, HttpOnly und Secure. Die Owner-Schritte liefen außerhalb des CRM in einer separaten authentifizierten Evelyn-Test-Owner-Session. Beide Schritte wurden vom vorgesehenen Test-Owner mit jeweils frischer Reauthentifizierung durchgeführt; es wird keine Freigabe durch zwei verschiedene Personen behauptet. Der Owner-Logout antwortete mit HTTP 200. Authentifizierte CRM-UI-Aufrufe zeigten die persistierten Outcomes ohne unbehandelte Browserexception.

| Live-Aktion | Persistierter Nachweis |
| --- | --- |
| Erfolgreicher synthetischer Vertrag | Action `bd1def2e-a8bf-40b3-a0da-a0de6477c076`, Correlation `2f082152-e59a-41d1-97d3-4f4506f6513d`, Version 1, Hash `78ed508f4c5243e14e60110ed043b8103342aa21793a40af466b3ee83fa3e679`, Approval `f41f4976-3db5-4e80-84bf-09d9b5bc3e49`, genau eine Execution `03f47810-4525-4ceb-ae9d-f55710a25e6a` |
| Nach Freigabe geänderte Aktion | Action `da8787f2-578b-4d6e-9996-8094682f2088`, Correlation `a4500dee-ba13-4150-85e7-fc7870a7bc6c`; ursprünglicher Hash `13ec07320c1683ee69094c86fb30c20971dfb21fe6357ca8ca9a5787e32968a0` und Approval `b47fc200-c402-42bc-9afb-c4a5c1441cb2`; neue Version 2 mit 2.037.100 Cent, Hash `f6da627d69f57675811c5819f1af7bf28c79c428444ccb147076743412915492`, neue PENDING-Approval `1e0aba7a-f944-4569-b2dd-cbea8e91ad76`; **0 Executions** |

Die gesonderte Datenbankprüfung lief in einer Read-only-Transaktion mit der nicht privilegierten QA-Runtime-Rolle: **50/50 PASS, 0 Datenbankschreibzugriffe**, abgeschlossen `2026-09-17T20:27:27.791Z`. Sie bindet exakt den finalen Livebericht über SHA-256 `7dad72b7282db617fd36e4afda48b2755df286cf5d37b433af231aee885dcdeb`. Geprüft wurden kanonische Hashes, Offer-/Revisionsbindung, Approvalreferenzen, Wirkungsanzahl, CRM-Domain-/Command-Audit samt HTTP-Auditreferenzen, Evelyn-Correlationketten und beide fachlichen Flows. Die erste Aktion hat eine Revision/eine Approval/eine Execution; die geänderte Aktion zwei Revisionen/zwei Approvals/keine Execution. Alle drei Flow-A-Angebote besitzen je einen manuell attestierten Versandbeleg und keine offenen Follow-ups. Kein E-Mail- oder Vertragsprovider wurde verwendet.

Die Fehlernachweise werden nach ihrer tatsächlichen Ausführungsumgebung getrennt:

| Fall | Echte Preview | Ergänzende lokale Prüfung |
| --- | --- | --- |
| Fehlende ApprovalReference | HTTP 409 `APPROVAL_REFERENCE_REQUIRED` vor Request/Execution | Repository- und Routengrenze |
| Owner-Session oder ungültiger Bearer als Serviceauth | Evelyn HTTP 401 `SERVICE_AUTH_REQUIRED` / `SERVICE_AUTH_DENIED` | Client-/Boundary-/Signaturtests |
| Falscher Tenant/Resource/Hash als Bodyoverride; fremder Scope | HTTP 400 `UNKNOWN_FIELD` bzw. HTTP 403 `EVELYN_QA_SCOPE_DENIED`; Browser kann serverseitigen Snapshot nicht überschreiben | Eigenständige Tenant-/Resource-/Hash-/Versions- und Antwortbindung |
| Unbekannte ApprovalReference | HTTP 409 `EVELYN_INVALID` | Strikte Antwort-/Referenzprüfung |
| PENDING vor und nach Step 1 | HTTP 409 `EVELYN_PENDING`, keine Wirkung | Clientstatus- und DB-Prüfungen |
| Alte Referenz nach Betragänderung | HTTP 409 `EVELYN_VERSION_MISMATCH` und `APPROVAL_REFERENCE_MISMATCH`; neue Approval bleibt PENDING | Änderung während externem Aufruf, CAS und atomarer Rollback |
| Retry, zweite Wirkung, gleiche Identität/andere Payload | Identischer erfolgreicher Replay; HTTP 409 `EVELYN_ALREADY_EXECUTED` / `IDEMPOTENCY_CONFLICT`, DB exakt eine Wirkung | Parallele Commands, Receipts, Nonce-/Routendomänen |
| Production-/falsche Project-/Team-/Environmentidentität | Kein Productiontoken verwendet und kein Productionzugriff ausgelöst | 27 echte lokale RS256/JWKS-Policytests sowie CRM-Boundarytests verweigern diese Identitäten |
| Unreachable, Timeout, HTTP 400/401/403/409/429/5xx, malformed/HTML/zu große Antwort | Keine künstliche Providerstörung live ausgelöst | Client-Transportfixtures: FAIL CLOSED PASS |
| EXPIRED, REJECTED, ACTION_MISMATCH, TENANT_MISMATCH | Keine gesonderte Live-Erzeugung dieser Evelyn-Statusfälle behauptet | Client-/Vertragsmatrix: FAIL CLOSED PASS |

Der abschließende Infrastrukturvergleich bestand **13/13 PASS** mit genau zwei GET-Anfragen. Beide Production-Ziele, SSO-Schutz, Team-OIDC und konfigurierte Metadaten sind gegenüber den Vorher-/Konfigurationssnapshots unverändert. Evelyn vertraut dem erwarteten CRM-Projekt ausschließlich für `preview → preview`; die bestehende Evelyn-Self-QA-Regel blieb erhalten. Die zehn CRM-Umgebungsvariablen sind verschlüsselt und ausschließlich an diesen Previewbranch gebunden. Keine Werte wurden entschlüsselt oder exportiert. Der CRM-Production-Deploymentzeiger blieb `dpl_ESYdRFQruH4CcsMnmrnBhZ5vQqah`, Evelyn hatte weiterhin kein Productionziel.

## Erhaltene Fehlversuche und QA-Vorbereitung

Der erste tatsächliche Previewversuch am Code-/Harness-Stand `461f42bdea91fce2406fe9ade162a8fd06f9aab1` erreichte den geschützten CRM-Origin sowie Passwort-/MFA-Anmeldung, scheiterte jedoch an der verpflichtenden Session-Cookie-Prüfung (`REAL_SERVER_MFA_SESSION_REQUIRED`). Die anschließende Diagnose zeigte ein vorhandenes opakes HttpOnly-Session-Cookie mit **`Secure=false`**. Der Versuch wird deshalb ausdrücklich nicht als bestandener authentifizierter Ablauf gewertet. Es wurden dabei **keine Evelyn-Requests, keine Approval-Aktionen und keine Vertragsausführungen** ausgeführt. Der ursprüngliche Fehler bleibt in `.npm-cache/g08/live-preview-first-cookie-failure.json` erhalten.

Der CRM-Fix ergänzt ausschließlich einen gemeinsamen [Cookie-Transporthelper](../../../src/lib/auth/cookie-security.ts) für Session-, Login-Challenge- und Passwortreset-Cookies. Eine echte Vercel-Preview über HTTPS setzt damit `Secure`; die bestehende Authentifizierungs-, MFA- und Berechtigungspolitik bleibt unverändert. Die drei Cookie-Builder und die Local-/Preview-/Production-Matrix wurden geprüft. Die vollständige lokale Wiederholungsprüfung bestand **501/501**; Source-Security-Review des Fixes PASS. Die isolierte QA-Datenbank und ihre Konfiguration blieben bestehen, einschließlich der im tatsächlichen Login entstandenen MFA-Anmeldung; kein Reset und kein Austausch der bestehenden QA-Secrets. Der korrigierte Commit `137c796` bestand anschließend den oben dokumentierten vollständigen Live-Lauf. Der ursprüngliche fehlgeschlagene Lauf bleibt FAIL/BLOCKED.

Der erste vorbereitende QA-Datenbankversuch meldete **FAIL** am Schritt `VERIFY_SOURCE_READ_ONLY` (`ERR_ASSERTION`), ausdrücklich **vor jeder Mutation**. Die diagnostizierte Abweichung besteht aus genau elf neuen Default-ACL-Einträgen des Grantors `cloud_admin` für den Grantee `neon_superuser` im Schema `public`, jeweils mit Grant Option: acht Tabellenrechte (`DELETE`, `INSERT`, `MAINTAIN`, `REFERENCES`, `SELECT`, `TRIGGER`, `TRUNCATE`, `UPDATE`) und drei Sequenzrechte (`SELECT`, `UPDATE`, `USAGE`). `public` bezeichnet hier das Schema, nicht den Grantee `PUBLIC`. Es entstanden keine entsprechenden Grants an `PUBLIC`, die Runtime-Rolle oder `novalure_tenant_app`; die Runtime-Rolle kann `neon_superuser` weder per `USAGE` verwenden noch per `SET ROLE` annehmen und besitzt kein Schema-`CREATE`-Recht. Sämtliche **141 Datentabellen-Digests**, das Migrationsledger und alle übrigen Katalogfelder stimmen mit dem ursprünglichen Nachweis überein.

Die überarbeitete, geprüfte Vorbereitung bindet genau diese elf zusätzlichen Provider-ACL-Einträge ausdrücklich ein und vergleicht alle übrigen Felder unverändert gegen den ursprünglichen Snapshot. Ein folgender nativer Restoreversuch erreichte seine **180-Sekunden-Grenze** und blieb als FAIL dokumentiert. Die vollständige Rücknahme der Restoretransaktion und die weiterhin leere neu angelegte Zieldatenbank wurden ausdrücklich geprüft. Der anschließende erlaubte Wiederanlauf verwendete ausschließlich dasselbe verifizierte leere Ziel, mit einer **900-Sekunden-Grenze**; es gab keinen `DROP`, keinen Reset bestehender Datenbanken und keine stillschweigende Bereinigung eines teilbefüllten Ziels.

**G08-QA-Datenbankvorbereitung: PASS**, abgeschlossen am `2026-09-17T20:04:49.758Z` laut `.npm-cache/g08/preview-db-evidence.json`. Ziel ist die neue isolierte Datenbank `qa_g08_pr63_20260917` im bekannten QA-Projekt `weathered-term-98273025`, Branch `br-spring-snow-alupo8u4`. Der vollständige native Archivrestore mit `pg_restore 18.6` bestand; wiederhergestelltes Ledger und sämtliche Datendigests wurden verglichen. Migration **086 und ihr Ledger-Eintrag** wurden anschließend atomar mit der synthetischen QA-Fixture committed.

Die Fixture verwendet exakt Evelyn-Tenant-ID = CRM-Workspace-ID `afeac3f9-7534-47f5-b749-b3fd91b8f91b`; die ausdrückliche Preview-Allowlist ist registriert. Die Runtime-Rolle `g24_qa_20260917_r3` ist weder Owner noch RLS-Bypassrolle, besitzt kein Schema-`CREATE` und sieht ohne Tenantkontext **0 Zeilen**. Der synthetische Benutzer erhielt keine vorab gesetzte Session und keinen vorab gesetzten MFA-Zustand. Diese entstanden durch den tatsächlichen Login.

Das ursprüngliche Restore-Archiv blieb unverändert, SHA-256 `7b891ca8e38b60129ba70e636030c76779a8e108b2de8c11566dccd1f8ad319c`. Die vollständigen aktuellen Quellsnapshots vor und nach der Vorbereitung sind identisch: `8e598cf92f0e5962d2b003fabea316365c2079b8b54b4c5071866f6a8c058e26`. Die G24-Quelldatenbank, bestehende Datenbanken und Provider-Rollen wurden nicht verändert; Productionzugriffe: **0**. Die früheren Fehler bleiben gesondert in `preview-db-first-source-failure.json` und `preview-db-native-timeout-failure.json` erhalten. Der abgeschlossene historische G24-Nachweis bleibt davon getrennt.

Das PASS der Vorbereitung ist vom anschließenden Live-Lauf und von der unabhängigen Read-only-Datenbankprüfung getrennt. Die Fehlversuche werden nicht in die erfolgreichen 21/21- oder 50/50-Zahlen eingerechnet.

## Ursprüngliche 18 High-Gaps

Quelle und Grenzen bleiben das [CRM-Remediation-Register](../../qa/evelyn-crm-gap-remediation.md) und der [G24-Neon-Nachweis](../../qa/g24-neon-final-evidence.json). **18/18 sind im jeweils dokumentierten Umfang REMEDIATED_AND_VERIFIED.** Die bisherigen 17 Positionen wurden erneut durch vollständige Baseline und Source-Review abgesichert. G08 ergänzt jetzt den tatsächlichen Preview- und persistierten Datenbanknachweis. Die abschließende unabhängige Sicherheitsabnahme bestätigt diese Einordnung und ihre Grenzen.

| Gap | Gegenstand | Stand |
| --- | --- | --- |
| G01 | Enger Dienstprincipal, Actor-/Scope-/Ressourcenbindung | REMEDIATED_AND_VERIFIED im begrenzten bisherigen Vertragsumfang |
| G02 | Tenanttransaktionen, Runtime-Rolle und RLS-Grenze | REMEDIATED_AND_VERIFIED im begrenzten bisherigen Vertrags-/QA-DB-Umfang |
| G03 | Keine impliziten Pipeline-Schreibreparaturen bei GET | REMEDIATED_AND_VERIFIED |
| G04 | Keine operativen Mockdaten als Fehlerfallback | REMEDIATED_AND_VERIFIED |
| G05 | Atomare CAS-Versionierung | REMEDIATED_AND_VERIFIED für die dokumentierten Entitäten |
| G06 | Idempotenz, dauerhafte Receipts und Ergebnisabgleich | REMEDIATED_AND_VERIFIED im dokumentierten Umfang |
| G07 | Atomare Inventarledgers | REMEDIATED_AND_VERIFIED |
| G08 | Gebundene unabhängige Freigabe mit echtem Preview-Consumer | **REMEDIATED_AND_VERIFIED / CLOSED** im synthetischen Preview-Umfang, 21/21 Live und 50/50 unabhängige DB-Prüfungen |
| G09 | Belegte Preis-/Statusautorität | REMEDIATED_AND_VERIFIED |
| G10 | Unverbindliche Reservierungsanfrage und separate Bestätigung | REMEDIATED_AND_VERIFIED |
| G11 | Atomare Businessdaten, Receipts, Audit und Events | REMEDIATED_AND_VERIFIED innerhalb PostgreSQL |
| G12 | Angebotsrevision, Freigabe, Versandstatus, Follow-up, Kundenantwort | REMEDIATED_AND_VERIFIED; Versand bisher manuell attestiert |
| G13 | Autorisierte Verkaufsbestätigung und Schutz gegen Doppelverkauf | REMEDIATED_AND_VERIFIED |
| G15 | Bauträger-/Projekt-/Ansprechpartnerautorität | REMEDIATED_AND_VERIFIED anhand synthetischer Belege |
| G16 | Positive Projektgrants | REMEDIATED_AND_VERIFIED; G08-Scope-Overrides und fremdes Projekt live verweigert, keine vollständige Live-Negativmatrix aller historischen APIs behauptet |
| G17 | Datenklasse, Sensitivität und Zweck | REMEDIATED_AND_VERIFIED im begrenzten Vertragsumfang |
| G24 | Neon-Neuaufbau, 061-Kompatibilität, Rollen/RLS und nativer Restore | **CLOSED**; unveränderter gesonderter historischer QA-Nachweis |
| G25 | Tatsächliche lokale HTTP-/DB-/Browsernachweise | REMEDIATED_AND_VERIFIED; aktuelle lokale und gesonderte authentifizierte Preview-Nachweise |

**OPEN CRITICAL: 0. OPEN HIGH: 0. OPEN MEDIUM: 8**, jeweils im beschriebenen Prüf- und Integrationsumfang, durch abschließenden unabhängigen Review bestätigt. Dies ist keine pauschale Production-Freigabe und keine Härtungszusage für sämtliche historischen APIs oder Daten.

Die acht Medium-Gaps bleiben offen: **G14** allgemeiner Company-Lifecycle; **G18** externe versionierte Outbox/Consumer; **G20** Kalender-/Appointment-Zuordnung; **G21** generischer Kommunikations-/Deliveryvertrag; **G22** globale Legacyfehlersemantik; **G23** globale Cursor-/Vollständigkeit; **G26** Provider-/Cron-/Deploymentbetrieb; **G27** umfassende historische Geld-/Steuersemantik. **G19** bleibt für Flow B geschlossen. Keine dieser Grenzen wurde durch den G08-Client stillschweigend geschlossen oder als generell unkritisch eingestuft.

## Weiteres Vorgehen und Freigabeschwelle

Die vollständigen Gates einschließlich des unabhängigen finalen Sicherheitsreviews erfüllen **18/18 REMEDIATED_AND_VERIFIED**, **OPEN CRITICAL=0**, **OPEN HIGH=0** und **Flow A/B Preview PASS**. PR #63 wurde deshalb gemäß Auftrag auf **Ready for Review** gesetzt.

Danach folgt der gemeinsame abschließende Pre-Merge-Review von Evelyn PR #4 und CRM PR #63. Evelyn PR #4 bleibt unverändert. **Kein Merge, keine Production-Promotion, keine echten Kunden und keine Vertrags- oder Zahlungszustellung.**
