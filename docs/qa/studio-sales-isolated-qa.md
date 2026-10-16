# Studio Sales: isolierte QA vorbereiten

Stand: 2026-10-16. Grundlage: Studio `2817241b997ee64721a4649d5d7f9f1efd0063e8`,
CRM `25aa8c3d996a1efdd79976c9be012f6dfb7a1569` und die Änderungen in
diesem Arbeitszweig. `LOCAL_PASS` und `INTEGRATION_IMPLEMENTED` beschreiben
lokale, teils synthetische Nachweise. `QA_VERIFIED` und `PRODUCTION_VERIFIED`
sind offen. Diese Anleitung erteilt keine Freigabe und startet keine Buchung.

## Bestandsaufnahme und genau fehlende Angaben

`vorhanden` meint Code oder historische Metadaten, nicht eine Freigabe für
diesen Lauf. Weder in den aktuellen Umgebungsvariablennamen noch in einer
`.vercel`-Projektverknüpfung fand sich eine Studio-QA-Bindung. Die Vercel-CLI
meldete in beiden Arbeitsverzeichnissen `link_required`; die reine Remote-
Projektliste war wegen eines CLI-Netzwerkfehlers nicht abrufbar. Es wurden
keine Geheimniswerte gelesen. Historische Neon-QA-Belege gelten nicht als
Ziel- oder Nutzungsfreigabe für den Studio-Chat.

| Punkt | Vorhanden | Freigegeben | Verwendbar | Genau noch benötigt |
| --- | --- | --- | --- | --- |
| Isoliertes CRM-/Datenbank-QA-Ziel | Neon-Zielschutz im Code; historische QA-Belege | Nicht für diesen Lauf belegt | Nein | Freigegebene CRM-Preview-Projekt-/Origin-ID, Neon-Projekt, Branch, Datenbank, gepoolter Host, Laufzeitrolle, Produktionshost zum Abgleich, QA-Laufkennung und Ziel-/Rollback-Freigabe |
| Studio-Testmandant | Feste Studio-Workspace-, Formular- und Actor-IDs im CRM-Code | Nicht im QA-Ziel belegt | Nein | Bestätigung, dass genau dieser Studio-Scope im isolierten QA-Ziel mit aktivem Actor und Testdaten existiert |
| Microsoft-Organisator/Zielkalender | Adapter erwartet explizite IDs | Nein | Nein | Freigegebene Test-Organisator-ID und exakte Kalender-ID |
| Kalenderverfügbarkeit | Graph-`calendarView`-Code, synthetisch getestet | Berechtigung nicht belegt | Nein | Genehmigung und gesonderter realer QA-Lesenachweis für den Testkalender |
| Terminerstellung | Graph-Event-Code, synthetisch getestet | Berechtigung nicht belegt | Nein | Genehmigung und gesonderter realer QA-Erstellnachweis mit Testteilnehmer |
| Teams-Besprechung | Teams-Link-Auswertung, synthetisch getestet | Berechtigung nicht belegt | Nein | Genehmigung und gesonderter realer QA-Linknachweis |
| Testempfänger | `romaustria82@gmail.com` wurde vom Auftraggeber für isolierte QA benannt und als einziger Kandidat in die Vorlage übernommen | QA-Zielbindung und Empfängerfreigabe nicht belegt | Nein | Bestätigung der Zielbindung und dokumentierte Testempfängerfreigabe; die Adresse ist kein Kalenderorganisator |
| Terminregeln | Kandidat: 30 Minuten, Mo–Fr 09:00–17:00 Europe/Dublin, 15 Minuten Puffer, 24 Stunden Vorlauf, 7 Tage Horizont | Produktionsfreigabe nicht erteilt | Nein | Bestätigung des Vorschlags, Startintervall in Minuten und Genehmigungs-ID |
| Studio–CRM-Verbindung | Versionierte HMAC-Schnittstelle im Code | QA-Bindung nicht belegt | Nein | Exakte HTTPS-Preview-Origins, Studio-/CRM-Projektidentität und dieselbe sicher hinterlegte Signatur auf beiden QA-Seiten |
| Dauerhafter Status | Migration 097 und CRM-Beleg-/Buchungstabellen lokal getestet | QA-Migration nicht freigegeben/angewandt | Nein | Freigabe und Nachweis von Migration 097, Laufzeit-RLS, Lead-/Buchungsbeleg, Wiederaufnahme und Rollback im isolierten QA-Ziel |

## Vorlage und Sperren

Die geheimnisfreie Vorlage liegt unter
`config/studio-sales-qa.example.json`. Eine ausgefüllte Kandidatendatei gehört
in das ignorierte Verzeichnis `.npm-cache/qa/`; keine Zugangsdaten oder
Besuchertexte in die Vorlage schreiben. Der lokale, rein statische Check:

```powershell
npm run qa:studio-sales:preflight -- .npm-cache/qa/studio-sales-qa-config.json
```

Die Vorlage enthält jetzt ausschließlich die vom Auftraggeber genannten
Kandidatenwerte. `organizerId`, `calendarId`, `intervalMinutes`, Freigabe- und
QA-Zielkennungen bleiben leer. Sie aktiviert keinen Kalender. Die
Slotberechnung verlangt, dass Start **und Ende** innerhalb 09:00–17:00 liegen;
vorhandene Belegungen und beidseitiger Puffer werden berücksichtigt.

