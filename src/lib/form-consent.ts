import type { WebsiteForm } from "@/lib/form-types";

type ConsentFormData = Pick<FormData, "getAll">;

function isAffirmativeConsent(values: FormDataEntryValue[]) {
  return values.length === 1 && typeof values[0] === "string"
    && /^(?:1|true|on|yes)$/i.test(values[0].trim());
}

export function extractConsent(
  form: Pick<WebsiteForm, "doubleOptIn" | "template">,
  formData: ConsentFormData,
) {
  // Conflicting or repeated values fail closed; a non-empty string is not consent.
  const privacy = isAffirmativeConsent([
    ...formData.getAll("privacy"),
    ...formData.getAll("privacy_consent"),
  ]);
  const marketing = isAffirmativeConsent(formData.getAll("marketing_consent"));

  return { doubleOptIn: form.doubleOptIn, marketing, privacy };
}
