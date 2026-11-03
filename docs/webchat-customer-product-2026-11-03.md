# Webchat-Kundenprodukt – isolierte Übergabe vom 3. November 2026

Status: **LOKAL_VERIFIZIERT / SYNTHETISCHE_ABNAHME**, kein Produktivabschluss.
Produktgrundlage ist der geprüfte CRM-Produktzweig
`codex/package3-reviewed-crm-baseline-20261102` (`1ef299b3`), nicht das ältere
`main`. Evelyns Masterprompt und die vorrangigen Entwicklungsregeln vom
2. November 2026 gelten. Paket 3/4 bleibt abgenommen.

## Nutzbarer isolierter Umfang

- `/webchat` führt zu den vorhandenen Website-, Wissens-, Assistenten- und
  Einbettungsfunktionen. Die vorhandene Mandantenplattform und Rollen/MFA werden
  wiederverwendet. Wissen bleibt Entwurf bis zur berechtigten Administratorfreigabe.
- Mitarbeiter mit bestehender Rolle `team_member` verwenden alle Projekte ihres
  eigenen, ausdrücklich eingerichteten Webchat-Testkundenkontos. Interne
  Novalure-Bereiche und andere Mandanten erhalten dadurch keine Freigabe.
- Das Portal zeigt eigene besuchersichtbare Gespräche, gespeicherte Textauszüge
  als Zusammenfassung, vorhandene Leads und Nutzung je Bot. Gesprächslisten und
  vollständige Verläufe sind seitenweise nachladbar; Systemnachrichten fehlen
  ausdrücklich in der Kundenprojektion. Gesprächsarchive werden kein Wissen.
- Atomare Reservierungen begrenzen alle Bots gemeinsam pro Kundenkonto. Vor
  einem Modellaufruf wird reserviert; ein begonnenes Modellvorhaben verbraucht
  eine technische Testeinheit. Ein bekannter Abschluss ohne Modellaufruf gibt
  die Reservierung zurück. Unbekannte Ausgänge bleiben reserviert und werden
  nicht automatisch freigegeben oder erneut ausgeführt. Eine fachliche
  Abrechnungseinheit für den Verkauf wird dadurch nicht festgelegt.
- Absichtliche Zusatzbestellungen binden einen vorhandenen Leistungseintrag
  einschließlich Revision. Es gibt keine automatische Bestellung oder Belastung.
  Nur eine bestätigte, signierte synthetische Zahlung fügt die bestellten
  Einheiten einmalig hinzu. Eine administrative Sperre bleibt dabei erhalten.
- Antwortbeleg, sichtbare Beiträge, Textauszug und Verbrauch werden gemeinsam
  gespeichert. Erneute gleiche Anfragen liefern einen Beleg ohne zweiten
  Modellaufruf; sämtliche verwendeten Quellenversionen und die Methodenfassung
  werden vor erneuter Ausgabe geprüft. Ein Rechteentzug vor dem Abschluss
  verhindert Antwortspeicherung und Ausgabe.

Migration `121_webchat_customer_product.sql` legt keine Kunden, Preise, Angebote
oder Kontingente an. Sie erzwingt RLS und Mandantenreferenzen und trennt die
normale Kundenlaufzeit vom gesonderten `novalure_webchat_payment_executor`.
Die normale Laufzeit kann weder Kontingente/Kundenzuordnungen ändern noch
Zahlungen unmittelbar als bestätigt eintragen. Der Signaturadapter aus
`knowledge-center/billing.ts` bleibt die vorhandene Stripe-Prüfung.

## Gemeinsamer Rechnungs-/Zahlungsvertrag

Abgestimmt mit dem laufenden Website-Auftragsstrang
`codex/website-order-fulfillment-20261103`, dessen Übergabe
`docs/handoffs/website-order-chain-20261103.md` den gleichen Vertrag referenziert.

