# Bot-Webhook- und Provider-Reconciliation

Stand: 23.08.2026

## Garantiegrenze

Migration `076_bot_webhook_durable_processing` stellt eine dauerhafte, geleaste und gefencete Verarbeitung je `(channel_account_id, external_message_id)` bereit. Parallele Zustellungen gewinnen genau einen aktiven Processor. Abgelaufene Leases und `failed`-Datensätze sind wiederaufnehmbar; `completed` und `ignored` werden ohne erneute interne oder externe Wirkung bestätigt.

Die externe Provider-ID wird vor der Persistenz auf einen festen, opaken SHA-256-Schlüssel abgebildet. Ein signierter Meta-Body wird deterministisch in alle WhatsApp-`changes`/Messages sowie alle Instagram-/Messenger-`messaging`-Events aufgefächert. Status-, Delivery- und Read-Ereignisse haben getrennte stabile Identitäten und werden terminal ohne Bot-/CRM-Wirkung ignoriert. Eine Batch-Antwort ist nur dann HTTP 200, wenn jedes Einzelereignis terminal `completed` oder `ignored` ist; bei einem teilweisen Fehler folgt HTTP 503. Beim Body-Replay bestätigen fertige Einzelereignisse nur ihren gespeicherten Abschluss, während offene Ereignisse weiterlaufen.

Für CRM-, Timeline-, Conversation-, Message-, Tool-, Dokument-, Approval- und Audit-Effekte ist `webhook_event_id` der interne Idempotenzschlüssel. In `audit_logs` bleibt er bewusst ein unveränderlicher UUID-Snapshot ohne Live-FK: das Audit-Ledger ist retained und append-only und darf bei einer QA-Bereinigung nicht per `ON DELETE` mutiert werden. Das bedeutet keine globale Exactly-once-Garantie gegenüber Meta. Die Meta-Messaging-Endpunkte akzeptieren den Novalure-Idempotenzschlüssel nicht. Novalure garantiert deshalb nur einen automatisch gestarteten Provider-Versuch pro Webhook-Ereignis.

`reply_state=completed` bedeutet, dass der Provider den Request als `sent` oder `queued` bestätigt hat; es ist keine Zustell- oder Lesebestätigung. `reply_state=uncertain` bedeutet, dass ein Request begonnen hatte, sein externes Ergebnis aber nicht sicher festgestellt werden konnte. Ein solcher Request wird niemals automatisch erneut gesendet.

## Zustände

| Verarbeitung | Bedeutung | Automatischer Replay |
| --- | --- | --- |
| `received` | alter oder noch nicht geclaimter Eingang | claimbar |
| `processing` | aktiver Lease-Inhaber | vor Lease-Ablauf retrybares HTTP 503, danach reclaimbar |
| `failed` | interner Fehler vor Abschluss | reclaimbar |
| `completed` | interne Verarbeitung abgeschlossen | HTTP 200, keine neue Wirkung |
| `ignored` | gültiger Eingang ohne verarbeitbaren Text | HTTP 200, keine neue Wirkung |

`not_found` und bewusst nicht unterstützte Ereignisse sind terminal und werden mit HTTP 200 bestätigt. `ambiguous` und `unavailable` bleiben mit HTTP 503 retrybar, weil ein Ack sie sonst dauerhaft verlieren würde. Unveränderliche Payload-Konflikte, ungültige Feldgrenzen, überschrittene Account-/Kontakt-Budgets und nach fünf Reclaims weiter fehlschlagende Ereignisse werden terminal quarantänisiert statt eine Provider-Retry-Schleife zu verstärken.

Pro Account sind innerhalb von fünf Minuten höchstens 120 textuelle Erstereignisse, pro Account/Kontakt höchstens 12 zulässig. Claim, Zählung und Entscheidung laufen unter global geordneten Account-/Kontakt-Advisory-Locks in derselben Transaktion; parallele Requests können das Limit daher nicht gemeinsam überschießen. Mehr als zehn normalisierte Ereignisse in einem signierten Body werden als ganze Envelope über den Raw-Body-SHA quarantänisiert und mit HTTP 200 beendet. Es wird weder ein repräsentatives Einzelereignis verarbeitet noch Raw-Payload/PII in diesem globalen Ledger gespeichert.

