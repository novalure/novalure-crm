# Gemeinsame Lernplattform – Paket 4

Basis: tatsächlich bereitgestellte CRM-Linie `6daf9b69`, regulär in den geprüften
Paket-3-Baselinezweig als `8ebcd10b` zusammengeführt. `main` enthält den separaten
Knowledge-Center-Betriebsabschluss und ist kein Ersatz dieser Produktlinie.
Die vorhandenen Kandidaten, deterministische Bewertung, getrennten Publisher,
unveränderlichen Veröffentlichungen und Rücknahme aus Paket 2 bleiben erhalten.

## Ergänzt und lokal geprüft

- Im bestehenden Knowledge Center: eigene Lernhistorie (höchstens 100 Einträge),
  aktive Methodenversion und ausdrückliche Einzellöschung mit Bestätigung.
  Sitzungs-, MFA-, CSRF- und Mitgliedschaftsprüfung bleiben serverseitig.
  Auch Eigentümer sehen keine Lernsignale anderer Nutzer desselben Unternehmens.
- Löschung und minimiertes Audit erfolgen atomar; das Audit speichert keine
  Signal-ID, Kategorie oder Bewertung. Fremde oder nicht vorhandene Signale
  ergeben denselben negativen Löschstatus. Veröffentlichungen bleiben unveränderlich.
- **Franz' Entscheidung vom 02.11.: „Vorerst keine automatische Löschung“.**
  Status `OWNER_DEFERRED`, keine Frist erfunden, keine automatische Löschroutine.
- Getrennte Publisher-Verwaltung über `scripts/shared-learning-manage.ts`:
  Kandidaten, Bewertungen, Verlauf und letzte 30 Lernläufe lesen; vorhandene
  Vorschlags-, Bewertungs-, Veröffentlichungs- und Rücknahmefunktionen bedienen.
  Kein Publisherpool wird einer Tenant-HTTP-Route zur Verfügung gestellt.
- Begrenzter periodischer Einstieg: höchstens ein Lauf je UTC-Datenbanktag,
  dauerhafte eindeutige Tagesreservierung, keine automatischen Wiederholungen
  nach Fehlern oder Unterbrechung. Der vorhandene deterministische Zyklus führt
  null Modellaufrufe aus und liest keine privaten Signale. Die Verwaltung zeigt
  `running`, `published`, `rejected` und `failed` mit Zeitpunkten; abgeschlossene
  Laufquittungen und deren Identität sind unveränderlich.

## Bedienung der getrennten Verwaltung

Nur explizites `BEHAVIOR_PUBLISHER_DATABASE_URL`, kein `DATABASE_URL`-Fallback.
Die vorhandene Publisher-Identitätsprüfung gilt bei jedem Zugriff; Tenant- und
Adminrollen können diese Verwaltung nicht verwenden. Credentialwerte gehören
weder in Befehlsargumente, Dateien, Ausgabe noch Git. Der freigegebene Host muss
sie regulär als Umgebung bereitstellen.

```sh
node --conditions=react-server --import tsx scripts/shared-learning-manage.ts inspect
node --conditions=react-server --import tsx scripts/shared-learning-manage.ts propose /private/proposal.json
node --conditions=react-server --import tsx scripts/shared-learning-manage.ts evaluate /private/candidate.json
node --conditions=react-server --import tsx scripts/shared-learning-manage.ts publish /private/publication.json
node --conditions=react-server --import tsx scripts/shared-learning-manage.ts rollback /private/rollback.json
node --conditions=react-server --import tsx scripts/shared-learning-manage.ts scheduled /private/schedule.json
```

Geschlossene JSON-Verträge: propose `{selection,expectedRevision}`, evaluate
`{candidateId}`, publish `{candidateId,expectedRevision}`, rollback
`{version,expectedRevision}`, scheduled `{enabled,selection}`. Selektion enthält
weiterhin nur feste `ruleIds` und `targets`. Maximale Konfigurationsdatei 4096
Bytes. Der periodische Einstieg liest die aktuelle Revision selbst; ein Lauf
vom Vortag hinterlässt keine automatisch veraltete Konfiguration. Deaktiviert
gibt es keinen Datenbankzugriff. Ein nach `running` unterbrochener Lauf wird
sichtbar gehalten, nicht automatisch neu gestartet.

## Nachweise und noch fehlende Aktivierung

Gezielte lokale PostgreSQL-Prüfung: `scripts/shared-behavior-package4-tests.ts`.
Sie ergänzt nur die neuen Pfade: echte Rollen/RLS, eigene/fremde Historie und
Löschung, widerrufene Mitgliedschaft/Schreibrechte, minimiertes Audit, direkte
Tenant-Sperre der Lauftabelle, gleichzeitige Tageszulassung, Fehl-/Ablehnungsstatus
und unveränderliche abgeschlossene Quittungen. Der historische <=090-Fixturebau
ist lokale synthetische Prüfung, keine Produktionsupgrade- oder Neon-Abnahme.
Ein anfänglicher Fixturefehler verwendete den nicht erlaubten Status `inactive`;
er wurde auf das reale `suspended` korrigiert. Die frühere fehlgeschlagene Prüfung
wird nicht als bestanden ausgegeben.

Migration bleibt unter `migrations/staged/shared_behavior_package4.sql` und wird
nicht vom Produktionsrunner gewählt. Vor Aktivierung fehlen: genaue aktuelle
Migrationsvorgängerprüfung, reservierte Nummer/Vertrag, überprüfte Migration,
separater tatsächlich bereitgestellter Publisherzugang und geprüfte Einbindung
in einen bestehenden berechtigten Scheduler. Der vorhandene CRM-Cron
`knowledge-monitoring` bedient Websiteüberwachung mit delegierter Tenantidentität;
er ist kein Publisher und wurde deshalb nicht mit zusätzlichen Rechten versehen.
Kein neuer Zeitplan wurde angelegt, kein bestehender der 13 geschützten Evelyn-
Zeitpläne verändert. Die CLI ist der lauffähige Aufrufer, kein behaupteter
aktivierter regelmäßiger Produktionsbetrieb. Fehlerzustände sind gespeichert;
eine tatsächliche externe Alarmzustellung bleibt eigener Betriebsnachweis.

Kein Produktionszugriff, keine Migration, Bereitstellung, Budgetänderung oder
Modellprüfung aus dieser Ergänzung. Exakte CI/App-Prüfung und echte Browserabnahme
der bereitgestellten Ansicht bleiben separate Abschlussgates. Der CRM-Dateirestore
und vorhandene Backup-Erfolge bleiben unverändert und sind kein Paket-4-Lernnachweis.
