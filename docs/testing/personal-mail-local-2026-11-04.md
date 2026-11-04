# Persönliche CRM-Antworten und private Anhänge – lokale Übergabe

Basis: `9b7f60a5452e5b4c5894bdc4c94fcdee5e2c98d8`, isolierter Branch `codex/personal-mail-20261104` in `C:/Projects/novalure-crm-personal-mail-20261104`.
Quellbindung und ausgeführte Resultate: `artifacts/personal-mail/local-evidence.json`.

## Konkrete Funktion

Der vorhandene persönliche Postfachbereich kann eine reine Textantwort auf eine bestimmte importierte Originalnachricht mit bis zu fünf geprüften privaten Anhängen vorbereiten, anzeigen und nach Einzelbestätigung einmal an Outlook/Gmail übergeben. Der persönliche Verlauf zeigt den gespeicherten Antworttext, Konto, Empfänger, Dateimanifest und den tatsächlichen Belegstatus. Anbieterannahme ist ausdrücklich kein Zustellnachweis.

Die vorhandene Authentifizierung, aktuelle Mitgliedschaft, Projektberechtigung, Kontaktzuständigkeit, Kontakt-/Widerspruchsprüfung, Command-Receipts und das Audit werden wiederverwendet. Absender und Empfänger können im Versandauftrag nicht frei angegeben werden. Der Empfänger kommt aus dem aktuell zugänglichen CRM-Originalkontakt und muss mit der frisch bestätigten Originalnachricht übereinstimmen. Unbekannte/mehrdeutige Absender erteilen keine Rechte; ohne geprüften Kontaktbezug ist kein Versand möglich. Microsoft-Nachrichten mit abweichendem Reply-To bleiben vorsorglich gesperrt.

## Freigabe und Wiederaufnahme

- Bestehende OAuth-Verbindungen bleiben standardmäßig lesend. `enableReply:true` fordert ausdrücklich `Mail.Send` bzw. `gmail.send` an und speichert einen neuen, persönlich identitätsgebundenen Freigabebeleg. Eine spätere reine Lesefreigabe entfernt diesen Beleg. Kalender- oder allgemeine Serverzugangsdaten werden nicht verwendet.
- Vorschau und Versand sind an aktuelle Quelle, Account-ID, Verbindungsrevision, Freigabe-ID, CRM-Kontakt, Text und Dateihashes gebunden. Widerrufene Rollen, Sitzungen, Projekte, Kontaktzuständigkeiten oder Einwilligungen blockieren die nächste Aktion.
- Vor Anbieter-I/O wird `dispatching` separat dauerhaft bestätigt. Verlorene Antworten oder eine fehlgeschlagene Speicherung nach einem möglichen Versand bleiben `uncertain` bzw. `dispatching`; weder derselbe Auftrag noch eine neue Kennung startet einen zweiten Versand. Ein echter neuer Prüfprozess bestätigt dies gegen dieselbe Loopback-Datenbank. Es gibt keinen automatischen erneuten Versand und keine Behauptung einer Zustellung.
- Nur ein nachweislich noch nicht gestarteter `prepared`-Beleg darf explizit verworfen werden. Ein unsicherer Ausgang wird dadurch nicht in einen erneut sendbaren Zustand umgewandelt. Eine unabhängige externe Rekonstruktion unsicherer Ergebnisse ist weiterhin ein gesonderter Nachweis; kein automatischer Anbieter-Sent-Suche-/Retry-Pfad wurde erfunden.
- Abgelaufene persönliche Zugangstokens benötigen im Antwortpfad eine erneute persönliche Bestätigung. Vorhandene getrennte Lese-Sync-/Refresh-Pfade bleiben erhalten.

## Anhänge

Dateien werden nur einzeln bestätigt geladen oder hochgeladen. Grenzen:2 MiB je Datei, fünf Dateien je Antwort,50 Dateibelege je Nachricht,50 MiB aktive private Bytes und1000 Belege je Nutzer. Unterstützt sind UTF-8-Text, PDF ohne aktive Aktionen/Einbettungen/Anmerkungen sowie PNG/JPEG mit begrenzter Auflösung und neu kodierten Bildbytes.

Die strukturelle Prüfung läuft begrenzt in einem eigenen Worker; PDF-Stromgrenzen werden aus dem vorhandenen privaten Wissensparser übernommen, externe Fetches sind gesperrt. Diese Prüfung ist kein Antivirus- oder Virenfreiheitsnachweis. Abgelehnte Dateien speichern nur Metadaten/Hash, keine freigegebenen Bytes. Zugelassene Bytes sind verschlüsselt an Mandant, Person, Nachricht und Datei gebunden. Download erfolgt ausschließlich authentifiziert, privat, `no-store`, `nosniff` und als Attachment; es gibt keine öffentliche Blob-URL und keine HTML-Ausführung. Löschen entfernt die privaten Bytes dauerhaft, behält Nachweismetadaten und verhindert stilles Wiederherstellen. Das Löschen einer importierten Kopie erfasst auch ihre privaten Anhänge und noch nicht gestarteten Antworten; bestehende Versand-/Auditbelege bleiben als eigene Aufzeichnungen erhalten.

