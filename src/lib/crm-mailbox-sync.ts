import type { MailboxProvider } from "./crm-mailbox";
export type MailboxSyncScope = { workspaceId: string; actorId: string; connectionId: string };
/** This host configuration error does not establish that the user's consent or token was revoked. */
export const mailboxHostConfigurationUnavailable = (code: string): boolean => code === "MAIL_OAUTH_NOT_CONFIGURED";
/** Keep other existing failure routing; provider outages must not request a new consent. */
export function mailboxSyncFailureStatus(code: string): "reauthorization_required" | "delayed" {
  return !mailboxHostConfigurationUnavailable(code) && /AUTH|REAUTH|SCOPE|ACCOUNT_CHANGED/.test(code) ? "reauthorization_required" : "delayed";
}
export type MailboxSyncPosition = { phase: "bootstrap" | "history" | "ready"; bootstrapCursor: string | null; anchor: string | null; historyCheckpoint: string | null; pendingCursor: string | null; deltaCheckpoint: string | null };
export type MailboxSyncChange = { id: string; removed?: boolean };
export type MailboxSyncCheckpoint = MailboxSyncPosition & { queued: MailboxSyncChange[]; afterQueue: MailboxSyncPosition | null };
export const emptyMailboxCheckpoint = (): MailboxSyncCheckpoint => ({ phase: "bootstrap", bootstrapCursor: null, anchor: null, historyCheckpoint: null, pendingCursor: null, deltaCheckpoint: null, queued: [], afterQueue: null });
export class MailboxCheckpointReviewRequired extends Error {
  constructor() { super("MAIL_CHECKPOINT_REVIEW_REQUIRED"); }
}
function microsoftPositionValid(value: unknown): value is MailboxSyncPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  if (position.bootstrapCursor !== null || position.anchor !== null || position.historyCheckpoint !== null) return false;
  const pending = position.pendingCursor, delta = position.deltaCheckpoint;
  if (pending !== null && (typeof pending !== "string" || !pending) || delta !== null && (typeof delta !== "string" || !delta)) return false;
  if (position.phase === "bootstrap") return delta === null;
  if (position.phase === "history") return typeof pending === "string" && typeof delta === "string";
  if (position.phase === "ready") return pending === null && typeof delta === "string";
  return false;
}
/** Refuse damaged Microsoft checkpoints rather than silently restarting a scan. */
export function assertMicrosoftMailboxCheckpoint(value: unknown, inboxId?: string): asserts value is MailboxSyncCheckpoint {
  if (!microsoftPositionValid(value)) throw new MailboxCheckpointReviewRequired();
  const checkpoint = value as unknown as MailboxSyncCheckpoint;
  if (!Array.isArray(checkpoint.queued) || (checkpoint.queued.length === 0 ? checkpoint.afterQueue !== null : !microsoftPositionValid(checkpoint.afterQueue))) throw new MailboxCheckpointReviewRequired();
  for (const change of checkpoint.queued) {
    if (!change || typeof change !== "object" || Array.isArray(change) || typeof change.id !== "string" || !change.id || change.id.length > 1024 || /[\u0000-\u0020]/.test(change.id) || change.removed !== undefined && typeof change.removed !== "boolean") throw new MailboxCheckpointReviewRequired();
  }
  if (inboxId !== undefined) {
    try {
      for (const position of [checkpoint, checkpoint.afterQueue]) {
        if (!position) continue;
        if (position.pendingCursor !== null) mailboxDeltaContinuationUrl(position.pendingCursor, inboxId, "next");
        if (position.deltaCheckpoint !== null) mailboxDeltaContinuationUrl(position.deltaCheckpoint, inboxId, "delta");
      }
    } catch { throw new MailboxCheckpointReviewRequired(); }
  }
}
/** Preserve the old cursor through a separate inbox scan, then replay its changes. */
export function contactBackfillCheckpoint(checkpoint: MailboxSyncCheckpoint, pending: boolean, resume: MailboxSyncCheckpoint | null): { checkpoint: MailboxSyncCheckpoint; resume: MailboxSyncCheckpoint | null; pending: boolean } | null {
  if (checkpoint.phase !== "ready" || checkpoint.queued.length || checkpoint.afterQueue) return null;
  if (resume) return { checkpoint: resume, resume: null, pending };
  return pending ? { checkpoint: emptyMailboxCheckpoint(), resume: checkpoint, pending: false } : null;
}
/** A saved resume/baseline must be a fully drained completed Inbox scan. */
export function assertMicrosoftReadyCheckpoint(value: unknown, inboxId?: string): asserts value is MailboxSyncCheckpoint {
  assertMicrosoftMailboxCheckpoint(value, inboxId);
  if (value.phase !== "ready" || value.queued.length || value.afterQueue !== null) throw new MailboxCheckpointReviewRequired();
}
/** Check the persisted 410 recovery phase and its completed baseline together. */
export function assertMicrosoftRecovery(recovery: { phase: unknown; baseline: unknown; ceilingId: unknown; lastId: unknown } | null, inboxId?: string): void {
  if (recovery === null) return;
  const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const ceiling = recovery.ceilingId, last = recovery.lastId;
  if (ceiling !== null && !validId(ceiling) || last !== null && !validId(last) || ceiling === null && last !== null) throw new MailboxCheckpointReviewRequired();
  if (typeof ceiling === "string" && typeof last === "string" && last.replaceAll("-", "").toLowerCase() > ceiling.replaceAll("-", "").toLowerCase()) throw new MailboxCheckpointReviewRequired();
  if (recovery.phase === "baseline") { if (recovery.baseline !== null || last !== null) throw new MailboxCheckpointReviewRequired(); return; }
  if (recovery.phase !== "verify" && recovery.phase !== "replay") throw new MailboxCheckpointReviewRequired();
  assertMicrosoftReadyCheckpoint(recovery.baseline, inboxId);
}
export function microsoftRecoveryReplay(current: MailboxSyncCheckpoint, baseline: unknown, inboxId?: string): MailboxSyncCheckpoint {
  assertMicrosoftMailboxCheckpoint(current, inboxId);
  assertMicrosoftReadyCheckpoint(baseline, inboxId);
  const replay = { ...baseline, queued: current.queued, afterQueue: current.queued.length ? mailboxSyncPosition(baseline) : null };
  assertMicrosoftMailboxCheckpoint(replay, inboxId);
  return replay;
}
export function microsoftContactBackfillCheckpoint(checkpoint: MailboxSyncCheckpoint, pending: boolean, resume: MailboxSyncCheckpoint | null, inboxId?: string) {
  assertMicrosoftMailboxCheckpoint(checkpoint, inboxId);
  if (resume !== null) assertMicrosoftReadyCheckpoint(resume, inboxId);
  const next = contactBackfillCheckpoint(checkpoint, pending, resume);
  if (next) { assertMicrosoftMailboxCheckpoint(next.checkpoint, inboxId); if (next.resume !== null) assertMicrosoftReadyCheckpoint(next.resume, inboxId); }
  return next;
}
export function queueMicrosoftMailboxDecision(checkpoint: MailboxSyncCheckpoint, providerId: string): MailboxSyncCheckpoint {
  assertMicrosoftMailboxCheckpoint(checkpoint);
  if (typeof providerId !== "string" || !providerId || providerId.length > 1024 || /[\u0000-\u0020]/.test(providerId)) throw new MailboxCheckpointReviewRequired();
  if (checkpoint.queued.some(change => change.id === providerId)) return checkpoint;
  const next = { ...checkpoint, afterQueue: checkpoint.afterQueue ?? mailboxSyncPosition(checkpoint), queued: [{ id: providerId }, ...checkpoint.queued] };
  assertMicrosoftMailboxCheckpoint(next);
  return next;
}
export type MailboxMetadata = { providerId: string; threadId: string | null; internetMessageId: string | null; inReplyTo: string | null; references: string[]; fromAddress: string | null; toAddresses: string[]; participants: string[]; subject: string; receivedAt: string; inInbox: boolean };
export type MailboxSyncDecision = { status: "known" | "review" | "ignored"; reason: string; projectId: string | null; leadId: string | null; contactId: string | null; automatic: boolean };
export function mailboxSyncPosition(checkpoint: MailboxSyncCheckpoint): MailboxSyncPosition { const { phase, bootstrapCursor, anchor, historyCheckpoint, pendingCursor, deltaCheckpoint } = checkpoint; return { phase, bootstrapCursor, anchor, historyCheckpoint, pendingCursor, deltaCheckpoint }; }
/** A delta link is opaque, but may only address the personally bound Inbox. */
export function mailboxDeltaUrl(value: unknown, inboxId?: string): string {
  if (typeof value !== "string" || value.length > 16000 || /[\u0000-\u0020]/.test(value)) throw new Error("MAIL_INVALID_DELTA_CURSOR");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("MAIL_INVALID_DELTA_CURSOR"); }
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash) throw new Error("MAIL_INVALID_DELTA_CURSOR");
  if (/^\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta$/i.test(url.pathname)) return value;
  // Graph may return the same folder as an opaque ID, either as a path
  // segment or OData key. Only the ID independently read for /me/inbox using
  // this same access token is accepted; a link must never select the folder.
  const segment = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages\/delta$/i)?.[1]
    ?? url.pathname.match(/^\/v1\.0\/me\/mailFolders\((?:'|%27)([^/'()]+)(?:'|%27)\)\/messages\/delta$/i)?.[1];
  let folder = "";
  try { if (segment) folder = decodeURIComponent(segment); } catch { throw new Error("MAIL_INVALID_DELTA_CURSOR"); }
  if (!inboxId || !folder || folder !== inboxId) throw new Error("MAIL_INVALID_DELTA_CURSOR");
  return value;
}
/** Check that a continuation carries state without interpreting or rewriting it. */
export function mailboxDeltaContinuationUrl(value: unknown, inboxId?: string, kind?: "next" | "delta"): string {
  const url = mailboxDeltaUrl(value, inboxId);
  const tokens = [...new URL(url).searchParams.entries()].filter(([name]) => /^\$?(skiptoken|deltatoken)$/i.test(name));
  // Microsoft documents skiptoken for nextLink and has also published a
  // message deltaLink using skiptoken. Leave deltaLink compatible with both.
  if (tokens.length !== 1 || !tokens[0][1] || kind === "next" && !/^\$?skiptoken$/i.test(tokens[0][0])) throw new Error("MAIL_INVALID_DELTA_CURSOR");
  return url;
}
export const mailboxSyncStatusLabel: Record<string, string> = { disabled: "Automatischer Eingang aus", not_initialized: "Noch nicht initialisiert", catching_up: "Holt Eingang nach", current: "Eingang abgeglichen", delayed: "Verzögert – erneuter Versuch folgt", review: "Einzelne Inhalte in Prüfung", reauthorization_required: "Erneute persönliche Verbindung nötig", identity_migration: "Outlook-Nachrichtenkennungen werden umgestellt", disconnected: "Verbindung getrennt" };
export function mailboxAutomaticScopeKey(scope: MailboxSyncScope) { return `${scope.workspaceId}:${scope.actorId}:${scope.connectionId}`; }
export function mailboxProviderReset(provider: MailboxProvider, status?: number) { return provider === "google" ? status === 404 : status === 410; }
/** A Microsoft 410 is a delta-cursor reset only when it came from the delta request. */
export function mailboxCursorResetAllowed(provider: MailboxProvider, status: number | undefined, microsoftDeltaExpired: boolean) {
  return mailboxProviderReset(provider, status) && (provider !== "microsoft" || microsoftDeltaExpired);
}
/** A 410 can expire a Microsoft cursor only if this delta request used one. */
export function microsoftCheckpointUsesContinuation(checkpoint: MailboxSyncCheckpoint, inboxId?: string): boolean {
  assertMicrosoftMailboxCheckpoint(checkpoint, inboxId);
  return checkpoint.pendingCursor !== null || checkpoint.deltaCheckpoint !== null;
}
/** Microsoft is current only after a fresh final page was committed and drained in this run. */
export function mailboxSyncCurrent(provider: MailboxProvider, checkpoint: MailboxSyncCheckpoint, freshFinalCursor: string | null): boolean {
  if (checkpoint.phase !== "ready" || checkpoint.queued.length) return false;
  if (provider !== "microsoft") return true;
  return checkpoint.afterQueue === null && freshFinalCursor !== null && checkpoint.deltaCheckpoint === freshFinalCursor;
}
