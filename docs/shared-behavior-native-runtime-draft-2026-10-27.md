# Paket3: vorbereitete native CRM-Chatanschlüsse

Dieser getrennte Entwurf basiert unverändert auf CRM116/c1a9c2d535d5b46c77c81d77dd5ec43baac145b3.
Er ist lokal vorbereitet und standardmäßig ausgeschaltet. Keine Bereitstellung,
Konfiguration, Migration, Methodenveröffentlichung, Botaktivierung oder produktive
Signalaufzeichnung wurde hierfür ausgeführt. Die persönliche Evelyn-Abnahme geht
einer späteren Aktivierung voraus. Studio und Telefonie bleiben gesonderter Scope.

## Tatsächliche Ausgangslage

Ein ausschließlich aggregierter Productionread am27.10.2026 um20:13:29 UTC ergab
drei aktive chatfähige Integrationen mit drei gültigen gespeicherten Assistenten-
und Projektzuordnungen. Sie verwenden drei verschiedene Bots; eine vorhandene
PublicActor-Identität wird von mehreren Assistenten geteilt. Die konfigurierten
Bots haben zweimal Status inactive, einmal draft.126 nichtsynthetische öffentliche
Chatsessions entstanden in den letzten sieben Tagen. Der Read enthielt keine
Namen, Schlüssel, Ursprünge, Besucher-/Kunden-IDs, Nachrichten oder Inhalte.

Der vorhandene öffentliche Runtimepfad ist `answerWebsiteChat` über
`/api/public/integrations/chat/answers`. Er verlangt Origin, Sitekey und aktive
Besuchersession; Workspace, Projekt, PublicActor und Bot stammen aus dem aktuellen
Registryeintrag. Derselbe PublicActor ist deshalb **kein** pro Assistent privater
Lernactor. Der vorhandene Botstatus wird durch diesen Entwurf nicht umgedeutet.

`runBotChat` bedient `/api/bots/chat` und bestehende Kanalwebhooks. Sein eingeloggter
oder bereits verifizierter Kanalcaller bleibt unverändert. `/api/bots/agent` ist
der vorhandene Tool-/Knowledgeaufruf und besitzt keinen eigenen Modellchat.
Ihm wird kein fingierter Modellinstruction-Verbrauch zugeschrieben.

## Vorbereiteter tatsächlicher Anschluss

`native-assistant.ts` verwendet den vorhandenen `loadSharedBehavior` mit konstantem
Ziel webchat beziehungsweise agent. Die veröffentlichte unveränderliche Auswahl
und der vorhandene Compiler bestimmen die Instruction. Browser und Modell können
keine Auswahl, Version, Abteilung, Rechte oder privaten Zugangswerte vorgeben.

Im öffentlichen Pfad wird die Instruction erst innerhalb der bisherigen gültigen
Autorisierung geladen und an den bestehenden Systemprompt angehängt. Keine zweite
Wissensabfrage, keine veränderten Quellen oder Tools. Der authentifizierte
`runBotChat`-Antwortpfad prüft sein gespeichertes Botprojekt und den aktuellen
Caller erneut und hängt dann dieselben veröffentlichten Katalogregeln für agent
an. Vorhandene Sperren/Knowledgechecks greifen davor. voice und telephone laden
keine neue Instruction. Bestehende Tool-/Buchungs-/Dokumentpfade erhalten keine
neuen Berechtigungen aus diesen Methoden.

Production-v1 ist gegenwärtig nur für ceo veröffentlicht. Für webchat/agent
liefert dieser Stand Versionsmetadaten1 und lediglich die drei Basisregeln.
Die sechs Methoden für neue Ziele verlangen später eine eigene bewertete Auswahl
über den vorhandenen Lifecycle. Dieser Entwurf veröffentlicht keine Version2;
synthetische Headfixtures in den Consumptiontests sind keine Releasezulassung.

## Enges privates Signal

