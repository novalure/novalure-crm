# Reservierungshistorie und manuelle Prüfaufgaben – Backendentwurf

Basis: `18fbc8421f294bd276728bc329c9c6d56f0ed715` / Tree `56d848d8bab91b3fd9f04c3b6a8886223e351503`.
Isolierter Entwurf; keine Migration, Grants, Provider-, Zahlungs- oder Vertragsaktion. Noch keine Laufabnahme.

## Kundenlesevertrag

`GET /api/crm/property-sales/history?workspaceId=W&projectId=P&unitId=U[&reservationId=R][&cursor=C]`

- Reguläre Sitzung mit `crm:read`; vorhandene Workspaceauflösung, frische Mitgliedschaft/Sitzung über `withCrmRead`, aktuelles Projektleserecht über `assertProjectGrant`.
- `projectId` und `unitId` sind Pflicht-UUIDs. Die Einheit muss zum autorisierten Workspace/Projekt gehören; ein optionaler Reservierungsbezug muss zur selben Einheit gehören. Kein projektübergreifender Sammelaufruf.
- Fehlender/ungültiger Pflichtbezug: `400 VALIDATION_ERROR`; nicht verfügbarer Einheiten-/Reservierungsbezug: `404 HISTORY_NOT_AVAILABLE`; fehlendes Projektrecht: `403 PROJECT_FORBIDDEN`; widerrufene Sitzung/Mitgliedschaft wird durch den bestehenden gemeinsamen Guard verweigert.
- Doppelte Scope-/Cursorparameter werden abgewiesen. Ungültiger, leerer oder für einen anderen W/P/U/R-Bereich erzeugter Cursor: `400 INVALID_HISTORY_CURSOR`.
- Antwort `{data: PropertySalesHistoryPage, source: "database"}` mit `Cache-Control: private, no-store` und `nosniff`, auch auf Fehlerantworten. Kein neuer Schreibhandler.
- Feste Seitengröße maximal 40, eine zusätzliche SQL-Zeile bestimmt `nextCursor`. Reihenfolge absteigend nach Datenbankzeit, Quellrang und UUID. Der Cursor erhält die Datenbankmikrosekunden unverändert und bindet W/P/U/R; ein Cursor ist kein Berechtigungsnachweis.

DTO und Clientvalidator stehen in `src/lib/property-sales-history.ts`. `coverage` lautet immer `RECORDED_EVENTS_ONLY`. Null bei vorherigem Status/Frist/Version heißt **unbekannt**; fehlende Ereignisse werden nicht rückwirkend erfunden.

## Unveränderliche Datenquellen und Datenschutzgrenze

Reservierungsereignisse entstehen aus dem Join `crm_domain_events` → `crm_command_receipts`. Er bindet Workspace, Projekt, Command, Actor, Operation, Auditreferenz, Correlation, Resource sowie Klassifikation/Zweck. Nur `property_sales.reservation.request`, `.confirm`, `.extend`, `.expire`, `.withdraw` werden projiziert. Eine NULL-Resource-ID älterer gültiger Befehle ist zulässig; verbindlich sind die strikt geprüften `response.record`-IDs, die aktuelle gleichprojektige Reservierung und ihre Einheit. Status und Operation müssen zusammenpassen. Andere oder widersprüchliche Bezüge werden nicht ausgegeben.

Es wird keine Rohresponse oder freie Payload geladen/ausgegeben. SQL wählt ausschließlich DTO-Felder. Zulässig sind Ereignisart, Zeit, Bearbeiter-ID/Anzeigename, Einheiten-/Reservierungs-ID, belegte Status-/Frist-/Versionswerte, verifizierbare Aufgaben-ID sowie der bestätigte Fach-Quellbeleg. Name/Beleg werden von Steuerzeichen bereinigt und auf 200/2000 Zeichen begrenzt. Kein allgemeiner PII-Detektor wird behauptet. Käufer-/Kontaktname, E-Mail, Telefon, Preis, komplette Metadaten und Auditgründe gehören nicht zum DTO. Darstellung als escaped Text; keine HTML- oder automatische Linkinterpretation.

