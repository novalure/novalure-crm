# Veröffentlichungsnachweis – Immobilienvollständigkeit

Veröffentlicht am 04.11.2026. Abschließende HTTP-Prüfung: 19:27 UTC / 20:27 Wien.

- Live: https://www.novalure-crm.app/
- Anwendungscode: `fa234f226c41def89f038ee7b1c52e838b90cb4f`
- Deployment: `dpl_8GGZ6dFQDg8vuR3YXnbhsKptSkzi`
- Branch: `codex/property-completeness-20261104`
- Produktionsmigrationen 185, 186 und 187 angewandt und mit identischen Quellprüfsummen im Schema-Ledger bestätigt. Keine weiteren automatischen Migrationen ausstehend. Die getrennten manuellen Studio-Cutover-Migrationen 097–099 wurden nicht verändert.
- Vorherige Live-Version: `8f4bfe0a775b8b0f8783b19b5cdc97dc2866defe`. Die Änderung baut auf diesem Stand auf.
- Sicherung vor dem Update: `snap-silent-heart-ali8f368`, Quelle `br-spring-night-alyu48yp`, Ablauf 11.11.2026 23:59 UTC.

## Abnahme

- Gesamtbuild mit Webpack einschließlich TypeScript und 184 statischen Seiten erfolgreich. ESLint für sämtliche geänderten/neuen JS-/TS-Dateien ohne Warnungen; Diffprüfung sauber.
- Vollständige Erfassung und Länder-Datenregression: 13 Fälle; zusätzliche gezielte Datumsprüfung erfolgreich. Länder-/UI-Prüfung: 3 Fälle einschließlich aller vier Länder mit bereits gespeicherten, aber unsichtbaren Fremdlandwerten.
- Einheiten: 15 Fälle; Kosten-/Textfragmente: 5; Kostenentwürfe: 5; Matching: 8.
- Öffentliche Fakten, echte Datenprojektionen, beide PDF-Wege, Portalexport und Vorlagen: 39 unterschiedliche Fälle. CHANGE/DELETE-XML gegen das tatsächliche OpenImmo-1.2.7d-XSD geprüft.
- Bestehende Immobilienanlage/-abteilung: 25 Fälle; bestehendes Zuordnungs-/KPI-Verhalten: 6 Fälle. Diese Suitezahlen werden wegen Überschneidungen nicht zu einer Gesamtzahl addiert.
- Browser mit ausschließlich fiktiven lokalen Daten: vollständige Anmeldung einschließlich MFA, neue Objektfelder speichern und nach Neuladen wiederanzeigen, Kosten mit Centbeträgen und Exposé-Auswahl speichern, geprüften Exposétext speichern, Einheitenflächen und Stellplätze speichern. Schmale und Desktopdarstellung geprüft.
- Länderwechsel im Browser: DE → ES → IE → DE → AT. Nur passende Länderfelder sichtbar; deutscher Grundbuch-Testwert nach Rückkehr erhalten. Der reine Länderwechsel-Prüfentwurf wurde verworfen.
- Sechs PDF-Beispiele DE/EN/ES, jeweils zwei Seiten, gerendert und visuell geprüft. Keine abgeschnittenen Inhalte oder isolierte fast leere Abschlussseite.
- Probe-Update auf isolierter Neon-Kopie erfolgreich. 16 tatsächliche Funktionsprüfungen mit `novalure_app` und aktivem RLS erfolgreich, sämtliche Produktänderungen anschließend zurückgerollt. Die Bereinigung der zwei synthetischen Seed-Workspaces wurde durch einen bestehenden unveränderlichen Ledger-Schutz mit SQLSTATE 55000 gestoppt; keine Schutzmechanismen wurden deaktiviert. Die isolierte Kopie `br-lingering-breeze-al22wgcp` läuft automatisch am 05.11.2026 um 19:04 UTC ab. Produktionsgeschäftsdaten wurden durch diese Prüfung nicht verändert.
- Live nach Umschaltung: `/api/version` HTTP 200 mit exakt dem obigen Commit und Deployment; `/login` HTTP 200; private Immobilien- und Einheiten-APIs ohne Anmeldung jeweils HTTP 401. Alle vier zugehörigen Produktionsdomains wurden erfolgreich zugeordnet.

## Nutzung

Im CRM neu laden, ein Objekt wählen und **Objekt vollständig bearbeiten** öffnen. Das **Objektland** steuert die zusätzlichen Eingabefelder. **Dokumente / Exposé** enthält Kosten und Texte; **Einheiten / Bestand → Details bearbeiten** enthält getrennte Einheitenflächen und Stellplätze.

Neue öffentliche Angaben erscheinen nach Erstellung und Freigabe einer neuen Exposé-/Exportfassung. Bestehende veröffentlichte Fassungen werden kontrolliert versioniert. Der Anlegerpreis bleibt intern. Land, Inhaltssprache und Zahlenformat bleiben getrennt.

Der Nachweis betrifft die konkret beauftragten Lücken; er ist keine Bestätigung unbekannter Drittanbieterfunktionen oder rechtlicher Vollständigkeit jedes einzelnen Immobilienangebots. Bedienprüfung und Schreibtests erfolgten in lokalen bzw. isolierten Testumgebungen; nach Veröffentlichung wurden Versionsstand, Erreichbarkeit und Anmeldeschutz live geprüft.
