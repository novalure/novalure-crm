import type { MailboxProvider } from "./crm-mailbox";
export type MailboxSyncScope = { workspaceId: string; actorId: string; connectionId: string };
export type MailboxSyncPosition = { phase: "bootstrap" | "history" | "ready"; bootstrapCursor: string | null; anchor: string | null; historyCheckpoint: string | null; pendingCursor: string | null; deltaCheckpoint: string | null };
export type MailboxSyncChange = { id: string; removed?: boolean };
export type MailboxSyncCheckpoint = MailboxSyncPosition & { queued: MailboxSyncChange[]; afterQueue: MailboxSyncPosition | null };
export const emptyMailboxCheckpoint = (): MailboxSyncCheckpoint => ({ phase: "bootstrap", bootstrapCursor: null, anchor: null, historyCheckpoint: null, pendingCursor: null, deltaCheckpoint: null, queued: [], afterQueue: null });
export type MailboxMetadata = { providerId: string; threadId: string | null; internetMessageId: string | null; inReplyTo: string | null; references: string[]; fromAddress: string | null; toAddresses: string[]; participants: string[]; subject: string; receivedAt: string; inInbox: boolean };
export type MailboxSyncDecision = { status: "known" | "review" | "ignored"; reason: string; projectId: string | null; leadId: string | null; contactId: string | null; automatic: boolean };
export function mailboxSyncPosition(checkpoint: MailboxSyncCheckpoint): MailboxSyncPosition { const { phase, bootstrapCursor, anchor, historyCheckpoint, pendingCursor, deltaCheckpoint } = checkpoint; return { phase, bootstrapCursor, anchor, historyCheckpoint, pendingCursor, deltaCheckpoint }; }
/** A delta link is opaque, but may only address the personally bound Inbox. */
export function mailboxDeltaUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16000 || /[\u0000-\u0020]/.test(value)) throw new Error("MAIL_INVALID_DELTA_CURSOR");
  const url = new URL(value);
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || !/^\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta$/i.test(url.pathname)) throw new Error("MAIL_INVALID_DELTA_CURSOR");
  return value;
}
export const mailboxSyncStatusLabel: Record<string, string> = { disabled: "Automatischer Eingang aus", not_initialized: "Noch nicht initialisiert", catching_up: "Holt Eingang nach", current: "Eingang abgeglichen", delayed: "Verzögert – erneuter Versuch folgt", review: "Einzelne Inhalte in Prüfung", reauthorization_required: "Erneute persönliche Verbindung nötig", identity_migration: "Outlook-Nachrichtenkennungen werden umgestellt", disconnected: "Verbindung getrennt" };
export function mailboxAutomaticScopeKey(scope: MailboxSyncScope) { return `${scope.workspaceId}:${scope.actorId}:${scope.connectionId}`; }
export function mailboxProviderReset(provider: MailboxProvider, status?: number) { return provider === "google" ? status === 404 : status === 410; }
