import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  getPropertyExportArtifact,
  PropertyExportRuntimeError,
} from "@/lib/db/property-export-repositories";
import { canAccessPropertyExports } from "@/lib/property-export/access";

type RouteContext = { params: Promise<{ jobId: string }> };
const noStoreHeaders = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  if (!canAccessPropertyExports(auth.session)) {
    return NextResponse.json(
      { code: "forbidden", error: "Property export requires publish and administration rights." },
      { headers: noStoreHeaders, status: 403 },
    );
  }
  const { jobId } = await context.params;

  try {
    const artifact = await getPropertyExportArtifact({ jobId, session: auth.session });
    if (!artifact) {
      return NextResponse.json(
        { code: "artifact_not_ready", error: "Preview QA export artifact is not available." },
        { headers: noStoreHeaders, status: 409 },
      );
    }
    const filename = artifact.filename.replace(/[\r\n"\\]/g, "-");
    return new Response(artifact.content, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Security-Policy": "sandbox",
        "Content-Type": artifact.contentType,
        "X-Content-Type-Options": "nosniff",
        "X-Novalure-Artifact-Sha256": artifact.sha256,
        "X-Novalure-Export-Mode": "preview-qa-only",
      },
    });
  } catch (error) {
    if (error instanceof PropertyExportRuntimeError) {
      const status = error.code === "database_unavailable"
        ? 503
        : error.code === "forbidden"
          ? 403
          : error.code === "not_found"
            ? 404
            : 400;
      return NextResponse.json(
        { code: error.code, error: error.message },
        { headers: noStoreHeaders, status },
      );
    }
    throw error;
  }
}
