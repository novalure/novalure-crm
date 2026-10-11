import type { PropertyAssetSummary } from "@/lib/property-department";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function selectVisibleProperty(assets: PropertyAssetSummary[], selectedId?: string, focusedId?: string) {
  const requestedId = focusedId || selectedId;
  // Never fall back to an unrelated old object when a filter or refresh hides the requested one.
  return requestedId ? assets.find((asset) => asset.id === requestedId) : assets[0];
}

export type PropertyUploadTarget = Readonly<{
  propertyId: string;
  projectId?: string;
  workspaceId: string;
  title: string;
  position: number;
  isCover: boolean;
}>;

export function propertyUploadTarget(asset: PropertyAssetSummary | undefined, workspaceId: string, imageCount = 0): PropertyUploadTarget | null {
  if (!asset || asset.kind !== "property" || asset.workspaceId !== workspaceId ||
    !uuid.test(workspaceId) || !asset.sellerListingId || !uuid.test(asset.sellerListingId) ||
    asset.id !== `listing:${asset.sellerListingId}`) return null;
  return Object.freeze({
    propertyId: asset.sellerListingId,
    projectId: asset.projectId,
    workspaceId,
    title: asset.title,
    position: imageCount,
    isCover: imageCount === 0,
  });
}

export function propertyWorkspaceEndpoint(path: "/api/media" | "/api/crm/properties", workspaceId: string) {
  if (!uuid.test(workspaceId)) throw new Error("Invalid property workspace");
  return `${path}?${new URLSearchParams({ workspaceId })}`;
}

export function confirmedPropertyCreation(payload: unknown, workspaceId: string, projectId: string) {
  const result = object(payload);
  const data = object(result.data);
  if (result.persisted !== true || typeof data.id !== "string" || !uuid.test(data.id) ||
    data.workspaceId !== workspaceId || data.projectId !== projectId) return null;
  return { id: data.id, assetId: `listing:${data.id}` };
}

const propertyAttachmentErrorCodes = [
  "FILE_CONTENT_MISMATCH", "FILE_TOO_LARGE", "IMAGE_TOO_LARGE", "INVALID_FILE_TYPE",
  "UNSUPPORTED_FILE_TYPE", "UNSUPPORTED_IMAGE_TYPE", "WORKSPACE_QUOTA_EXCEEDED",
  "PRIVATE_STORAGE_UNAVAILABLE", "PUBLIC_STORAGE_UNAVAILABLE", "INVALID_STORAGE_REFERENCE",
  "INVALID_UPLOAD_FORM", "MISSING_MEDIA_FILE", "UPLOAD_FAILED", "ATTACHMENT_FAILED",
  "NETWORK_ERROR", "INVALID_UPLOAD_RESPONSE", "INVALID_ATTACHMENT_RESPONSE",
] as const;

export type PropertyAttachmentErrorCode = typeof propertyAttachmentErrorCodes[number];

export class PropertyAttachmentError extends Error {
  readonly phase: "upload" | "attach";
  readonly uploadedAssetId?: string;
  readonly code?: PropertyAttachmentErrorCode;
  readonly httpStatus?: number;

  constructor(message: string, phase: "upload" | "attach", uploadedAssetId?: string,
    details: { code?: PropertyAttachmentErrorCode; httpStatus?: number } = {}) {
    super(message);
    this.name = "PropertyAttachmentError";
    this.phase = phase;
    this.uploadedAssetId = uploadedAssetId;
    // The API is an untrusted boundary even when a caller supplies a typed value.
    this.code = propertyAttachmentErrorCodes.find((code) => code === details.code);
    this.httpStatus = Number.isInteger(details.httpStatus) && details.httpStatus! >= 100 && details.httpStatus! <= 599
      ? details.httpStatus : undefined;
  }
}

