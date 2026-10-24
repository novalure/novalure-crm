---
name: novalure-diagnose
description: "Diagnostiziert im aktuellen Novalure-Projekt einen konkreten Fehler oder eine Leistungsregression anhand eines passenden Fehlersignals. Für kaputte CRM-, Chatbot-, Evelyn- oder Telefonieabläufe im beauftragten Scope."
---

# Novalure Diagnose

1. Beginne mit dem konkreten Fehlerbild: Auslöser, Soll/Ist, betroffene Revision und Umgebung, sichtbare Meldung beziehungsweise falsches Ergebnis. Lies geltende Anweisungen und den [Projektkontext](../PROJECT.md); erhalte fremde Arbeitsänderungen.
2. Wähle zuerst eine geeignete Rückmeldung, an der genau diese Korrektur erkennbar wird: vorhandener gezielter Test, reproduzierbarer UI-/HTTP-/CLI-Ablauf oder nachvollziehbare manuelle Beobachtung. Bei Performance einen passenden Ausgangswert messen. Halte fest, was bereits ausgeführt ist und was mangels Zugriff/Reproduktion noch fehlt; ein fremder grüner Test belegt diesen Fehler nicht.
3. Grenze den Auslöser ein und prüfe plausible, widerlegbare Ursachen mit gezielten Beobachtungen. Mehrere Hypothesen, Minimierung oder Wiederholungen nur, soweit sie hier helfen; keine starre Phasen-, Hypothesen- oder Wiederholungsquote. Ändere je Versuch möglichst eine relevante Variable.
4. Behebe die belegte Ursache im autorisierten Scope. Nutze vorhandene Testgrenzen; ergänze eine Regression nur, wenn sie das echte Fehlerverhalten sinnvoll absichert. Prüfe das ursprüngliche Fehlerbild und relevante Auswirkungen. Bestehende Pflichtprüfungen bleiben erhalten; unveränderte Nachweise nicht pauschal erneut erzeugen.
5. Entferne temporäre Diagnosehilfen. Notiere Ursache, Korrektur, ausgeführte Prüfungen und verbleibende Lücken bei der Aufgabe, bei Bedarf `docs/tasks/<task-id>/diagnosis.md`. Ohne passenden Nachweis keine erfolgreiche Korrektur behaupten. Fehlende Reproduktion mit kleinstem sinnvollen nächsten Schritt benennen.

Verwende synthetische oder geeignet bereinigte Daten. Keine Tokens, Auth-Header, Zugangsdaten, personenbezogenen Kundendaten oder vollständigen Kundenmitschnitte in allgemeinen Nachweisen. Produktionsinstrumentierung und echte externe Wirkungen benötigen ihren tatsächlich gültigen Scope; dieser Skill erteilt ihn nicht.

Adaptiert aus `diagnosing-bugs`; [Quellstand und MIT-Lizenz](../UPSTREAM.md).
