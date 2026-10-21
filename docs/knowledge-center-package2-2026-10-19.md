# Evelyn Knowledge Center — Paket 2/4

## Auftrag und verifizierte Grundlage

Franz hat am 19.10.2026 die Entwicklung dieses universellen CRM-Moduls freigegeben: eigener Branch, vorhandene Identitäten/Mandanten/Projekte, sichere Wissensverwaltung und Vorbereitung von Paket 3. Produktive Migrationen, Kundendatenänderungen, echte Zahlungen, bezahlte Dienste und produktive Telefonie sind ausdrücklich ausgeschlossen.

Die tatsächliche CRM-Produktionsrevision `b0e99c4cedc23a24ba3b9d4e67a59423f7b54f92` wurde über Vercel als `READY` bestätigt (`dpl_5DFrPtNs1pLmux8j8DM2WZDWtArk`). Der Produktionsalias verweist inzwischen auf Paket 1: `ea668e625b8c778c2f79dd6a33210e731bb8a662`, Deployment `dpl_GmsvmFHvXR3u3sNhiujptB5KSjkk`. Aliasstand: 19.10.2026 19:14:16 Europe/Vienna. Paket 2 baut auf genau dieser neueren Revision auf. Es ändert keinen fremden Branch und übernimmt keine ungeprüfte `main`-Revision.

Gelesene Steuerungsquellen im separaten Repository `novalure/evelyn`: kanonischer Masterplan vom 07.10., A0-Verfassung, Produktmasterplan/Masterprompt und technischer Entwicklungsstand vom 17.10. sowie Entwicklungs-/Budget-/Freigaberegeln. Der lokale kanonische Masterplan-Digestcheck bestand. Das CRM bleibt operative Datenquelle; dieser Branch entwickelt keine zweite Unternehmens-, Projekt-, Immobilien- oder Benutzerverwaltung.

## Tatsächliche Datenbankstruktur

Die Neon-Metadaten wurden am 19.10.2026 um 21:24:28 Europe/Vienna ausschließlich lesend geprüft: Projekt `misty-cloud-70835427`, Produktionsbranch `br-snowy-fog-aldx77v8`, Datenbank `neondb`, PostgreSQL 17. Keine Kundeninhalte und keine Verbindungsgeheimnisse wurden ausgelesen. Die Katalogabfrage lief über den Connector als Datenbankeigentümer; sie ist kein Nachweis eines erfolgreichen Anwendungszugriffs.

- `knowledge_sources` und `knowledge_chunks` sind vorhanden, bislang ohne RLS/FORCE RLS und ohne Knowledge-Policies oder Trigger. Die bisherige Anwendungsrolle besitzt direkte Schreibrechte.
- `bots`, `projects` und `media_assets` besitzen bereits FORCE RLS. Beide Anwendungsrollen sind weder Superuser noch BYPASSRLS-Rollen.
- Quellen besitzen vorhandene Workspace-/Projekt-IDs; Chunks erben ihren Bereich bisher allein über `source_id`. Ein optionaler Projektfilter in der alten Suche ist kein Berechtigungsnachweis.
- `workspace_module_settings` ist vorhanden. Vertragsentitlements, Knowledge-Bereiche, Versionen und Assistentenzuordnungen waren nicht vorhanden; Stripe-/Billingtabellen wurden nicht gefunden.
- Der reale Migrationsledger beginnt mit Baseline 041; letzter Eintrag ist `100_studio_enquiry_production`. 097–099 sind nicht eingetragen. Ein nicht vorhandener Ledgerbeleg für 001/002 wird nicht erfunden.

Zwei unterschiedliche Migrationen 002 müssen getrennt bleiben: CRM `002_product_runtime.sql` ergänzt unter anderem Chunk-Metadaten; Evelyn `migrations/production/002_knowledge_storage.sql` gehört zur separaten internen Unternehmenswissensinfrastruktur. Ihr historischer Liveabschluss auf Evelyn-Revision `933197fbcbf5e1f0ba17b174348917293fefa460` belegt weder ein Kundenportal noch CRM-RLS in dieser Sitzung. Eine dritte Wissensplattform wird nicht erzeugt: Die CRM-Oberfläche erweitert ihre bestehenden Quellen/Chunks und stellt einen klaren Retrievalvertrag bereit.

