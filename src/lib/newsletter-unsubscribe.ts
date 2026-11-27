import { createHash } from "node:crypto";
import { queryOne } from "@/lib/db/client";
type PublicQuery = (sql: string, params: unknown[]) => Promise<{ result: unknown } | null>;
const defaultQuery: PublicQuery = (sql, params) => queryOne<{ result: unknown }>(sql, params);
function tokenHash(value: string) { return /^[a-zA-Z0-9_-]{43}$/.test(value) ? createHash("sha256").update(value).digest("hex") : null; }
export async function checkNewsletterUnsubscribe(token: string, query: PublicQuery = defaultQuery) {
  const hash = tokenHash(token); if (!hash) return null;
  const row = await query("select public.crm_newsletter_public_check($1) as result", [hash]);
  const result = row?.result as { valid?: unknown; unsubscribed?: unknown; language?: unknown } | null;
  return result?.valid === true && typeof result.unsubscribed === "boolean" && ["de", "en", "es"].includes(String(result.language)) ? { valid: true, unsubscribed: result.unsubscribed, language: String(result.language) } : null;
}
export async function applyNewsletterUnsubscribe(token: string, query: PublicQuery = defaultQuery) {
  const hash = tokenHash(token); if (!hash) return false;
  const row = await query("select public.crm_newsletter_public_unsubscribe($1) as result", [hash]); return row?.result === true;
}
