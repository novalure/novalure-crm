import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { listWebsiteForms, upsertWebsiteForm } from "@/lib/db/form-repositories";
import type { WebsiteForm } from "@/lib/form-types";
import {
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionJson,
} from "@/lib/security/public-submission-abuse";

const formEditorBodyLimits = Object.freeze({ maxBodyBytes: 256 * 1024 });

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const payload = await listWebsiteForms({ session: auth.session });
  if (payload.source !== "database" || payload.error) {
    return NextResponse.json(
      { error: "Forms persistence unavailable", forms: [], source: "unavailable", submissions: [] },
      { status: 503 },
    );
  }
  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  let body: { expectedVersion?: number; form?: WebsiteForm };
  try {
    const parsed = await readBoundedPublicSubmissionJson(request, formEditorBodyLimits);
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    body = parsed.value as { expectedVersion?: number; form?: WebsiteForm };
  } catch (error) {
    const status = error instanceof PublicSubmissionRequestError ? error.status : 400;
    return NextResponse.json(
      { code: error instanceof PublicSubmissionRequestError ? error.code : "invalid_json", error: "Invalid JSON" },
      { status },
    );
  }

  if (!body.form) {
    return NextResponse.json({ error: "Missing form" }, { status: 400 });
  }

  const operationId = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    return NextResponse.json({ code: "FORM_IDEMPOTENCY_KEY_INVALID", error: "A valid idempotency key is required" }, { status: 400 });
  }

  const expectedVersion = Number(body.expectedVersion ?? 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return NextResponse.json({ code: "FORM_VERSION_INVALID", error: "A valid form version is required" }, { status: 400 });
  }

  let result;
  try {
    result = await upsertWebsiteForm({
      expectedVersion,
      form: body.form,
      operationId,
      session: auth.session,
    });
  } catch {
    return NextResponse.json(
      { code: "FORM_PERSISTENCE_UNAVAILABLE", error: "Forms persistence is temporarily unavailable" },
      { status: 503 },
    );
  }

  if (!result.persisted) {
    const status = result.code === "FORM_OWNER_INVALID" ||
      result.code === "FORM_OWNER_MODE_UNAVAILABLE" ||
      result.code === "FORM_CONSENT_CONFIGURATION_UNAVAILABLE" ||
      result.code === "FORM_CUSTOM_PATTERN_UNAVAILABLE" ||
      result.code === "FORM_FILE_UPLOAD_UNAVAILABLE"
      ? 400
      : result.code === "FORM_SAVE_CONFLICT"
        ? 409
        : 503;
    return NextResponse.json(
      { code: result.code ?? "FORM_PERSISTENCE_UNAVAILABLE", error: result.reason ?? "Form could not be saved" },
      { status },
    );
  }

  return NextResponse.json({ form: result.form, persisted: true });
}
