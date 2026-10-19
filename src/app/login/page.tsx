import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CookieConsentButton } from "@/components/cookie-consent-button";
import { LoginEmailAutofocus } from "@/components/login-email-autofocus";
import { LoginUrlHygiene } from "@/components/login-url-hygiene";
import { PasswordVisibilityInput } from "@/components/password-visibility-input";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { SubmitOnceForm } from "@/components/submit-once-form";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import {
  getLoginChallengeView,
  getSessionFromHeaders,
  isLoginConfigured,
} from "@/lib/auth/session";
import {
  getCrmLandingPageCopy,
  getLoginPageCopy,
  languageRequestHeaderName,
  type LanguageCode,
} from "@/lib/i18n";
import { companyLegalDetails, publicSiteOrigin } from "@/lib/legal";
import { getRequestCountry, resolveAuditHref } from "@/lib/public-audit";
import { resolvePublicLanguage } from "@/lib/public-language";
import { resolveSafeLocalRedirect } from "@/lib/security/redirects";
import { buildPublicPageMetadata, resolvePublicPageLanguage } from "@/lib/page-metadata";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: LoginPageProps): Promise<Metadata> {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const language = resolvePublicPageLanguage(requestHeaders, query);
  return buildPublicPageMetadata({
    description: language === "de"
      ? "Sicherer Zugang zu freigegebenen Novalure CRM Workspaces."
      : "Secure access to approved Novalure CRM workspaces.",
    language,
    path: "/login",
    title: language === "de" ? "Anmelden" : "Sign in",
  });
}

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getErrorText(error: string, text: ReturnType<typeof getLoginPageCopy>, language: LanguageCode) {
  if (error === "login_not_configured") {
    return text.errors.login_not_configured;
  }

  if (error === "database_unavailable") {
    return text.errors.database_unavailable;
  }

  if (error === "invalid_mfa") {
    return language === "de"
      ? "Der Code ist ungültig, bereits verwendet oder vorübergehend gesperrt. Verwenden Sie einen neuen Code oder versuchen Sie es nach kurzer Wartezeit erneut. Starten Sie die Anmeldung bei Bedarf neu."
      : "The code is invalid, has already been used or is temporarily blocked. Use a new code or try again after a short wait. Restart sign-in if needed.";
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

function getForgotPasswordHref(language: LanguageCode) {
  const params = new URLSearchParams({ lang: language });
  return `/login/forgot-password?${params.toString()}`;
}

function getLoginLanguageHref(
  language: LanguageCode,
  query: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams({ lang: language });

  for (const key of ["error", "reset", "returnTo"]) {
    const value = getQueryValue(query[key]);
    if (value) params.set(key, value);
  }

  return `/login?${params.toString()}`;
}

function getCanonicalPublicHref(path: string, language: LanguageCode) {
  const url = new URL(path, publicSiteOrigin);
  url.searchParams.set("lang", language);
  return url.toString();
}

function MailIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M4.8 6.8h14.4v10.4H4.8V6.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="m5.2 7.2 6.8 5.4 6.8-5.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M7.2 10.4h9.6v8H7.2v-8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 10.4V8.2a3 3 0 0 1 6 0v2.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M5 12h13.5m-5-5 5 5-5 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};
  const country = getRequestCountry(requestHeaders);
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country,
    persistedLanguage: requestHeaders.get(languageRequestHeaderName),
    requestedLanguage: query.lang,
  });
  const returnTo = resolveSafeLocalRedirect(getQueryValue(query.returnTo, "/"), {
    blockedPathPrefixes: ["/api", "/login"],
    fallback: "/",
    trustedOrigin: getTrustedAppOrigin(),
  });

  if (session) {
    redirect(returnTo);
  }

  const loginCopy = getLoginPageCopy(language);
  const landingCopy = getCrmLandingPageCopy(language);
  const configured = isLoginConfigured();
  const loginChallenge = configured ? await getLoginChallengeView(requestHeaders) : null;
  const errorText = getErrorText(getQueryValue(query.error), loginCopy, language);
  const statusText = getStatusText(getQueryValue(query.reset), loginCopy);
  const hasLoginNotice = !configured || Boolean(errorText) || Boolean(statusText);
  const auditHref = resolveAuditHref(country, language);
  const publicHomeHref = getCanonicalPublicHref("/", language);
  const cookieHref = getCanonicalPublicHref("/cookies", language);
  const privacyHref = getCanonicalPublicHref("/privacy", language);
  const languageHrefs = {
    de: getLoginLanguageHref("de", query),
    en: getLoginLanguageHref("en", query),
  };
  const introCopy = language === "de"
    ? {
        eyebrow: "Privater CRM-Zugang",
        title: "Ihr geschützter Immobilien-Workspace.",
        body: "Melden Sie sich an, um Leads, Zuständigkeiten und nächste Aktionen in Ihrem Novalure Workspace zu bearbeiten.",
        points: ["Nur für freigegebene Teams", "Mandantengetrennte Arbeitsbereiche", "Sicherer Zugang zu operativen CRM-Daten"],
      }
    : {
        eyebrow: "Private CRM access",
        title: "Your protected real estate workspace.",
        body: "Sign in to manage leads, ownership and next actions in your Novalure workspace.",
        points: ["For approved teams only", "Tenant-isolated workspaces", "Secure access to operational CRM data"],
      };

  return (
    <>
      <PublicSiteShell
        currentPath="/login"
        language={language}
        languageHrefs={languageHrefs}
      >
        <div className={subpageStyles.authLayout}>
          <section className={subpageStyles.authIntro}>
            <p className={subpageStyles.eyebrow}>{introCopy.eyebrow}</p>
            <h1>{introCopy.title}</h1>
            <p>{introCopy.body}</p>
            <ul className={subpageStyles.authPoints}>
              {introCopy.points.map((point) => <li key={point}>{point}</li>)}
            </ul>
          </section>

          <section aria-labelledby="login-heading" className={subpageStyles.authCard}>
            <h2 id="login-heading">{loginCopy.title}</h2>
            <p>{loginCopy.description}</p>

              {hasLoginNotice ? (
                <div className={subpageStyles.noticeStack}>
                  {!configured ? (
                    <p className={subpageStyles.notice}>{loginCopy.notConfigured}</p>
                  ) : null}

                  {errorText ? (
                    <p
                      aria-live="polite"
                      className={subpageStyles.noticeError}
                      role="alert"
                    >
                      {errorText}
                    </p>
                  ) : null}

                  {statusText ? (
                    <p
                      aria-live="polite"
                      className={subpageStyles.noticeSuccess}
                    >
                      {statusText}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {loginChallenge ? (
                <SubmitOnceForm action="/api/auth/login" className={subpageStyles.form} method="post">
                  <LoginUrlHygiene clearError={Boolean(errorText)} />
                  <input name="flow" type="hidden" value="challenge" />
                  <input name="returnTo" type="hidden" value={returnTo} />
                  <input name="language" type="hidden" value={language} />

                  {loginChallenge.kind === "workspace_selection" ? (
                    <>
                      <p className={subpageStyles.fieldHelp}>
                        {language === "de"
                          ? "Wählen Sie den Workspace für diese Sitzung. Ihre Identität und Ihr Passwort gelten zentral."
                          : "Choose the workspace for this session. Your identity and password are shared centrally."}
                      </p>
                      {loginChallenge.workspaces.map((workspace) => (
                        <button
                          className={subpageStyles.submitButton}
                          key={workspace.id}
                          name="workspaceUserId"
                          type="submit"
                          value={workspace.id}
                        >
                          <span>{workspace.name}</span>
                          <ArrowRightIcon />
                        </button>
                      ))}
                    </>
                  ) : (
                    <>
                      <p className={subpageStyles.fieldHelp}>
                        {language === "de"
                          ? `Zusätzliche Bestätigung für den Zugang zu ${loginChallenge.workspaceName}.`
                          : `Additional verification for access to ${loginChallenge.workspaceName}.`}
                      </p>

                      {loginChallenge.kind === "mfa_enrollment" ? (
                        <div className={subpageStyles.noticeStack}>
                          <p className={subpageStyles.notice}>
                            {language === "de"
                              ? "Richten Sie den Schlüssel in einer TOTP-App ein und bewahren Sie die einmaligen Wiederherstellungscodes sicher auf."
                              : "Add this key to a TOTP app and store the one-time recovery codes securely."}
                          </p>
                          <p className={subpageStyles.fieldHelp}>
                            <strong>{language === "de" ? "TOTP-Schlüssel:" : "TOTP key:"}</strong>{" "}
                            <code>{loginChallenge.secret}</code>
                          </p>
                          <p className={subpageStyles.fieldHelp}>
                            <strong>{language === "de" ? "Provisioning-URI:" : "Provisioning URI:"}</strong>{" "}
                            <code>{loginChallenge.provisioningUri}</code>
                          </p>
                          <p className={subpageStyles.fieldHelp}>
                            <strong>{language === "de" ? "Wiederherstellungscodes:" : "Recovery codes:"}</strong>
                          </p>
                          <ul className={subpageStyles.authPoints}>
                            {loginChallenge.recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
                          </ul>
                          <label className={subpageStyles.field}>
                            <input name="recoveryCodesSaved" required type="checkbox" value="1" />
                            {language === "de"
                              ? "Ich habe die Wiederherstellungscodes sicher gespeichert."
                              : "I stored the recovery codes securely."}
                          </label>
                        </div>
                      ) : null}

                      <label className={subpageStyles.field} htmlFor="login-mfa-code">
                        {loginChallenge.kind === "mfa_enrollment"
                          ? language === "de"
                            ? "Sechsstelliger Code aus der Authenticator-App"
                            : "Six-digit authenticator code"
                          : language === "de"
                            ? "Code aus der Authenticator-App oder Wiederherstellungscode"
                            : "Authenticator or recovery code"}
                        <input
                          aria-describedby="login-mfa-help"
                          autoCapitalize="none"
                          autoComplete="one-time-code"
                          autoFocus
                          className={subpageStyles.input}
                          id="login-mfa-code"
                          inputMode={loginChallenge.kind === "mfa_enrollment" ? "numeric" : "text"}
                          maxLength={loginChallenge.kind === "mfa_enrollment" ? 6 : 19}
                          name="code"
                          pattern={loginChallenge.kind === "mfa_enrollment" ? "[0-9]{6}" : undefined}
                          required
                          spellCheck={false}
                          type="text"
                        />
                      </label>
                      <p className={subpageStyles.fieldHelp} id="login-mfa-help">
                        {loginChallenge.kind === "mfa_enrollment"
                          ? language === "de"
                            ? "Bestätigen Sie die Einrichtung mit dem aktuellen sechsstelligen Code. Wiederherstellungscodes können Sie erst bei einer späteren Anmeldung verwenden."
                            : "Confirm setup with the current six-digit code. Recovery codes can be used for a later sign-in."
                          : language === "de"
                            ? "Geben Sie den aktuellen sechsstelligen Code oder einen unbenutzten Wiederherstellungscode ein. Ein bereits verwendeter Code ist nicht erneut gültig; warten Sie auf den nächsten Code."
                            : "Enter the current six-digit code or an unused recovery code. A used code cannot be reused; wait for the next code."}
                      </p>
                      <button className={subpageStyles.submitButton} type="submit">
                        <span>{language === "de" ? "Sicher bestätigen" : "Verify securely"}</span>
                        <ArrowRightIcon />
                      </button>
                    </>
                  )}
                </SubmitOnceForm>
              ) : (
              <SubmitOnceForm action="/api/auth/login" className={subpageStyles.form} method="post">
                <LoginEmailAutofocus />
                <LoginUrlHygiene clearError={Boolean(errorText)} />
                <input name="returnTo" type="hidden" value={returnTo} />
                <input name="language" type="hidden" value={language} />
                <div className={subpageStyles.field}>
                  <label htmlFor="login-email">
                    {loginCopy.emailLabel}
                  </label>
                  <div className={subpageStyles.inputWrap}>
                    <span className={subpageStyles.inputIcon}>
                      <MailIcon />
                    </span>
                    <input
                      autoComplete="username"
                      className={subpageStyles.inputWithIcon}
                      id="login-email"
                      name="email"
                      placeholder={loginCopy.placeholderEmail}
                      required
                      type="email"
                    />
                  </div>
                </div>
                <div className={subpageStyles.field}>
                  <label htmlFor="login-password">
                    {loginCopy.passcodeLabel}
                  </label>
                  <div className={subpageStyles.inputWrap}>
                    <span className={subpageStyles.inputIcon}>
                      <LockIcon />
                    </span>
                    <PasswordVisibilityInput
                      autoComplete="current-password"
                      className={subpageStyles.inputWithIcon}
                      hideLabel={loginCopy.passcodeHideLabel}
                      id="login-password"
                      name="password"
                      required
                      showLabel={loginCopy.passcodeShowLabel}
                    />
                  </div>
                  <p className={subpageStyles.fieldHelp}>{loginCopy.passcodeHelp}</p>
                </div>
                <div className={subpageStyles.alignRight}>
                  <Link
                    className={subpageStyles.textLink}
                    href={getForgotPasswordHref(language)}
                  >
                    {loginCopy.passwordReset.forgotLink}
                  </Link>
                </div>
                <button
                  className={subpageStyles.submitButton}
                  disabled={!configured}
                  type="submit"
                >
                  <span>{loginCopy.submit}</span>
                  <ArrowRightIcon />
                </button>
              </SubmitOnceForm>
              )}

              {loginChallenge ? (
                <SubmitOnceForm action="/api/auth/login" method="post">
                  <input name="flow" type="hidden" value="cancel" />
                  <input name="returnTo" type="hidden" value={returnTo} />
                  <input name="language" type="hidden" value={language} />
                  <button className={subpageStyles.textLink} type="submit">
                    {language === "de" ? "Anmeldung neu starten" : "Restart sign-in"}
                  </button>
                </SubmitOnceForm>
              ) : null}

            <div className={subpageStyles.authLinks}>
              <Link
                className={subpageStyles.textLink}
                href={publicHomeHref}
              >
                {loginCopy.overviewLink}
              </Link>
              <a
                className={subpageStyles.textLink}
                href={auditHref}
              >
                {loginCopy.auditLink}
              </a>
            </div>
            <p className={subpageStyles.authHelp}>
              {loginCopy.accessHelp.prefix}{" "}
              <a className={subpageStyles.textLink} href={auditHref}>
                {loginCopy.accessHelp.auditLabel}
              </a>{" "}
              {loginCopy.accessHelp.connector}{" "}
              <a className={subpageStyles.textLink} href={`mailto:${companyLegalDetails.email}`}>
                {companyLegalDetails.email}
              </a>
              .
            </p>
          </section>
        </div>
      </PublicSiteShell>
      <CookieConsentButton cookieHref={cookieHref} copy={landingCopy.cookieConsent} placement="login" privacyHref={privacyHref} />
    </>
  );
}
