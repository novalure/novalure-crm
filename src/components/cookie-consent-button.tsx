"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type CookieConsentChoice = "necessary" | "all";

type CookieConsentRecord = {
  analytics: boolean;
  choice: CookieConsentChoice;
  marketing: boolean;
  necessary: true;
  updatedAt: string;
  version: 1;
};

export type CookieConsentButtonCopy = {
  acceptAll: string;
  description: string;
  detailsLink: string;
  manageButton: string;
  necessaryDescription: string;
  necessaryTitle: string;
  optionalDescription: string;
  optionalTitle: string;
  rejectOptional: string;
  savedAll: string;
  savedNecessary: string;
  title: string;
};

type CookieConsentButtonProps = {
  cookieHref: string;
  copy: CookieConsentButtonCopy;
};

const cookieName = "novalure_cookie_consent";
const storageKey = "novalure_cookie_consent_v1";
const consentMaxAgeSeconds = 60 * 60 * 24 * 180;

function parseConsent(value: string | null) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<CookieConsentRecord>;
    if (parsed.version !== 1 || parsed.necessary !== true) return null;
    if (parsed.choice !== "necessary" && parsed.choice !== "all") return null;

    return {
      analytics: parsed.choice === "all" ? parsed.analytics === true : false,
      choice: parsed.choice,
      marketing: parsed.choice === "all" ? parsed.marketing === true : false,
      necessary: true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      version: 1,
    } satisfies CookieConsentRecord;
  } catch {
    return null;
  }
}

function readCookieConsent() {
  if (typeof document === "undefined") return null;

  const value = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);

  return parseConsent(value ? decodeURIComponent(value) : null);
}

function createConsentRecord(choice: CookieConsentChoice) {
  const optional = choice === "all";

  return {
    analytics: optional,
    choice,
    marketing: optional,
    necessary: true,
    updatedAt: new Date().toISOString(),
    version: 1,
  } satisfies CookieConsentRecord;
}

function persistConsent(record: CookieConsentRecord) {
  localStorage.setItem(storageKey, JSON.stringify(record));

  const secureFlag = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${cookieName}=${encodeURIComponent(JSON.stringify(record))}; Max-Age=${consentMaxAgeSeconds}; Path=/; SameSite=Lax${secureFlag}`;

  window.dispatchEvent(new CustomEvent("novalure-cookie-consent", { detail: record }));
}

export function CookieConsentButton({ cookieHref, copy }: CookieConsentButtonProps) {
  const [consent, setConsent] = useState<CookieConsentRecord | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let isActive = true;

    queueMicrotask(() => {
      if (!isActive) return;

      const storedConsent = parseConsent(localStorage.getItem(storageKey)) ?? readCookieConsent();
      setConsent(storedConsent);
      setIsOpen(!storedConsent);
      setIsMounted(true);
    });

    return () => {
      isActive = false;
    };
  }, []);

  if (!isMounted) return null;

  function choose(choice: CookieConsentChoice) {
    const nextConsent = createConsentRecord(choice);
    persistConsent(nextConsent);
    setConsent(nextConsent);
    setIsOpen(false);
  }

  const statusText = consent?.choice === "all" ? copy.savedAll : copy.savedNecessary;

  return (
    <>
      {consent && !isOpen ? (
        <button
          aria-haspopup="dialog"
          className="fixed bottom-4 left-4 z-[70] inline-flex min-h-10 items-center justify-center rounded-md border border-[#cdd4ce] bg-white px-3 py-2 text-xs font-semibold text-[#111614] shadow-lg transition hover:border-[#111614] focus:outline-none focus:ring-2 focus:ring-[#111614] focus:ring-offset-2"
          onClick={() => setIsOpen(true)}
          type="button"
        >
          {copy.manageButton}
        </button>
      ) : null}

      {isOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-[80] px-4 pb-4 sm:pb-6">
          <section
            aria-label={copy.title}
            className="mx-auto max-w-4xl rounded-lg border border-[#d8ddd7] bg-white p-4 text-[#111614] shadow-2xl sm:p-5"
            role="dialog"
          >
            <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
              <div>
                <p className="text-sm font-semibold uppercase text-[#277258]">{copy.title}</p>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-[#50645b]">{copy.description}</p>
                {consent ? <p className="mt-2 text-xs font-semibold text-[#277258]">{statusText}</p> : null}
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-[#d8ddd7] bg-[#f8f7f1] p-3">
                    <p className="text-sm font-semibold">{copy.necessaryTitle}</p>
                    <p className="mt-1 text-xs leading-5 text-[#50645b]">{copy.necessaryDescription}</p>
                  </div>
                  <div className="rounded-md border border-[#d8ddd7] bg-[#f8f7f1] p-3">
                    <p className="text-sm font-semibold">{copy.optionalTitle}</p>
                    <p className="mt-1 text-xs leading-5 text-[#50645b]">{copy.optionalDescription}</p>
                  </div>
                </div>
                <Link className="mt-3 inline-flex text-sm font-semibold text-[#111614] underline-offset-4 hover:underline" href={cookieHref}>
                  {copy.detailsLink}
                </Link>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
                <button
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-[#cdd4ce] bg-white px-4 py-3 text-sm font-semibold text-[#111614] transition hover:border-[#111614] hover:bg-[#f8f7f1] focus:outline-none focus:ring-2 focus:ring-[#111614] focus:ring-offset-2"
                  onClick={() => choose("necessary")}
                  type="button"
                >
                  {copy.rejectOptional}
                </button>
                <button
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-[#111614] bg-[#111614] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#26342f] focus:outline-none focus:ring-2 focus:ring-[#111614] focus:ring-offset-2"
                  onClick={() => choose("all")}
                  type="button"
                >
                  {copy.acceptAll}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