Der tatsächliche Publicantwortpfad ist sowohl für grounded Modellantworten als
auch seine unveränderten festen Ersatzantworten verdrahtet. Die reine Formatmetrik
prüft ausschließlich das Vorhandensein des Labels „Nächster Schritt:“, „Next step:“
oder „Siguiente paso:“ und schreibt `unclear_next_step/pass` beziehungsweise fail.
Die festen Ersatzantworten ohne Label ergeben damit korrekt fail, obwohl sie
inhaltlich einen sicheren Kontakt-/Wiederholungsschritt nennen. Das ist ausdrücklich
**kein** Beleg fehlender semantischer Klarheit oder schlechter Gesprächsqualität.
Auch ein vorhandenes Label beweist weder Qualität, Nutzerzufriedenheit, tatsächliche
Übergabe oder Behebung eines Wissensmangels. Kein Modell bewertet diese Metrik.

Pro erfasster Antwort wird eine neue zufällige eventId erzeugt. Sie ist weder
Session-, Nachrichten-, Conversation-, Kontakt- noch Kunden-ID. Gespeichert werden
ausschließlich die bereits vorhandenen kategorialen Felder in
`behavior_learning_signals`. Nachrichtentexte, Quellen, Zusammenfassungen und
Wissensimporte werden nicht an den Signaladapter übergeben. Regelmäßige Analyse,
Retention und automatische Auswertung bleiben Paket4. Wiederholte Anfragen sind
eigene Formatereignisse; eine deduplizierte semantische Konversation wird nicht
behauptet. Die bestehende Gateway-Ratenbegrenzung bleibt erhalten.

Der Signaladapter verwendet `recordEvelynRuntimeSignal` und damit `withRuntime`
ausschließlich für das Schreiben des privaten Signals. Der öffentliche Wissens-
und Queryactor bleibt derselbe. Es gibt keinen CEO-Capability-Reuse und keinen
öffentlichen Signalendpunkt.

Jeder tatsächlich anzuschließende Bot braucht eine **eigene** neue private
agent-Workspaceidentität und eine eigene neue32-Byte-Capability. Seine neue
`behavior_runtime_bindings`-Zeile bindet den vorhandenen aktuell vom Gateway
verifizierten PublicActor nur als Broker an diesen Bot und diesen privaten Actor.
Credentialidentität disabled, password_hash NULL, keine Sessions oder anderen
Loginmittel. Bindung zunächst disabled, mit expliziter Frist und Widerrufspfad.
Die vorhandene eindeutige Bot-/Actorbindung bleibt maßgeblich. Keine Identität
eines anderen Assistenten, Eigentümers, persönlichen Evelyn-Callers oder Studios
übernehmen; keine bestehenden Rows löschen oder still ersetzen.

Für einen customer-Tenant muss der private project_sales_member den exakten
Botprojekt-Metadatensatz lesen dürfen. Der synthetische Test qualifiziert eine
Read-only-Projektzuordnung ohne can_edit_deals. Ohne diese Sichtbarkeit bleibt
das Signal aus; der Adapter leiht keine Ownerrechte. Für interne Workspaces ist
wie bisher eine interne Mitgliedschaft nötig; deren bestehender Rollen-Scope
ist ausdrücklich kein pauschaler SQL-Deny aller übrigen CRMtabellen. Die
Identität wird allein im privaten Signalpfad verwendet, nie für Tools/Wissen.
Keine internen Knowledge-Areagrants anlegen: die117-Policies sperren damit für
diese Signalidentität auch generische Quellenabfragen. Öffentliche bestehende
Knowledgegrants und ihre Widerrufslogik bleiben vollständig erhalten.

