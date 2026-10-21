import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { getWorkspaceEnabledModules } from "@/lib/product-model";
import { BookingError, type BookingKind, type BookingProviderName } from "@/lib/booking/types";

export function bookingJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

export async function bookingAuth(request: Request, write = false) {
  const auth = await requirePermissionAndProductCapability(request, write ? "crm:write" : "crm:read", "calendar:manage");
  if (!auth.ok) return auth;
  const modules = getWorkspaceEnabledModules({ setupState: auth.session.workspaceSetupState, workspaceId: auth.session.workspaceId, workspaceName: auth.session.workspaceName });
  if (!modules.calendar) return { ok: false as const, response: bookingJson({ error: "booking_module_disabled" }, 403) };
  return auth;
}

export async function bookingBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new BookingError("invalid_json", 415);
  const limit = 16_384;
  if (Number(request.headers.get("content-length")) > limit) throw new BookingError("body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BookingError("invalid_json");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new BookingError("body_too_large", 413); }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BookingError("invalid_json");
    return body as Record<string, unknown>;
  } catch (error) { if (error instanceof BookingError) throw error; throw new BookingError("invalid_json"); }
}

export function bookingString(body: Record<string, unknown>, key: string, maxLength = 256) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new BookingError(`invalid_${key}`);
  if (key === "idempotencyKey") bookingUuid(value);
  return value.trim();
}
export function bookingUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new BookingError("invalid_booking_reference");
  return value;
}
export function bookingKind(body: Record<string, unknown>): BookingKind {
  const value = bookingString(body, "kind");
  if (!["phone", "teams", "meet", "office", "onsite"].includes(value)) throw new BookingError("invalid_kind");
  return value as BookingKind;
}
export function bookingProvider(body: Record<string, unknown>): BookingProviderName {
  const value = bookingString(body, "provider");
  if (value !== "microsoft" && value !== "google") throw new BookingError("invalid_provider");
  return value;
}
export function bookingFailure(error: unknown) {
  if (error instanceof BookingError) return bookingJson({ error: error.code }, error.status);
  return bookingJson({ error: "booking_unavailable" }, 503);
}
