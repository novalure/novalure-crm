import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { executeCrmCommand, reconcileCrmCommand, type CrmCommandInput, type TenantTransaction } from "@/lib/crm-command";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { readKnowledgeBytes } from "@/lib/knowledge-center/http";
import { websiteSalesActorId, websiteSalesWorkspaceId } from "@/lib/website-sales-ingestion";
import { bookingChannelError, bookingChannelJson, dispatchTrustedBookingTool } from "./channel-http";
import { lookupBookingPublication, prepareBookingPublication, serverBookingSession } from "./publication";
import { trustedStudioBookingKind } from "./channels";
import type { BookingChannelOptions, BookingChannelRelation, StudioHoldOperation } from "./channels";
import type { BookingChannelAuthority } from "./channel-bindings";
import type { PublicBookingPublication } from "./publication-types";
import { BookingError } from "./types";

const version = "booking-tools-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Options = BookingChannelOptions & { env?: NodeJS.ProcessEnv };
const studioHoldFields = ["token", "startsAt", "recipientEmail", "recipientName", "location", "locationConfirmed", "idempotencyKey", "recipientPhone"];
const studioKinds = ["teams", "phone"] as const;

/** Studio creates only Teams/phone appointments; existing grants keep their management path. */
export function studioPublicationForOperation(publication: PublicBookingPublication, operation: unknown): PublicBookingPublication {
  if (operation === "status" || operation === "cancel") return publication;
  return { ...publication, types: publication.types.filter(type => type.kind === "teams" || type.kind === "phone")
    .sort((left, right) => Number(left.kind !== "teams") - Number(right.kind !== "teams")) };
}

export function validateStudioCallbackPhone(value: unknown): string {
  if (typeof value !== "string") throw new BookingError("BOOKING_CALLBACK_PHONE_REQUIRED", 400);
  const phone = value.trim();
  if (phone.length > 100 || !/^\+?[0-9() .\/-]+$/.test(phone) || (phone.match(/\d/g) ?? []).length < 6)
    throw new BookingError("BOOKING_CALLBACK_PHONE_REQUIRED", 400);
  return phone;
}
export function assertStudioCallbackPhoneMatches(current: string, expected: unknown) {
  if (current !== validateStudioCallbackPhone(expected)) throw new BookingError("BOOKING_CALLBACK_PHONE_CHANGED", 409);
}

export function prepareStudioHoldPayload(kind: "phone" | "teams" | "meet" | "office" | "onsite", payload: Record<string, unknown>) {
  if (Object.keys(payload).some(key => !studioHoldFields.includes(key)) || typeof payload.token !== "string")
    throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
  if (kind !== "phone" && payload.recipientPhone !== undefined)
    throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
  const callbackPhone = kind === "phone" && payload.recipientPhone !== undefined
    ? validateStudioCallbackPhone(payload.recipientPhone) : undefined;
  const channelPayload = { ...payload };
  delete channelPayload.recipientPhone;
  return { callbackPhone, channelPayload };
}

export async function assertStudioEnglishMutation(operation: unknown, payload: Record<string, unknown>,
  relation: BookingChannelRelation, binding: BookingChannelOptions) {
  if (operation !== "reschedule" && operation !== "cancel") return;
  if (typeof payload.token !== "string") throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
  await trustedStudioBookingKind(payload.token, relation, binding);
}

/** The accepted enquiry, lead and canonical contact are looked up again inside the fixed tenant. */
async function studioCallbackContact(tx: TenantTransaction, proof: Record<string, unknown>, contactId: string | undefined, lock = false) {
  if (!contactId) throw new BookingError("BOOKING_CALLBACK_CONTACT_REQUIRED", 409);
  const contact = await tx.queryOne<{ id: string; phone: string | null; version: string }>(
      `select contact.id,contact.phone,contact.version::text as version from public.studio_enquiry_transfers transfer
       join public.leads lead on lead.id=transfer.lead_id and lead.workspace_id=transfer.workspace_id
       join public.contacts contact on contact.id=lead.contact_id and contact.workspace_id=lead.workspace_id
       where transfer.workspace_id=$1::uuid and transfer.operation_id=$2::uuid and transfer.revision=$3
         and transfer.payload_hash=$4 and transfer.reference=$5 and transfer.state='accepted'
         and contact.id=$6::uuid and contact.archived_at is null
       ${lock ? "for share of transfer, lead for update of contact" : ""}`,
      [websiteSalesWorkspaceId, proof.operationId, proof.revision, proof.payloadHash, proof.crmReference, contactId]);
  if (!contact) throw new BookingError("BOOKING_CALLBACK_CONTACT_REQUIRED", 409);
  return contact;
}

