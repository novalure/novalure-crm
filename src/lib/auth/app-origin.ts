import { publicSiteOrigin } from "@/lib/legal";

function cleanOrigin(value: string | undefined) {
  if (!value) return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function getTrustedAppOrigin() {
  return (
    cleanOrigin(process.env.NOVALURE_APP_ORIGIN) ||
    cleanOrigin(process.env.NEXT_PUBLIC_APP_URL) ||
    cleanOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    publicSiteOrigin
  );
}
