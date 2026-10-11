import type { PropertyActionState, PropertyAssetSummary, PropertyPreflightResult } from "./property-department";

export function getPropertyCommandCopy(language: string) {
  return language === "de" ? {
    newProperty: "Neues Objekt",
    openInquiries: "Anfragen öffnen",
    openUnits: "Einheiten / Bestand öffnen",
    openChannels: "Kanäle und Vorprüfung öffnen",
    openDocuments: "Dokumente und interne Prüfung öffnen",
    editProperty: "Objekt / Preis bearbeiten",
    editPermission: "Bestätigte CRM-Schreib- und Immobilien-Bearbeitungsrechte für diesen Workspace erforderlich.",
    targetRequired: "Zuerst eine gespeicherte Einzelimmobilie auswählen. Projektübersichten sind keine bearbeitbaren Einzelobjekte.",
    unavailable: "Diese Aktion ist derzeit nicht verfügbar.",
    deliveryUnavailable: "Noch nicht verfügbar: Ein vollständiger Veröffentlichungs-/Exportablauf mit geprüftem Ziel, Übertragung und Widerruf ist nicht eingerichtet. Eine Vorprüfung veröffentlicht nichts.",
    blockedPreflight: "Die Vorprüfung enthält blockierende Punkte. Diese zuerst beheben; Veröffentlichung und Export bleiben gesperrt.",
    localPreflight: "Vorprüfung der geladenen Daten",
    localPreflightHint: "Diese Prüfung bewertet die aktuelle Ansicht. Sie ist keine gespeicherte Freigabe und startet keinen Export oder Versand.",
    suggestionHeading: "Automatische Vorschläge – noch nicht gespeichert",
    suggestionCount: "Vorschläge",
    noSuggestions: "Keine Anfragen für Vorschläge in diesem Bereich vorhanden.",
    manual: "Noch keine eindeutige Zuordnung",
    channelTarget: "Ausgewähltes Objekt",
    ready: "Vorprüfung bestanden",
    warning: "Prüfung erforderlich",
    blocked: "Gesperrt",
    pass: "Erfüllt",
    missing: "Fehlt",
  } : {
    newProperty: "New property",
    openInquiries: "Open inquiries",
    openUnits: "Open units / inventory",
    openChannels: "Open channels and preflight",
    openDocuments: "Open documents and internal review",
    editProperty: "Edit property / price",
    editPermission: "Verified CRM write and property operating permissions for this workspace are required.",
    targetRequired: "Select a saved individual property first. Project summaries cannot be edited as individual properties.",
    unavailable: "This action is currently unavailable.",
    deliveryUnavailable: "Not available yet: A complete publication/export workflow with a verified destination, delivery and revocation is not configured. Preflight does not publish anything.",
    blockedPreflight: "Preflight contains blocking issues. Resolve them first; publication and export remain disabled.",
    localPreflight: "Preflight of loaded data",
    localPreflightHint: "This check evaluates the current view. It is not a saved approval and does not start export or delivery.",
    suggestionHeading: "Automatic suggestions — not saved",
    suggestionCount: "Suggestions",
    noSuggestions: "No inquiries available for suggestions in this scope.",
    manual: "No unambiguous assignment yet",
    channelTarget: "Selected property",
    ready: "Preflight passed",
    warning: "Review required",
    blocked: "Blocked",
    pass: "Passed",
    missing: "Missing",
  };
}

/** No delivery implementation exists in this release. A green local check is not launch permission. */
export function getPropertyDeliveryAction(action: PropertyActionState, asset: PropertyAssetSummary | undefined, preflight: PropertyPreflightResult | null, language: string): PropertyActionState {
  const copy = getPropertyCommandCopy(language);
  const reason = !asset || asset.kind !== "property" || !asset.sellerListingId
    ? copy.targetRequired
    : preflight?.status === "blocked"
      ? `${copy.blockedPreflight} ${copy.deliveryUnavailable}`
      : copy.deliveryUnavailable;
  return { ...action, enabled: false, reason };
}

export function resolvePropertyActionButton(action: PropertyActionState, hasHandler: boolean, fallbackReason: string) {
  const enabled = action.enabled && hasHandler;
  return { ...action, enabled, reason: enabled ? undefined : action.reason || fallbackReason };
}
