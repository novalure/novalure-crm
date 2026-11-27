import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  CrmCommandError,
  crmCommandErrorResponse,
  crmRequestMetadata,
} from "@/lib/crm-command";
import {
  mutateMarketing,
  readMarketingWorkspace,
} from "@/lib/db/marketing-repository";
import { NewsletterWorkspaceError } from "@/lib/newsletter-workspace";
export const maxDuration = 60;
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
function failure(error: unknown) {
  const response = crmCommandErrorResponse(
    error instanceof NewsletterWorkspaceError
      ? new CrmCommandError("INVALID_TEMPLATE", error.message)
      : error,
  );
  Object.entries(headers).forEach(([key, value]) =>
    response.headers.set(key, value),
  );
  return response;
}
export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, {
      permission: "crm:read",
    });
    if (!auth.ok) return auth.response;
    const query = new URL(request.url).searchParams;
    const days = Number(query.get("days") || 30);
    if (days !== 30 && days !== 90 && days !== 365) throw new CrmCommandError("INVALID_PERIOD", "Berichtszeitraum ist ungültig.");
    return Response.json(
      await readMarketingWorkspace(
        auth.session,
        query.get("projectId") || undefined,
        { days },
      ),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, {
      permission: "crm:write",
      capability: "workspace:operate",
    });
    if (!auth.ok) return auth.response;
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json") ||
      !request.body
    )
      throw new CrmCommandError("INVALID_REQUEST", "JSON ist erforderlich.");
    const reader = request.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 550000) {
          await reader.cancel();
          throw new CrmCommandError(
            "PAYLOAD_TOO_LARGE",
            "Marketinginhalt ist zu groß.",
            413,
          );
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error();
    } catch {
      throw new CrmCommandError(
        "INVALID_REQUEST",
        "Ungültige Marketinganfrage.",
      );
    }
    const metadata = crmRequestMetadata(request, body);
    delete body.idempotencyKey;
    delete body.correlationId;
    const result = await mutateMarketing(auth.session, body, metadata);
    return Response.json(
      { ...result.data, replayed: result.replayed },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
