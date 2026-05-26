# Production Readiness Phase 4

Datum: 2026-05-26

## Ziel

Fehlerhafte Eingaben und destructive Aktionen duerfen nicht still oder inkonsistent gespeichert werden. Die Serverantwort muss eindeutig sein und Loeschen muss als wiederherstellbare Archivierung laufen.

## Erledigt

- Servervalidierung in den zentralen CRM-Schreibrepositories:
  - Kontakte: ungueltige E-Mail, zu lange Namen/Absichten und aktive Dubletten per E-Mail werden abgelehnt.
  - Deals: zu lange Namen/naechste Aktion und unplausible Betraege (`<= 0` oder extrem hoch) werden abgelehnt.
  - Leads: zu lange Absichten/naechste Aktionen und vergangene `nextContactAt`-Termine werden abgelehnt.
  - Aufgaben: zu lange Titel werden abgelehnt.
- API-Fehlerstatus verbessert:
  - Validierungsfehler liefern 400.
  - Rollen-/Ownerfehler liefern 403.
  - Nicht gefundene Datensaetze liefern 404.
  - Echte Infrastrukturfehler bleiben 503.
- Kontakt-Loeschpfad bestaetigt und abgesichert: `DELETE /api/crm/contacts` archiviert per `archived_at`/`archived_by_user_id`; die UI verlangt bereits eine explizite Archivierungsbestaetigung.
- Automatisierte Phase-4-Smoke-Tests decken Validierung, Dubletten, Fehlerstatus und Kontakt-Soft-Delete ab.

## Abnahmekriterium

- Pflicht-/Formatfehler erzeugen eine eindeutige API-Fehlantwort statt eines scheinbaren Speichererfolgs.
- Ein Kontakt mit gleicher aktiver E-Mail kann nicht doppelt angelegt werden.
- Ein Deal mit Betrag 0, leerem/ungueltigem Betrag oder extrem unplausiblem Wert wird abgelehnt.
- Kontaktloeschung bleibt wiederherstellbar, weil sie als Archivierung statt als hartes Delete umgesetzt ist.

Status: ja fuer Kontakte, Deals, Leads und Aufgaben. Papierkorb-/Restore-UI fuer archivierte Kontakte und Soft-Delete fuer weitere Entitaeten bleiben offen.

## Betroffene Dimensionen

- Technik gesamt: +6 erwartete Punkte durch serverseitige Negativvalidierung und korrekte Statuscodes.
- UX gesamt: +5 erwartete Punkte, weil Fehler nicht mehr als generischer Speicherfehler erscheinen muessen.
- Persistenz/Speicherung: +5 erwartete Punkte, weil Dubletten und unplausible Daten nicht persistiert werden.

## Validierung

- `npm.cmd run test:phase4`
- `npm.cmd run test:phase3`
- `npm.cmd run lint`
- `npm.cmd run build`

## Offene Punkte / Risiken

- Vollstaendige Papierkorb-/Restore-Oberflaeche fuer alle Entitaeten ist noch nicht abgeschlossen.
- Kontakt-Datensatz besitzt noch keinen eigenen `owner_user_id`; owner-genaue Kontakt-Rechte brauchen ein Datenmodell-Update.
- UI-Fehlermeldungen koennen in Phase 5 weiter sprachlich geglaettet werden.

## Naechster Schritt

Phase 5: Prototyp-/lokale Begriffe in weiteren Modulen entfernen, deutsch/englisch konsistent halten und leere Zustaende verbessern.