## Enger echter Testimport ohne Geschäftsmaileinfuhr

`POST /api/crm/mailbox/import-exact?workspaceId=<workspace>` akzeptiert ausschließlich:

```json
{
  "connectionId": "<eigene Verbindungs-UUID>",
  "providerMessageId": "<vorher bekannte einzelne Anbieterkennung>",
  "qaBatchId": "<registrierte Testbatch-UUID>",
  "approvedAddresses": ["<vorher verifiziertes eigenes Testkonto>", "<kontrollierter Testteilnehmer>"],
  "reviewed": true
}
```

Der Betreff muss exakt mit `[NOVALURE-QA:<qaBatchId>]` beginnen. `approvedAddresses` und `reviewed` sind ausschließlich Filter und Bestätigung, keine Autoritäts- oder Kontenkontrollbelege. Der Einstieg ist ohne den getrennten serverseitigen Hostpin `NOVALURE_MAIL_QA_IMPORT_SCOPES` gesperrt. Er verwendet kein vom Browser übermitteltes Registry-Dokument und keine Wissens-QA-Maschinenidentität. Der bestehende068-Registrierungsledger allein beweist keine externe Ressourcenkontrolle und wird nicht zu einer Mailfreigabe umgedeutet.

Der Hostpin ist eine begrenzte JSON-Liste mit je einem expliziten Scope pro bekannter Nachricht: `workspaceId`, `actorId`, `identityId`, `connectionId`, `provider`, `providerAccountId`, `accountLabel`, `qaBatchId`, `providerMessageId`, `participantAddresses`, `expectedBodySha256`, `expectedAttachmentManifestSha256`, `allowedReferenceIds`, `verificationReference` (`sha256:<Hash des tatsächlichen Root-Ressourcennachweises>`) und `expiresAt` (höchstens24 Stunden). Nur der vertrauenswürdige Hostbetreiber darf diese kurzlebige Liste aus der separat nachgewiesenen Testressourcenfreigabe konfigurieren. Der Parser beweist keine Kontenkontrolle aus einer Hashzeichenfolge; er bindet einen Hostentscheid an die aktuelle tatsächliche OAuth-Account-ID und persistierte persönliche Sitzung. Hier wurde keine reale Hostfreigabe gesetzt. Die eigentliche persönliche Zustimmung und aktuelle Leseberechtigung bleiben zusätzlich notwendig; ein Hostpin erteilt keine Sendeberechtigung.

Zuerst werden nur Metadaten dieser einen freigegebenen ID geprüft: aktuelle persönliche Anbieteridentität, Testmarker, sichtbare Teilnehmer, eigenes Konto als Empfänger und freigegebene Original-Referenzen. Sichtbares Bcc, Reply-To und mehrdeutige doppelte relevante Header werden vor dem Inhaltsabruf abgelehnt. Erst danach wird genau dieser Nachrichteninhalt geladen und seine Teilnehmer-/Nachrichtenbindung erneut geprüft. Nur der hostseitig vorab erwartete reine Text und das erwartete Anhangmanifest dürfen gespeichert werden; unerwartete zitierte Geschäftsinhalte, gekürzter/HTML-Ersatztext und nicht freigegebene Original-Mail-Referenzen werden nicht übernommen. Vor Persistenz und auch vor Receipt-Replay werden Verbindung, Revision und Hostpin mit der frischen Sitzung in derselben finalen Transaktion gesperrt und erneut geprüft. Die betroffene Suite weist dies auch mit einem echten Pool mit maximal einer Verbindung und mit einem späten Disconnect vor einem Replay nach.

Es gibt keine Inbox-/History-Aufzählung, keine Suche nach Ersatztreffern, keine Änderung am Anbieter und keine automatische CRM-/Leadzuordnung. Erneute Ausführung dedupliziert und übernimmt keine gelöschte oder fremde Kopie. Der schmale Pfad verwendet die vorhandenen Metadata-/KnownContent-Ports und den privaten Persistenzhelfer. Die normale Benutzerfunktion zum breiten Inbox-Import ist für die echte QA-Abnahme ausdrücklich nicht der Testimportweg. Nicht beweisbar durch gelesene Empfängerheader ist die Abwesenheit vom Anbieter bereits entfernter verdeckter Bcc-Empfänger. Die Root-Kampagne muss deshalb die tatsächlichen kontrollierten ursprünglichen Sendebelege und Teilnehmer separat prüfen; der lokale Import behauptet hierfür keinen Anbieter-/Live-PASS.

