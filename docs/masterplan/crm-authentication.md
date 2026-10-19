# CRM → Authentifizierung → MFA-Onboarding

**Status:** Verbindliche CRM-Anforderung, ergänzt am 19.10.2026. Diese Ergänzung
gilt für das bestehende CRM und für die spätere Wiederverwendung im
mandantenfähigen Kundenportal. Sie ergänzt die bestehende
[Authentifizierungs- und MFA-Spezifikation](../security/auth-identity-session-mfa.md).

## Verbindliches Einrichtungsverhalten

Bei der erstmaligen MFA-Einrichtung wird standardmäßig ein QR-Code für eine
Authenticator-App angezeigt. Er kodiert unverändert die vorhandene
TOTP-Provisioning-URI und unterstützt Microsoft Authenticator, Google
Authenticator und kompatible TOTP-Apps.

Die manuelle Schlüsseleingabe bleibt vollständig als optionale Alternative
verfügbar. Der Link „QR-Code kann nicht gescannt werden? Einrichtungsschlüssel
anzeigen.“ öffnet den manuellen Einrichtungsschlüssel; eine Kopierfunktion
erleichtert die Übernahme auf demselben Smartphone. Der Ablauf funktioniert auf
Desktop und Smartphone und verwendet die bestehende deutsche und englische
Spracharchitektur.

Die bestehende sechsstellige Bestätigung aktiviert den Faktor. QR-Code und
manueller Schlüssel gehören zu derselben Einrichtung und verwenden dieselbe
vorhandene TOTP-Implementierung und Sicherheitsprüfung.

## Sicherheit und Wiederverwendung

Der QR-Code wird lokal innerhalb der vertrauenswürdigen Anwendung erzeugt.
Provisioning-URI und Einrichtungsschlüssel dürfen weder an externe QR-Dienste
noch in Logs oder dauerhafte Browserablagen gelangen. Bestehende Challenge-,
Replay-, Rate-Limit-, Recovery- und Session-Sicherheitsregeln bleiben verbindlich.

Das zukünftige mandantenfähige Kundenportal muss dasselbe Einrichtungsverhalten
und die vorhandene Authentifizierungslogik wiederverwenden. Diese Anforderung
führt weder eine zweite MFA-Architektur noch eine neue TOTP-Implementierung ein;
die bestehenden Identitäts- und Mandantengrenzen gelten weiterhin.

Die Abnahme prüft den aus dem angezeigten QR-Code dekodierten URI-Inhalt, den
Einrichtungsabschluss mit einem unabhängig erzeugten TOTP-Code, die manuelle
Alternative einschließlich Kopierfunktion, beide Sprachen und mobile Darstellung.
Die bestehenden verpflichtenden MFA-Sicherheitsprüfungen bleiben erhalten.
