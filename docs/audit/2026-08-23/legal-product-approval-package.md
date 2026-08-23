# Legal-, Unternehmensprofil- und Product-Freigabepaket

Stand: 23.08.2026
Status: **NO-GO – menschliche Freigaben fehlen**

Dieses Paket friert ausschließlich die technisch geprüften Quellen ein. Es ist keine Rechtsberatung und ersetzt weder Legal- noch Product-Unterschriften. Der finale Candidate-SHA, das SHA-identische Preview-Deployment und gerenderte Content-Hashes werden erst nach dem finalen Deployment in einer getrennten Release-Attestation eingetragen.

## Legal-Inhalt

Das maschinenlesbare Manifest liegt in legal-content-manifest.json. Es umfasst /imprint, /privacy, /terms, /cookies, /data-deletion, /meta und /unsubscribe jeweils mit getrennten DE-/EN-Rendernachweisen. Der Legacy-Alias /datadeletion ist explizit an /data-deletion gebunden; /unsubscribe/confirm ist als eigener funktionaler POST-Vertrag inventarisiert. Die Source-Hashes werden durch scripts/legal-approval-manifest-tests.mjs gegen den Dateibaum geprüft. Render-Hashes, Legal-Owner und Freigabestatus bleiben bis zum finalen SHA-identischen Preview bewusst leer beziehungsweise PENDING.

Noch zwingend durch Legal zu bestätigen:

- Directors beziehungsweise vertretungsbefugte Personen;
- VAT-/Steuerdaten oder eine dokumentierte Nichtanwendbarkeit;
- Privacy-/DPO-Kontakt oder dokumentierte DPO-Nichtanwendbarkeit;
- PSRA-/Immobilienlizenz oder signierte Entscheidung, dass keine lizenzpflichtige Vermittlung erfolgt;
- Geschäfts- und Billing-Anschrift, soweit vom Registered Office abweichend;
- Aussagen zu Meta, KI, Tracking, Rechtsgrundlagen, Aufbewahrung und Drittanbietern;
- ein eigener Versions-/Updated-Stand für /unsubscribe;
- lokalisierte Datumsdarstellung in DE und EN;
- gerenderter Content-Hash je Route und Sprache auf dem finalen Preview.

## Unternehmensprofil

Die technische Approval-Grenze wurde gehärtet:

- Fallback und Seed gelten nicht mehr automatisch als belastbare Freigabe;
- approved/locked benötigt einen erfolgreichen Länder-Preflight, Approver und Zeitpunkt;
- freigegebene Inhalte können nicht in demselben Request entsperrt und verändert werden;
- Wechsel zu draft/needs_review löscht alte Approval-Metadaten;
- Profil, Version und Audit werden in einer Transaktion geschrieben;
- Migration 078 stuft bestehende unvollständige Scheinf­reigaben auf needs_review zurück und erzwingt Approval-Integrität.

Nachtrag 23.08.2026: Migration 078 und die additive Rollenverschärfung 079 wurden nach separater ausdrücklicher Freigabe ausschließlich auf der isolierten Preview-Main-Datenbank angewandt und checksummengebunden nachgeprüft. Migration 061, 062 und 065 sowie Production blieben unverändert. Das Preview-Unternehmensprofil wurde dabei korrekt von einer unvollständigen Scheinf­reigabe auf needs_review zurückgestuft; dies ist keine Legal-Freigabe. Die bereits angewandte Migration 075 wurde nicht nachträglich verändert. Es wurden keine fehlenden Unternehmensdaten erfunden.

## Product-Entscheidungen

Product muss die vollständige Surface-Matrix mit exakt LAUNCH-ON, LAUNCH-OFF oder INTERNAL-ONLY je Zeile signieren. Mindestens zu bestätigen:

- Kern-CRM und Rollenmodell;
- Public Forms/Funnels, Consent und Proof-Refresh;
- Provider-Reads und -Writes;
- reduzierte OFF-Flächen;
- spanische öffentliche Produktoberfläche als explizite `LAUNCH-OFF`-Surface ohne öffentliche Sprachwahl oder hreflang-Angebot;
- Unit-/Buyer-/Deal-Beziehungen;
- bekannte P2-Risiken samt Owner und Termin.

Für Unit-/Buyer-/Deal-Beziehungen bleibt ausschließlich der reduzierte Weg zulässig, bis die zehn Fachentscheidungen in docs/audit/2026-08-22/unit-buyer-deal-decision.md beantwortet sind. Die Initial-Launch-OFF-Entscheidung ist zusätzlich als `specialDecisions.unitBuyerDealRelationship` in der Gesamtmatrix abgebildet und benötigt eigene Signaturen von Product, Sales Operations, Engineering und Data/Compliance. Die API-, Cron-, Repository- und nun auch Viewing-/Offer-UI-Pfade bleiben technisch OFF.

## Signaturhülle

| Freigabe | Name | Rolle | Datum/Zeit | Candidate-SHA | Deployment | Matrix-/Content-Hash | akzeptierte OFF-/INTERNAL-Flächen | Signaturreferenz |
|---|---|---|---|---|---|---|---|---|
| Product | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Engineering | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Security | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Operations/DBA | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Legal/Privacy | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ |
| Sales Operations | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | Unit-/Buyer-/Deal-OFF | _offen_ |
| Data/Compliance | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | _offen_ | Unit-/Buyer-/Deal-OFF | _offen_ |

Leere Zeilen oder pauschale Freigaben sind ungültig. Bis alle Pflichtrollen den finalen SHA und dieselben Hashes bestätigen, bleiben launchScopePolicyApproval und die Gesamtentscheidung auf PENDING_SIGNATURE beziehungsweise NO-GO.
