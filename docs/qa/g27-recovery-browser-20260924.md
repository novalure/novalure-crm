# G27 Restore- und Browser-Verifikation vom 24.09.2026

G27 bleibt OPEN, bis die erneute vollständige Regression und die echte Preview-Abnahme A–F abgeschlossen sind. Production Impact: NONE. PR #65 bleibt Draft; kein Merge und kein Production-Deploy.

## Nativer Restore: PASS

Der instrumentierte 180-Sekunden-Probelauf verarbeitete kontinuierlich Objekte (972 durch den Folgeschritt bestätigte Abschlüsse). Der letzte gestartete Schritt war der Trigger `crm_sales_classification_guard`. 17 Messpunkte zeigten keine blockierenden Sessions oder Lock-Waits; Deadlocks: 0. Die Client-CPU betrug im beobachteten Fenster 0,4375 Sekunden bei 159,2 Sekunden Laufzeit. Server-CPU ist über die verwendeten PostgreSQL-Kataloge nicht verfügbar. Der Prozess hing nicht; die serielle entfernte Wiederherstellung überschritt die alte Frist. Die einzelne Restore-Transaktion wurde beim Abbruch zurückgerollt, das Ziel blieb leer.

Der neue Grenzwert folgt dem gemessenen TOC-Durchsatz: 180,009 Sekunden / 972 abgeschlossene Objekte × 1.928 Archivobjekte × 1,25 Reserve, aufgerundet auf **447 Sekunden**. Single-Transaction und Exit-on-Error bleiben aktiv.

Der anschließende vollständige native Restore in eine neue leere QA-Datenbank bestand mit Exit-Code 0 nach **335,915 Sekunden**. Dump: 1.160.754 Bytes, SHA-256 `1a27f62302567b8eb9b77fc8446726054a182819bc338cbc6b6534f7e08cf723`.

| Gate | Ergebnis |
| --- | --- |
| Dump-Erstellung | PASS, 44,923 s |
| Leeres Ziel vorbereiten | PASS, 3,184 s |
| Native Wiederherstellung aller 1.928 TOC-Objekte | PASS |
| Migration-Ledger | identisch, 1,040 s |
| Vollständiger Katalog-/Datenvergleich | identisch, 25,347 s |
| RLS/Berechtigungen nach Restore | 64/64 PASS, 68,068 s |
| Quelle nach Restore unverändert | PASS, 25,842 s |

Vorher-/Nachher-Gesamthash: `83465b62f3b40c0f993c0bfa910bf9970cc6cd46654239374b3e0fe7fb04292b`.

Verglichen wurden 153 Relationen, 2.359 Spalten, 2.780 Constraints einschließlich 586 Foreign Keys, 527 Indizes, 114 Policies, 215 Funktionen, 102 Trigger, 44 Ledger-Einträge sowie sämtliche Zeilen aus 150 Datentabellen. Die 85 ausgeführten Migrationsdateien entsprechen nicht der Anzahl der historisch geführten Ledger-Einträge.

Der Dump enthält tatsächlich befüllte Finanzdaten: zwei immutable Snapshots (NEEDS_REVIEW und verifizierter Nachfolger), drei registrierte Currency-/Rounding-/Tax-Policy-Versionen, sieben Financial Events und sieben Audit-Zeilen. Die Fixture nutzt die echten Runtime-Repositories einschließlich Review-Transition und Source-Binding. Kein VERIFIED-Status wurde direkt gesetzt; ein zuvor abgewiesener Fixture-Versuch wurde vollständig zurückgerollt.

Ziel: ausschließlich Projekt `super-block-59791927`, Branch `br-summer-breeze-awuzinct`, Quelle `qa_g27_20260923`, Restore `qa_g27_recovery_20260924`. API-Metadaten und SQL-Fingerprint wurden vor Writes geprüft. Der Test stellt eine Datenbank innerhalb desselben isolierten QA-Clusters wieder her; er ist kein Nachweis eines clusterübergreifenden Disaster Recovery einschließlich separat wiederhergestellter globaler Rollen.

Private lokale Evidenz liegt unter `.npm-cache/g27/recovery-probe-20260924` und `.npm-cache/g27/recovery-verify-20260924-v2`. Dump, Zugangsdaten und vollständige private Artefakte gehören nicht ins Repository.

## Browser: fachlicher Blocker PASS

Der ursprüngliche Freigabefehler ließ sich in zwei instrumentierten Läufen mit unveränderten Assertions nicht reproduzieren (je 20/20 PASS, einer mit frischem Next-Cache). Der Approval-POST lieferte HTTP 200, `persisted: true` und APPROVED; ein separater GET bestätigte den gespeicherten Zustand. Eine eindeutige Ursache des ursprünglichen fünfsekündigen Fehlers ist deshalb nicht bewiesen.

Die Angebotsfreigabe ist eine andere Transition als die Finanzprüfung für Approval V2. Vor Annahme war kein verifizierter Snapshot vorhanden. Die tatsächliche Kundenannahme erzeugt immutable NEEDS_REVIEW-Evidenz. „Finanzprüfung offen“ ist dafür fachlich richtig; die alte Fixture enthielt noch keine vollständige V2-Finanzsemantik. Die neue Fixture registriert synthetische, versionierte Policies und verwendet den echten V2-Vorbereitungspfad für den akzeptierten Vorgang.

