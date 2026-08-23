import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  listWorkspaceMedia,
  maxMediaUploadBytes,
  MediaStoreError,
  publishWorkspaceMedia,
  revokeWorkspaceMediaPublication,
  saveWorkspaceFile,
  serializeMediaAsset,
} from "@/lib/media-store";
import { evaluateLaunchScope } from "@/lib/launch-scope";

const privateJsonHeaders = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const mutationScope = evaluateLaunchScope("mediaBlobMutation");
  if (new URL(request.url).searchParams.get("scopeOnly") === "true") {
    return NextResponse.json(
      { mutationsAllowed: mutationScope.allowed },
      { headers: privateJsonHeaders },
    );
  }

  const media = await listWorkspaceMedia(auth.session.workspaceId);
  return NextResponse.json(
    {
      assets: media.assets.map(serializeMediaAsset),
      mutationsAllowed: mutationScope.allowed,
      quota: media.quota,
    },
    { headers: privateJsonHeaders },
  );
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const launchScope = evaluateLaunchScope("mediaBlobMutation");
  if (!launchScope.allowed) {
    return NextResponse.json(
      { code: launchScope.code, error: "media_blob_mutation_launch_scope_blocked" },
      { headers: privateJsonHeaders, status: 503 },
    );
  }

  if (request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const assetId = typeof body?.assetId === "string" ? body.assetId : "";
    if ((body?.action !== "publish" && body?.action !== "revoke") || !assetId) {
      return NextResponse.json({ error: "Invalid media action." }, { headers: privateJsonHeaders, status: 400 });
    }

    try {
      const changedAsset = body.action === "publish"
        ? await publishWorkspaceMedia(assetId, auth.session.workspaceId)
        : await revokeWorkspaceMediaPublication(assetId, auth.session.workspaceId);
      if (!changedAsset) {
        return NextResponse.json({ error: "Media asset not found." }, { headers: privateJsonHeaders, status: 404 });
      }
      return NextResponse.json({ asset: serializeMediaAsset(changedAsset) }, { headers: privateJsonHeaders });
    } catch (error) {
      if (error instanceof MediaStoreError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { headers: privateJsonHeaders, status: statusForMediaError(error) },
        );
      }
      return NextResponse.json({ error: "Media publication failed." }, { headers: privateJsonHeaders, status: 500 });
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload form data." }, { headers: privateJsonHeaders, status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing media file." }, { headers: privateJsonHeaders, status: 400 });
  }

  if (file.size > maxMediaUploadBytes) {
    return NextResponse.json({ error: "Files must be 10 MB or smaller." }, { headers: privateJsonHeaders, status: 413 });
  }

  try {
    const asset = await saveWorkspaceFile({
      alt: stringField(formData.get("alt")),
      file,
      folder: stringField(formData.get("folder")),
      name: stringField(formData.get("name")),
      workspaceId: auth.session.workspaceId,
    });
    const publishedAsset = isTruthy(formData.get("public"))
      ? await publishWorkspaceMedia(asset.id, auth.session.workspaceId)
      : null;
    const media = await listWorkspaceMedia(auth.session.workspaceId);
    return NextResponse.json(
      { asset: serializeMediaAsset(publishedAsset ?? asset), quota: media.quota },
      { headers: privateJsonHeaders, status: 201 },
    );
  } catch (error) {
    if (error instanceof MediaStoreError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { headers: privateJsonHeaders, status: statusForMediaError(error) },
      );
    }
    return NextResponse.json({ error: "Media upload failed." }, { headers: privateJsonHeaders, status: 500 });
  }
}

function stringField(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : undefined;
}

function isTruthy(value: FormDataEntryValue | null) {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function statusForMediaError(error: MediaStoreError) {
  if (error.code === "FILE_TOO_LARGE" || error.code === "IMAGE_TOO_LARGE") return 413;
  if (error.code === "PRIVATE_STORAGE_UNAVAILABLE" || error.code === "PUBLIC_STORAGE_UNAVAILABLE") return 503;
  if (error.code.startsWith("LAUNCH_SCOPE_")) return 503;
  if (error.code === "WORKSPACE_QUOTA_EXCEEDED") return 409;
  return 415;
}