Unmittelbar vor der privaten Aufzeichnung prüft derselbe Publicpfad seine
Besucher-/Bot-/Projekt-/Entitlement-Autorisierung erneut. Im `withRuntime`-Fence
prüft/lockt der bestehende `crm_external_integration_resolve` erneut die feste
Integration, den Projekt-/Bot-/Brokerbezug und chatEnabled. Der vorhandene
`behavior_lock_runtime` prüft Capability, gültige aktive Mitglieder, enabled,
Frist und Widerruf und hält auch den Botrowlock. Der zusätzliche Projektvergleich
benötigt deshalb nur SELECT und kein Botedit. Die zusätzliche Signaltransaktion
hat2s Statement-/Lockbudget. Fehler oder unklare Zuordnung unterdrücken dieses
optionale Signal und verändern keine bisherige sichere Antwort; keine Rohfehler
oder Konfigurationen werden geloggt. Das interne Receipt unterscheidet disabled,
not_configured, not_requested, recorded und unconfirmed. Auch ein tatsächlicher
Commit mit verlorener Bestätigung heißt unconfirmed und wird nie als abwesend
behauptet oder automatisch wiederholt. Ein optionaler Hostobserver erhält nur
Methodenversion, Bestätigungsstatus und diese feste Kategorie; keine privaten IDs,
Capabilities, Gesprächsinhalte oder Rohfehler. Die Publicresponse bleibt unverändert.

Die Methoden werden um den Modellaufruf erneut geladen und Version/Instruction
verglichen. Veränderte Methoden geben keine veraltete gelernte Antwort frei. Der
bisherige vollständige öffentliche Knowledge-/Authoritycheck bleibt erhalten.

## Konfiguration und unveränderte Grenzen

Alle drei neuen Keys sind serverseitig und bleiben zunächst abwesend:

| Key | Wirkung bei später gesondert geprüfter Konfiguration |
| --- | --- |
| NOVALURE_SHARED_NATIVE_METHODS_ENABLED | Nur exaktes1 unter VERCEL_ENV=production lädt veröffentlichte Methoden. |
| NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED | Nur exaktes1 unter Production erlaubt den privaten kategorialen Hook. |
| NOVALURE_SHARED_NATIVE_SIGNAL_BINDINGS | Sensitiver serverseitiger JSONmap, keine NEXT_PUBLIC-Variable, nie Prompt/Browser/Log. |

Der Map ist ein geschlossenes Objekt mit version1 und1–16 bindings. Jeder Eintrag
enthält exakt workspaceId, projectId (UUID oder NULL), botId, integrationId (UUID
oder für ausschließlich internen Scope NULL),
brokerActorId, actorId und capability. Alle IDs werden validiert; Bot-, Actor-
und Capabilitywiederverwendung im Map wird abgelehnt. Der Lookup benötigt den
vollständigen serververifizierten Integration-/Workspace-/Projekt-/Bot-/Broker-
Tuple. Ein erwarteter privater Actor wird zusätzlich mit dem tatsächlichen
gesperrten Runtimebinding verglichen. Keine beliebigen Dienste, Routen oder
Dispatcheraktionen. Der optionale nativeBehaviorEnv-Parameter ist ein reiner
Hosttestport wie pool/model; HTTPrequestfelder werden ihm nicht zugeführt.

Auch der konkrete `runBotChat`-Antwortpfad zeichnet dieselbe feste Formatmetrik
auf, nachdem seine bestehenden Geschäfts-/Archivoperationen abgeschlossen sind.
Der authentifizierte Caller kann vom privaten festen Broker abweichen. Er wird
als er selbst über `resolveBotConversationContext`, frische Mitgliedschaft,
Sessionsperre falls vorhanden, Bot-/Projekt-/Conversation-/Channelbezug und
vorhandene Projektberechtigung geprüft. Alle dem Modell gezeigten Source-/Version-
Referenzen, Channelgrants, Entitlement/Modulstatus und Methodenversion werden ohne
zweite Quotaabfrage revalidiert. Erst danach wird aus dem serververifizierten
Bot-/Workspace-/Projekttuple der feste private Broker/Actor gewählt. Es gibt keine
Umsetzung einer Benutzer-/Modellrolle auf die Knowledge- oder Toolsession.

