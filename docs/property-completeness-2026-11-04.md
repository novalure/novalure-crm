# Immobilienerfassung und Weiterverwendung – Umsetzung 04.11.2026

## Auftrag und Abdeckung

Diese Änderung schließt die sechs konkret benannten Lücken des Livelisted-Abgleichs. Sie behauptet keine vollständige Funktionsgleichheit mit allen unbekannten Funktionen eines anderen Produkts.

| Bereich | Umsetzung |
| --- | --- |
| Nachträgliche Bearbeitung | Vollständige, frisch geladene private Objektmaske; 125 bestehende Detaildefinitionen plus 26 Ergänzungen. Passende Zahlen-, Datum-, Auswahl- und Ja/Nein/Unbekannt-Felder, erhaltene ältere Freitexte, eindeutige Bindung doppelter Stammdaten. Konflikte werden vor dem Überschreiben erkannt. |
| Einheiten | Eigene Balkon-, Terrassen-, Garten-, Loggia- und Dachterrassenflächen; Tiefgarage, Carport und Freistellplätze; Schlafzimmer, Heizungsjahr und separater Anlegerpreis. Fehlender Wert bleibt unbekannt, eine Null ist ausdrücklich Null. |
| Weitere Objektdaten | Schlafzimmer, Heizungsjahr und Heizungsart, touristische Vermietung mit Genehmigungsstatus, strukturierte Lagearten. |
| Matching | Gemeinsame Auswertung gespeicherter Objektangaben und der konkret zugeordneten Einheit. Zwölf objektive Merkmale einschließlich touristischer Vermietung und Lage. Änderungen einer Einheit machen alte Treffer unbrauchbar, bis sie neu berechnet wurden. |
| Exposé/PDF/Export | Gemeinsame Auswahl öffentlicher Fakten für Web-Exposé, beide PDF-Wege und OpenImmo. Zusätzliche Flächen, Ausstattung und ausdrücklich freigegebene Kosten. Getrennte Sprache, Objektland und Zahlenformate. PDF-Feldbeschriftungen DE/EN/ES. |
| Länder | AT: bestehende Katastral-/Grundbuchangaben; DE: Grundbuchblatt/Gemarkung/Flur/Flurstück; ES: Referencia catastral/Finca registral/CRU; IE: Folio/Townland/Eircode und Prüfstatus. Andere Länderwerte bleiben bei einem Länderwechsel erhalten, werden aber nicht als Angaben des neuen Landes ausgegeben. |

## Bedienung

1. Immobilien öffnen, Objekt auswählen, **Objekt vollständig bearbeiten**. Die Detailgruppen lassen sich einzeln aufklappen. Die geführte Neuanlage führt danach ebenfalls in diese vollständige Bearbeitung.
2. Unter **Einheiten / Bestand → Details bearbeiten** die getrennten Flächen und Stellplätze pflegen. Der Anlegerpreis hat eine eigene Bestätigung mit Quellenangabe und benötigt eine bestehende ausdrückliche Projektvollmacht für Preisänderungen.
3. Unter **Dokumente / Exposé** Kosten und Texte bearbeiten. Neue Kosten sind zunächst privat. Die Auswahl für das Exposé erfolgt je Position. Öffentliche Textänderungen müssen als geprüft bestätigt werden, bevor sie für öffentliche Ausgaben verwendet werden.
4. Nach Datenänderungen eine neue Exposé-/Exportfassung prüfen und ausdrücklich veröffentlichen. Bestehende Veröffentlichungen werden nicht unbemerkt ersetzt.

## Datenverhalten

- Objektland, Inhaltssprache und Zahlenformat sind unabhängig. Eine Sprachwahl übersetzt keinen selbst eingegebenen Freitext.
- Interne Notizen, Abgeberdaten und Kataster-/Grundbuchkennungen gelangen nicht automatisch in öffentliche Ausgaben. Nur ausdrücklich ausgewählte Kosten werden verwendet; bei ausgeblendetem Preis werden auch Kosten und Anlegerpreis ausgeblendet.
- Objekt- und Einheitenfragmente werden getrennt gespeichert. Die Bearbeitung von Objekttexten/-kosten entfernt keine Einheiteninhalte. Sprachfassungen können nebeneinander bestehen.
- Änderungen sind an aktuelle Rollen-, Projekt- und Workspace-Berechtigungen gebunden, protokolliert und gegen veraltete Bearbeitungsstände abgesichert.
- Ungespeicherte Bearbeitungsentwürfe bleiben bei Bereichswechseln im geöffneten CRM erhalten. Neuladen oder Abmelden verwirft diese Arbeitsspeicherentwürfe; die geführte Neuanlage besitzt weiterhin ihre gespeicherten Serverentwürfe.
- Die älteren optionalen Stammdaten Zimmer/Baujahr/öffentlicher Preis behalten beim Leeren der Eingabe ihren bisherigen Wert; die Oberfläche weist darauf hin. Neue Detail- und Einheitenfelder können ausdrücklich auf unbekannt zurückgesetzt werden.
- Länderfelder sind Datenerfassung und Veröffentlichungshilfen. Die regionale Zulässigkeit einer Nutzung oder Vollständigkeit rechtlicher Unterlagen muss anhand des konkreten Objekts geprüft werden.

## Prüfung und Veröffentlichung

Gezielte Tests prüfen echte PostgreSQL-Speicherung, Wiederladen, alle Detaildefinitionen, Kosten-/Text-Sprachfassungen, Berechtigungen, Konflikte, Audit-Rollback, Matching, öffentliche Datenfilterung, PDF-Inhalte und das tatsächliche OpenImmo-XSD. Zusätzlich erfolgt eine Browserprüfung mit rein fiktiven Daten einschließlich Neuladen sowie eine PDF-Sichtprüfung.

Neue Datenbankmigrationen: 185 (Matching-Merkmale), 186 (Einheitenfelder), 187 (sprachgetrennte Textfassungen und durch bestehende RLS geschützte Fragmentersetzung). Keine geschätzte Rückbefüllung vorhandener Objektdaten.

Der konkrete Live-Stand und die endgültigen Prüfergebnisse werden nach dem Deployment im gesonderten Veröffentlichungsnachweis festgehalten.
