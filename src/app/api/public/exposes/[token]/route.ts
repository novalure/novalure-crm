import { queryOne } from "@/lib/db/client";
import { validWebExposeToken, webExposeHash, webExposeToken } from "@/lib/db/web-expose-repository";
import { parseWebExposeEvents, parseWebExposeInquiry } from "@/lib/web-expose";
import { readBoundedJsonObject } from "@/lib/external-api-response";
import { createPublicSubmissionOpaqueHash, getTrustedPublicSubmissionClientIp } from "@/lib/security/public-submission-abuse";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { isWebExposeOriginAllowed } from "@/lib/web-expose-http";

const responseHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: responseHeaders });
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    if (!validWebExposeToken(token)) return reply({ error: "unavailable" }, 404);
    if (!isWebExposeOriginAllowed(request,getTrustedAppOrigin())) return reply({ error: "origin_denied" }, 403);
    const b = await readBoundedJsonObject(request, 32768);
    const hash = webExposeHash(token);
    if (b.action === "start") {
      if (b.consent !== true) return reply({ error: "consent_required" }, 400);
      if (/(?:^|;\s*)novalure_session=/.test(request.headers.get("cookie") ?? "") || /bot|crawler|spider|facebookexternalhit|preview|scanner/i.test(request.headers.get("user-agent") ?? "") || request.headers.get("dnt") === "1") return reply({ excluded: true });
      if (!validWebExposeToken(b.visitorToken)) return reply({ error: "invalid_visitor" }, 400);
      const sessionToken = webExposeToken();
      const r = await queryOne<{ accepted: boolean }>(`select crm_web_expose_start($1,$2,$3) as accepted`, [hash, webExposeHash(sessionToken), webExposeHash(hash + ":" + b.visitorToken)]);
      return r?.accepted ? reply({ sessionToken }) : reply({ error: "unavailable" }, 404);
    }
    if (b.action === "events" || b.action === "withdraw") {
      if (!validWebExposeToken(b.sessionToken)) return reply({ error: "invalid_session" }, 400);
      if (b.action === "withdraw") {
        await queryOne(`select crm_web_expose_withdraw($1,$2)`, [hash, webExposeHash(b.sessionToken)]);
        return reply({ withdrawn: true });
      }
      const events = parseWebExposeEvents(b.events);
      const r = await queryOne<{ accepted: number }>(`select crm_web_expose_events($1,$2,$3::jsonb) as accepted`, [hash, webExposeHash(b.sessionToken), JSON.stringify(events)]);
      return reply({ accepted: r?.accepted ?? 0 });
    }
    if (b.action === "inquiry") {
      const key = request.headers.get("idempotency-key") ?? "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return reply({ error: "idempotency_required" }, 400);
      if (b.website) return reply({ error: "invalid_inquiry" }, 400);
      const input = parseWebExposeInquiry(b.inquiry);
      const ip = getTrustedPublicSubmissionClientIp(request.headers);
      if (!ip) return reply({ error: "temporarily_unavailable" }, 503);
      const networkHash = createPublicSubmissionOpaqueHash({ label: "expose-inquiry-network", value: ip });
      const emailHash = createPublicSubmissionOpaqueHash({ label: "expose-inquiry-email", value: input.email });
      const r = await queryOne<{ data: { accepted?: boolean; reference?: string; error?: string } }>(`select crm_web_expose_inquire($1,$2,$3,$4,$5,$6::jsonb) as data`, [hash, key, webExposeHash(JSON.stringify(input)), networkHash, emailHash, JSON.stringify(input)]);
      if (r?.data?.accepted === true) return reply(r.data, 202);
      return reply({ error: r?.data?.error || "temporarily_unavailable" }, r?.data?.error === "rate_limited" ? 429 : r?.data?.error === "conflict" ? 409 : 422);
    }
    return reply({ error: "invalid_action" }, 400);
  } catch (error) {
    const known = error instanceof Error && /^invalid_(event|events|inquiry)/.test(error.message);
    return reply({ error: known ? error.message : "temporarily_unavailable" }, known ? 400 : 503);
  }
}
