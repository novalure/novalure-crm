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
export function mailboxText(value: unknown, limit: number) { return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, limit) : ""; }
export function mailboxAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  const matches = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/ig);
  return matches?.length === 1 && matches[0].length <= 254 ? matches[0].toLowerCase() : null;
}
export function mailboxProviderId(value: unknown): string { if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u0020]/.test(value)) throw new Error("INVALID_MAIL_MESSAGE_ID"); return value; }
export function mailboxCursor(provider: MailboxProvider, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020]/.test(value)) throw new Error("INVALID_MAIL_CURSOR");
  if (provider === "google") { if (!/^[A-Za-z0-9_=-]+$/.test(value)) throw new Error("INVALID_MAIL_CURSOR"); return value; }
  const url = new URL(value);
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || !/^\/v1\.0\/me\/(?:mailFolders\/inbox\/)?messages$/.test(url.pathname)) throw new Error("INVALID_MAIL_CURSOR");
  return url.toString();
}
