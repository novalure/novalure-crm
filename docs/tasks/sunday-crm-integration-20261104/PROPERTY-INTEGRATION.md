# Property: koordinierter lokaler Backend-/Clientanschluss

Dieser Nachfolger erweitert den unveröffentlichten CRM-Sammelstand `0abea1facc4ff3e6a948f39935a52027340d37ba`. Er ist keine zweite Releasefassung und kein Produktivnachweis.

**Neuer offener Funktionsbefund SRC05:** Der Pending-Ref der Direkterfassung geht derzeit beim Verlassen des Immobilienbereichs und Unmount der Komponente verloren. Ein späterer Remount kann deshalb den ursprünglichen Body und die UUIDs eines unklaren Ergebnisses nicht wiederverwenden. Die QA erstellt einen eigenen Nachfolger über den bestehenden RAM-Draftstore auf CRM-Sitzungsebene; dieser ist hier noch nicht enthalten. Kein Browserstorage und kein automatisches Wiederholen sind autorisiert oder hinzugefügt. Dieser neue Fehler ist unabhängig vom alten8/9-Stringtest und verhindert eine vollständige SRC05-Abnahme.

## Herkunft und Reihenfolge

1. Backendserie auf Assistant `11c4384c`: `e6fe1e76f44bea5da7a359362570fa455314c317` → `0a63bb46afe84619464077f7e97a543df4958e71` → `4c0d45f7385c61159789849424b4f309fd3fc7c8` → `8d94b6b21d07b74ef8e3960f66824c73f6a447f5`. Regulärer lokaler Merge: `e7cf5713f6205ad5eba8b269dd2d08ded73638ee`.
2. Danach Client `6b9b38c5f54279b757f057c4b2f31393b5d243d1`. Regulärer lokaler Merge und erster geprüfter Quellenstand: `b26da35368c7225c4c84b4fca2aba56878722d14`.
3. Root beobachtete danach die neue öffentliche Assistantrevision `bb8bbaa916e5194ae7bdd7e6535f93283906a75c` mit Deployment `dpl_FWru64SJYvcZJU5otFsmTEJEuWu6`. Sie erweitert `11c4384c` tatsächlich um serverseitige lokale Zeitzonen im Assistantprompt und einen Regressionstest. Regulärer lokaler Merge: `44b504c1ed03a2f994103be54d09ec7e686cd3c2`. Die veröffentlichte Quelle ist enthalten; dieser Sammelkandidat selbst ist unveröffentlicht.
4. Enger UI-Nachfolger `2a7ac7f2943fad98b8de510cb33914fcb0edf682` wurde mit Herkunft einzeln als `5416515a38cb30bc5f8e3389de5cb124fe0e470e` übernommen. Die doppelte UI-Helferkopie `3a28f87997e16a02561c992d18b9f0a00c353684` wurde nicht übernommen; das ursprüngliche `4c0d45f7` ist bereits Vorfahr. Aktueller Sourceabschluss: `5416515a38cb30bc5f8e3389de5cb124fe0e470e`.

Beide Zusammenführungen waren konfliktfrei. Die geänderten Backend- und Clientquellen sind unveränderte Donorbytes. Der Client wurde erst nach dem Backend-Receipt integriert. Alle Hashes wurden aus dem vorhandenen lokalen Gitinventar bestätigt; kein Fetch war nötig.

## Ergebnis

Die Direkterfassung verwendet den ausgewählten Workspace und bestätigt Workspace sowie Projekt des gespeicherten Objekts. Flächen, Zimmer und Geldbeträge behalten ihre zulässige Dezimalpräzision. Vor der Normalisierung lehnt das Backend ungültige Werte ab.

Die bestehende CRM-Befehlsinfrastruktur speichert `property.create` mit stabilen Idempotenz- und Korrelationskennungen. Wiederholungen prüfen aktuelle Rollen- und Projektrechte und erzeugen kein zweites Objekt. Der Client hält bei unklarem Ergebnis Body, Ziel und Kennungen fest, sperrt Änderungen und bietet eine ausdrückliche Wiederholung desselben Vorgangs. Ein bestätigter Speichervorgang wird auch bei anschließendem Refreshfehler nicht erneut erstellt.

Neue Backend-Schreibvorgänge unterscheiden unbekannte Zahlen von ausdrücklich eingegebener Null über `canonicalPayload.coreNumericState` Version1. Der vollständige Editor kann optionale Zahlen bewusst auf unbekannt setzen. Alte partielle Updates und historische unversionierte Nullwerte behalten ihre dokumentierte Semantik.

