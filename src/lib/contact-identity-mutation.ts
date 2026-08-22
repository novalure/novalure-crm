type ContactIdentityPatch = Record<string, unknown>;

function cleanIdentityValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve sparse Contact identity updates without treating an omitted field as
 * a deletion. Supplying the field with an empty string or null is the explicit
 * clear operation; omitting it retains the current persisted value.
 */
export function resolveContactIdentityMutation(input: {
  currentEmail?: string | null;
  currentPhone?: string | null;
  patch: ContactIdentityPatch;
}) {
  const emailProvided = Object.hasOwn(input.patch, "email");
  const phoneProvided = Object.hasOwn(input.patch, "phone");

  return Object.freeze({
    email: cleanIdentityValue(emailProvided ? input.patch.email : input.currentEmail),
    emailProvided,
    phone: cleanIdentityValue(phoneProvided ? input.patch.phone : input.currentPhone),
    phoneProvided,
  });
}
