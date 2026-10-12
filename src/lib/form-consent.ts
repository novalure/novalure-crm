import type { WebsiteForm } from "@/lib/form-types";

type ConsentFormData = Pick<FormData, "getAll">;

function isAffirmativeConsent(values: FormDataEntryValue[]) {
  return values.length > 0 && values.every((value) =>
    typeof value === "string" && /^(?:1|true|on|yes)$/i.test(value.trim()),
  );
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
  const marketingValues = formData.getAll("marketing_consent");
  const marketing = marketingValues.length > 0
    ? isAffirmativeConsent(marketingValues)
    : form.template === "newsletter" && privacy;

  return { doubleOptIn: form.doubleOptIn, marketing, privacy };
}