`withRuntime` sperrt weiterhin Broker, Actor, Binding und den exakten Bot. Der
private Actor muss den eigenen Botprojekt-Metadatensatz sehen; er erhält keine
Knowledgegrants oder Toolausführung. Eine fehlende Sichtbarkeit ergibt unconfirmed.
Öffentliche Requests verlangen zusätzlich den passenden nicht-NULL-Integration-
Tuple und die vorhandene Gatewayautorisierung; sie können keinen internen Eintrag
auswählen. Die bestehende eindeutige perBot-Bindung kann dieselben privaten
kategorialen Signale aus den zwei autorisierten Pfaden desselben Assistenten halten.

Widerrufene Quellen oder Methoden ersetzen den Modelltext durch die bestehende
sichere Antwort; auch CompatibilitytoolResults und Quellenangaben enthalten dann
keine widerrufenen Auszüge. Bereits bestätigte Buchungs-/Geschäftsergebnisse werden
dadurch nicht als fehlgeschlagen umetikettiert. Telemetriefehler lassen eine gültige
Geschäftsantwort erhalten. Verschachtelte fremde Tenanttransaktionen werden durch
die vorhandene Grenze abgewiesen und ergeben unconfirmed; es gibt keinen neuen
Contextwechsel-/Dispatcherbypass.

`/api/bots/agent` ist nach Prüfung seiner tatsächlichen Returns ein Toolaufruf
mit Status, Entscheidung und strukturierten Toolresultaten beziehungsweise
Source-Referenzen. Er erzeugt keinen eigenen menschlichen Modellantworttext.
Eine Gesprächsinstruction oder Next-step-Labelwertung wäre dort fingiert und
wird deshalb nicht eingebaut. Der tatsächliche Gesprächspfad ist `runBotChat`.

## Lokale Nachweise

- Bestehende Websiteantworttests und die neuen tatsächlichen Hooks:12/12 PASS
  auf ausschließlich lokalem eingebettetem PostgreSQL, mit AI-SDK-Mockmodell.
  Kein externer Modellaufruf, kein Neon-/Providerwrite.
- Neue Fälle: defaultOFF-Prompt unverändert; CEO-only-v1 liefert keine sechs
  Webchatregeln; synthetischer Head für neue Ziele wird tatsächlich konsumiert;
  kein Tool; keine Telefonieinstruction; falscher Tenant/Projekt abgelehnt.
- Grounded Antworten erzeugen ausschließlich labelbasiertes pass/fail. Eine
  Methodenänderung während der synthetischen Generierung verwirft die Antwort
  und erzeugt kein Signal. Keine zusätzliche Modellanfrage.
- Zwei Assistenten hinter demselben Ownerbroker schreiben auf zwei private
  Actors. Owner sieht keine Signale, Actor1 nur sein eigenes. Generischer
  Quellenread des privaten Actors liefert null. Bestehende private Archive/
  Leads bleiben durch den Signalhook unverändert.
- Falsche Actor-ID, fremde Capability, anderes Projekt, leere/duplizierte Map,
  disabled Runtimebinding, fehlender privater Projektread und widerrufene
  Integration erzeugen kein Signal; die gültige feste Ersatzantwort bleibt sicher.
- Ein tatsächlicher lokaler Signal-COMMIT mit anschließend künstlich verlorener
  Commitantwort bleibt als eine Row bestehen, wird intern unconfirmed gemeldet
  und nicht erneut ausgeführt; die grounded Antwort bleibt erhalten.
- Der tatsächliche `runBotChat` mit anderem angemeldeten Caller als dem festen
  Broker schreibt ausschließlich auf den eigenen privaten Assistantactor. Der
  Caller hat null private Signale. Ein Quellenwiderruf während der Generierung
  verwirft Modelltext und Compatibilityauszüge. Fehlendes Caller-Projektrecht
  verhindert den Aufruf; keine privaten Rechte werden geliehen.
- TypeScript und gezielter ESLint-/Whitespacecheck sind Teil der lokalen Prüfung.
  Kein unabhängiger Review-, CI-, Merge-, Release- oder Liveabnahme-PASS wird aus
  diesen lokalen Tests abgeleitet.
