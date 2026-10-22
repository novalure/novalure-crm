import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { readKnowledgeBytes } from "@/lib/knowledge-center/http";
import { websiteSalesActorId, websiteSalesWorkspaceId } from "@/lib/website-sales-ingestion";
import { bookingChannelError, bookingChannelJson, dispatchTrustedBookingTool } from "./channel-http";
import { getPublicBookingPublication } from "./publication";
import type { BookingChannelOptions } from "./channels";
import type { BookingChannelAuthority } from "./channel-bindings";
import { BookingError } from "./types";

const version = "booking-tools-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Options = BookingChannelOptions & { env?: NodeJS.ProcessEnv };

export function verifyStudioChannelSignature(raw: string, headers: Headers, secret: string | undefined, now = Date.now()) {
  const timestamp = headers.get("x-novalure-timestamp") ?? "";
  const signature = headers.get("x-novalure-signature") ?? "";
  if (!secret || Buffer.byteLength(secret) < 32 || headers.get("x-novalure-booking-version") !== version ||
      !/^\d{10,11}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${version}.${timestamp}.${raw}`).digest();
  const supplied = Buffer.from(signature, "base64url");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function verifyStudioChannelEnquiry(proof: unknown, options: BookingChannelOptions = {}) {
  const input = proof && typeof proof === "object" && !Array.isArray(proof) ? proof as Record<string, unknown> : {};
  if (Object.keys(input).length !== 4 || !uuid.test(String(input.operationId ?? "")) || !Number.isSafeInteger(input.revision) ||
      !/^[a-f0-9]{64}$/.test(String(input.payloadHash ?? "")) || !/^NL-[A-F0-9]{8}$/.test(String(input.crmReference ?? ""))) throw new BookingError("BOOKING_ENQUIRY_DENIED", 403);
  return withTenantTransaction({ actorId: websiteSalesActorId, workspaceId: websiteSalesWorkspaceId }, async tx => {
    const actor = await tx.queryOne<{ active: boolean }>("select status='active' as active from workspace_users where id=$1::uuid and workspace_id=$2::uuid", [websiteSalesActorId, websiteSalesWorkspaceId]);
    if (!actor?.active) throw new BookingError("BOOKING_ENQUIRY_DENIED", 403);
    const row = await tx.queryOne<{ leadId: string; contactId: string | null }>(
      `select transfer.lead_id as "leadId",lead.contact_id as "contactId"
       from public.studio_enquiry_transfers transfer
       join public.leads lead on lead.id=transfer.lead_id and lead.workspace_id=transfer.workspace_id
       where transfer.workspace_id=$1::uuid and transfer.operation_id=$2::uuid and transfer.revision=$3
         and transfer.payload_hash=$4 and transfer.reference=$5 and transfer.state='accepted'`,
      [websiteSalesWorkspaceId, input.operationId, input.revision, input.payloadHash, input.crmReference]);
    if (!row) throw new BookingError("BOOKING_ENQUIRY_DENIED", 403);
    return { source: "studio_handoff" as const, sourceId: input.operationId as string,
      leadId: row.leadId, ...(row.contactId ? { contactId: row.contactId } : {}) };
  }, options);
}

/** Server-signed Studio visitor gateway; the browser never supplies a tenant or CRM relationship. */
export async function handleStudioBookingChannelRequest(request: Request, options: Options = {}) {
  try {
    if (request.method !== "POST" || !request.headers.get("content-type")?.includes("application/json")) throw new BookingError("INVALID_BOOKING_REQUEST", 400);
    const raw = Buffer.from(await readKnowledgeBytes(request, 16_384)).toString("utf8");
    const env = options.env ?? process.env;
    if (!verifyStudioChannelSignature(raw, request.headers, env.STUDIO_ENQUIRY_SIGNING_SECRET, options.now?.() ?? Date.now())) throw new BookingError("BOOKING_CHANNEL_UNAUTHORIZED", 401);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["version", "enquiry", "operation", "payload", "clientIp"].includes(key)) ||
        body.version !== version || typeof body.clientIp !== "string" || !isIP(body.clientIp) || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) throw new BookingError("INVALID_BOOKING_REQUEST");
    const publicId = env.STUDIO_BOOKING_PUBLIC_ID;
    if (!publicId || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(publicId)) throw new BookingError("BOOKING_CHANNEL_NOT_CONFIGURED", 503);
    const relation = await verifyStudioChannelEnquiry(body.enquiry, options);
    const publication = await getPublicBookingPublication(publicId, "chat", options);
    if (!publication) throw new BookingError("BOOKING_CHANNEL_NOT_CONFIGURED", 503);
    const authority: BookingChannelAuthority = { publicId, workspaceId: websiteSalesWorkspaceId, bindingId: relation.sourceId,
      typeIds: publication.types.map(type => type.id), relation };
    if (body.operation === "publication") {
      if (Object.keys(body.payload as object).length) throw new BookingError("INVALID_BOOKING_REQUEST");
      return bookingChannelJson({ publication });
    }
    const forwarded = new Headers(request.headers);
    forwarded.set("x-vercel-forwarded-for", body.clientIp);
    const scopedRequest = new Request(request.url, { method: "POST", headers: forwarded });
    return bookingChannelJson(await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
      { ...(body.payload as Record<string, unknown>), operation: body.operation }, options));
  } catch (error) { return bookingChannelError(error); }
}
