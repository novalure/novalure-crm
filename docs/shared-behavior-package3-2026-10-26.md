# Paket 3 – CRM-Anschluss für CEO und Abteilungen

Franz autorisierte am26.10.2026 Paket3 mit allen erforderlichen Freigaben.
Basis ist PR114/59b39ec56b60029f8500380ec360d73e6b5e2704. Bestehende
Paket1-/Paket2-Branches und die getrennte CEO-/EV2-Arbeit werden nicht geändert.

## Konkreter Entwicklungsumfang

Neue serverseitige Kontext- und Signaladapter verbinden die gemeinsame
Verhaltensebene mit dem vorhandenen Knowledge Center. Der Server bestimmt
Workspace, Runtime-Actor, Bot, Zielklasse und Wissenskanal aus gespeicherten
Bindings. Modellargumente dürfen nur die Suchfrage beziehungsweise feste
Lernsignale enthalten; keine Department-, Tenant-, Actor-, Bot- oder Bereichsauswahl.

Der vorhandene Vertrag kennt13 Rollen-IDs: executive (CEO), sales, marketing,
buyer, support, finance, engineering, security, legal, qc, procurement, hr und
personal. Die Rollen sind keine Behauptung13 bereits aktiver Abteilungen.
Executive nutzt gemeinsame CEO-Methoden; die anderen Rollen nutzen
Department-Methoden. Wissensauszüge bleiben getrennte Daten mit Quellen-/Versions-ID
und erhalten keine System- oder Toolautorität.

Auch bei einer gemeinsamen nativen Workloadidentität benötigt jeder Runtime-
Zugang eine eigene zufällige Capability (mindestens32 Zufallsbytes, Base64url).
Die Datenbank speichert nur deren SHA256-Hash. Das Binding weist einen eigenen
Actor und Bot zu; Unique- und zusammengesetzte Fremdschlüssel verhindern
Wiederverwendung desselben Actors/Bots und tenantfremde Beziehungen. Besitz der
Workloadidentität allein berechtigt nicht zur Auswahl einer beliebigen Abteilung.
Capabilities gehören ausschließlich in den jeweiligen vertrauenswürdigen
Runtime-/Transportkontext, niemals in Modellprompts, Wissensquellen oder Browser.
Ein gemeinsamer Broker, der Zugriff auf sämtliche Capabilities besitzt, ist eine
vertrauenswürdige Kontrollinstanz und keine gegen sich selbst isolierte Partei.

FORCE RLS schützt die Bindingtabelle; Tenant-Runtimes dürfen sie weder lesen noch
ändern. Ein eigener NOLOGIN-Resolver ohne Superuser-/BYPASSRLS-/Tenant-Mitgliedschaft
liefert über enge Funktionen nur das zum jeweiligen Zugang gehörende Binding.
Bindung, Broker-/Actor-Mitgliedschaft, Bot und native Service-Principals werden
bei Kontext-/Signalaufrufen gesperrt und überprüft. Ablauf und Widerruf werden
nicht durch einen Cache übergangen. Eine widerrufene Bindung muss bestehen
bleiben: Löschen hebt die Actor-Spezialklassifikation auf und gehört nicht zum
normalen Widerrufsweg.

Zusätzliche restriktive Knowledge-RLS prüft Runtime-Actors gegen die ausdrücklich
am eigenen Bot gespeicherten internal-Bereichsgrants. Das gilt auch für generische
Abfragen ohne Bot oder mit einem fremden Bot. Bestehende Projekt-, Versions-,
Veröffentlichungs-, Mandanten- und Vertragsprüfungen bleiben zusätzlich wirksam.
Der CEO erhält keinen pauschalen Zugriff auf andere Abteilungen oder Mandanten.
Gemeinsames Firmenwissen muss ausdrücklich für den jeweiligen Bot freigegeben sein.
Lernsignale werden unter den getrennten Runtime-Actors gespeichert.

Die neuen HTTP-POST-Ports unter /api/integrations/evelyn/runtime/context und
/signal sind standardmäßig aus. Bei späterer Aktivierung verlangen sie zusätzlich
zur Capability die bestehende verifizierte CRM-Workloadidentität mit unveränderten
OIDC-, Principal-, Kill-Switch- und Environmentgrenzen. Es gibt keinen Cookie-,
Origin-, Header-Identitäts- oder statischen Testtoken-Fallback. Es wird kein neuer
Principal, kein produktives Credential, kein Binding und kein Vertrag erzeugt.
Die bestehenden CRM-Machine-Beschränkungen werden nicht zu einem allgemeinen
Produktivzugang erweitert. Tools werden durch den Kontextvertrag nicht gewährt.

## Nachweis und noch fehlender Anschluss

Ausführbare synthetische PostgreSQL-Prüfung:
scripts/shared-behavior-runtime-tests.ts. Geprüft werden alle bekannten Rollen,
getrennte Sentinel-Wissenstexte bei gleicher Workloadidentität, identische Methoden,
selektives gemeinsames Wissen, Draft-/Fremdmandantenschutz, Abwehr von Modell-
Scopewechseln, generische SQL/RLS-Lesepfade, private Lernsignale, native HTTP-
Authentifizierungsgrenzen sowie Widerruf/Ablauf/Grantentzug. Der HTTP-Test injiziert
wie die bestehenden CRM-Tests einen synthetischen OIDC-Verifier; dies ist kein
realer Provider-/Teams- oder kryptografischer End-to-End-Nachweis.

Alle Migrationen bleiben unter migrations/staged. Vor Rollout sind die echten
aktuellen Vorgänger und Rollen-/Scopeverhältnisse zu prüfen. Der vorhandene
historische <=090-Testbootstrap samt unveränderter92/93-Machine-Vorgänger und
additivem Knowledge-Schema ersetzt keinen Produktionsupgradebeleg. Aktuelle
CI-Ergebnisse stehen im Draft-PR. Automatische Vercel-Deployments dieses Branches
sind explizit ausgeschaltet; die Enable-Variable wird nicht gesetzt.

**Paket3 ist damit noch kein Live-Anschluss von Evelyn:** Evelyn PR259 ist
weiterhin Draft und nennt A1-Nachweis, Runtime-DB403 und sicheren separaten Releaseweg
als offene Grenzen. Der Versuch, das private Evelyn-Repository für diesen Auftrag
lesend zu klonen, scheiterte an fehlender Git-Authentifizierung. Dessen AGENTS.md
verlangt vor Implementierung den lokalen Cloud-Preflight und sagt ausdrücklich:
"Do not start implementation if it fails." Der Preflight ist ohne zugänglichen
Checkout und funktionierenden Git-Zugriff nicht ausführbar. Deshalb wurden dort
keine Quellen, Kontrollregeln oder Entwicklungsstände verändert.

Quelle der Repositoryvorgabe:
https://github.com/novalure/evelyn/blob/main/AGENTS.md
Statusquelle der getrennten CEO-Arbeit:
https://github.com/novalure/evelyn/pull/259

Für den tatsächlichen nächsten Anschluss: autorisierten Evelyn-Checkout mit
bestehendem Authweg bereitstellen, vorgeschriebenen Preflight und Kontrollplan
prüfen; den Consumer in einem eigenen Branch an die hier getesteten Ports binden;
exakte Provider-/Releasegrenzen erfüllen und die echte Teams-Folge nachweisen.
Keine Ersatzrechte, neue breitere Credentials oder Umgehung des403 sind umgesetzt.
