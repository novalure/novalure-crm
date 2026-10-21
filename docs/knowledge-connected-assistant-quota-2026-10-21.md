# Kontingent für mit Wissen verbundene Assistenten

`knowledge_center_entitlements.limits.maxAssistants` begrenzt die Zahl verschiedener Assistenten, die im jeweiligen Mandanten mindestens eine gespeicherte Wissenszuweisung haben. Dies ist kein allgemeines Limit für CRM-Botentwürfe.

Ein Assistent zählt einmal über alle Bereiche und Kanäle hinweg. Auch Zuweisungen zu archivierten Bereichen zählen weiter. Pausieren eines Bots, Deaktivieren eines Kanals oder Moduls und fehlende veröffentlichte Quellen geben keinen Platz frei. Erst das ausdrückliche Entfernen der letzten Wissenszuweisung gibt den Platz frei. Weitere Domains desselben verbundenen Assistenten verbrauchen keinen zusätzlichen Platz.

## Durchsetzung

Die normale Zuweisungsfunktion prüft neue Verbindungen in derselben Mandantentransaktion wie das Schreiben der Grants. Alle Zuweisungen und Entzüge benutzen den vorhandenen Advisory-Lock `knowledge-center:<workspaceId>`. Ein neuer Assistent darf nur verbunden werden, wenn der vollständige Mandantenzähler unter dem vertrauenswürdigen Vertragslimit liegt. Ein bereits verbundener Assistent kann weitere Bereiche oder Kanäle erhalten, sofern Vertrag und Kanal das erlauben.

Migration 107 ergänzt `knowledge_connected_assistant_count(workspaceId, optionalBotId)`. Die Funktion prüft den aktuellen Mandanten und eine aktive Mitgliedschaft. Das Gesamt-Aggregat liefert ausschließlich eine Anzahl und zählt auch Zuweisungen aus Projekten, deren Datensätze der aufrufende Benutzer nicht lesen darf. Eine gezielte Abfrage für einen einzelnen Bot setzt dagegen dessen aktuelle Projekt- und Datensichtbarkeit voraus; sie kann keine Existenzprüfung verborgener Bots ausführen. Die Laufzeitrolle erhält keine zusätzlichen Tabellenrechte und keinen RLS-Bypass.

Ein Vertragsdowngrade löscht keine bestehenden Assistenten oder Zuweisungen. Er blockiert neue Verbindungen, solange kein Platz frei ist. Reiner Entzug bleibt auch bei deaktiviertem Vertrag, deaktivierten Modulen oder abgesenktem Kontingent zulässig; Rollen- und Projektrechte bleiben erforderlich. Eine spätere erneute Verbindung wird wie jede neue Verbindung geprüft.

## Rollout und Nachweis

Migration `107_knowledge_connected_assistant_quota.sql` muss vor dem zugehörigen Anwendungscode auf dem freigegebenen Ziel installiert werden. Bestehende Migrationen werden nicht verändert. Diese Änderung führt keine Live-Migration aus und ändert keine Verträge, Preise oder Bestandszuweisungen.

`scripts/knowledge-connected-assistant-quota-tests.ts` prüft auf einer isolierten PostgreSQL-Instanz unter einer normalen Laufzeitrolle: letzten freien Platz bei parallelen Anfragen, vollständige Zählung verborgener Projekte, unveränderte fremde Mandanten, mehrere Kanäle pro Assistent, archivierte Bereiche, Entzug des letzten Grants sowie Entzug nach Vertrags- und Modulabschaltung. Der Funktionsbesitzer besitzt im Test weder Superuser- noch BYPASSRLS-Rechte.