Die UI lädt nach einem erfolgreichen Command den persistierten Angebotszustand erneut. Die Angebotsversion ist Teil des Finanzsnapshot-Ladeschlüssels. Während des Ladens zeigt sie „Finanzstatus wird geladen“; eine offene oder fehlende Prüfung bleibt gesperrt. Fehlgeschlagenes Nachladen behält den Idempotenzschlüssel für eine sichere Wiederholung.

Der erweiterte Browserlauf bestand **26/26** Prüfungen:

| Fall | Nachweis |
| --- | --- |
| A: vollständiger Snapshot | UI und GET zeigen VERIFIED/COMPLETE, gespeicherten Hash und EUR 9.900 netto + 1.980 Steuer = 11.880 brutto; Druck freigegeben |
| B: NEEDS_REVIEW | echte Annahme erzeugt Pending-Evidenz; autoritativer Druck bleibt gesperrt |
| C: fehlende Tax Policy | echtes V2-Repository verweigert unbekannte Policy mit UNKNOWN_FINANCIAL_POLICY |
| D: falscher Hash | authentifizierter HTTP-POST verweigert mit 409 FINANCIAL_SNAPSHOT_HASH_MISMATCH |
| E: veraltete Angebotsversion | echtes V2-Repository verweigert mit VERSION_MISMATCH |
| F: fremder Mandant | authentifizierter HTTP-GET wird verweigert |
| G: historische Stabilität | aktueller Dealwert und neue Steuer-Policy-Version ändern gespeicherten Snapshot, Hash und UI-Werte nicht |

C/E laufen über die vorhandene, ausschließlich für die lokale Loopback-Testdatenbank erlaubte Repository-Schnittstelle. Der Preview-only HTTP-Gate wird nicht umgangen. Der lokale Lauf fordert keine entfernte Evelyn-Freigabe an und ist kein Ersatz für Preview A–F oder Two-Step VALID.

Der erste erneute Browserlauf während der parallelen Gesamtregression erreichte nach erfolgreicher MFA das fünfsekündige Navigationslimit. Diese Fehlerevidenz bleibt erhalten. Der anschließende serielle Gesamtlauf bestand 26/26, ohne Änderung der Navigationsassertion oder ihres Timeouts.

## Erneute Gesamtregression

Frisch ausgeführt nach den beiden erfolgreichen Blocker-Gates: G27 **114/114**, Baseline ohne Browser **481/481**, Typecheck, Lint, Production Dependency Audit (0 Schwachstellen) und Secret Scan der sechs geänderten/neuen Codedateien: PASS. Das zusätzliche G27-Neon-Profil bestand separat **11/11**; einschließlich Browser beträgt der frische lokale Gesamtstand **632/632**.

Standardbuild mit Turbopack: PASS, TypeScript und 85/85 statische Seiten. Serieller Browser-Gesamtlauf: 26/26 PASS. Damit beträgt die frische Baseline 507/507 und der Gesamtstand 621/621 (114 G27 + 507 Baseline). Der erste isolierte Build scheiterte an einer außerhalb des Turbopack-Projektroots liegenden node_modules-Junction. Für den erfolgreichen erneuten Standardbuild wurden die lockfilegebundenen Dependencies direkt im isolierten Checkout installiert. Keine Änderung der produktiven Build-Konfiguration.

Preview A–F, Race/Idempotency, Cleanup und finaler Security-Review: noch nicht als abgeschlossen gewertet. Evelyn-Pin unverändert: `1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc`.

## Noch offene Preview-Infrastruktur

Die Vercel-API bestätigte den Evelyn-Pin frisch: Deployment `dpl_Adbe72F6BsmuCYpiHf322GZ1zAn3`, READY, Preview, exakt `1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc`. Für `codex/crm-production-readiness-g27` existieren noch keine branchspezifischen Runtime-Variablen. Die vorhandenen 16 `G27_QA_*`-Variablen ersetzen keine `DATABASE_URL`-Runtime-Bindung.

Ein ausschließlich auf Novalure beschränkter Ein-Stunden-Vercel-Token wurde für diese GET-Metadatenprüfung erstellt, nur im Prozess gehalten und nach Ablauf verworfen. Kein Einsatz für Writes oder Deploys.

Anschließend meldeten wiederholte Browser-Seitenzugriffe Timeouts; die Tab-Liste war weiterhin erreichbar. Dadurch ging der ausschließlich im Prozess gehaltene Neon-Zugang verloren. Nach Wiederverbindung in einem frischen Tab wurde der projektbeschränkte Schlüssel `G27 recovery temporary 20260924` erfolgreich widerrufen; Neon bestätigte seine Löschung. Diese Zugangsstörung ist kein fehlgeschlagener G27-Test und keine gemeldete Sicherheitsrichtlinien-Ablehnung.

Nach Wiederverbindung wurden QA-Projekt/Branch und der vollständige Quell-Hash erneut geprüft. Die synthetische Preview-Fixture wurde atomar in qa_g27_20260923 angelegt, ohne Sessions oder MFA-Vorgaben. Neun private Variablen wurden ausschließlich für den G27-Preview-Branch gespeichert; der öffentliche URL-Eintrag und die abschließende Metadatenprüfung sind noch offen. Erst danach die echte CRM↔Evelyn-Abnahme A–F einschließlich Race/Idempotency und Cleanup ausführen. Keine bestehenden G08-Daten oder Passwörter als G27-Nachweis übernehmen.
