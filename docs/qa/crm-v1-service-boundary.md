# CRM-v1-Dienstgrenze: Implementierung und lokale Belegkarte

Stand: 2026-09-17. Diese Belegkarte beschreibt den Integrationsumfang der Originalgaps G01, G02, G16 und G17. Sie ist keine Aussage über eine vollständige Sicherheitsmigration aller historischen manuellen CRM-Module und kein Produktions- oder Preview-Nachweis.

## Additive Read-Version v1.1 (EVM-08B.1)

`crm-integration-v1.1` erweitert dieselbe Dienstgrenze ausschließlich um `Deal`-Reads und strukturierte Suchen über `Contact`, `BuyerLead` und `Deal`. Der bestehende Vertrag `crm-integration-v1` und seine Request-Paritätsvektoren bleiben unverändert. Deal und Search lehnen einen Versions-Downgrade auf v1 ab.

Die neuen Scopes heißen `crm.deals.read` und `crm.search.read`. Search verlangt immer beide: `crm.search.read` und den Read-Scope der Zielentität. Eine Search-Anfrage ist an ein bestehendes Project-Resource-Binding sowie dessen unveränderliche Auditbindung gebunden. Ergebnisse werden zusätzlich auf einzeln für denselben Principal gebundene Ressourcen desselben Workspace/Projekts, Datenkontexts, Sensitivitätsniveaus, Fachbereichs und Zwecks begrenzt.

Search akzeptiert nur `page` 1–5, `pageSize` 1–25 sowie die festen Filter `updatedAfter`, `status` (nur BuyerLead) und `stage` (nur Deal). Tabellen, Zielentitäten, Sortierung und Projektionen sind serverseitig festgelegt. Beliebige Felder, SQL oder eine allgemeine Query-Sprache existieren nicht.

Die Deal-Projektion enthält ausschließlich Referenzen auf Deal, Tenant, Pipeline, Owner und verknüpften Kontakt sowie Version, SHA-256-Projektionshash, Stage, Next Action, Änderungszeit und den als `FINANCIAL` klassifizierten EUR-Minor-Unit-Wert. Rohmetadaten, Wahrscheinlichkeit, Risiko, E-Mail und Telefonnummer werden nicht exportiert. Migration `087_evm08b1_read_contracts.sql` erweitert nur die geschlossenen Scope-/Entity-Constraints; sie erzeugt weder Principal noch Credential noch Geschäftsdaten.

Auf dem ausschließlich dafür vorgesehenen Git-Branch `codex/evm-08b1-read-contracts` akzeptiert die Vercel-Preview-Runtime als Datenziel nur `G27_QA_DATABASE_URL`. Ein gleichzeitig vorhandenes abweichendes generisches Datenbankziel führt vor dem Verbindungsaufbau zum Abbruch. Production, `main` und alle anderen Branches können diesen Fallback nicht verwenden.

## Verbindlicher Bezug

Evelyn-Tag `phase-2a-crm-contract-v1`, Commit `8119798a97347eb1c96126c6a14308e158e20862`: `src/connectors/crm/contract.ts`, `mapping.ts`, `src/domain/types.ts` und `src/security/redaction.ts`. Der frühere auditierte CRM-Quellstand bleibt `c3705927e2b47fc8fb0d52bfd28e5b8feff2f600`; neue CRM-Projektionen behaupten nicht, laufende Daten dieses alten Commits zu sein.

`scripts/qa-crm-contract-parity.mjs <readonly-Evelyn-checkout>` liest diese vier Dateien und vergleicht sie gegen den genannten Git-Commit. Der ausgeführte Vergleich lieferte **166 Fälle, 0 Unterschiede**. Die eingecheckte `scripts/fixtures/crm-v1-request-parity.json` enthält die erwarteten Ergebnisse und SHA256-Hashes der normalisierten Quellen. Der normale CI-Test verwendet ausschließlich diese Fixture; ein Evelyn-Checkout ist dafür nicht erforderlich. Der Vergleich ist repräsentativ, kein Beweis für sämtliche möglichen Eingaben.

## Erreichbarkeit und Identität