export async function uploadPropertyAttachment(input: {
  file: File;
  kind: "media" | "document";
  target: PropertyUploadTarget;
  request: (url: string, init: RequestInit) => Promise<Response>;
  uploadError: string;
  attachError: string;
}) {
  // Capture once before the first await. A later selection change cannot retarget this operation.
  const target = { ...input.target };
  const { file, kind, request } = input;
  const folder = `properties/${target.propertyId}`;
  const form = new FormData();
  form.append("file", file);
  form.append("folder", folder);
  form.append("name", file.name);
  form.append("alt", file.name.replace(/\.[^.]+$/, ""));
  form.append("public", "false");
  let uploadedAssetId: string | undefined;
  let uploadStatus: number | undefined;
  try {
    const response = await request(propertyWorkspaceEndpoint("/api/media", target.workspaceId), { method: "POST", body: form });
    uploadStatus = response.status;
    const payload = object(await response.json().catch(() => null));
    const uploaded = object(payload.asset);
    if (!response.ok) {
      throw new PropertyAttachmentError(input.uploadError, "upload", undefined, {
        code: propertyAttachmentErrorCodes.find((code) => code === payload.code), httpStatus: response.status,
      });
    }
    if (typeof uploaded.id !== "string" || !uuid.test(uploaded.id) || uploaded.folder !== folder ||
      uploaded.isPublic === true || uploaded.publicUrl) {
      throw new PropertyAttachmentError(input.uploadError, "upload", undefined, {
        code: "INVALID_UPLOAD_RESPONSE", httpStatus: response.status,
      });
    }
    uploadedAssetId = uploaded.id;
  } catch (error) {
    if (error instanceof PropertyAttachmentError) throw error;
    throw new PropertyAttachmentError(input.uploadError, "upload", undefined, {
      code: uploadStatus === undefined ? "NETWORK_ERROR" : "INVALID_UPLOAD_RESPONSE", httpStatus: uploadStatus,
    });
  }

  let attachStatus: number | undefined;
  try {
    const body = kind === "media" ? {
      operation: "attach_media",
      propertyId: target.propertyId,
      projectId: target.projectId,
      media: {
        category: target.isCover ? "cover" : "detail",
        isCover: target.isCover,
        mediaAssetId: uploadedAssetId,
        mediaType: "image",
        position: target.position,
        status: "draft",
        title: file.name,
        visibility: "private",
      },
    } : {
      operation: "attach_document",
      propertyId: target.propertyId,
      projectId: target.projectId,
      document: { category: "expose", mediaAssetId: uploadedAssetId, requiredForPublication: false, status: "needs_review", title: file.name, visibility: "private" },
    };
    const response = await request(propertyWorkspaceEndpoint("/api/crm/properties", target.workspaceId), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    attachStatus = response.status;
    const payload = object(await response.json().catch(() => null));
    const data = object(payload.data);
    if (!response.ok || payload.persisted !== true || typeof data.id !== "string" || !uuid.test(data.id)) {
      throw new PropertyAttachmentError(input.attachError, "attach", uploadedAssetId, {
        code: response.ok ? "INVALID_ATTACHMENT_RESPONSE" : "ATTACHMENT_FAILED", httpStatus: response.status,
      });
    }
    return { target, mediaAssetId: uploadedAssetId };
  } catch (error) {
    if (error instanceof PropertyAttachmentError) throw error;
    throw new PropertyAttachmentError(input.attachError, "attach", uploadedAssetId, {
      code: attachStatus === undefined ? "NETWORK_ERROR" : "INVALID_ATTACHMENT_RESPONSE", httpStatus: attachStatus,
    });
  }
}

export function getPropertyInteractionCopy(language: string) {
  return language === "de" ? {
    resetFilters: "Suche und Status zurücksetzen",
    mutationInProgress: "Speicherung oder Upload läuft. Bitte bis zum Abschluss keine weitere Speicherung starten oder die Seite schließen.",
    selectObject: "Bitte ein Objekt aus den sichtbaren Ergebnissen auswählen.",
    savedTarget: "Gespeichertes Zielobjekt",
    noUploadTarget: "Bitte zuerst eine gespeicherte Einzelimmobilie in der Übersicht auswählen. Projektübersichten sind keine Upload-Ziele.",
    saveBeforeUpload: "Bitte dieses neue Objekt zuerst speichern. Bilder und Dokumente werden danach dem gespeicherten Objekt zugeordnet.",
    privateUpload: "Neue Uploads bleiben privat. Eine Veröffentlichung ist ein eigener Schritt.",
    savedRefreshFailed: "Das Objekt wurde gespeichert, aber die Ansicht konnte nicht aktualisiert werden. Bitte neu laden, nicht erneut anlegen.",
    attachedRefreshFailed: "Die Datei wurde zugeordnet, aber die Ansicht konnte nicht aktualisiert werden. Bitte neu laden, nicht erneut hochladen.",
    attachFailed: "Die Datei wurde hochgeladen, konnte aber nicht dem Objekt zugeordnet werden. Sie bleibt privat in der Medienablage; der Upload ist nicht abgeschlossen.",
    saveUnconfirmed: "Die Speicherung wurde nicht eindeutig bestätigt. Bitte vor einem erneuten Versuch den Bestand prüfen; der Entwurf bleibt erhalten.",
    uploadTo: "Upload-Ziel",
  } : {
    resetFilters: "Reset search and status",
    mutationInProgress: "A save or upload is in progress. Wait for completion before starting another save or closing this page.",
    selectObject: "Select a property from the visible results.",
    savedTarget: "Saved target property",
    noUploadTarget: "First select a saved individual property in the overview. Project summaries are not upload targets.",
    saveBeforeUpload: "Save this new property first. Images and documents can then be attached to the saved property.",
    privateUpload: "New uploads remain private. Publication is a separate step.",
    savedRefreshFailed: "The property was saved, but the view could not be refreshed. Reload instead of creating it again.",
    attachedRefreshFailed: "The file was attached, but the view could not be refreshed. Reload instead of uploading it again.",
    attachFailed: "The file was uploaded but could not be attached to the property. It remains private in the media library; the upload is incomplete.",
    saveUnconfirmed: "Saving was not conclusively confirmed. Check the inventory before retrying; the draft is retained.",
    uploadTo: "Upload target",
  };
}
