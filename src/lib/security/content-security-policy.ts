const embeddedPublicPathPrefixes = ["/book/", "/forms/", "/preview/"] as const;

export const contentSecurityPolicyModeHeader = "nonce-enforced-v1";

function isIntentionalEmbedPath(pathName: string) {
  return embeddedPublicPathPrefixes.some(
    (prefix) => pathName === prefix.slice(0, -1) || pathName.startsWith(prefix),
  );
}

export function createContentSecurityPolicy(input: {
  development: boolean;
  nonce?: string | null;
  pathName: string;
}) {
  const nonce = input.nonce?.trim();
  const scriptPolicy = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${input.development ? " 'unsafe-eval'" : ""}`
    : `script-src 'self' 'unsafe-inline'${input.development ? " 'unsafe-eval'" : ""}`;
  const connectPolicy = input.development
    ? "connect-src 'self' https: http: ws: wss:"
    : "connect-src 'self' https:";
  const directives = [
    "default-src 'self'",
    scriptPolicy,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    connectPolicy,
    "media-src 'self' blob: https:",
    "worker-src 'self' blob:",
    "frame-src 'self' https:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!isIntentionalEmbedPath(input.pathName)) {
    directives.push("frame-ancestors 'none'");
  }
  if (!input.development) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
