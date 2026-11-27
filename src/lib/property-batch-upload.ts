export class PropertyUploadError extends Error {
  constructor(message: string, readonly stopBatch = false) {
    super(message);
  }
}

/** A lost or malformed response can follow a successful write. Never retry it blindly. */
export function classifyPropertyUploadResponse(status: number, assetId: unknown, code: unknown): "confirmed" | "uncertain" | "stop" | "continue" {
  const hasAssetId = typeof assetId === "string" && assetId.length > 0;
  if (status >= 200 && status < 300) return hasAssetId ? "confirmed" : "uncertain";
  if (hasAssetId || status === 408 || status >= 500) return "uncertain";
  if ([401, 403, 429].includes(status) || code === "WORKSPACE_QUOTA_EXCEEDED") return "stop";
  return "continue";
}

export function isConfirmedPropertyAttachment(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as { persisted?: unknown; data?: { id?: unknown } };
  return value.persisted === true && typeof value.data?.id === "string" && value.data.id.length > 0;
}

/** A floor plan cannot be a cover, and the first new photo fills a missing cover. */
export function shouldSetPropertyCover(existing: readonly { isCover: boolean }[], floorplan: boolean, attachedCount: number): boolean {
  return !floorplan && attachedCount === 0 && !existing.some(item => item.isCover);
}

/** Upload one item at a time to avoid overwhelming the API and storage quota. */
export async function uploadPropertyBatch<T>(
  files: readonly T[],
  upload: (file: T, attachedCount: number) => Promise<void>,
  onProgress: (completed: number, total: number) => void,
) {
  const failures: { file: T; message: string }[] = [];
  let attached = 0;
  let attempted = 0;
  for (const file of files) {
    try {
      await upload(file, attached);
      attached += 1;
    } catch (error) {
      failures.push({ file, message: error instanceof Error ? error.message : "Upload failed" });
      attempted += 1;
      onProgress(attempted, files.length);
      // Unexpected exceptions have an unknown side-effect status. Only a
      // deliberately classified, recoverable file error may continue.
      if (!(error instanceof PropertyUploadError) || error.stopBatch) break;
      continue;
    }
    attempted += 1;
    onProgress(attempted, files.length);
  }
  return { attached, failures, notAttempted: files.length - attempted };
}
