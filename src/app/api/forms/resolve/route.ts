import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getPublicWebsiteFormByKey } from "@/lib/db/form-repositories";

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const formKey = new URL(request.url).searchParams.get("form")?.trim() ?? "";
  if (!formKey) {
    return NextResponse.json({ error: "Missing form key", resolved: false }, { status: 400 });
  }

  try {
    const persisted = await getPublicWebsiteFormByKey(formKey);
    if (
      !persisted?.form ||
      persisted.workspaceId !== auth.session.workspaceId ||
      !persisted.publicPath
    ) {
      return NextResponse.json({ resolved: false }, { status: 404 });
    }

    return NextResponse.json({
      formId: persisted.form.id,
      publicPath: persisted.publicPath,
      resolved: true,
      source: "database",
    });
  } catch {
    return NextResponse.json(
      { error: "Public form resolver unavailable", resolved: false },
      { status: 503 },
    );
  }
}
