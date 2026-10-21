import type { LanguageCode } from "@/lib/i18n";

const unitFeedbackCopy = {
  de: {
    priceConfirmation: "Preis wird nach autorisierter Bestätigung übernommen",
    unconfirmed: "Die Änderung wurde nicht bestätigt. Prüfen Sie den gespeicherten Stand, bevor Sie es erneut versuchen.",
    refreshFailed: "Die Änderung wurde gespeichert. Die Ansicht konnte nicht aktualisiert werden. Bitte laden Sie neu und speichern Sie nicht erneut.",
    conflict: "Die Einheit oder Reservierung wurde inzwischen geändert. Laden Sie den aktuellen Stand und prüfen Sie Ihre Angaben erneut.",
    forbidden: "Für diese Aktion fehlt Ihnen die Berechtigung. Wenden Sie sich an Ihre Unternehmensadministration.",
    session: "Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.",
  },
  en: {
    priceConfirmation: "The price is applied after authorised confirmation",
    unconfirmed: "The change was not confirmed. Check the saved record before trying again.",
    refreshFailed: "The change was saved, but the view could not refresh. Please reload without saving again.",
    conflict: "The unit or reservation has changed. Reload the current record and review your details.",
    forbidden: "You do not have permission for this action. Contact your company administrator.",
    session: "Your session has expired. Please sign in again.",
  },
} as const;

export function getUnitBoardFeedbackCopy(language: LanguageCode) { return unitFeedbackCopy[language]; }

export function getUnitBoardErrorMessage(language: LanguageCode, cause: unknown): string {
  const text = unitFeedbackCopy[language];
  const code = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (code.includes("VERSION_CONFLICT") || code === "CONFLICT") return text.conflict;
  if (["FORBIDDEN", "forbidden", "Insufficient permissions"].includes(code)) return text.forbidden;
  if (["UNAUTHORIZED", "Unauthorized", "UNAUTHENTICATED"].includes(code)) return text.session;
  return text.unconfirmed;
}
