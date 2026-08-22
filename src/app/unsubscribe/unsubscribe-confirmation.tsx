"use client";

import { useEffect, useRef, useState } from "react";
import subpageStyles from "@/components/public-subpage.module.css";
import type { LanguageCode } from "@/lib/i18n";

type ViewState = "checking" | "ready" | "submitting" | "success" | "invalid" | "unavailable" | "preview";

const copy = {
  de: {
    checking: "Der sichere Abmeldelink wird geprüft.",
    confirm: "Newsletter-Abmeldung bestätigen",
    invalid: "Dieser sichere Abmeldelink ist ungültig oder abgelaufen.",
    invalidTitle: "Abmeldung nicht möglich",
    preview: "Dies ist nur die Vorschau der sicheren Abmeldeseite. Es werden keine Daten geändert.",
    previewTitle: "Abmelde-Vorschau",
    ready: "Bestätige die Abmeldung. Erst danach wird die Newsletter-Sperre gespeichert.",
    readyTitle: "Newsletter wirklich abmelden?",
    submitting: "Abmeldung wird gespeichert …",
    success: "Die Newsletter-Abmeldung wurde gespeichert. Weitere Newsletter an diese Adresse werden unterdrückt.",
    successTitle: "Du bist abgemeldet",
    unavailable: "Die Abmeldung konnte gerade nicht gespeichert werden. Bitte versuche es später erneut.",
    unavailableTitle: "Dienst vorübergehend nicht verfügbar",
  },
  en: {
    checking: "The secure unsubscribe link is being checked.",
    confirm: "Confirm newsletter unsubscribe",
    invalid: "This secure unsubscribe link is invalid or has expired.",
    invalidTitle: "Unable to unsubscribe",
    preview: "This is only a preview of the secure unsubscribe page. No data will be changed.",
    previewTitle: "Unsubscribe preview",
    ready: "Confirm the request. The newsletter suppression is stored only after confirmation.",
    readyTitle: "Unsubscribe from the newsletter?",
    submitting: "Saving unsubscribe request …",
    success: "The newsletter unsubscribe was saved. Further newsletters to this address will be suppressed.",
    successTitle: "You are unsubscribed",
    unavailable: "The unsubscribe could not be saved right now. Please try again later.",
    unavailableTitle: "Service temporarily unavailable",
  },
} as const;

function isPlausibleOpaqueToken(value: string) {
  return value.length <= 2_048 && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
}

export function UnsubscribeConfirmation({ language, preview }: { language: LanguageCode; preview: boolean }) {
  const text = copy[language];
  const [state, setState] = useState<ViewState>(preview ? "preview" : "checking");
  const tokenRef = useRef("");
  const submittingRef = useRef(false);

  useEffect(() => {
    const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const token = new URLSearchParams(fragment).get("token") ?? "";
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );

    if (preview) return;
    if (!isPlausibleOpaqueToken(token)) {
      queueMicrotask(() => setState("invalid"));
      return;
    }
    tokenRef.current = token;
    queueMicrotask(() => setState("ready"));
  }, [preview]);

  const confirm = async () => {
    if (submittingRef.current || !tokenRef.current) return;
    submittingRef.current = true;
    setState("submitting");
    try {
      const response = await fetch("/unsubscribe/confirm", {
        body: JSON.stringify({ action: "unsubscribe", token: tokenRef.current }),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.ok) {
        tokenRef.current = "";
        setState("success");
      } else if (response.status >= 500) {
        setState("unavailable");
      } else {
        tokenRef.current = "";
        setState("invalid");
      }
    } catch {
      setState("unavailable");
    } finally {
      submittingRef.current = false;
    }
  };

  const title = state === "success" ? text.successTitle
    : state === "ready" || state === "submitting" ? text.readyTitle
      : state === "preview" ? text.previewTitle
        : state === "unavailable" ? text.unavailableTitle
          : text.invalidTitle;
  const description = state === "success" ? text.success
    : state === "ready" ? text.ready
      : state === "submitting" ? text.submitting
        : state === "preview" ? text.preview
          : state === "unavailable" ? text.unavailable
            : state === "checking" ? text.checking
              : text.invalid;

  return (
    <>
      <h1>{title}</h1>
      <p aria-live="polite">{description}</p>
      {state === "ready" || state === "submitting" ? (
        <button
          className={subpageStyles.submitButton}
          disabled={state === "submitting"}
          onClick={confirm}
          type="button"
        >
          {state === "submitting" ? text.submitting : text.confirm}
        </button>
      ) : null}
    </>
  );
}
