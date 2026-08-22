# Provider-, Legal- und Product-Abnahme — Go-Live 22.08.2026

Status: **NICHT FREIGEGEBEN**
Release-Kandidat: wird nach finalem Commit und SHA-identischem Preview-Deployment eingetragen.
Grundsatz: Eine leere Unterschrift, ein nicht ausgeführter Provider-Test oder ein fehlender QA-Zielwert ist ein Releaseblocker und niemals ein stilles `PASS`.

## 1. Erhobener Provider-Stand

Die folgenden Angaben sind Vercel-Key-/Scope-Metadaten; Secret-Werte wurden weder angezeigt noch protokolliert.

| Bereich | Beobachtung | Status |
|---|---|---|
| Resend Marketplace | Resend ist nicht als Vercel-Integration installiert. Ein bestehender `RESEND_API_KEY` ist als Projektvariable vorhanden. | OFFEN |
| Resend Key-Scope | `RESEND_API_KEY` gilt gemeinsam für Production und Preview. Eine isolierte QA-Credential ist nicht belegt. | BLOCKER |
| Absender | `RESEND_FORM` gilt für Production und Preview; der vom Code verlangte Key `RESEND_FROM` fehlt. | BLOCKER |
| QA-Mailziel | `NOVALURE_QA_EMAIL_ALLOWLIST` fehlt. Ein echter QA-Versand ist damit absichtlich nicht freigegeben. | BLOCKER |
| Google Calendar | `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` sind nur für Production vorhanden. | PREVIEW NICHT KONFIGURIERT |
| Microsoft Calendar | Client-ID, Client-Secret, Tenant-ID und Calendar-User-ID gelten gemeinsam für Production und Preview. Ein eigener QA-Kalender ist nicht belegt. | BLOCKER |
| Product-Grenze | Newsletter-Send, Meeting-/Bot-/Dokument-/QA-Testversand, öffentliche Booking-Mutationen und Kalender-Provider-Mutationen bleiben technisch `LAUNCH-OFF`, bis diese Abnahme bestanden und separat signiert ist. | SAFE/OFF |

## 2. Verbindliche Resend-Abnahme

Vorbereitung durch Product/Ops:

1. Entscheiden und dokumentieren, ob das vorhandene Resend-Konto verknüpft oder ein neues Unternehmenskonto angelegt wird. Die Verknüpfung erzeugt persistenten OAuth-/API-Zugriff und erfordert die Bestätigung des Kontoinhabers im Vercel-Dialog.
2. Eine verifizierte Versanddomain und einen freigegebenen Absender im Format `Name <mailbox@verified-domain>` benennen.
3. Einen ausschließlich für Preview bestimmten Resend-Key bereitstellen; der Production-Key darf nicht in Preview gelten.
4. Eine ausdrücklich freigegebene QA-Mailbox benennen und ausschließlich diese Adresse in `NOVALURE_QA_EMAIL_ALLOWLIST` für Preview hinterlegen.
5. `RESEND_FROM` für Preview setzen. `RESEND_FORM` ist ein Tippfehler und darf nicht als stiller Runtime-Fallback verwendet werden.

Abnahmelauf, genau einmal und nur auf dem SHA-identischen Preview:

| Test | Erwartung | Evidenz |
|---|---|---|
| Readiness | Provider meldet extern/konfiguriert; keine Secret-Werte in Response oder Logs. | Deployment-ID, Timestamp, redigierter Status |
| Allowlist negativ | Nicht freigegebene Empfängeradresse wird vor Provideraufruf abgewiesen. | HTTP-Status, Request-ID |
| Allowlist positiv | Genau eine E-Mail geht an die benannte QA-Mailbox. | Resend Message-ID, Timestamp |
| Inhalt | Absender, Reply-To, DE/EN-Inhalt, Links und Unsubscribe-Ziel sind fachlich korrekt. | Reviewer + Screenshot/Headers ohne Token |
| Idempotenz | Wiederholung desselben Testschlüssels erzeugt keine unkontrollierte Doppelwirkung. | Provider-/App-Evidenz |
| Observability | Providerfehler sind redigiert, klassifiziert und alarmierbar. | Log-/Trace-ID |

Der zentrale Resend-Adapter erzwingt den Delivery-Purpose defense-in-depth. Newsletter sowie Meeting-, Bot-, Dokument- und QA-Testversand bleiben auch nach erfolgreicher technischer Resend-Abnahme `LAUNCH-OFF`, bis Product die jeweilige Fläche separat als `LAUNCH-ON` signiert. Passwort-Reset und Workspace-Einladung bleiben getrennte Account-Access-Verträge und benötigen jeweils einen eigenen End-to-End-Nachweis.

## 3. Kalenderprovider-Abnahme

Product/Ops muss genau einen primären Launchprovider und ein ausschließliches QA-Ziel auswählen. Ohne diese Auswahl bleiben alle Provider-Mutationen `LAUNCH-OFF`.

Erforderliche Inputs:

