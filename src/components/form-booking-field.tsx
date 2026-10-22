"use client";

import { useEffect, useState } from "react";
import type { FormField } from "@/lib/form-types";
import type { LanguageCode } from "@/lib/language-runtime";
import { csrfFetch } from "@/lib/security/csrf-client";
import { PublicBookingForm, type PublicBookingReceipt } from "./public-booking-form";

type FormBookingFieldProps = { field: FormField; language?: LanguageCode; onChange?: (value: string) => void };
export function FormBookingField(props: FormBookingFieldProps) {
  return <FormBookingFieldRuntime key={`${props.field.id}:${props.field.bookingPublicId ?? ""}`} {...props} />;
}

function FormBookingFieldRuntime({ field, language = "de", onChange }: FormBookingFieldProps) {
  const [receipt, setReceipt] = useState<PublicBookingReceipt | null>(null);
  const de = language === "de";
  if (!field.bookingPublicId) return <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{de ? "Für dieses Buchungsfeld wurde noch keine veröffentlichte Terminbuchung ausgewählt." : "No published booking configuration has been selected for this field yet."}</p>;
  const required = field.bookingRequired ?? field.required;
  return <div className="grid min-w-0 gap-3" data-novalure-form-booking={field.bookingPublicId}>
    <p className="text-xs font-normal text-slate-600">{required ? de ? "Vor dem Absenden ist eine ausdrücklich bestätigte Buchung erforderlich." : "An explicitly confirmed booking is required before submitting this form." : de ? "Sie können das Formular auch ohne bestätigte Buchung absenden. Eine ausgewählte Zeit allein ist noch keine Buchung." : "You can submit this form without a confirmed booking. Selecting a time alone does not create a booking."}</p>
    <PublicBookingForm key={field.bookingPublicId} publicId={field.bookingPublicId} channel="form" initialLanguage={language} embeddedInForm onBooked={value => { setReceipt(value); onChange?.(value.booking.id); }} onCleared={() => { setReceipt(null); onChange?.(""); }} />
    <input type="hidden" name={`booking_${field.id}_id`} value={receipt?.booking.state === "confirmed" ? receipt.booking.id : ""} readOnly />
    <input type="hidden" name={`booking_${field.id}_token`} value={receipt?.booking.state === "confirmed" ? receipt.sessionToken : ""} readOnly />
  </div>;
}

export function FormBookingFieldSettings({ field, language, onChange }: { field: FormField; language: LanguageCode; onChange: (value: Partial<FormField>) => void }) {
  const [publication, setPublication] = useState<{ publicId: string; title: string; enabled: boolean; channels: { form: boolean } } | null>(null);
  const [failed, setFailed] = useState(false);
  const de = language === "de";
  useEffect(() => {
    let active = true;
    csrfFetch("/api/booking/publication", { cache: "no-store" }).then(async response => { if (!response.ok) throw new Error("PUBLICATION_UNAVAILABLE"); return response.json(); }).then(value => { if (active) setPublication(value.publication); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  return <fieldset className="grid gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3"><legend className="text-sm font-semibold">{de ? "Gemeinsame Terminbuchung" : "Shared appointment booking"}</legend>
    <label className="grid gap-1 text-sm">{de ? "Veröffentlichte Buchungskonfiguration" : "Published booking configuration"}<select className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={field.bookingPublicId ?? ""} onChange={event => onChange({ bookingPublicId: event.target.value })}><option value="">{de ? "Bitte auswählen" : "Please select"}</option>{publication ? <option value={publication.publicId} disabled={!publication.enabled || !publication.channels.form}>{publication.title}</option> : field.bookingPublicId ? <option value={field.bookingPublicId}>{de ? "Gespeicherte Auswahl – erneut prüfen" : "Saved selection – review required"}</option> : null}</select></label>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={field.bookingRequired ?? field.required} onChange={event => onChange({ bookingRequired: event.target.checked, required: event.target.checked })} />{de ? "Bestätigte Buchung vor Formularversand erforderlich" : "Require a confirmed booking before form submission"}</label>
    {failed || publication && (!publication.enabled || !publication.channels.form) ? <p className="text-xs text-amber-900">{de ? "Unter Terminbuchung → Veröffentlichen zuerst den Formular-Kanal freigeben und speichern. Die Konfiguration muss zum selben Unternehmen gehören." : "First enable and save the form channel under Appointment booking → Publish. The configuration must belong to the same company."}</p> : null}
  </fieldset>;
}
