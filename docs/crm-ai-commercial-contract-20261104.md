# Führender Vertrag für KI-Guthaben und manuelle Buchungen

Dieser Stand dokumentiert die tatsächlich implementierten Produktregeln. Er erzeugt keine Rechnungen, Zahlungen oder verbindlichen Vertragsangebote.

## Führende Quellen

- Öffentlicher Zusatzleistungs-Katalog: `src/lib/ai-billing/catalog.ts`, Version `2026-11-04-draft-v1`.
- Serverseitige Buchungs- und Kontingentregeln: `migrations/146_ai_credit_billing.sql`. Artikel, Beträge, Kontingente und Katalogversion werden dort erneut geprüft; Browserwerte werden nicht als Preisautorität verwendet.
- Interne Freischaltung und unveränderlicher Bearbeitungsbeleg: `migrations/152_ai_billing_admin.sql`, durch `153_ai_billing_runtime_acl.sql` für die reale Laufzeitrolle eingegrenzt.
- Verbrauchsautorität: `src/lib/ai-billing/metering.ts`, `repository.ts` und zentrale Provideranbindung. Die tatsächlich bestätigte Token-Nutzung bestimmt den Verbrauch; eine unbekannte Ausführung bleibt reserviert.
- Der neue Arbeitsassistent verwendet diese bestehenden Kontingente. Migration188 speichert private Arbeitsprodukte, sie führt keinen zweiten Guthaben-, Quoten- oder Zahlungsvertrag ein.

## Bereits festgelegte Produktregeln

| Artikel | Preisvorschlag netto | Kontingent |
| --- | --- | --- |
| KI inklusive | im CRM-Grundtarif | 1.000 Credits je Unternehmen und UTC-Kalendermonat |
| KI Plus | zusätzlich 99 € monatlich | 21.000 Credits insgesamt je UTC-Kalendermonat |
| KI Pro | zusätzlich 199 € monatlich | 51.000 Credits insgesamt je UTC-Kalendermonat |
| Zusatzguthaben klein | einmalig 29 € | 5.000 Credits ohne Ablaufdatum |
| Zusatzguthaben groß | einmalig 99 € | 20.000 Credits ohne Ablaufdatum |
| Makler-Website/Hosting/Betreuung | individuelles Angebot | keine KI-Creditfreigabe durch Bearbeitung der Website-Anfrage |

Monatsguthaben wird zuerst verbraucht, Zusatzguthaben danach. Mitarbeiter teilen das Unternehmenskontingent. Plus/Pro erhöhen das Kontingent, nicht die Datenberechtigungen. Die Vorschläge sind in der Kundenoberfläche als vorläufig gekennzeichnet.

Der CRM-Basispreis wird in der Oberfläche mit 99 € netto für bis zu zehn Nutzer und 1 € je aktivem Objekt beschrieben. Diese KI-Erweiterung implementiert dafür weder automatische Grundtarif-Rechnungen noch einen zweiten Benutzer-/Objektabrechnungsmechanismus.

## Kundenfreischaltung

Kundenverantwortliche senden unter **Tarif & Zusatzleistungen** eine Anfrage. Sie bleibt `pending` und verändert weder Zugriff noch Guthaben. Ein aktiver interner Novalure-Admin prüft sie unter **KI-Buchungsanfragen**, bestätigt Unternehmen, Konditionen, Belegreferenz und bei bezahlten KI-Paketen das Ende des bezahlten UTC-Kalendermonats. Erst diese bestätigte Bearbeitung aktiviert das gespeicherte Paket beziehungsweise vergibt Zusatzguthaben.

Freischaltungen sind idempotent und werden mit Bearbeiter, Zielunternehmen, Eingabe und Ergebnis protokolliert. Eine Änderung darf einen bereits bezahlten Zeitraum nicht verkürzen. Ein laufendes Pro-Paket wird nicht vorzeitig auf Plus herabgesetzt. Ein vorgemerkter Wechsel zum Basiskontingent erhält den bereits bestätigten Zeitraum.

## Zahlungs-, Rechnungs- und Steuergrenze

Stripe ist für diese Anfragen nicht verbunden. Es erfolgen keine Onlineabbuchungen, Zahlungszusagen oder automatische Rechnungsstellungen. Eine eingetragene Rechnungs-/Vertrags-/Prüfreferenz ist ein interner Bearbeitungsbeleg; sie wird derzeit nicht gegen ein führendes Rechnungsbuch abgeglichen und belegt für sich keinen Zahlungseingang.

Die gespeicherten Zusatzbeträge sind Nettobeträge. Der KI-Katalog berechnet keine Umsatzsteuer und trifft keine Entscheidung über Umsatzsteuer-ID, Reverse Charge oder sonstige Rechnungsanforderungen. Die verbindliche Rechnung und Steuerbehandlung gehören in den später festzulegenden beziehungsweise angeschlossenen Rechnungsprozess.

## Noch offene Entscheidungen von Franz

- Endgültige Zusatzpreise und Freigabe des vorläufigen Katalogs.
- Vereinbarung und Abrechnung des ersten Teilmonats; die technische Kontingentperiode ist ein UTC-Kalendermonat.
- Verbindlicher Rechnungsanbieter, Zahlungsabgleich und späterer Stripe-Übergang.
- Konkrete Angebote für Website-Erstellung, Hosting und laufende Betreuung.

Vorhandene Kontingentregeln und Freischaltrechte benötigen dafür keine neue Quotenarchitektur. Ein älterer synthetischer Produkt-/Abrechnungsstand darf die produktiven Regeln146/152/153 nicht ersetzen.
