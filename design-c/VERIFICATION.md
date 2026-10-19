# Verifikation — Design C

Stand: 19.10.2026. Lokale synthetische Designprüfung, kein produktiver CRM-Abnahmebeleg. Verifizierte Ausgangsbasis: `ea668e625b8c778c2f79dd6a33210e731bb8a662`. Der genaue geprüfte Quellinhalt ist in `verification/source-manifest.json` gehasht; die Browserzusammenfassung steht in `verification/summary.json`.

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| `npm run typecheck` | TypeScript für das gesamte CRM bestanden; Produktionsquelltexte unverändert. |
| `npm run design:c:typecheck` | Separate Design-App bestanden. |
| ESLint für alle Design-Quellen/Skripte und geänderte ESLint-Konfiguration | Bestanden, keine Warnungen. |
| `npm run design:c:build` | Next.js 16.4.0, optimierter statischer Export erfolgreich. |
| Bestehende Design-Foundations- und Admin-Navigationsprüfungen | 14 bestanden. |
| `studio-navigation-profile-tests.ts` | 6 bestanden; autorisierter Projektkontext, Ablehnung fremder Scopes, isolierte Präferenzen und echte/synthetische Anfragegrenzen. |
| `npm run design:c:browser` | **80 bestanden, 0 fehlgeschlagen**, Chromium mit Playwright. |
| Responsive Darstellung | 10 Ansichten bei 360, 390, 768, 1440 und 1920 px; 50 Kombinationen ohne horizontalen Dokumentüberlauf. Tabellen scrollen in ihrem eigenen Bereich. |
| Automatische Accessibility | 13 axe-core-4.11.4-Scans mit WCAG-2/2.1-A/AA- und WCAG-2.2-AA-Tags; 0 Verstöße. |
| Manuell ergänzte Browser-Assertions | Tastaturfokus, native Modaldialoge, Escape/Fokusrückkehr, mobile Navigation, sichtbare Fokusmarkierungen und deren Kontrast in Light/Dark bestanden. |
| Daten-/Aktionsgrenze im Browser | Keine externen, API- oder Schreibanfragen; keine ungefangenen Fehler, Konsolenfehler oder fehlgeschlagenen Ressourcen. |
| Statischer lokaler Server | GET 200; CSP `connect-src 'none'`; POST 405; API-Pfad 404; kodierter Verzeichnisausbruch 403. |
| Diff-Prüfung | `git diff --check` bestanden. |

Zusätzlich geprüft: Tabellen-Suche, Statusfilter, Zurücksetzen, Pagination und Sortierung mit rohen Zahlenwerten; insbesondere €490 vor €8.400 bei aufsteigender Geldsortierung. Studio-Angebotsfilter und sichtbare Status stimmen überein. Galerieformulare zeigen verständliche Validierungsfehler. Mandantenwechsel setzt Domänen- und Chatkontext zurück. Das Portal blendet interne Verwaltung, Wissensentwürfe und nicht zum Beispielpaket gehörende Immobiliennavigation aus. Dark Mode und reduzierte Bewegung wurden geprüft.

## Korrigierte Befunde

Der erste Browserdurchlauf fand schwache Textkontraste und einen mobilen Überlauf durch absolut positionierte Screenreader-Hilfstexte in Tabellen. Die unabhängige Codeprüfung fand zusätzlich formatierte Geldsortierung, abweichende Angebotsfilter, verschachtelte Beschreibungsabsätze, einen internen Portalhinweis und zu schwache Fokusmarkierungen auf dunklen Flächen. Diese Punkte wurden korrigiert und im abschließenden Browserdurchlauf gezielt geprüft. Der erste fehlgeschlagene Build während der parallelen Dateierstellung wurde durch die vervollständigten Styles aufgelöst; der abschließende Build ist bestanden.

## Aussagegrenzen und offene Integration

- Die automatischen Scans enthalten ausgewiesene `incomplete`-Kontrastfälle für eine ergänzende manuelle Prüfung; sie sind keine vollständige WCAG-Zertifizierung. Eine umfassende Screenreader- und Zoomabnahme wurde nicht durchgeführt.
- Kein produktiver Login, CRM-Datenabruf, echter Kundenablauf, KI-Modellaufruf, Zahlungsablauf oder Datenbankzugriff wurde ausgeführt. Sämtliche Ansichten sind Vorschauen mit synthetischen Daten.
- Die Produktionsanwendung wurde nicht vollständig neu gebaut oder vollständig regressionstestet. Ihr gesamter TypeScript-Stand und die konkret betroffenen gemeinsamen UI-/Navigationsgrenzen wurden gezielt geprüft.
- Es bestehen keine Änderungen an den funktionalen Dateien von Paket 1–4. Der konkrete Ergebnisstand von Paket 2–4 ist nicht verifiziert; endgültige DTOs, Controlleranschlüsse, Rechte-/Mandantenregression und Versions-/Freigabeintegration bleiben offen. Siehe [INTEGRATION.md](INTEGRATION.md).
- Beide Vercel-Demoprojekte melden `live: false`. Keine Online-Preview wurde bereitgestellt; es erfolgten keine Deployments, Domainänderungen oder Entpausierungen. Der lokale Export und das separat erzeugte ZIP sind nutzbar.
- Die unabhängige Prüfung ist eine lokale AI-Agent-Codeprüfung. Sie ersetzt keinen SHA-gebundenen Trusted-App-Check für einen späteren Merge. Es wurde nichts gemergt oder produktiv integriert.
