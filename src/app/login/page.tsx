import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PublicCrmLanding, type PublicCrmLandingLoginForm } from "@/components/public-crm-landing";
import { getSessionFromHeaders, isLoginConfigured } from "@/lib/auth/session";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getLoginPageCopy,
  getPublicPageCopy,
} from "@/lib/i18n";
import { getRequestCountry, resolveAuditHref } from "@/lib/public-audit";
import { resolvePublicLanguage } from "@/lib/public-language";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: "Novalure CRM | Protected Real Estate Lead Operations",
  description:
    "Protected CRM workspace behind the Novalure lead system, with private Pipeline Audit request and controlled team login.",
};

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getSafeReturnTo(value: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/api/") || value.startsWith("/login")) return "/";
  return value;
}

function getErrorText(error: string, text: ReturnType<typeof getLoginPageCopy>) {
  if (error === "login_not_configured") {
    return text.errors.login_not_configured;
  }

  if (error === "database_unavailable") {
    return text.errors.database_unavailable;
  }

  if (error) return text.errors.invalid;
  return "";
}

function getStatusText(status: string, text: ReturnType<typeof getLoginPageCopy>) {
  if (status === "password_reset") {
    return text.passwordReset.loginSuccess;
  }

  return "";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};
  const country = getRequestCountry(requestHeaders);
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country,
    requestedLanguage: query.lang,
  });
  const returnTo = getSafeReturnTo(getQueryValue(query.returnTo, "/"));

  if (session) {
    redirect(returnTo);
  }

  const loginCopy = getLoginPageCopy(language);
  const loginForm: PublicCrmLandingLoginForm = {
    configured: isLoginConfigured(),
    email: getQueryValue(query.email),
    errorText: getErrorText(getQueryValue(query.error), loginCopy),
    language,
    returnTo,
    statusText: getStatusText(getQueryValue(query.reset), loginCopy),
  };

  return (
    <PublicCrmLanding
      auditHref={resolveAuditHref(country, language)}
      basePath="/login"
      copy={getCrmLandingPageCopy(language)}
      language={language}
      legalCopy={getLoginLegalFooterCopy(language)}
      loginCopy={loginCopy}
      loginForm={loginForm}
      pageCopy={getPublicPageCopy(language)}
      showLoginForm
    />
  );
}