## Integrationsvertrag

`workspace_id` bleibt die Tenant-ID. Unternehmen, Projekte, Bots, Mitgliedschaften und Medien verweisen auf bestehende CRM-Objekte. Firmen-/Geschäftsbereichs-/Projektwissen sind Konfigurationen derselben Engine. Quellen werden ausdrücklich pro gespeichertem Assistenten und Kanal zugeordnet. Der Workspace-Selektor verwendet die vorhandene serverseitige Mitgliedschaftsprüfung; eine URL, ein Header oder ein Formularfeld erteilt selbst keine Rechte.

RBAC, gebuchtes Modul und Mengenlimits sind getrennte Prüfungen. Rollen werden aus der aktuellen Datenbankmitgliedschaft neu bestimmt. Vertragsrechte können nicht über eine normale Kunden-API gesetzt werden. Die Migration aktiviert keine Verträge und erfindet keine Preise. Fehlende Freischaltung wird als gesperrter Modulzustand angezeigt.

Dokumente bleiben private Medien und erhalten einen eigenen Knowledge-Zugriff. Ein Dateiupload ist keine Veröffentlichung und kein automatisch erfolgreicher PDF-/Bildimport. Websiteinhalte sind untrusted Daten; ihr Abruf darf weder Berechtigungen noch Systemanweisungen verändern. Änderungen werden als prüfbare Entwürfe behandelt. Aktuelle Immobilienpreise und Verfügbarkeiten benötigen eine autorisierte frische CRM-Antwort; alte Dokumente ersetzen diesen Nachweis nicht.

## Migration und Betriebsgrenze

`101_knowledge_center.sql` ist eine vorbereitete additive Migration mit RLS-/Versionsgrundlage. Sie wird ausschließlich in einer lokalen, wegwerfbaren PostgreSQL-Testinstanz geprüft. Die Produktionsdatenbank wird in diesem Auftrag nicht migriert. Bestehende Quellen werden nicht stillschweigend neuen Assistenten zugeordnet oder als neu geprüft veröffentlicht.

Automatische Git-Deployments dieses Entwicklungsbranches sind deaktiviert, damit keine Preview mit geerbtem Produktionsdatenbankzugang entsteht. Eine nutzbare gehostete Preview benötigt eine nachgewiesen isolierte Datenbank, Anwendung von 101 dort, synthetische normale Loginidentitäten, geschützte Deploymentbindung und eine kostenlose/autorisiert bestehende Infrastruktur. Keine Authentifizierungsumgehung ist vorgesehen.

## Übergabe an Paket 3/4

Paket 3 verwendet die bestehenden unveränderlichen Versionsstände und konkrete Freigabereferenzen für Prüfung, Kommentare, Wiederherstellung als neuen Entwurf und Administratorveröffentlichung. Es soll keine zweite Versions-/Freigabetabelle einführen. Ein Mitarbeiterentwurf darf eine aktive Version nicht ersetzen. Websiteüberwachung benötigt anschließend eine konkret konfigurierte Frequenz, serverseitige Mengen-/Kostenkontrolle und einen autorisierten Scheduler-Aufruf; ein vorbereiteter Scanner ist kein laufender Überwachungsdienst.

Vor Kundenrelease fehlen weiterhin die gesonderten vollständigen MP1-Abnahmen aus dem Masterplan, insbesondere echte Zwei-Mandanten-Portalabläufe und die separat beauftragten Provider-/Kalender-/Billingintegrationen. Vapi-, Stripe- und Live-CRM-Ports sind keine aktivierten externen Verbindungen. Der Abschlussbericht dieses Branches nennt die tatsächlich ausgeführten Prüfungen und verbleibenden Grenzen separat.
