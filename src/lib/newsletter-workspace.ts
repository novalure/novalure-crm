import { newsletterVariableIssues } from "./newsletter-message-variables";

export type NewsletterEditorBlock =
  | { id: string; type: "text" | "heading"; text: string }
  | { id: string; type: "image"; imageUrl: string; alt: string; caption: string }
  | { id: string; type: "button"; label: string; url: string }
  | { id: string; type: "property"; title: string; location: string; price: string; detail: string; ctaLabel: string; ctaUrl: string }
  | { id: string; type: "feedback"; question: string }
  | { id: string; type: "social"; website: string; instagram: string; linkedin: string }
  | { id: string; type: "spacer"; size: "small" | "medium" | "large" }
  | { id: string; type: "divider" };
export type NewsletterDraftState = { contentBlocks: NewsletterEditorBlock[]; fromEmail: string; fromName: string; previewText: string; replyTo: string; sendAt: string; subject: string; variantA: string; variantB: string; legalAddress: string; language: "de" | "en" | "es" };
export type SavedNewsletterDraft = { campaignId: string; projectId: string; name: string; segmentId: string | null; revision: number; approvedRevision: number | null; input: NewsletterDraftState; updatedAt: string };
export type NewsletterRecipient = { contactId: string; name: string; email: string; eligible: boolean; reason: string; deliveryPolicy?: { allowed: boolean; issues: string[]; nextAllowedAt: string | null } };
export class NewsletterWorkspaceError extends Error {}
export const newsletterUnsubscribePlaceholder = "{{NOVALURE_UNSUBSCRIBE_URL}}";
export function newsletterRecipientReason(input: { email: string; consentStatus?: string | null; consentLabel: string; suppressed: boolean; duplicate?: boolean }) {
  const out = /(opt.?out|abgemeldet|unsubscribe|unsubscribed|widerspruch|stop|no|false)/i.test(input.consentStatus ?? "") || /(opt.?out|abgemeldet|unsubscribe|unsubscribed|widerspruch|stop|no|false)/i.test(input.consentLabel);
  const optIn = !/(double.?opt.?in|doi).*(offen|pending|open)|pending/i.test(input.consentStatus ?? "") && /(opt.?in|einwilligung|zugestimmt|subscribed|newsletter\s+ja|ja\s+newsletter|yes|true)/i.test(input.consentStatus ?? "");
  return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ? "missing_address" : input.suppressed ? "newsletter_suppression" : out ? "opt_out" : input.duplicate ? "duplicate_email" : !optIn ? "missing_opt_in" : "allowed_opt_in";
}
const blockFields = { text: ["text"], heading: ["text"], image: ["imageUrl", "alt", "caption"], button: ["label", "url"], property: ["title", "location", "price", "detail", "ctaLabel", "ctaUrl"], feedback: ["question"], social: ["website", "instagram", "linkedin"], spacer: ["size"], divider: [] } as const;
const stringFields = ["fromEmail", "fromName", "previewText", "replyTo", "sendAt", "subject", "variantA", "variantB", "legalAddress"] as const;

export function emptyNewsletterDraft(fromEmail = "", fromName = ""): NewsletterDraftState {
  return { contentBlocks: [], fromEmail, fromName, previewText: "", replyTo: "", sendAt: "", subject: "", variantA: "", variantB: "", legalAddress: "", language: "de" };
}
export function normalizeNewsletterDraft(value: unknown): NewsletterDraftState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NewsletterWorkspaceError("Ein Mailingentwurf ist erforderlich.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => ![...stringFields, "contentBlocks", "language"].includes(key as never))) throw new NewsletterWorkspaceError("Der Entwurf enthält unbekannte Felder.");
  const draft = emptyNewsletterDraft();
  for (const field of stringFields) {
    if (typeof input[field] !== "string" || input[field].length > (field === "legalAddress" ? 1500 : field === "previewText" ? 1000 : 300)) throw new NewsletterWorkspaceError("Ein Mailingfeld fehlt oder ist zu lang.");
    draft[field] = input[field].trim();
  }
  if (!["de", "en", "es"].includes(String(input.language))) throw new NewsletterWorkspaceError("Die Inhaltssprache ist ungültig.");
  draft.language = input.language as NewsletterDraftState["language"];
  if ([draft.subject, draft.fromName, draft.fromEmail, draft.replyTo].some(value => /[\r\n]/.test(value))) throw new NewsletterWorkspaceError("Absender und Betreff dürfen keine Zeilenumbrüche enthalten.");
  if (!Array.isArray(input.contentBlocks) || input.contentBlocks.length > 40) throw new NewsletterWorkspaceError("Höchstens 40 Inhaltsblöcke sind möglich.");
  const ids = new Set<string>();
  draft.contentBlocks = input.contentBlocks.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new NewsletterWorkspaceError("Ein Inhaltsblock ist ungültig.");
    const block = value as Record<string, unknown>, type = String(block.type);
    if (!Object.hasOwn(blockFields, type) || typeof block.id !== "string" || !/^[a-zA-Z0-9_-]{1,150}$/.test(block.id) || ids.has(block.id)) throw new NewsletterWorkspaceError("Inhaltsblöcke benötigen eindeutige gültige IDs.");
    ids.add(block.id);
    const fields = blockFields[type as keyof typeof blockFields];
    if (Object.keys(block).some(key => !["id", "type", ...fields].includes(key)) || fields.some(field => typeof block[field] !== "string" || String(block[field]).length > 6000)) throw new NewsletterWorkspaceError("Ein Inhaltsfeld ist ungültig oder zu lang.");
    if (type === "spacer" && !["small", "medium", "large"].includes(String(block.size))) throw new NewsletterWorkspaceError("Der Abstand ist ungültig.");
    for (const field of ["url", "ctaUrl", "imageUrl", "website", "instagram", "linkedin"]) {
      const url = block[field]; if (!url) continue;
      try { const parsed = new URL(String(url)); if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || String(url).includes("{{")) throw new Error(); }
      catch { throw new NewsletterWorkspaceError("Links und Bilder benötigen eine vollständige HTTP- oder HTTPS-Adresse."); }
    }
    return { ...block } as NewsletterEditorBlock;
  });
  if (JSON.stringify(draft).length > 150000) throw new NewsletterWorkspaceError("Der Mailingentwurf ist zu groß.");
  return draft;
}

