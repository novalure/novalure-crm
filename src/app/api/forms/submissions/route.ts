import { NextResponse } from "next/server";
import { persistWebsiteFormSubmission } from "@/lib/db/form-repositories";
import { sanitizeLocalRedirect } from "@/lib/auth/redirects";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const returnTo = getString(formData, "return_to");
  const formSlug = getString(formData, "form_slug") || getString(formData, "form_id") || getString(formData, "form") || "formular";
  const source = getString(formData, "utm_source") || "website";
  const persistence = await persistWebsiteFormSubmission({
    formData,
    formKey: formSlug,
    requestUrl: request.url,
  });
  if (request.headers.get("accept")?.includes("application/json")) {
    return NextResponse.json(
      persistence.persisted
        ? { persisted: true, form: persistence.form }
        : { error: persistence.reason, persisted: false },
      { status: persistence.persisted ? 200 : getFailureStatus(persistence.reason) },
    );
  }

  const configuredRedirect = persistence.persisted ? persistence.redirectUrl : "";
  const fallback = `/forms/${encodeURIComponent(formSlug)}`;
  const safeReturnTo = sanitizeLocalRedirect(configuredRedirect || returnTo, fallback);
  const redirectUrl = new URL(safeReturnTo, request.url);

  redirectUrl.searchParams.set("submitted", persistence.persisted ? "1" : "0");
  redirectUrl.searchParams.set("utm_source", source);
  redirectUrl.searchParams.set("crm_status", persistence.persisted ? "saved" : "failed");
  if (!persistence.persisted) {
    redirectUrl.searchParams.set("crm_reason", persistence.reason);
  }

  return NextResponse.redirect(redirectUrl, { status: 303 });
}

function getFailureStatus(reason: string) {
  if (reason === "Form not found") return 404;
  if (reason === "privacy_consent_required" || reason.startsWith("required_field_missing") || reason === "invalid_email") {
    return 422;
  }

  return 400;
}
