import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { listWebsiteForms, upsertWebsiteForm } from "@/lib/db/form-repositories";
import type { WebsiteForm } from "@/lib/form-types";

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const payload = await listWebsiteForms({ session: auth.session });
  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  let body: { form?: WebsiteForm };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.form) {
    return NextResponse.json({ error: "Missing form" }, { status: 400 });
  }

  const result = await upsertWebsiteForm({ form: body.form, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason ?? "Form could not be saved" }, { status: 503 });
  }

  return NextResponse.json({ form: result.form, persisted: true });
}