Einziger Einstieg: `POST /api/crm/contract/v1` mit eigenem `qa-crm-v1.`-Bearer. Die Migration erzeugt weder Principal noch Credential. Nur der isolierte synthetische Testaufbau erzeugt einen zufälligen, kurzlebigen Testwert im Arbeitsspeicher und speichert dessen SHA256-Hash in der Testdatenbank.

Die Datenbank prüft Principal, aktives Mitglied, exakten Actor, Department, Tenant-Alias, Scope, Ablauf, Widerruf, synthetischen QA-Workspace und die Produktrolle `agent/project_sales_member`. Owner-/Admin-Identitäten sind für diesen Vertrag unzulässig. Cookies, Browser-Origin und abweichende Kontext-/Zweck-/Klassifikationsheader werden abgewiesen. Production ist gesperrt. Ein Preview-Betrieb ist nicht durch diese lokalen Tests nachgewiesen.

`getRequestSession` lehnt diesen Service-Bearer vor der menschlichen Cookie-/Headerauflösung ab. Das gilt auch beim Versuch, zugleich Owner-Header einzuschleusen. Der tatsächliche Service-Principal kann damit die unten inventarisierten älteren CRM-Routen nicht erreichen. Deren menschliche Produktberechtigungen werden dadurch nicht neu definiert.

## Autorisierung, Datenzugriff und Transaktion

- `queryAuthenticationRows` führt die schmale Credentialprüfung über dieselbe verifizierte, nicht privilegierte Laufzeitrolle aus, in einer Transaktion mit leerem Tenant-/Actor-Kontext. Hashes sind der Laufzeitrolle nicht direkt lesbar.
- Danach verwendet der Dienst `withCrmRead` und die bestehende Tenant-Transaktion. Der Principal wird innerhalb dieser Transaktion erneut geprüft und gesperrt; auch Actor-/Workspace- und Projektfreigaben werden frisch geprüft.
- Immutable Bindings verknüpfen genau Principal, Workspace, synthetischen Alias, Entity, native Ressource und Projekt. Erforderlich sind unabhängig voneinander `CUSTOMER_TENANT`, die Sensitivitätsklasse des Principals, `BUSINESS` und `OPERATIONS`. Fehlende Binding-Klassifikation ist `UNCLASSIFIED` und bleibt gesperrt.
- Der native Datensatz muss zusätzlich das richtige Workspace-/Projektpaar und die bestehende CRM-Klassifikation `CUSTOMER_TENANT` mit Zweck `crm_sales` besitzen. Die historische CRM-Spalte `data_classification` bezeichnet den Datenkontext; die zusätzliche Binding-Klasse bezeichnet ausdrücklich die Sensitivität. Sie werden nicht gleichgesetzt.
- PRIVATE_FRANZ, NOVALURE_INTERNAL, SECRET, unklassifizierte oder fremde Kontexte erhalten keinen impliziten Zugriff. Es gibt keine Owner-Ausnahme im Dienstvertrag.
- Die technische Auditbindung ist an den Digest des vollständigen validierten Requests, die Ressource, den Principal und einen Ablauf gebunden. Sie ist keine geschäftliche ApprovalReference.
- Alle drei erlaubten Writes verwenden `executeCrmCommand`, SQL-CAS, unveränderliche Receipts, Audit und Event in derselben Transaktion. Reconcile authentifiziert und autorisiert erneut. `NOT_FOUND` beweist ausschließlich, dass kein passendes Receipt beobachtet wurde; unbekannte Ergebnisse dürfen nur reconciliert werden.
- Der interne Command-Digest hat Version 2 und bindet nun ausdrücklich auch die Correlation-ID. Bereits erzeugte unveröffentlichte QA-Receipts werden nicht umgeschrieben; veraltete Receipts können daher konfliktbehaftet sein und benötigen einen sauberen isolierten QA-Aufbau. Eine Produktions-Receipt-Migration wird nicht behauptet.

## Feld- und Tabelleninventar

Alle Projektionen enthalten nur explizit ausgewählte Spalten, geprüfte synthetische Freitexte und die vereinbarten Status-/Zeit-/Profilfelder. Kontakt-Mailadresse, Telefonnummer, Roh-Metadaten und Credentialhash fehlen. Native UUID-Referenzen bleiben `referenceScope: NOT_VERIFIED`; es werden weder referenzierte Datensätze nachgeladen noch daraus Autoritäten abgeleitet.

