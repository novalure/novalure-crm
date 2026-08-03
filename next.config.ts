import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingIncludes: {
    "/api/system/database": ["./migrations/**/*.sql"],
  },
  poweredByHeader: false,
  async headers() {
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "upgrade-insecure-requests",
    ].join("; ");
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
  async redirects() {
    return [
      { source: "/de", destination: "/?lang=de", permanent: true },
      { source: "/en", destination: "/?lang=en", permanent: true },
      { source: "/impressum", destination: "/imprint?lang=de", permanent: true },
      { source: "/datenschutz", destination: "/privacy?lang=de", permanent: true },
      { source: "/nutzungsbedingungen", destination: "/terms?lang=de", permanent: true },
      { source: "/datenloeschung", destination: "/data-deletion?lang=de", permanent: true },
      { source: "/datadeletion", destination: "/data-deletion", permanent: true },
    ];
  },
};

export default nextConfig;
