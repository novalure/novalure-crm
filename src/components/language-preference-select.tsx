"use client";

import { useId } from "react";
import { getLanguagePreferenceCopy, type LanguageCode } from "@/lib/i18n";
import { isLanguagePreference, type LanguagePreference } from "@/lib/crm-language";

export type LanguagePreferenceSaveState = "idle" | "saving" | "saved" | "error" | "unavailable";

export function LanguagePreferenceSelect({
  language, preference, saveState, onChange, showDescription = false,
}: {
  language: LanguageCode;
  preference: LanguagePreference;
  saveState: LanguagePreferenceSaveState;
  onChange(preference: LanguagePreference): void;
  showDescription?: boolean;
}) {
  const id = useId();
  const copy = getLanguagePreferenceCopy(language);
  const message = saveState === "saving" ? copy.saving
    : saveState === "saved" ? copy.saved
      : saveState === "error" ? copy.error
        : saveState === "unavailable" ? copy.unavailable : "";
  return (
    <div className="grid min-w-0 gap-1 text-xs font-semibold text-stone-600" data-crm-language-control>
      <label htmlFor={id}>{copy.label}</label>
      {showDescription ? <p className="max-w-prose text-sm font-normal leading-6" id={`${id}-description`}>{copy.description}</p> : null}
      <select
        aria-describedby={[showDescription ? `${id}-description` : "", message ? `${id}-status` : ""].filter(Boolean).join(" ") || undefined}
        aria-busy={saveState === "saving"}
        className="min-h-11 w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 disabled:cursor-wait disabled:opacity-70"
        disabled={saveState === "saving"}
        id={id}
        onChange={event => { if (isLanguagePreference(event.target.value)) onChange(event.target.value); }}
        value={preference}
      >
        <option value="auto">{copy.automatic}</option>
        <option value="de">Deutsch</option>
        <option value="en">English</option>
      </select>
      {message ? <p className={`max-w-prose break-words text-xs font-normal leading-5 ${saveState === "error" || saveState === "unavailable" ? "text-rose-700" : "text-stone-600"}`} id={`${id}-status`} role={saveState === "error" ? "alert" : "status"}>{message}</p> : null}
    </div>
  );
}