- Provider: `Microsoft 365` oder `Google Calendar`;
- dediziertes QA-Konto bzw. QA-Kalender-User-ID;
- Preview-only OAuth-/App-Credentials und erlaubte Redirect-URIs;
- eine ausdrücklich freigegebene QA-Teilnehmeradresse;
- Zeitzone `Europe/Vienna` sowie Testzeitfenster;
- Verantwortliche Person für die abschließende Löschung des Testtermins.

Abnahmematrix:

| Test | Erwartung |
|---|---|
| Nicht authentifiziert / falscher Tenant | 401/403, keine Providerwirkung |
| Nicht freigegebene Rolle | 403, keine Providerwirkung |
| Create | genau ein QA-Termin; Event-ID und Sync-Ledger persistiert |
| Reload | UI, API, DB und Provider zeigen denselben Termin |
| Retry/Doppelklick | keine unkontrollierte Duplikation |
| Update/Reschedule | App und Provider konvergieren nachvollziehbar |
| Delete/Cancel | erst nach gesonderter Aktionsbestätigung; Provider und lokale Daten bereinigt |
| Providerfehler | redigierter Fehler, stabiler Zustand, keine falsche Erfolgsanzeige |
| Audit/Observability | Correlation-, Sync- und Audit-ID vorhanden; Alarmweg bestätigt |

## 4. Legal- und Unternehmensprofil-Abnahme

Legal prüft den exakten DE- und EN-Inhalt dieser öffentlichen Routen: `/imprint`, `/privacy`, `/terms`, `/cookies`, `/data-deletion`, `/meta` und `/unsubscribe`. Die Freigabe gilt nur für den eingetragenen Commit und die eingetragenen Content-Hashes.

Für die öffentlich genannte irische Gesellschaft sind im Plattform-Unternehmensprofil mindestens zu prüfen:

- Company name und legal form;
- CRO registration number sowie place/authority of registration;
- registered office und business address;
- öffentliche Kontakt-E-Mail;
- Directors bzw. vertretungsbefugte Personen;
- bei Immobilienvermittlung: PSRA-Lizenzangaben;
- Privacy-/DPO-Kontakt, VAT-/Steuerangaben und freigegebene externe Nutzungen;
- Profilstatus `approved` oder `locked` mit approver und Timestamp.

Kein Feld darf aus Marketingtext oder Footer abgeleitet und ungeprüft als rechtliche Wahrheit gespeichert werden.

## 5. Product-Entscheidungen

Die versionierte technische Matrix `2026-08-22.7` liegt in `src/lib/launch-scope.ts`. Ihr Status bleibt `PENDING_SIGNATURE`.

Empfohlener Launchumfang:

| Fläche | Kandidatenentscheidung | Begründung |
|---|---|---|
| Kern-CRM, sichere Public Forms | `LAUNCH-ON` | gehärteter Kernvertrag; Preview-E2E bleibt Pflicht |
| Public-Form Proof Refresh | `LAUNCH-ON` | gleiche Idempotency Identity, keine externe Wirkung, fail-closed |
| Unit-/Building-Inventarpflege | `LAUNCH-ON` | ohne automatische Reservierungs-/Deal-Synchronisierung |
| Unit-Status ↔ Käufer ↔ Deal/Reservierung | `LAUNCH-OFF` | fachliche Ownership-, Status- und Fehlerkompensation nicht signiert |
| Newsletter-Send, Funnel-Webhook, Import | `LAUNCH-OFF` | Provider-/Durability-/Rollback-Abnahme fehlt |
| Customer-facing Meeting-/Bot-/Dokument-/QA-Test-Providerdelivery | `LAUNCH-OFF` | isolierte QA-Ziele, Product-/Ops-Freigabe und Cleanup fehlen |
| Public Booking und Kalender-Provider-Mutationen | `LAUNCH-OFF` | QA-Provider-/Saga-Nachweis fehlt |
| QA Reset, Systemdiagnostik | `INTERNAL-ONLY` | zentrale Rolle/Capability plus lokaler Guard |
| Spanische Produktoberfläche | `LAUNCH-OFF`, bis vollständige ES-Content-/Legal-Abnahme vorliegt | Teilübersetzung ist kein freigegebenes Produkt |

Product muss für jede inventarisierte Fläche im Launch-Scope-Inventar genau einen der drei Zustände signieren. Eine pauschale Unterschrift ohne Zeilenentscheidung ist ungültig.

## 6. Unterschriften

| Freigabe | Name | Datum/Zeit | Commit/Deployment | Entscheidung | Signatur/Referenz |
|---|---|---|---|---|---|
| Product Owner | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |
| Engineering Owner | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |
| Security | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |
| Operations/DBA | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |
| Legal/Privacy | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |
| Resend/Domain Owner | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |
| Calendar Owner | _offen_ | _offen_ | _offen_ | PENDING | _offen_ |

Die finale Go-Live-Entscheidung bleibt `NO-GO`, solange eine Pflichtzeile offen ist oder der signierte Commit nicht SHA-identisch mit dem geprüften Deployment ist.
