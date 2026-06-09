export type PublicSlugLookup = {
  slug: string;
  workspacePublicKey: string;
};

export function cleanPublicPathSegment(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

export function parsePublicSlugLookup(value: string | null | undefined): PublicSlugLookup | null {
  const segments = cleanPublicPathSegment(value)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length !== 2) return null;

  return {
    workspacePublicKey: decodeURIComponent(segments[0]),
    slug: decodeURIComponent(segments[1]),
  };
}

export function buildPublicFormPath(input: PublicSlugLookup) {
  return `/forms/${encodeURIComponent(input.workspacePublicKey)}/${encodeURIComponent(input.slug)}`;
}

export function buildPublicMeetingPath(input: PublicSlugLookup) {
  return `/book/${encodeURIComponent(input.workspacePublicKey)}/${encodeURIComponent(input.slug)}`;
}

export function appendSearchParams(path: string, query: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) params.append(key, item);
      }
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }

  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}