| Entity | Quelle | Ausgewählte fachliche Spalten |
| --- | --- | --- |
| Contact | contacts | name, organization_id |
| Company / Developer | organizations | name, type, lifecycle_stage; Developer nur Bauträger |
| Project | projects | name, type, status |
| Unit | property_units | unit_number, building_id, buyer_contact_id, deal_id, status, price_cents |
| BuyerLead / Qualification | leads | contact_id, type, status, score, buyer_profile; nur Käufer |
| Task | tasks | title, contact_id, lead_id, due_at, priority, status |
| Appointment | calendar_events | title, contact_id, lead_id, starts_at, ends_at, status |
| Viewing | property_viewing_slots | unit_id, contact_id, lead_id, starts_at, ends_at, status, note |
| Reservation | property_reservations | unit_id, contact_id, deal_id, status, expires_at, deposit_cents, contract_milestone, next_action |
| Communication | conversations | contact_id, lead_id, channel, direction, summary, sentiment, last_message_at |

Workspace, ID, Projekt, Änderungszeit und Klassifikation/Zweck werden zusätzlich zur Scopeprüfung selektiert. Die ersten elf Entity-Projektionen verwenden bestehende Tenant-/Projekt-RLS. Communication verwendet ausschließlich `crm_read_contract_conversation`: einen engen SECURITY-DEFINER-Reader mit erneutem Credential-, Actor-, Scope-, Binding-, Projekt- und Klassifikationscheck. **Es gibt keinen neuen generischen SELECT-Grant auf conversations.** Fehlende Klassifikation historischer Conversations wird nicht automatisch aufgefüllt.

## Scope-Vokabular und wirklicher Funktionsumfang

Die 22 Scope-Namen entsprechen exakt dem eingefrorenen Vertrag:

`crm.contacts.read`, `crm.contacts.write`, `crm.companies.read`, `crm.developers.read`, `crm.projects.read`, `crm.projects.write`, `crm.units.read`, `crm.leads.read`, `crm.leads.write`, `crm.qualifications.read`, `crm.offers.read`, `crm.offers.prepare`, `crm.tasks.read`, `crm.tasks.write`, `crm.appointments.read`, `crm.viewings.read`, `crm.reservations.read`, `crm.reservations.prepare`, `crm.sales.read`, `crm.communications.read`, `crm.communications.write`, `crm.approvals.read`.

Die Existenz eines Scope-Namens ist keine ausführbare Freigabe. Positiv implementiert sind die **12 oben genannten Read-Projektionen** sowie **Contact.name, Project.name und Task.title** als genau ein synthetisches Patchfeld mit erwarteter Version. BuyerLead-/Communication-Write, PrepareOffer, PrepareReservation, SendOffer, ConfirmReservation und ConfirmSale bleiben gesperrt. Offer, Sale und ApprovalReference liefern weiterhin SEMANTIC_GAP. Es gibt keine Dienstoperation für Preise, Reservierungszusage, Verkauf, Zahlungsfreigabe, externen Versand oder sonstige Feldänderungen. Das separate manuelle Angebotssystem ist keine vorgetäuschte Evelyn-Zweikanalfreigabe; G08 bleibt eigenständig zu bewerten.

## Tatsächlich ausgeführte Nachweise

`node --import tsx --test scripts/crm-command-tests.ts scripts/crm-service-contract-tests.ts`: **50/50 PASS** (29 Foundation + 21 Service). Die Suite betreibt einen lokalen isolierten PostgreSQL-Cluster mit echter nicht privilegierter Laufzeitrolle. Der HTTP-Harness ruft die tatsächlichen importierten Next-Route-Handler über einen Loopback-HTTP-Server auf; er ist kein vollständiger Next-Browserlauf oder Preview-Test.

Nachgewiesen sind insbesondere positive Reads aller 12 Entities, die drei erlaubten Metadatenwrites, Versionsrennen, Replay, Correlation-Konflikt, Reconcile, Rollback, unveränderliche Audit-/Receipt-Daten, sichere Poolrolle, Pool-Kontexttrennung, Tenant-/Projekttrennung, Principalwiderruf, Scopeentzug, unveränderliche Klassifikations-/Zweckbindings und Ablehnung unsicherer Quelldaten. Die Service-Suite enthält außerdem die 166 gespeicherten Schemafälle in einem benannten Test und prüft **61 historische CRM-HTTP-Methoden** auf 401/403. Die Fallzahlen 166 und 61 werden nicht zusätzlich als eigenständige Node-Testfälle gezählt.