Die Aufgabenreferenz wird gegen den aktuellen Workspace/Projekt-/Reservierungs-/Einheitenbezug und den serverseitigen Command-/Metadatenvertrag geprüft. Eine legitime spätere Ownerzuweisung entfernt den historischen Link nicht; der historische Actor stammt unverändert aus dem Event. Eine unpassende oder umgehängte Aufgabe wird nicht aus der Rohresponse durchgereicht.

`property_unit_audit_events` ergänzt getrennte `source: "unit_audit"`, `kind: "unit.audit"`-Bestandsbelege. Nur erlaubte Status-/Versionswerte und Actor/Zeit werden projiziert. Ohne belastbaren Reservierungsbezug bleibt `reservationId` null. Bei explizitem R-Filter werden nur exakt R zugeordnete Unit-Audits einbezogen. Zeitlich ähnliche Ereignisse werden nicht zusammengeführt.

Vorhandene FORCE-RLS und Tabellenrechte bleiben unverändert. Der Leser verwendet weder `recommendation-runtime` noch `crm_fallback_audits`, keine allgemeinen Auditgrants und keine privilegierte Ausweichverbindung.

## Vier manuelle Aufgabenfolgen

Innerhalb desselben erfolgreichen `executeCrmCommand`-Callbacks wird pro Anfrage, Bestätigung, Verlängerung oder Ablauf genau eine neue Aufgabe erzeugt. Bestehende Aufgaben werden weder geändert noch erledigt. Die vorhandene separate Rücknahmeaufgabe bleibt unverändert und wird nicht dupliziert.

| Befehl | Titel | Eigentümer / Status / Fälligkeit |
|---|---|---|
| request | Reservierungsanfrage manuell prüfen | aktueller Actor / open / NULL |
| confirm | Bestätigte Reservierung manuell prüfen | aktueller Actor / open / NULL |
| extend | Reservierungsverlängerung manuell prüfen | aktueller Actor / open / NULL |
| expire | Abgelaufene Reservierung manuell nachbereiten | aktueller Actor / open / NULL |

Der Titel kann die Einheitsnummer enthalten. Es wird kein fachlicher Fälligkeitstermin erfunden: Der generische Aufgabenvertrag akzeptiert `due_at=NULL`. Die Reservierungsfrist steht ausschließlich als Kontext in `metadata.reservationExpiresAt`.

Weitere feste Metadaten: `source: reservation_manual_review`, `reservationId`, `unitId`, `action`, `manualReviewOnly: true`, `commandId`. Tenant, Owner und Referenzen stammen aus dem aktiven Commandkontext und der gesperrten gespeicherten Reservierung/Einheit; keine übergebenen Aufgaben-Owner/Workspacewerte.

Die Hilfe prüft vor der Wirkung und vor einem möglichen Receipt-Replay `crm:write`, die tatsächliche generische Aufgabenfähigkeit `workspace:operate`, aktuelles Projektwrite sowie den unveränderten `assertRecordWriteAccess`-Validator des normalen Aufgabenwriters für den aktuellen Actor als Owner. Dazu wird ausschließlich der vorhandene Validator exportiert; seine Rollen-/Own-/Projektregeln ändern sich nicht. Alle derzeitigen Produktrollen mit `reservations:write` besitzen auch `workspace:operate` und erfüllen für eigene neue Aufgaben diese Regeln. Es werden keine künstlichen Rollen oder neuen Grants eingeführt. Eine fehlende Aufgabeautorität verweigert den Gesamtbefehl atomar.

`taskId` und die tatsächlich verfügbare vorherige Reservierungssicht (`historyBefore.status/expiresAt`) werden im bestehenden Receipt gespeichert. Receipt-Replay ruft den Writer nicht erneut auf. Scheitert die Aufgabenanlage, muss die gesamte Transaktion mit Reservierung, Bestand und Audit zurückrollen. Früher Ablauf, Versionskonflikt und abgewiesene Autorität erzeugen keine Aufgabe.