| Bezug | Verantwortliche Zuordnung |
| --- | --- |
| Kunde | `workspaceId` und vorher gespeicherte Stripe-`customerId`/`accountId` |
| Bestellung | unveränderliche ID, absichtliche `requestId`, Auftraggeber, Leistung und Revision, Vertragsreferenz, Einheiten, Integerstring `amountMinor`, ISO-Währung |
| Zahlung | vorher hostseitig gespeicherte `paymentIntentId`, bestätigter Status, signiertes Testereignis, `eventId`, Digest und Erstellzeit |
| Recht/Bereitstellung | eindeutiger Bezug auf Bestellung, Modul `webchat`, Vertragsreferenz und Einheiten; atomar mit Zahlungsbeleg und Audit |
| Website-Rechnung | bestehender Website-/CRM-Verantwortungsbereich; zusätzliche Rechnungsreferenz, Revision und Digest vor Produktivabschluss binden |

Checkout-Redirects und Ereignis-Metadaten vergeben keine Rechte. Falscher Kunde,
Account, Betrag oder Währung wird abgewiesen. Gleiche Ereignisse sind einmalig;
abweichende Bytes unter derselben Ereignis-ID sind ein Konflikt. Verspätete
Ereignisse und stornierte Bestellungen reaktivieren nichts. Eine Websitezahlung
wird niemals an eine Webchat-Zusatzkontingentbestellung umgedeutet.
Die Ereignis- und Signaturgrenzen wurden gegen die offiziellen
[Stripe-Webhook-Regeln](https://docs.stripe.com/webhooks) und die
[PaymentIntent-Statusbeschreibung](https://docs.stripe.com/payments/payment-intents/verifying-status)
abgeglichen; dies ersetzt keine echte Providerabnahme.

Hier entstehen weder eine zweite Rechnungs-/Stripeplattform noch eine
Buchungsengine. Der Website-Strang behält seine Angebots-, Liefer-, Abnahme- und
Rechnungsbezüge. Studio behält Booking Engine und Providerverbindungen.
BrightBooks bleibt pausiert.

## Tatsächliche Nachweise

Die zusammenhängende Abnahme `scripts/webchat-customer-product-tests.ts`
verwendet zwei frisch provisionierte synthetische Kunden, je zwei Bots,
unveränderte Originalmigrationen einschließlich 121, FORCE RLS und eine
eingeschränkte lokale PostgreSQL-Laufzeit. Sie prüft Einrichtung, Rollen,
Veröffentlichung, Portal, gemeinsame Pause, bewusste Bestellung, signierte
Testzahlung, einmalige Freischaltung, Parallelität, falsche Bindungen,
Quellenwiderruf, späte Rechteänderungen und fremde Daten/Rechte.

Die Testbeträge und Mengen sind ausdrücklich synthetische Fixturewerte und
keine Preis- oder Leistungsentscheidung. MFA-Sitzungen und Mitarbeiter werden
als synthetische persistierte Identitäten angelegt; dies ist keine neue reale
Passwort-/MFA- oder Einladungsemail-Abnahme. Leads werden als bereits vorhandenes
Übergabeergebnis projiziert; eine neue Lead-Erzeugung wird nicht behauptet.
Modelle und Zahlungsereignisse sind simuliert; ausgehende Netzaufrufe sind im
Durchlauf gesperrt. Die Datenbank läuft ausschließlich auf Loopback.

Ausgeführte Prüfungen und Korrekturen werden im PR und im Evelyn-Entwicklungsstand
mit ihrer tatsächlichen Revision festgehalten. Bestehende 260 Sicherheits-/Rollen-
Tests, 237 Knowledge-Center-Tests, betroffene Website-/Provisionierungsprüfungen,
Lint, Typecheck, Build und Produktions-Abhängigkeitsaudit gehören zum
anwendbaren Prüfungsumfang. Frühere eingeschränkte Ausführung scheiterte an
Loopback-`EACCES`; die tatsächlichen Datenbankprüfungen wurden anschließend mit
der erlaubten lokalen Testverbindung ausgeführt. Frühe Testfehler führten zu
den dokumentierten Berechtigungs-/Abschlusskorrekturen und gelten nicht als PASS.

Unveränderte Paket-3/4-, Originaldatei-, TXT-, Budget-/Stop- und Restorebelege
werden nur für ihren unveränderten Umfang wiederverwendet. Die frühere
86,72-Sekunden-Fortsetzung bleibt ausdrücklich keine vollständige Import-RTO.
Es wurde keine neue vollständige Restoreübung durchgeführt.

Der zusammenhängende Durchlauf bestand mit **11/11 Prüfungen**. Zusätzlich
bestand die tatsächliche Portal-Komponente in Headless Edge **9 gezielte
Präsentationsprüfungen** mit ausschließlich synthetischen lokalen HTTP-Antworten
(Desktop und 390-px-Mobilansicht). Dieser Browsernachweis ist ausdrücklich
keine Authentifizierungs-, Datenbank- oder Providerabnahme. Der lokale Beleg
liegt unter `.npm-cache/qa/webchat-presentation/receipt.json`, SHA-256
`c7799fb82b9550699ea40eb5576e1005372ac45368efe9c159436ab942948c54`.
Die abschließende Team-Anbindung bestand weitere **6 gezielte Browserprüfungen**:
vorhandene Rollen-/Einladungsoberfläche im verifizierten Zielkonto, keine
Profilabfrage und keine Einladungs-/Mutationausführung. Beleg
`.npm-cache/qa/webchat-presentation/team-receipt.json`, SHA-256
`2af6f00ce49e7c50ad97ac2db5df812e4ada69d052989ec45930a9ce7c1f6808`.

## Produktionsabschluss – getrennt offen

1. Preise, Vertrags-/Rechnungsregeln, Abrechnungseinheit, Mengen, Reset und
   Gültigkeit zusätzlicher Einheiten verbindlich konfigurieren. Hier existieren
   keine angenommenen Standardwerte oder Aufbewahrungsfristen.
2. Initiale Kundenaktivierung von einer reinen Kontingentergänzung unterscheiden;
   der jetzige Zahlungspfad hebt ausschließlich eine Kontingentpause auf und
   überschreibt keine administrative Sperre.
3. Vertrauenswürdigen Checkout-/Provider-Bindungspfad und zugeordneten
   Webhook-Empfänger fertigstellen, gesonderte Payment-Executor-Identität sicher
   anbinden und reale Providerabnahme durchführen. Der isolierte Consumer hat
   keinen öffentlichen Produktions-Webhook und führt keinen Stripe-Aufruf aus.
4. Migration nach vorhandener Zustands-/Recoveryprüfung im konkret bestätigten
   Ziel ausführen; Rollen und Rückweg dort nachweisen. Schema 121 wurde bislang
   ausschließlich in wegwerfbaren lokalen Testdatenbanken angewandt.
5. Exakte unabhängige Revisionsprüfung und unverfälschten Trusted-App-Check sowie
   erforderliche CI-/Release-Gates bestehen lassen. Lokaler Agentenreview
   ersetzt keinen App-Check und gibt keinen Merge oder Produktivbetrieb frei.
6. Kundenaktivierung/öffentliche Registrierung und veröffentlichte Einbettungen
   erst im späteren beauftragten Produktivabschluss behandeln. Der jetzige
   Produktpfad verlangt `NOVALURE_WEBCHAT_PRODUCT_ISOLATED_ENABLED=1`, eine
   Trainingsverbindung und synthetische Besuchersitzung; Production ist gesperrt.

Automatische Löschung bleibt aus. Es gibt keinen automatischen Reset,
Kontingentkauf, Versand, realen Zahlungsvorgang oder neuen kostenpflichtigen
Vertrag. Die bestehende Einladungseinrichtung wird wiederverwendet; ihre
konkrete Zustellung wird vor tatsächlicher Kundenaktivierung gesondert geprüft.
