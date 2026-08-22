import { recordNewsletterUnsubscribe } from "@/lib/db/runtime-repositories";
import { parseNewsletterUnsubscribeToken } from "@/lib/newsletter-unsubscribe-token";
import { validateCsrfRequestContext } from "@/lib/security/csrf-core";

export const runtime = "nodejs";

const responseHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function resultResponse(status: number, result: "invalid_or_expired" | "unavailable" | "unsubscribed") {
  return Response.json({ ok: result === "unsubscribed", status: result }, { headers: responseHeaders, status });
}

export async function POST(request: Request) {
  const requestContext = validateCsrfRequestContext(request.headers, new URL(request.url).origin);
  if (!requestContext.ok) return resultResponse(403, "invalid_or_expired");

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (mediaType !== "application/json" || contentLength > 4_096) {
    return resultResponse(415, "invalid_or_expired");
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > 4_096) return resultResponse(413, "invalid_or_expired");
    body = JSON.parse(rawBody);
  } catch {
    return resultResponse(400, "invalid_or_expired");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return resultResponse(400, "invalid_or_expired");
  const input = body as Record<string, unknown>;
  if (input.action !== "unsubscribe" || typeof input.token !== "string") {
    return resultResponse(400, "invalid_or_expired");
  }

  let verified: ReturnType<typeof parseNewsletterUnsubscribeToken>;
  try {
    verified = parseNewsletterUnsubscribeToken(input.token);
  } catch {
    return resultResponse(503, "unavailable");
  }
  if (!verified) return resultResponse(400, "invalid_or_expired");

  try {
    const persisted = await recordNewsletterUnsubscribe({
      campaignId: verified.campaignId,
      email: verified.email,
      tokenId: verified.tokenId,
      workspaceId: verified.workspaceId,
    });
    return persisted.persisted ? resultResponse(200, "unsubscribed") : resultResponse(503, "unavailable");
  } catch {
    return resultResponse(503, "unavailable");
  }
}
