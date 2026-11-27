export const mailboxProviders = ["microsoft", "google"] as const;
export type MailboxProvider = typeof mailboxProviders[number];
export type MailboxAttachment = { providerId: string; name: string; mimeType: string; sizeBytes: number; inline: boolean; status: "quarantined_metadata_only"; storedBytes: false };
export type MailboxImportedMessage = { providerId: string; threadId: string | null; internetMessageId: string | null; subject: string; fromLabel: string; fromAddress: string | null; toAddresses: string[]; receivedAt: string; bodyText: string; bodyTruncated: boolean; attachments: MailboxAttachment[]; senderIdentityVerified: false };
export const mailboxRequestedScopes = {
  microsoft: ["openid", "profile", "email", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Read"],
  google: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"],
} as const;
export function mailboxProvider(value: unknown): MailboxProvider { if (!(mailboxProviders as readonly unknown[]).includes(value)) throw new Error("INVALID_MAILBOX_PROVIDER"); return value as MailboxProvider; }
export function hasMailboxReadScope(provider: MailboxProvider, scopes: readonly string[]) {
  return provider === "google" ? scopes.some((scope) => scope === "https://www.googleapis.com/auth/gmail.readonly" || scope === "https://www.googleapis.com/auth/gmail.modify" || scope === "https://mail.google.com/")
    : scopes.some((scope) => /^(?:https:\/\/graph\.microsoft\.com\/)?Mail\.Read(?:Write)?$/i.test(scope));
}
/** Verified Microsoft mailbox connections must remain read-only. The provider
 * may return Graph scopes either qualified or unqualified and may include OIDC
 * scopes. An unknown/additional permission is not silently accepted. */
export function hasVerifiedMicrosoftMailboxScopes(scopes: readonly string[]) {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32) return false;
  const allowed = new Set(["openid", "profile", "email", "offline_access", "user.read", "mail.read"]);
  const normalized: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.length > 256 || !scope || /\s/.test(scope)) return false;
    const value = scope.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, "");
    if (!allowed.has(value)) return false;
    normalized.push(value);
  }
  return normalized.includes("mail.read");
}
/** Read-only presentation: it never changes credentials or certifies provider state. */
export type MailboxConnectionPresentation = "configured" | "not_connected" | "scope_review" | "binding_review" | "check_unconfirmed" | "extra_permissions" | "extra_permissions_check_unconfirmed";
export function microsoftMailboxBindingReady(mode: boolean | null, verified: boolean, hasSubject: boolean, hasAccountId: boolean): boolean {
  return mode !== null && mode === verified && (!verified || hasSubject && hasAccountId);
}
export function mailboxConnectionPresentation(input: { provider: MailboxProvider; status: string; scopes: unknown; verifiedMicrosoft: boolean; microsoftBindingReady?: boolean; checkPending: boolean }): MailboxConnectionPresentation {
  if (input.status !== "connected") return "not_connected";
  if (input.provider === "microsoft" && input.microsoftBindingReady !== true) return "binding_review";
  const scopes = Array.isArray(input.scopes) && input.scopes.every(value => typeof value === "string") ? input.scopes as string[] : [];
  if (!hasMailboxReadScope(input.provider, scopes)) return "scope_review";
  if (input.provider === "microsoft" && !hasVerifiedMicrosoftMailboxScopes(scopes)) {
    if (input.verifiedMicrosoft) return "scope_review";
    return input.checkPending ? "extra_permissions_check_unconfirmed" : "extra_permissions";
  }
  return input.checkPending ? "check_unconfirmed" : "configured";
}
export function mailboxConnectionPresentationLabel(presentation: MailboxConnectionPresentation, de: boolean): string {
  switch (presentation) {
    case "configured": return de ? "Verbindung eingerichtet" : "Connection configured";
    case "check_unconfirmed": return de ? "Abgleich nicht bestätigt" : "Mailbox check not confirmed";
    case "scope_review": return de ? "Mail-Berechtigungen prüfen" : "Review mail permissions";
    case "binding_review": return de ? "Postfachverbindung prüfen" : "Review mailbox connection";
    case "extra_permissions": return de ? "Weitergehende Berechtigungen prüfen" : "Review additional permissions";
    case "extra_permissions_check_unconfirmed": return de ? "Weitergehende Berechtigungen prüfen · Abgleich nicht bestätigt" : "Review additional permissions · mailbox check not confirmed";
    default: return de ? "Mail-Zustimmung erneut erforderlich" : "Mail authorization required";
  }
}
export function mailboxPresentationWhileUncertain(presentation: MailboxConnectionPresentation, uncertain: boolean): MailboxConnectionPresentation {
  if (!uncertain) return presentation;
  if (presentation === "configured") return "check_unconfirmed";
  if (presentation === "extra_permissions") return "extra_permissions_check_unconfirmed";
  return presentation;
}
/** Disabling existing automatic checking remains possible even if the account
 * is no longer connected; enabling and sync still require current readiness. */
export function mailboxAutoControls(input: { connected: boolean; needsReview: boolean; enabled: boolean; settingEnabled: boolean; disabled: boolean }) {
  return {
    canToggle: !input.disabled && (input.enabled || input.connected && !input.needsReview),
    canSave: !input.disabled && (!input.enabled || input.connected && !input.needsReview),
    canSync: !input.disabled && input.connected && !input.needsReview && input.settingEnabled,
  };
}
export function mailboxText(value: unknown, limit: number) { return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, limit) : ""; }
export function mailboxAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  const matches = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/ig);
  return matches?.length === 1 && matches[0].length <= 254 ? matches[0].toLowerCase() : null;
}
export function mailboxProviderId(value: unknown): string { if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u0020]/.test(value)) throw new Error("INVALID_MAIL_MESSAGE_ID"); return value; }
/** Preliminary URL shape check; this does not establish that the folder is Inbox. */
export function microsoftMailboxCursorCandidate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020]/.test(value)) throw new Error("INVALID_MAIL_CURSOR");
  const url = new URL(value);
  const rawPath = value.split(/[?#]/, 1)[0];
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || rawPath !== `https://graph.microsoft.com${url.pathname}` || !/^\/v1\.0\/me\/mailFolders\/[^/]+\/messages$/.test(url.pathname)) throw new Error("INVALID_MAIL_CURSOR");
  return value;
}
export function mailboxCursor(provider: MailboxProvider, value: unknown, inboxId?: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (provider === "google") {
    if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_=-]+$/.test(value)) throw new Error("INVALID_MAIL_CURSOR");
    return value;
  }
  const candidate = microsoftMailboxCursorCandidate(value)!;
  const segment = new URL(candidate).pathname.split("/")[4];
  let folder: string;
  try { folder = decodeURIComponent(segment); } catch { throw new Error("INVALID_MAIL_CURSOR"); }
  if (folder !== "inbox" && (!inboxId || folder !== mailboxProviderId(inboxId))) throw new Error("INVALID_MAIL_CURSOR");
  return candidate;
}
