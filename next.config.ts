import type { NextConfig } from "next";

const buildGitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "unknown";
const buildGitBranch = process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_REF_NAME ?? "unknown";
const buildTimestamp = process.env.NOVALURE_BUILD_TIMESTAMP ?? new Date().toISOString();
const applicationVersion = process.env.npm_package_version ?? "0.1.0";
const deploymentIdentity = process.env.VERCEL_DEPLOYMENT_ID ?? (buildGitSha !== "unknown" ? buildGitSha : undefined);

const baselineCsp = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const baselineSecurityHeaders = [
  { key: "Content-Security-Policy", value: baselineCsp },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  { key: "Permissions-Policy", value: "browsing-topics=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
] as const;

const protectedPageHeaders = [
  { key: "Content-Security-Policy", value: `${baselineCsp}; frame-ancestors 'none'` },
  { key: "X-Frame-Options", value: "DENY" },
] as const;

const visualQaContentHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'none'",
      "connect-src 'none'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
] as const;

const nextConfig: NextConfig = {
  deploymentId: deploymentIdentity,
  env: {
    NOVALURE_APPLICATION_VERSION: applicationVersion,
    NOVALURE_BUILD_DEPLOYMENT_ID: deploymentIdentity ?? "unknown",
    NOVALURE_BUILD_GIT_BRANCH: buildGitBranch,
    NOVALURE_BUILD_GIT_SHA: buildGitSha,
    NOVALURE_BUILD_TIMESTAMP: buildTimestamp,
  },
  serverExternalPackages: ["pg"],
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      {
        headers: [...baselineSecurityHeaders],
        source: "/:path*",
      },
      {
        headers: [...protectedPageHeaders],
        source: "/",
      },
      {
        headers: [...protectedPageHeaders],
        source: "/login/:path*",
      },
      {
        headers: [...visualQaContentHeaders],
        source: "/visual-qa/crm/content",
      },
    ];
  },
  poweredByHeader: false,
};

export default nextConfig;
