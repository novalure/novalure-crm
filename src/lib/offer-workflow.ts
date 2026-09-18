export type OfferStatus = "DRAFT" | "APPROVED" | "QUEUED" | "SENT" | "ACCEPTED" | "REJECTED" | "CANCELLED";
export type OfferLine = { description: string; quantity: number; unitNetCents: number };
export type OfferContent = { subject: string; recipientName: string; recipientEmail: string; terms: string; validUntil: string; currency: "EUR"; taxBasis: "NET"; items: OfferLine[] };
export type OfferAction = "revise" | "approve" | "revoke" | "queue_send" | "record_sent" | "record_unknown" | "accept" | "reject" | "schedule_follow_up" | "stop_follow_up" | "complete_follow_up";
export class OfferValidationError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
const fail = (code: string): never => { throw new OfferValidationError(code); };
export function offerText(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) return fail(`INVALID_${label}`);
  return value.trim();
}
export function offerDate(value: unknown, label: string): string {
  const text = offerText(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) return fail(`INVALID_${label}`);
  if (new Date(text).toISOString().slice(0, 19) !== text.slice(0, 19)) return fail(`INVALID_${label}`);
  return new Date(text).toISOString();
}
export function parseOfferContent(raw: unknown): OfferContent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("INVALID_CONTENT");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !["subject", "recipientName", "recipientEmail", "terms", "validUntil", "currency", "taxBasis", "items"].includes(key))) return fail("UNKNOWN_CONTENT_FIELD");
  if (input.currency !== "EUR" || input.taxBasis !== "NET") return fail("EUR_NET_REQUIRED");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) return fail("INVALID_ITEMS");
  const recipientEmail = offerText(input.recipientEmail, "RECIPIENT_EMAIL", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) return fail("INVALID_RECIPIENT_EMAIL");
  const items = input.items.map((value): OfferLine => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_ITEM");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !["description", "quantity", "unitNetCents"].includes(key))) return fail("UNKNOWN_ITEM_FIELD");
    if (!Number.isSafeInteger(item.quantity) || (item.quantity as number) <= 0 || (item.quantity as number) > 1000000) return fail("INVALID_QUANTITY");
    if (!Number.isSafeInteger(item.unitNetCents) || (item.unitNetCents as number) < 0) return fail("INVALID_PRICE");
    return { description: offerText(item.description, "DESCRIPTION", 1000), quantity: item.quantity as number, unitNetCents: item.unitNetCents as number };
  });
  const content: OfferContent = { subject: offerText(input.subject, "SUBJECT", 240), recipientName: offerText(input.recipientName, "RECIPIENT_NAME", 240), recipientEmail, terms: offerText(input.terms, "TERMS", 20000), validUntil: offerDate(input.validUntil, "VALID_UNTIL"), currency: "EUR", taxBasis: "NET", items };
  offerTotal(content);
  return content;
}
export function offerTotal(content: Pick<OfferContent, "items">): number {
  let total = 0;
  for (const item of content.items) {
    const line = item.quantity * item.unitNetCents;
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(total + line)) return fail("AMOUNT_OVERFLOW");
    total += line;
  }
  if (total <= 0) return fail("POSITIVE_TOTAL_REQUIRED");
  return total;
}
export function nextOfferStatus(status: OfferStatus, action: OfferAction): OfferStatus {
  const rules: Partial<Record<OfferAction, Partial<Record<OfferStatus, OfferStatus>>>> = {
    revise: { DRAFT: "DRAFT", APPROVED: "DRAFT", SENT: "DRAFT" },
    approve: { DRAFT: "APPROVED" }, revoke: { APPROVED: "DRAFT", QUEUED: "DRAFT" },
    queue_send: { APPROVED: "QUEUED" }, record_sent: { QUEUED: "SENT" }, record_unknown: { QUEUED: "QUEUED" },
    accept: { SENT: "ACCEPTED" }, reject: { SENT: "REJECTED" },
    schedule_follow_up: { SENT: "SENT" }, stop_follow_up: { SENT: "SENT", ACCEPTED: "ACCEPTED", REJECTED: "REJECTED" },
    complete_follow_up: { SENT: "SENT" },
  };
  return rules[action]?.[status] ?? fail("INVALID_OFFER_TRANSITION");
}
export function assertOfferApproval(input: { revision: number; digest: string; approverId: string; configuredApproverId: string | null; approval: { revision: number; digest: string; actorId: string; expiresAt: string } | null; now: number }): void {
  const approval = input.approval;
  if (!input.configuredApproverId || !approval || approval.actorId !== input.configuredApproverId || approval.actorId !== input.approverId || approval.revision !== input.revision || approval.digest !== input.digest || Date.parse(approval.expiresAt) <= input.now || !Number.isFinite(Date.parse(approval.expiresAt))) fail("VALID_APPROVAL_REQUIRED");
}
export function assertFreshOfferSession(input: { authenticated: boolean; source: string; authSessionId?: string; sessionCreatedAt?: string | Date }, now: number): void {
  const created = input.sessionCreatedAt ? new Date(input.sessionCreatedAt).getTime() : NaN;
  if (!input.authenticated || input.source === "demo" || !input.authSessionId || !Number.isFinite(created) || created > now || now - created > 15 * 60 * 1000) fail("FRESH_AUTHENTICATION_REQUIRED");
}
/** Offers and contracts are separate approval objects; this workflow never sends contracts. */
export function requiredSalesApprovalSteps(action: "offer.send" | "contract.send", totalNetCents: number): 1 | 2 {
  if (!Number.isSafeInteger(totalNetCents) || totalNetCents <= 0) return fail("INVALID_PRICE");
  return action === "contract.send" && totalNetCents >= 500000 ? 2 : 1;
}
export function assertOfferOnlyAction(action: string): void {
  if (action !== "offer.send") fail("CONTRACT_AND_PAYMENT_EXECUTION_DISABLED");
}
