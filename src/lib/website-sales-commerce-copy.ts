/** Ordinary Sales language; provider receipts remain separate from an operator's notes. */
export function websiteSalesCommerceCopy(language: string) {
  const de = language === 'de';
  return {
    title: de ? 'Abschluss und Betreuung' : 'Closing and ongoing service',
    intro: de
      ? 'Vom freigegebenen Angebot bis zu Vertrag, Leistung, Rechnung und laufender Betreuung. Jeder Schritt zeigt seinen aktuellen Nachweis.'
      : 'From the approved offer through the contract, delivery, invoice and ongoing service. Each step shows its current evidence.',
    refresh: de ? 'Stand aktualisieren' : 'Refresh status',
    loading: de ? 'Abschlussakte wird geladen.' : 'Loading the closing record.',
    loadError: de ? 'Der aktuelle Stand konnte nicht geladen werden. Aktualisieren Sie die Akte vor der nächsten Änderung.' : 'The current record could not be loaded. Refresh it before making another change.',
    saved: de ? 'Gespeichert. Den aktuellen Schritt und seine Nachweise finden Sie in der Übersicht.' : 'Saved. The overview shows the current step and its evidence.',
    saving: de ? 'Vorgang wird gespeichert.' : 'Saving this operation.',
    denied: de ? 'Der Vorgang konnte nicht ausgeführt werden. Prüfen Sie den aktuellen Stand und die angezeigten Voraussetzungen.' : 'This operation could not be completed. Check the current record and the listed requirements.',
    unknown: de ? 'Das Ergebnis ist noch nicht eindeutig bestätigt. Weitere Sales-Änderungen bleiben bis zum Abgleich gesperrt.' : 'The result has not been confirmed. Further Sales changes remain blocked until reconciliation.',
    damaged: de ? 'Die gespeicherte Wiederaufnahme ist nicht lesbar. Die Akte bleibt gesperrt, bis der ursprüngliche Vorgang sicher abgeglichen wurde.' : 'The saved recovery record cannot be read. Changes remain blocked until the original operation has been safely reconciled.',
    checkOriginal: de ? 'Ursprüngliche Akte prüfen' : 'Check the original record',
    reconcile: de ? 'Ergebnis abgleichen' : 'Reconcile the result',
    retryOriginal: de ? 'Ursprünglichen Vorgang fortsetzen' : 'Continue the original operation',
    notFound: de ? 'Für genau diesen Vorgang wurde noch kein gespeichertes Ergebnis gefunden. Sie können denselben Vorgang mit unveränderten Angaben fortsetzen.' : 'No saved result was found for this exact operation. You can continue it with the original details.',
    currentReadRequired: de ? 'Lesen Sie zuerst die ursprüngliche Akte neu ein.' : 'Reload the original record first.',
    unavailable: de ? 'Noch nicht eingerichtet' : 'Not configured yet',
    noRecords: de ? 'Für diesen Schritt liegen noch keine Einträge vor.' : 'There are no records for this step yet.',
    unknownValue: de ? 'Noch nicht bestätigt' : 'Not confirmed yet',
    providerProof: de ? 'Durch die angebundene Quelle bestätigt' : 'Confirmed by the connected source',
    manualProof: de ? 'Verantwortlich dokumentierte Angabe' : 'Operator-recorded information',
    pendingProof: de ? 'Wartet auf einen Nachweis' : 'Awaiting evidence',
    current: de ? 'Aktuell' : 'Current',
    stale: de ? 'Grundlage geändert – neu prüfen' : 'Source changed — review required',
    blocked: de ? 'Voraussetzung fehlt' : 'Requirement missing',
    reference: de ? 'Quellenbeleg' : 'Source reference',
    recordedAt: de ? 'Erfasst am' : 'Recorded at',
    validUntil: de ? 'Gültig bis' : 'Valid until',
    choose: de ? 'Bitte auswählen' : 'Choose an item',
    required: de ? 'Bitte prüfen Sie dieses Feld.' : 'Please check this field.',
    errorTitle: de ? 'Bitte prüfen Sie die Angaben' : 'Check these details',
    history: de ? 'Nachweise und Verlauf' : 'Evidence and history',
    permission: de ? 'Für diese Aktion fehlt die passende Berechtigung.' : 'You do not have permission for this action.',
    stageLabels: {
      offer: de ? 'Angebot' : 'Offer',
      contract: de ? 'Vertrag' : 'Contract',
      delivery: de ? 'Leistung und Abnahme' : 'Delivery and acceptance',
      invoice: de ? 'Rechnung und Zahlung' : 'Invoice and payment',
      subscription: de ? 'Laufende Betreuung' : 'Ongoing service',
      configuration: de ? 'Grundlagen' : 'Configuration',
    },
  };
}