Gezielter ESLint für die Service-/Foundation-Änderungen und Tests: PASS. Der Gesamt-Typecheck und globale Gatelauf werden im übergeordneten Abschlussbericht ausgewiesen.

## Gaps und Grenzen

| Gap | Lokaler Befund im ursprünglichen Integrationsumfang |
| --- | --- |
| G01 | Dienst-Principal, granulare Scopes und Actor-/Tenantbindung tatsächlich serverseitig verifiziert; keine aktive Evelyn-Verbindung oder breit privilegierte Identität. |
| G02 | Alle erreichbaren v1-Geschäftsqueries im geprüften Tenant-Transaktionspfad; enge Authentifizierungsquery davor ohne Geschäftszugriff. Historische CRM-Methoden sind für diesen Principal unerreichbar. |
| G16 | Positive Projektfreigaben plus Immutable Resourcebinding und RLS/enger Conversation-Reader; gleiches Tenant mit nicht freigegebenem Projekt praktisch abgewiesen. |
| G17 | Expliziter Datenkontext, Sensitivität, Domain und Zweck; fehlende oder abweichende Werte praktisch abgewiesen. |

Diese vier Befunde sind lokale Implementierungs-/Testnachweise; die unabhängige Abschlussbewertung obliegt dem Review. Keine pauschale Absicherung sämtlicher historischer menschlicher CRM-/Hintergrundmodule wird behauptet. Vorgeschlagene globale Querysperren, flächige RLS-Änderungen und pauschale Recommendation-Abschaltungen wurden nach automatischer Ablehnung nicht angewendet. Die engere Dienstgrenze benötigt diese Eingriffe nicht.

G24, Migration/Preview und providerbedingte Rollengates bleiben separat. Diese Arbeit führte keinen Remote-DB-Zugriff, keine Provideraktivierung, keine Evelyn-Änderung, keinen Productionzugriff und kein Deployment aus.

## Historische CRM-Routen: negative Erreichbarkeitsprüfung

Die folgende Liste stammt aus den exportierten tatsächlichen Route-Handlern. Der automatisierte Test inventarisiert sie bei jedem Lauf neu. Jede hier genannte Methode wurde mit gültigem Service-Bearer und gefälschten Owner-Headern abgewiesen.

| Route | Methoden |
| --- | --- |
| /api/crm/analytics-events | GET |
| /api/crm/bots | POST |
| /api/crm/broker/mandates | GET, POST, PATCH |
| /api/crm/broker/search-profiles | GET, POST, PATCH |
| /api/crm/calendar-events | GET, POST, PATCH |
| /api/crm/commands/reconcile | POST |
| /api/crm/contacts | POST, PATCH, DELETE |
| /api/crm/core | GET |
| /api/crm/customer-access | GET, POST, PATCH |
| /api/crm/dashboard-views | GET, POST |
| /api/crm/data-quality | GET, POST |
| /api/crm/deals | POST, PATCH |
| /api/crm/deals/[dealId]/stage | POST, PATCH |
| /api/crm/deals/[dealId]/stage-history | GET |
| /api/crm/editor-preflight | POST |
| /api/crm/funnels | POST |
| /api/crm/google-notifications | GET, POST, PATCH |
| /api/crm/google-notifications/[notificationId]/retry | POST, PATCH |
| /api/crm/leads | POST, PATCH |
| /api/crm/notes | GET, POST, PATCH |
| /api/crm/offers | GET, POST |
| /api/crm/projects | POST, PATCH |
| /api/crm/properties | GET, POST |
| /api/crm/property-sales | GET, POST |
| /api/crm/recommendation-runtime | GET, POST |
| /api/crm/reservations | POST, PATCH |
| /api/crm/tasks | POST, PATCH |
| /api/crm/teams-notifications | GET, POST, PATCH |
| /api/crm/teams-notifications/[notificationId]/retry | POST, PATCH |
| /api/crm/units | GET, POST |