function readStudioCallbackContact(proof: Record<string, unknown>, contactId: string | undefined, options: BookingChannelOptions) {
  return withTenantTransaction({ actorId: websiteSalesActorId, workspaceId: websiteSalesWorkspaceId },
    tx => studioCallbackContact(tx, proof, contactId), options);
}

export async function readStudioCallbackPhone(proof: Record<string, unknown>, contactId: string | undefined,
  supplied: unknown, options: BookingChannelOptions = {}) {
  const contact = await readStudioCallbackContact(proof, contactId, options);
  return validateStudioCallbackPhone(supplied === undefined ? contact.phone : supplied);
}

/** Contact version and effect receipts use existing CRM commands under the accepted enquiry's actor. */
function studioCallbackPhoneChange(proof: Record<string, unknown>, contactId: string, initialVersion: string, phone: string, options: BookingChannelOptions) {
  const actor = serverBookingSession(websiteSalesWorkspaceId, websiteSalesActorId);
  const command = (operation: StudioHoldOperation, apply = false): CrmCommandInput => ({
    operation: apply ? "booking.studio_callback.apply" : "booking.studio_callback.prepare",
    idempotencyKey: apply ? operation.coreKey : operation.id,
    correlationId: operation.id,
    resourceId: contactId,
    capability: "pipeline:write",
    payload: { proof, holdRequestHash: operation.requestHash },
  });
  return {
    async prepare(operation: StudioHoldOperation) {
      await executeCrmCommand(actor, command(operation), async (tx) => {
        const contact = await studioCallbackContact(tx, proof, contactId, true);
        if (contact.version !== initialVersion) throw new BookingError("BOOKING_CALLBACK_PHONE_CHANGED", 409);
        return { version: contact.version };
      }, options);
    },
    async commit(operation: StudioHoldOperation) {
      await executeCrmCommand(actor, command(operation, true), async (tx) => {
        const prepared = await reconcileCrmCommand<{ version: string }>(actor, command(operation), options);
        if (prepared.status !== "COMMITTED") throw new BookingError("BOOKING_CALLBACK_PREPARATION_REQUIRED", 409);
        const contact = await studioCallbackContact(tx, proof, contactId, true);
        if (contact.version !== prepared.data.version) throw new BookingError("BOOKING_CALLBACK_PHONE_CHANGED", 409);
        if (contact.phone !== phone) {
          const updated = await tx.queryOne(`update public.contacts set phone=$3,updated_at=now()
            where workspace_id=$1::uuid and id=$2::uuid and version=$4::bigint returning id`,
            [websiteSalesWorkspaceId, contact.id, phone, prepared.data.version]);
          if (!updated) throw new BookingError("BOOKING_CALLBACK_CONTACT_REQUIRED", 409);
        }
        return { id: contact.id };
      }, options);
    },
  };
}

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
    const stored = await lookupBookingPublication(publicId, options);
    if (stored.workspaceId !== websiteSalesWorkspaceId || !stored.config.enabled || !stored.config.channels.chat || stored.config.language !== "en") throw new BookingError("BOOKING_CHANNEL_NOT_CONFIGURED", 503);
    const manageLegacy = body.operation === "status" || body.operation === "cancel";
    const authority: BookingChannelAuthority = { publicId, workspaceId: websiteSalesWorkspaceId, bindingId: relation.sourceId,
      typeIds: stored.config.assignments.filter(type => manageLegacy || studioKinds.some(kind => kind === type.kind)).map(type => type.id), relation };
    if (body.operation === "publication") {
      if (Object.keys(body.payload as object).length) throw new BookingError("INVALID_BOOKING_REQUEST");
      const prepared = await prepareBookingPublication(stored, "chat", options, studioKinds);
      return bookingChannelJson({ publication: studioPublicationForOperation(prepared.publication, "publication") });
    }
    const forwarded = new Headers(request.headers);
    forwarded.set("x-vercel-forwarded-for", body.clientIp);
    const scopedRequest = new Request(request.url, { method: "POST", headers: forwarded });
    const binding: BookingChannelOptions = { ...options, trustedBinding: {
      expectedChannel: "chat", expectedWorkspaceId: websiteSalesWorkspaceId, expectedPublicId: publicId,
      expectedBindingId: relation.sourceId, expectedTypeIds: authority.typeIds } };
    if (body.operation === "session") {
      const payload = { ...(body.payload as Record<string, unknown>) }, initialDate = payload.initialDate, findNext = payload.findNext;
      if (initialDate !== undefined && (typeof initialDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(initialDate) || !Number.isFinite(Date.parse(`${initialDate}T12:00:00Z`)) || new Date(`${initialDate}T12:00:00Z`).toISOString().slice(0, 10) !== initialDate) || findNext !== undefined && (typeof findNext !== "boolean" || initialDate === undefined)) throw new BookingError("INVALID_DATE");
      delete payload.initialDate; delete payload.findNext;
      const prepared = await prepareBookingPublication(stored, "chat", options, studioKinds);
      prepared.publication = studioPublicationForOperation(prepared.publication, "session");
      const session = await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
        { ...payload, operation: "session", language: "en" }, { ...options, preparedPublication: prepared });
      if (!("publication" in session) || !("token" in session)) throw new BookingError("BOOKING_CHANNEL_UNAVAILABLE", 503);
      if (initialDate === undefined) return bookingChannelJson(session);
      try {
        const availability = await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
          { operation: "availability", token: session.token, date: initialDate }, { ...options, findNextAvailability: findNext === true });
        return bookingChannelJson({ ...session, initialAvailability: { ...availability, typeId: payload.typeId } });
      } catch (error) {
        const failure = bookingChannelError(error);
        if (failure.status < 500) throw error;
        return bookingChannelJson({ ...session, initialAvailabilityError: { date: initialDate, typeId: payload.typeId, code: (await failure.json()).code } });
      }
    }
    if (body.operation === "availability") {
      const payload = { ...(body.payload as Record<string, unknown>) }, findNext = payload.findNext;
      if (findNext !== undefined && typeof findNext !== "boolean") throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
      delete payload.findNext;
      return bookingChannelJson(await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
        { ...payload, operation: "availability" }, { ...options, findNextAvailability: findNext === true }));
    }
    if (body.operation === "confirm") {
      const payload = body.payload as Record<string, unknown>;
      if (typeof payload.token !== "string") throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
      const kind = await trustedStudioBookingKind(payload.token, relation, binding);
      let confirmAuthorize: (() => Promise<void>) | undefined;
      if (kind === "phone") {
        const expectedPhone = validateStudioCallbackPhone(payload.recipientPhone);
        confirmAuthorize = async () => {
          const currentPhone = await readStudioCallbackPhone(body.enquiry as Record<string, unknown>, relation.contactId, undefined, options);
          assertStudioCallbackPhoneMatches(currentPhone, expectedPhone);
        };
        await confirmAuthorize();
      } else if (payload.recipientPhone !== undefined) throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
      const channelPayload = { ...payload };
      delete channelPayload.recipientPhone;
      return bookingChannelJson(await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
        { ...channelPayload, operation: body.operation }, { ...options, studioConfirmAuthorize: confirmAuthorize }));
    }
    if (body.operation === "hold") {
      const payload = body.payload as Record<string, unknown>;
      if (typeof payload.token !== "string") throw new BookingError("INVALID_BOOKING_CHANNEL_OPERATION");
      const kind = await trustedStudioBookingKind(payload.token, relation, binding);
      const { callbackPhone, channelPayload } = prepareStudioHoldPayload(kind, payload);
      const proof = body.enquiry as Record<string, unknown>;
      const contact = kind === "phone" ? await readStudioCallbackContact(proof, relation.contactId, options) : undefined;
      const checkedPhone = contact ? validateStudioCallbackPhone(callbackPhone ?? contact.phone) : undefined;
      const phoneChange = contact && callbackPhone ? studioCallbackPhoneChange(proof, contact.id, contact.version, callbackPhone, options) : undefined;
      return bookingChannelJson(await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
        { ...channelPayload, operation: body.operation }, { ...options, studioHoldPhone: checkedPhone, studioHoldPhoneChange: phoneChange }));
    }
    await assertStudioEnglishMutation(body.operation, body.payload as Record<string, unknown>, relation, binding);
    return bookingChannelJson(await dispatchTrustedBookingTool(scopedRequest, "chat", authority,
      { ...(body.payload as Record<string, unknown>), operation: body.operation }, options));
  } catch (error) { return bookingChannelError(error); }
}
