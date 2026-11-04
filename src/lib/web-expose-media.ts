export const webExposeResourceKinds = ["image", "floorplan", "document", "video", "external_link"] as const;
export type WebExposeResourceKind = typeof webExposeResourceKinds[number];
export type WebExposeResource = {
  id: string; kind: WebExposeResourceKind; assetId: string | null; url: string | null; title: string; position: number;
  visibility: "private" | "published"; status: "draft" | "approved"; revision: number; mimeType: string | null;
  sizeBytes: number | null; contentHash: string | null; updatedAt: string;
};
export type WebExposeResourceInput = Pick<WebExposeResource, "kind" | "assetId" | "url" | "title" | "position" | "visibility" | "status">;
export const webExposeDirectUploadLimit = 4 * 1024 * 1024;
export const webExposeResourceMimeTypes = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"],
  floorplan: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  document: ["application/pdf"], video: ["video/mp4", "video/webm"], external_link: [],
} as const;
/** This URL is opened by the viewer, never fetched by the server during intake. */
export function normalizeWebExposeResourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !host.includes(".") ||
        /^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
    if ([...url.searchParams.keys()].some((key) => /^(?:password|passwd|secret|authorization|access_token|refresh_token|api_key|x-amz-signature|x-goog-signature)$/i.test(key))) return null;
    return url.toString();
  } catch { return null; }
}
export function parseWebExposeResourceInput(value: unknown): WebExposeResourceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_EXPOSE_RESOURCE");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["kind", "assetId", "url", "title", "position", "visibility", "status"].includes(key)) || !(webExposeResourceKinds as readonly unknown[]).includes(v.kind) || typeof v.title !== "string" || !v.title.trim() || v.title.length > 300 || /[\u0000-\u001f]/.test(v.title) || !Number.isSafeInteger(v.position) || Number(v.position) < 0 || Number(v.position) > 1000 || !["private", "published"].includes(String(v.visibility)) || !["draft", "approved"].includes(String(v.status))) throw new Error("INVALID_EXPOSE_RESOURCE");
  const url = v.url === null || v.url === undefined || v.url === "" ? null : normalizeWebExposeResourceUrl(v.url);
  const assetId = v.assetId === null || v.assetId === undefined || v.assetId === "" ? null : typeof v.assetId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.assetId) ? v.assetId : null;
  if ((v.url !== null && v.url !== undefined && v.url !== "" && !url) || (v.assetId !== null && v.assetId !== undefined && v.assetId !== "" && !assetId) || (v.visibility === "published" && v.status !== "approved")) throw new Error("INVALID_EXPOSE_RESOURCE");
  if (v.kind === "external_link" || (v.kind === "video" && !assetId)) { if (!url || assetId) throw new Error("INVALID_EXPOSE_RESOURCE_URL"); }
  else if (!assetId || url) throw new Error("INVALID_EXPOSE_RESOURCE_FILE");
  return { kind: v.kind as WebExposeResourceKind, assetId, url, title: v.title.trim(), position: Number(v.position), visibility: v.visibility as WebExposeResourceInput["visibility"], status: v.status as WebExposeResourceInput["status"] };
}