Die globale Envelope-Tabelle ist für `novalure_tenant_app` nicht direkt les- oder schreibbar. Die Anwendung besitzt ausschließlich `EXECUTE` auf der validierenden `SECURITY DEFINER`-Funktion `quarantine_bot_channel_webhook_envelope(text,text,integer,text)`; `PUBLIC` besitzt weder Funktions- noch Tabellenrechte. Damit kann die App nur den eigenen Hash/Provider/Count/Grund upserten und keine globalen Envelope-Zeilen auslesen.

| Provider-Reply | Bedeutung | Aktion |
| --- | --- | --- |
| `not_requested` | noch kein Provider-Versuch | genau ein Versuch darf begonnen werden |
| `attempting` | Versuch ist dauerhaft markiert, Ergebnis noch offen | nicht senden; nach Unterbrechung zu `uncertain` |
| `completed` | Provider hat `sent` oder `queued` bestätigt | nicht senden |
| `blocked` | Scope-, Policy- oder Consent-Gate blockiert | nicht senden |
| `not_applicable` | keine Antwort vorgesehen | nicht senden |
| `uncertain` | Provider-Ergebnis unbekannt | niemals blind erneut senden |

## Read-only-Triage

Nur Metadaten prüfen; `payload`, `normalized_message`, Credentials und Empfängerwerte nicht in Tickets oder Logs kopieren.

```sql
select
  id,
  channel,
  external_message_id,
  status,
  processing_attempt,
  lease_expires_at,
  completed_at,
  reply_state,
  reply_attempted_at,
  reply_completed_at,
  reply_result->>'provider' as provider,
  reply_result->>'status' as provider_status,
  reply_result->>'messageId' as provider_message_id,
  reply_result->>'reconciliationReason' as reconciliation_reason
from public.bot_channel_webhooks
where workspace_id = '<QA_WORKSPACE_UUID>'::uuid
  and (
    reply_state in ('attempting', 'uncertain')
    or status in ('processing', 'failed')
  )
order by received_at asc;
```

1. Bei `processing` vor `lease_expires_at` nicht eingreifen. Eine parallele Zustellung erhält HTTP 503, damit der Provider das Ereignis bis zu einem terminalen Zustand erneut liefert.
2. Bei abgelaufenem `processing` oder `failed` darf ausschließlich derselbe signierte Provider-Event erneut zugestellt werden. Die State-Machine reclaimt ihn; interne Unique Guards verhindern doppelte Wirkungen.
3. Bei `attempting` oder `uncertain` keinen Replay und keinen manuellen Versand aus Novalure starten. Im freigegebenen Provider-Postfach anhand Provider-Zeitpunkt und Provider-Message-ID prüfen, ob die Nachricht vorhanden ist.
4. Ist das Provider-Ergebnis nicht zweifelsfrei belegbar, bleibt der Zustand `uncertain`. Der Fall wird als manuelle Kundenkommunikationsentscheidung eskaliert; ein neuer Versand benötigt einen neuen, ausdrücklich freigegebenen Vorgang und darf den alten Webhook nicht wiederverwenden.
5. Keine direkte SQL-Statusänderung durchführen. Eine spätere Reconciliation-Funktion muss tenant-gebunden, rollenbeschränkt, append-only auditiert und mit Provider-Evidenz versehen sein.

## Go-Live-Gate

`botChannelInboundProcessing` bleibt zentral `LAUNCH-OFF`. Vor Aktivierung müssen Migration 057, 075 und 076 mit exakter SHA-256-Checksumme im isolierten Preview-Ledger stehen. Der Katalog-Gate muss den entfernten Legacy-Unique-Index, den validen Account-Event-Index, Lease-/Quarantäne-Artefakte, sechs Live-FKs plus den FK-losen Audit-Snapshot sowie die write-only Envelope-RPC-Rechte bestätigen.

Zusätzlich sind die fokussierten Tests für Failure→Retry, parallelen Claim/Budget, Completed-Replay, Lease-Reclaim, Meta-Fan-out/Partial-Retry, interne Deduplizierung, First-Response-Races, Retry-Quarantäne und Provider-`uncertain` grün. Die Provider-Abnahme muss bestätigen, dass Batches mit mehr als zehn relevanten Ereignissen nicht regulär zugestellt werden oder operativ aus dem Envelope-Ledger aufgelöst werden können. Solange kein freigegebener Provider-Reconciliation-Prozess existiert, bleibt jeder `uncertain`-Fall fail-safe ohne automatischen Resend.