Für eine spätere echte Abnahme: neu verbundene persönliche Postfächer und gespeicherte Auto-Sync-Einstellungen müssen weiterhin deaktiviert bleiben; nicht auf die normalen Import-/Auto-Sync-Buttons drücken. Nur registrierte, vorher bekannte Testkennungen verwenden. `approvedAddresses` filtert diese lokale Einfuhr, ist keine allgemeine Produktfreigabe und keine neue Versandberechtigung. Die Root-Kampagne hält die verifizierte Empfänger-Allowlist und die tatsächliche Ressourcenkontrolle separat.

Vom Auftrag benannte spätere Testkonten sind Microsoft `hello@novalure.eu` und Google Workspace `hallo@zum-erfolg.at`; die private Gmail-Adresse ist nicht mehr aktiv autorisiert. Hier wurden ausschließlich synthetische `example.invalid`-Konten und Providerstubs verwendet. Es wurden keine realen Konten verbunden und keine echten Nachrichten/Termine ausgelöst.

## Ausgeführte lokale Nachweise

Rohlogs mit ursprünglichen Ausgabe-Leerzeichen sind unverändert gzip-komprimiert versioniert; `compressed-evidence.json` bindet zusätzlich ihre entpackten SHA256-Werte.

- `node --conditions=react-server --import tsx --test --test-reporter=tap --test-concurrency=1 scripts/personal-mail-reply-tests.ts scripts/crm-mailbox-tests.ts scripts/mailbox-auto-sync-tests.ts`:43/43,0Fail,0Skip. Enthält aktuelle Auth-Sitzungen, getrennte Mandanten/Personen, Outlook/Gmail-Ports, alte Lesefreigaben, private Bytes/Quarantäne/Tombstones, Quellen- und Rechtewechsel, Lost-Ack, Parallelaufrufe und einen neuen Prüfprozess. Protokoll: `artifacts/personal-mail/targeted-tests.tap`.
- `node scripts/personal-mail-reply-browser-tests.mjs`: fünf echte React-/Browserprüfungen mit synthetischen HTTP-Antworten über Loopback. Der echte `csrfFetch`-Client wird verwendet; dies ist kein Nachweis echter Session-/HTTP-Serverautorisierung oder einer Anbieterabnahme. Protokoll: `artifacts/personal-mail/browser.log.gz`.
- `npm run typecheck`: Exit0; enger ESLint: Exit0; `npm run build`: Exit0,191/191 statische Generierung. Build ohne Datenbankzugang und mit deaktivierter Telemetrie. Keine neue Gesamttestsuite ausgeführt.
- Statische Next-Dateiverfolgung enthält Worker, PDF-Preflight sowie die tatsächlich aufgelösten PDF-/Sharp-Einstiege. Das ist ein lokaler Verpackungsnachweis und kein Linux-/Deployment-Nachweis.
- Die erste zusätzliche Neustart-Prüfhilfe scheiterte an nicht unterstütztem Top-Level-await im CJS-Ausgabeformat; die Hilfsdatei wurde in einen expliziten Async-Einstieg korrigiert. Der ursprüngliche fehlgeschlagene Lauf bleibt unter `targeted-tests-initial-restart-probe-failure.tap.gz` erhalten. Der letzte Lauf oben ist vollständig grün.

## Migration und echte offene Gates

`migrations/192_personal_mail_reply_and_attachments.sql`, SHA256 `c4c446ce73d27b7c983fd9ef26ece2383ad4eceae65e30cc9d487260d9ac500b`. Keine Änderungen an189–191 oder Kalender193. Die Migration ergänzt drei explizite Freigabespalten und zwei private RLS-Tabellen; sie aktiviert keine Konten, Provider, Scheduler oder Businessrechte. Pakete und Lockfile bleiben exakt auf der Basis.

Der Datenbanktest verwendet den vorhandenen Loopback-Bootstrap bis106 plus die vorhandenen Mail-Voraussetzungen154/161/170/177/178/182 und192. Dies ist kein originalgetreuer vollständiger Produktions-Upgrade-/Restore-Nachweis; diesen muss die zentrale Datenbankprobe mit dem endgültigen additiven Schema separat erbringen. Ebenso offen bleiben exakter unabhängiger Review, gemeinsame Integration/Regression nach Übernahme, native CI/Linux-Verpackung, echte App-/Session-/CSRF-Abnahme und reale persönlich freigegebene Outlook-/Google-Providerabnahme einschließlich tatsächlicher Anhänge/Zustellung. Keine dieser Grenzen wird durch lokale grüne Nachweise umetikettiert.

Providerverträge wurden nur aus offiziellen Dokumentationen geprüft: [Microsoft MIME reply](https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0), [Microsoft attachment read](https://learn.microsoft.com/en-us/graph/api/attachment-get?tabs=http&view=graph-rest-1.0), [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [Gmail threading](https://developers.google.com/workspace/gmail/api/guides/threads), [Gmail attachment read](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get). Keine dieser Dokumentationsabfragen war ein Konten-/Provideraufruf.