export function newsletterReadyIssues(draft: NewsletterDraftState): string[] {
  const issues: string[] = [];
  if (!draft.subject) issues.push("Betreff fehlt.");
  if (!draft.fromName || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(draft.fromEmail)) issues.push("Vollständiger Absender fehlt.");
  if (draft.replyTo && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(draft.replyTo)) issues.push("Antwortadresse ist ungültig.");
  if (draft.legalAddress.length < 10) issues.push("Absenderanschrift fehlt.");
  if (draft.sendAt) issues.push("Für diesen Versand bitte den Termin entfernen und manuell starten.");
  if (!draft.contentBlocks.some(block => (block.type === "text" || block.type === "heading") ? !!block.text.trim() : block.type === "property" ? !!block.title.trim() : block.type === "image" ? !!block.imageUrl : false)) issues.push("Nachrichteninhalt fehlt.");
  for (const block of draft.contentBlocks) {
    if (block.type === "image" && block.imageUrl && !block.alt.trim()) issues.push("Ein Bild benötigt Alternativtext.");
    if (block.type === "button" && (!block.label.trim() || !block.url)) issues.push("Ein Button ist unvollständig.");
    if (block.type === "property" && (!block.title.trim() || !block.ctaUrl || !block.ctaLabel.trim())) issues.push("Ein Immobilienblock ist unvollständig.");
  }
  if (newsletterVariableIssues(JSON.stringify(draft)).length) issues.push("Eine Pflichtvariable ist unvollständig oder nicht mit echten Daten verbunden.");
  return [...new Set(issues)];
}
export function equalNewsletterDrafts(left: NewsletterDraftState, right: NewsletterDraftState) {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
  return JSON.stringify(ordered(normalizeNewsletterDraft(left))) === JSON.stringify(ordered(normalizeNewsletterDraft(right)));
}
function escape(value: string) { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }
export function renderApprovedNewsletter(draft: NewsletterDraftState, context: { contactName: string; projectName: string; agentName: string; unsubscribeUrl: string; test?: boolean }) {
  const text = (value: string) => escape(value.replaceAll("{{contact.name}}", context.contactName).replaceAll("{{project.name}}", context.projectName).replaceAll("{{agent.name}}", context.agentName)).replaceAll("\n", "<br>");
  const link = (url: string, label: string) => `<a href="${escape(url)}" style="display:inline-block;padding:12px 18px;color:#fff;background:#0f172a;border-radius:8px;text-decoration:none">${text(label)}</a>`;
  const blocks = draft.contentBlocks.map(block => {
    if (block.type === "text") return `<p>${text(block.text)}</p>`;
    if (block.type === "heading") return `<h2>${text(block.text)}</h2>`;
    if (block.type === "image") return block.imageUrl ? `<p><img style="max-width:100%;height:auto" src="${escape(block.imageUrl)}" alt="${escape(block.alt)}"></p>${block.caption ? `<p>${text(block.caption)}</p>` : ""}` : "";
    if (block.type === "button") return `<p>${link(block.url, block.label)}</p>`;
    if (block.type === "property") return `<h2>${text(block.title)}</h2><p>${text(block.location)} · ${text(block.price)}</p><p>${text(block.detail)}</p><p>${link(block.ctaUrl, block.ctaLabel)}</p>`;
    if (block.type === "feedback") return `<p>${text(block.question)}</p>`;
    if (block.type === "social") return `<p>${[block.website, block.instagram, block.linkedin].filter(Boolean).map(url => `<a href="${escape(url)}">${escape(new URL(url).hostname)}</a>`).join(" · ")}</p>`;
    if (block.type === "spacer") return `<div style="height:${block.size === "large" ? 32 : block.size === "small" ? 12 : 20}px" aria-hidden="true"></div>`;
    return "<hr>";
  }).join("");
  const footer = context.test ? `<p>${draft.language === "de" ? "Testnachricht an das angemeldete Benutzerkonto. Der Abmeldelink wird beim Empfängerversand eingesetzt." : draft.language === "es" ? "Mensaje de prueba para la cuenta del usuario. El enlace para cancelar se incluye en el envío a destinatarios." : "Test message to the signed-in user account. The unsubscribe link is inserted for recipient mailings."}</p>` : `<p><a href="${escape(context.unsubscribeUrl)}">${draft.language === "de" ? "Newsletter abmelden" : draft.language === "es" ? "Cancelar suscripción" : "Unsubscribe"}</a></p>`;
  return `<!doctype html><html lang="${draft.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(draft.subject)}</title></head><body style="margin:0;background:#f5f5f4;color:#0f172a;font-family:Arial,sans-serif;font-size:16px;line-height:1.5"><main style="max-width:620px;margin:auto;background:#fff;padding:24px"><p style="color:#57534e">${text(draft.previewText)}</p>${blocks}<footer style="margin-top:32px;border-top:1px solid #ddd;padding-top:16px;font-size:13px"><p>${text(draft.fromName)}<br>${text(draft.legalAddress)}</p>${footer}</footer></main></body></html>`;
}