Die nachfolgende Übersicht zeigt ausdrücklich bekannte Fläche0 als0m². Historische oder als unbekannt gespeicherte Null bleibt unbekannt. Daraus wird keine Kenntnis des aggregierten Einheitenpreises abgeleitet.

## Lokale Prüfung dieses Sammelstands

- 32/32 gezielte Backendfälle, keine Fehler/Skips. Echte neue Loopback-PostgreSQL-Datenbanken mit synthetischen Mandanten, Cookie/CSRF, konkurrierendem Replay, aktuellen Rechten, Null/0 und Auditrollback.
- 8/8 Browserfälle mit realer zusammengeführter Komponente und synthetischem HTTP, keine Browserfehler. Kein Live-Backend- oder Produktions-Browsernachweis.
- Typecheck und betroffener Lint: Exit0.
- Neuer vollständiger lokaler Nextbuild: Exit0, einschließlich TypeScript und aller188 statischen Seiten.

Nach dem Assistantnachfolger bestanden auf `44b504c1` weitere25/25 Assistant-/Guard-/191-Fälle mit lokalem Fakeprovider und realen synthetischen SQL-Belegen, engerLint und ein neuer vollständiger Nextbuild einschließlich TypeScript/188Seiten. Die Property-Backendquellen und deren Fixture sind seit dem32erLauf unverändert.

Der anschließende `5416515`-Diff ändert nur die eine Property-Übersichtskomponente, ihr Browserprüfskript und zwei QA-Belege. Dafür bestanden gezielt9/9 Browserfälle, Typecheck und engerLint. Diese neun Fälle enthalten keinen Unmount-/Remount-/Late-Response-Nachweis und schließen den neuen SRC05-Befund nicht. Der vollständige Nextbuild bleibt dem vorherigen `44b504c1` zugeordnet; für den finalen kleinen UI-Nachfolger wird kein neuer vollständiger Build behauptet.

Die Backendfälle wurden im Sammelstand erneut ausgeführt, weil dessen lokale Sales-Fixture die öffentlichen Chatvorgänger bewusst auslässt. Donorprüfungen wurden daher nicht pauschal auf diese Fixture übertragen. Die Browserfälle wurden ebenfalls erneut ausgeführt, weil der vereinte Editor nun die Backend-Ergänzungen verwendet. Die unveränderten Originalausgaben und der neue Browserbericht liegen unter `artifacts/sunday-crm-integration-20261104/property-*`.

Vier Konsolenausgaben enthalten originale Leerzeichen/Leerzeilen am Zeilenende. Ihre vollständigen Bytes liegen unverändert im Belegcommit `18f563c` und verlustfrei als `*.raw.json` vor; Dekodierung und SHA256 wurden abgeglichen. Die Testausgaben wurden weder bereinigt noch erneut erzeugt. Die frühere b26-Receiptdatei bleibt unverändert und verweist auf diese ursprünglichen Bytes.

## Erhalt und offene Anschlüsse

- Assistant-Schema188, aktuelle kommerzielle Guthaben-/Billingregeln, atomare Workspace-Einstellung/Audit, autorisierter Workspace nach Reload und eigene Kompatibilitätsmigration191 bleiben gegenüber `0abea1fa` unverändert. Die Assistant-Servicequelle wird ausdrücklich durch den aktuellen veröffentlichten `bb8bbaa9`-Nachfolger ergänzt. Keine Migration wird durch diesen Nachfolger ergänzt.
- Die versionierte Backend-Knownness-Helferlogik ist enthalten. **Migration189 für Medienzugriff und Migration190 für öffentliche Unknown-Ausgabe sind nicht enthalten**; ihre separaten laufenden QA-Abschlüsse müssen später mit finalen Quellen- und Schemaübergaben integriert werden. Öffentliche Ausgabe-/Matchingverbraucher erhalten durch diesen Nachfolger keinen pauschalen Knownness-PASS.
- Der frühere 8/9-Scope mit breitem Stringtest bleibt als tatsächlicher historischer Fehler dokumentiert. Es wurde keine neue Gesamtkampagne ausgeführt und kein vollständiger Gate-PASS abgeleitet.
- Aktuelle Produktionsrevision und Schema müssen vor einem späteren Release erneut mit dem führenden Stand abgeglichen werden. Unabhängige exakte Kandidatenprüfung, anwendbare native CI/genuine App, reales Zielverhalten und finanzielle Freigaben bleiben offen.
- Keine Provider-, Modell-, Reviewer- oder Produktionsaufrufe, kein Push/Online-PR/Deployment, kein Produktionsschemaeingriff, keine Zahlung, kein Mailing und keine Kundendatenänderung. Andere Arbeitskopien bleiben unverändert.

Maschinenlesbare Herkunft, tatsächliche Belege und Grenzen: `property-integration.json`.
