# CRM Production-Abhängigkeitsaudit: kompatible Auflösung

Aufgabe: das konkrete Hindernis von [Skill-PR #110](https://github.com/novalure/novalure-crm/pull/110)
mit `novalure-diagnose` untersuchen und begrenzt korrigieren. Ausgangsbasis ist
`93f442853483862712451aeeb0b6e3f0ffcfec41` auf `main`; eigener Arbeitszweig
`codex/crm-audit-compat`. Keine Studio-Webchat-Reparatur oder Provideränderung.

## Fehlersignal und Abgleich laufender Arbeit

Der [fehlgeschlagene Production-Audit](https://github.com/novalure/novalure-crm/actions/runs/40080543166/job/120833005515)
von PR #110 verlangt `npm run security:production`. Derselbe Befehl beziehungsweise
`npm audit --omit=dev --audit-level=moderate --json` reproduzierte auf der Basis
Exit 1 mit acht Befunden (drei moderate, fünf high). Passendes Korrektursignal:
Exit 0 ohne Production-Befunde, bei unveränderten Anwendungs-/Providerpaketen und
kompatibler tatsächlicher Auflösung je Verbraucher.

Vor der Bearbeitung wurden `origin/main`, Remote-Branches und offene PRs gelesen:

- [PR #109](https://github.com/novalure/novalure-crm/pull/109) enthält bereits den
  reinen Paketcommit [e8c6673](https://github.com/novalure/novalure-crm/commit/e8c6673c2cc38960f335121abaac1b12730c5e74).
  Dessen Blob-Patch `undici 6.29.1` und Zod-Auflösung `4.6.7` werden wiederverwendet.
  Der dort globale Undici-6-Override erfüllt jedoch nicht die tatsächliche
  Undici-7-Anforderung der vorhandenen AI-Provider-Utils. Die sachfremden
  Kontakt-/Webchatänderungen dieses Zweigs werden nicht übernommen oder verändert.
- [Dependabot-PR #105](https://github.com/novalure/novalure-crm/pull/105) bündelt neun
  Paketupdates. Sie sind für diese begrenzte Korrektur nicht erforderlich.

## Tatsächliche Ketten und kleinste kompatible Korrektur

| Verbraucher im unveränderten Bestand | Deklarierte Anforderung | Vorher | Korrektur |
| --- | --- | --- | --- |
| `@vercel/blob 2.8.0` | `undici ^6.23.0` | global erzwungen `6.28.1` | nur für Blob `6.29.1` |
| `ai 7.0.148` → `@ai-sdk/provider-utils 5.0.65` | `undici ^7.29.0` | global erzwungen `6.28.1` | nur für Provider-Utils `7.30.1` |
| `@vercel/oidc 3.8.8` → `@vercel/cli-config 0.2.7` | exakt `zod 4.1.11` | private Installation `4.1.11` | vorhandenen gezielten Override auf `4.6.7` wiederverwenden |
| `ai`, Gateway und Provider-Utils | Zod-Peer `^3.25.76 || ^4.1.8` | gemeinsame Installation `4.4.3` | kompatible Lockfile-Auflösung `4.6.7` |

Der globale Undici-Override entfällt. Die zwei Verbraucher behalten ausdrücklich
ihre unterschiedlichen Hauptversionen. Undici `7.29.0` wurde als Kandidat geprüft
und verworfen: Es erfüllt die deklarierte Hauptversion, bleibt aber von den
aktuellen Advisories betroffen. `7.30.1` ist die erste veröffentlichte passende
7.x-Version außerhalb der beobachteten Bereiche `<7.30.1` und läuft innerhalb der
bereits geforderten Node-24-Toolchain. Für Blob ist `6.29.1` die erste passende
6.x-Korrektur. Quellen: [EventSource-Advisory](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[Content-Encoding-Advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c).

Für Zod ist der [beobachtete Bereich `<4.6.6`](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
maßgeblich; `4.6.7` erhält die bereits laufende kompatible Korrektur aus PR #109.
Der Override von CLI-Config ist bewusst enger als ein globaler Zod-Override und
ersetzt eine exakte Hersteller-Pinnung; deshalb werden dessen Parser separat
geprüft. Die AI-/Lint-Peers akzeptieren diese Version. Ein CLI-Config-Paketupgrade
brächte hier keinen Auflösungsgewinn: die gelesene aktuelle Version `0.3.3`
deklariert ebenfalls `zod 4.1.11`.

Wichtige Nachweisgrenze: CLI-Config bündelt zusätzlich Zod `4.1.11` in seinem
eigenen `dist/index.js`. Der Dependency-Override ersetzt diesen eingebetteten Code
nicht. Die geprüften exportierten Konfigurationsschemas bestehen aus Objekten,
Skalaren, Enums, Optional-/Passthrough-Werten; betroffene begrenzte Collections
wurden darin nicht gefunden. Dieser Nachweis bestätigt die Dependency-Auflösung
und Parserkompatibilität, keine umfassende Sicherheitsabnahme des Herstellerbundles.

## Prüfnachweise und Umfang

[verification.json](verification.json) hält Befehle, Ergebnisse, Umgebung und die
Hashes der tatsächlich geprüften Paketdateien fest. Der optionale, auf diese
Aufgabe begrenzte [Consumer-Smoke](consumer-smoke.mjs) prüft die je Verbraucher
aufgelösten Hauptversionen und Deklarationen, beide echten Undici-Transporte mit
netzgesperrtem MockAgent, AI-SDK/Zod-Schemagenerierung und negative Validierung
sowie CLI-Config-Parser. Er liest keine Kontodateien, Credentials oder Kundendaten.

Es werden nur `package.json`, vier relevante Lockfile-Einträge und diese
Aufgabennachweise verändert. Kein `npm audit fix --force`, kein direktes
Anwendungs-/Providerpaketupgrade und keine Änderung an vorhandenen Tests oder Gates.
Der exakte integrierte PR-Head benötigt weiterhin die bestehende vollständige CI
und den vertrauenswürdigen unabhängigen App-Review.