Es werden keine Verträge, Anzahlungen, Finanzfolgen, Provider oder Nachrichten automatisch erledigt oder versendet.

## Bestehende Replay-/Lookupgrenzen

Der gemeinsame Commandpfad prüft aktuelle Mitgliedschaft/Sitzung und Projektwrite bereits vor dem Receipt-Replay. Zusätzlich prüfen confirm/extend und sale.confirm wie die vorhandene Rücknahme die aktuelle Fachautorität vor dem Receiptlookup, mit gleichbleibender Reservierung → Einheit → Authority-Sperrreihenfolge. unit.price.confirm hält Einheit → Price-Authority vor dem Lookup. CAS-/Zustandsprüfungen bleiben ausschließlich im echten Wirkungscallback; ein korrekt autorisierter Replay wird nicht wegen inzwischen fortgeschrittener Versionen abgelehnt. Request/expire erhalten keine erfundene Fachvollmacht, prüfen aber vor Lookup wie alle vier neuen Aufgabenwirkungen den bestehenden Aufgabenvertrag.

Der generische `/api/crm/commands/reconcile`-Handler unterstützt im Basisstand keine property-sales-Targets. Er wird hier nicht zu einem Historien- oder neuen Salesreconcilevertrag erweitert. Eine unsupported-Denial ist kein positiver Nachweis eines Reservierungs-Reconcile. Bestehende Rechteprüfungen werden nicht gelockert.

Die gemeinsame Funktion `withCrmCommandPreflight` verwendet dieselbe Operation-/UUIDv4-/Correlation-/Resource-/Projekt-/Versionsvalidierung wie der Commandpfad. Nach frischer Mitgliedschaft/Sitzung und Capabilityprüfung belegt sie **zuerst** den Transaktionslock `crm-command:W:key`, danach das aktuelle Projektrecht und erst dann fachliche Vorprüfungen. `executeCrmCommand`, `reconcileCrmCommand` sowie die Salesvorprüfungen einschließlich vorhandener Withdrawal verwenden denselben Pfad. Innere Commandaufrufe belegen denselben Lock reentrant. Somit entsteht zwischen gleichzeitigem request und confirm/extend/price/sale/withdraw mit demselben Schlüssel kein K→U gegen U→K-Zyklus. Ein geänderter Body unter demselben Schlüssel bleibt ein Idempotenzkonflikt.

Authorityassign läuft ebenfalls erst nach K und nimmt keine Einheitsperre. Der unveränderte Requestcallback nimmt seine Einheit vor dem Käuferlead; beide liegen hinter K. Andere bestehende Fachflüsse mit anderen Schlüsseln werden durch diese enge K-Korrektur nicht generell neu geordnet; es wird keine globale Deadlockfreiheit aller CRM-Operationen behauptet. CAS-/Zustandsprüfung verbleibt ausschließlich beim echten Wirkungscallback und wird nicht als Vorbedingung für einen bereits bestätigten Replay verwendet.

Für spätere Auxiliary-Anpassungen: Am älteren a1a1995 gab es die Rücknahme noch nicht. Die Basis18f enthält200/withdrawal samt dessen Vorabvollmacht, prüfte die übrigen Fachvollmachten aber erst im Callback. Der aktuelle Entwurf ergänzt ausschließlich vor Lookup die vier Aufgabenrechtsprüfungen sowie confirm/extend/price/sale-Fachvollmachten. Keine Auxiliary-Dateien, Testlauncher, Versionpins oder Release-Worktrees werden durch diesen Backendauftrag verändert.

Der zusätzliche technische Lockorderdelta gilt auch für den bestehenden Withdrawal-Vorabpfad: K wird nun vor dessen R/U/A belegt. Der erste Freeze `backend-freeze.json` bleibt als historischer Entwurfsbeleg unverändert; die K-Korrektur erhält den separaten neuen Freeze `backend-freeze-lock-order.json`.
