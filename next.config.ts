import type { NextConfig } from "next";
import {
  contentSecurityPolicyModeHeader,
  createContentSecurityPolicy,
} from "./src/lib/security/content-security-policy";

const development = process.env.NODE_ENV === "development";
const staticFallbackCsp = createContentSecurityPolicy({
  development,
  pathName: "/forms/public",
});
const protectedPageCsp = createContentSecurityPolicy({ development, pathName: "/" });

const baselineSecurityHeaders = [
  { key: "Content-Security-Policy", value: staticFallbackCsp },
  { key: "X-Content-Security-Policy-Mode", value: `${contentSecurityPolicyModeHeader}-static-fallback` },
  { key: "Permissions-Policy", value: "browsing-topics=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
] as const;

const protectedPageHeaders = [
  { key: "Content-Security-Policy", value: protectedPageCsp },
  { key: "X-Frame-Options", value: "DENY" },
] as const;

const publicCapabilityPageHeaders = [
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "Referrer-Policy", value: "no-referrer" },
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
        headers: [...publicCapabilityPageHeaders],
        source: "/preview/:path*",
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