Ohne ausgefüllte Vorlage liefert der Check `QA_BLOCKED` und nur Feldnamen.
Ein vollständiger Kandidat beweist noch weder externe Freigabe noch
Graph-Berechtigung. Der verantwortliche Eigentümer muss die Referenzen auf
die tatsächlichen Freigaben prüfen.

Zur späteren Preview-Bindung gehören auf Studio-Seite
`NOVALURE_CRM_WEBHOOK_URL`, `STUDIO_BOOKING_QA_CRM_ORIGIN`,
`STUDIO_BOOKING_CONFIG_APPROVAL_ID`, `STUDIO_BOOKING_QA_RECIPIENTS_JSON`,
`NOVALURE_STUDIO_INGESTION_SECRET` und `STUDIO_BOOKING_REAL_MODE=1`.
`STUDIO_BOOKING_QA_STUDIO_PROJECT_ID` muss der tatsächlichen
`VERCEL_PROJECT_ID` des Studio-Previews entsprechen.
Der Browser darf keine Empfänger-, Mandanten- oder Ziel-Overrides setzen.
Die Preview-Lead-Übergabe und Buchung sperren bei fehlender Bindung sowie
nicht freigegebenen Empfängern. Localhost bleibt beim expliziten synthetischen
Testadapter.

CRM benötigt dieselbe Signatur, Genehmigungs-ID und Empfängerliste sowie
`STUDIO_BOOKING_POLICY_JSON`, die vorhandenen Microsoft-Credential-Namen,
`DATABASE_URL`, `NOVALURE_QA_DATABASE_URL`,
`NOVALURE_QA_DATABASE_HOST`, `NOVALURE_QA_PROJECT_ID`,
`NOVALURE_QA_BRANCH_ID`, `NOVALURE_QA_DATABASE_NAME`,
`NOVALURE_QA_DATABASE_ROLE` und `NOVALURE_PRODUCTION_DATABASE_HOST`.
`STUDIO_BOOKING_QA_CRM_PROJECT_ID` muss der tatsächlichen
`VERCEL_PROJECT_ID` des CRM-Previews entsprechen.
`DATABASE_URL` und `NOVALURE_QA_DATABASE_URL` müssen exakt auf dasselbe
isolierte Ziel zeigen. Der CRM-Booking-Endpunkt prüft die tatsächlichen Neon-
Projekt-/Branch-/Datenbank-/Rollenmerkmale, Buchungstabelle und den aktiven
Studio-Actor vor Kalenderzugriff. Fehlende Werte ergeben `request_only`;
Produktionslaufzeit bleibt gesperrt. Die Graph-Berechtigungen können erst
im freigegebenen QA-System real nachgewiesen werden.
`STUDIO_BOOKING_POLICY_JSON.approvalId` und
`STUDIO_BOOKING_CONFIG_APPROVAL_ID` müssen beide der genehmigten
`approvalRecordId` entsprechen; `STUDIO_BOOKING_QA_RECIPIENTS_JSON` enthält
auf beiden Seiten dieselbe freigegebene Liste.

## Kurzer Ablauf nach vorliegender Freigabe

1. Genehmigungsreferenzen und Zielmetadaten in der ignorierten Kandidatendatei
   eintragen; den statischen Check ausführen. Beide Vercel-Projekte explizit
   identifizieren, Preview-Zugriff schützen und die Secret-Namen ohne Wertausgabe
   prüfen. Eine Projektverknüpfung wird nicht automatisch hergestellt.
2. Mit bereits freigegebenem QA-Zugang `npm run ci:qa-target` ausführen. Das
   vorhandene Skript liest die Neon-Zielidentität und verlangt zusätzlich
   `NOVALURE_QA_RUN_PREFIX`; es verändert keine Daten. Studio-Actor, RLS und
   Migration 097 anschließend read-only bestätigen. Erst nach separater
   Migrationsfreigabe die Migration auf das isolierte QA-Ziel anwenden.
3. Die zwei geprüften Revisionen in geschützte Preview-Ziele bringen und
   QA-Variablen dort binden. Zunächst nur Kalenderlesen und freie Zeitfenster
   prüfen; Fehler müssen ohne buchbaren Erfolg enden.
4. Mit einer freigegebenen Testadresse je einen Telefon- und Teams-Termin
   bestätigen. CRM-Lead-ID, Ereignis-ID, Teams-Link und tatsächlichen
   Einladungseingang getrennt belegen. Doppelklick, parallele Anfrage,
   inzwischen belegten Slot, Timeout und Wiederaufnahme mit derselben ID
   prüfen; niemals einen unklaren Erstellungsvorgang blind wiederholen.
5. QA-Belege mit Ziel/Revision/Zeitpunkt sichern und Testeinträge kontrolliert
   bereinigen. Bei Fehlern `STUDIO_BOOKING_REAL_MODE` deaktivieren und den
   betroffenen Beleg zur Klärung halten. `QA_VERIFIED` erst nach allen realen
   Nachweisen setzen. Produktionsfreigabe ist ein eigener Vorgang.
