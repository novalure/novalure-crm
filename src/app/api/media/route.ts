import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { listWorkspaceMedia, maxMediaUploadBytes, MediaStoreError, publishWorkspaceMedia, saveWorkspaceFile } from "@/lib/media-store";

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const media = await listWorkspaceMedia(auth.session.workspaceId);
  return NextResponse.json(media);
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload form data." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing media file." }, { status: 400 });
  }

  if (file.size > maxMediaUploadBytes) {
    return NextResponse.json({ error: "Files must be 10 MB or smaller." }, { status: 413 });
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
    return NextResponse.json({ asset: publishedAsset ?? asset, quota: media.quota }, { status: 201 });
  } catch (error) {
    if (error instanceof MediaStoreError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: statusForMediaError(error) });
    }
    return NextResponse.json({ error: "Media upload failed." }, { status: 500 });
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
  if (error.code === "WORKSPACE_QUOTA_EXCEEDED") return 409;
  return 415;
}
