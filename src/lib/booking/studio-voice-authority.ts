import "server-only";
import { CRM_MACHINE_AUDIENCE, getCrmMachineBearer } from "@/lib/crm-machine-auth";
import { queryAuthenticationRows } from "@/lib/db/tenant-client";
import { STUDIO_VOICE_AUDIENCE, STUDIO_VOICE_WORKSPACE_ID, verifyStudioVoiceMachineToken,
  type StudioVoiceMachineAuthOptions } from "@/lib/studio-voice-machine-auth";
import type { BookingChannelAuthority } from "./channel-bindings";
import { bookingChannelError, bookingChannelJson, dispatchTrustedBookingTool, handleMachineBookingRequest, readBookingChannelToolBody } from "./channel-http";
import type { BookingChannelOptions } from "./channels";
import { publicationUuid } from "./publication";
import { BookingError } from "./types";

export type StudioVoiceBookingOptions = BookingChannelOptions & { machineAuth?: StudioVoiceMachineAuthOptions };
type Binding = { principal_id: string; grant_id: string; workspace_id: string; public_id: string; type_id: string };
const deny = (): never => { throw new BookingError("STUDIO_VOICE_BOOKING_DENIED", 403); };

/** Only the independently saved server binding selects tenant, publication, type, calendar and organizer. */
export async function verifyStudioVoiceBookingAuthority(request: Request, options: StudioVoiceBookingOptions = {}): Promise<BookingChannelAuthority> {
  if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin") || new URL(request.url).search) return deny();
  const bearer = getCrmMachineBearer(request.headers);
  if (!bearer) return deny();
  const c = await verifyStudioVoiceMachineToken(bearer, options.machineAuth);
  const rows = await queryAuthenticationRows<Binding>(
    "select * from public.studio_voice_authenticate($1,$2,$3,$4,$5,$6)",
    [c.subject, c.issuer, c.audience, c.projectId, c.ownerId, c.environment], options);
  const b = rows[0];
  if (rows.length !== 1 || !b || Object.keys(b).length !== 5 || b.workspace_id !== STUDIO_VOICE_WORKSPACE_ID ||
    !publicationUuid.test(b.principal_id) || !publicationUuid.test(b.grant_id) || !publicationUuid.test(b.type_id) ||
    typeof b.public_id !== "string" || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(b.public_id)) return deny();
  return { workspaceId: b.workspace_id, publicId: b.public_id, typeIds: [b.type_id], bindingId: b.principal_id,
    relation: { source: "studio_voice", sourceId: b.grant_id } };
}

export async function handleStudioVoiceBookingRequest(request: Request, options: StudioVoiceBookingOptions = {}): Promise<Response> {
  try {
    const authority = await verifyStudioVoiceBookingAuthority(request, options);
    const body = await readBookingChannelToolBody(request);
    if (!["session", "availability", "hold", "confirm", "status"].includes(String(body.operation))) return deny();
    return bookingChannelJson(await dispatchTrustedBookingTool(request, "voice", authority, body, options));
  } catch (error) { return bookingChannelError(error); }
}

/** Untrusted audience selects one complete verifier; an authentication failure never falls back. */
export async function handleVoiceBookingRequest(request: Request, options: StudioVoiceBookingOptions = {}): Promise<Response> {
  try {
    const bearer = getCrmMachineBearer(request.headers);
    if (!bearer || bearer.length > 16_384) return deny();
    const payload: unknown = JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return deny();
    const aud = (payload as { aud?: unknown }).aud;
    if (aud === STUDIO_VOICE_AUDIENCE) return await handleStudioVoiceBookingRequest(request, options);
    if (aud === CRM_MACHINE_AUDIENCE) return await handleMachineBookingRequest(request, "voice", options);
    return deny();
  } catch (error) { return bookingChannelError(error); }
}
