import type { FunnelBlueprint, FunnelElement, FunnelField, FunnelSubmissionPayload } from "@/lib/funnel-schema";

export type FunnelAnswer = FunnelSubmissionPayload["answers"][string];
export type FunnelAnswers = FunnelSubmissionPayload["answers"];

/** Every value on the wire is addressed by its declared field ID. CRM names are projections. */
export function funnelElementFields(element: FunnelElement): FunnelField[] {
  if (element.type === "form") return element.fields ?? [];
  if (element.type === "choice") return [{ id: element.id, type: "singleChoice", crmField: element.crmField ?? element.id, label: element.content ?? element.name, required: element.required ?? true, options: element.options ?? [] }];
  return [];
}

export function funnelRuntimeFields(blueprint: FunnelBlueprint): FunnelField[] {
  const byId = new Map<string, FunnelField>();
  for (const page of blueprint.pages) for (const section of page.sections) for (const row of section.rows) for (const column of row.columns) for (const element of column.elements) {
    for (const field of funnelElementFields(element)) if (!byId.has(field.id)) byId.set(field.id, field);
  }
  return [...byId.values()];
}

export function initialFunnelAnswers(blueprint: FunnelBlueprint): FunnelAnswers {
  return Object.fromEntries(funnelRuntimeFields(blueprint).map(field => [field.id, field.type === "multiChoice" ? [] : field.type === "consent" ? false : ["number", "slider", "rating"].includes(field.type) ? field.defaultValue ? Number(field.defaultValue) : null : field.defaultValue ?? ""]));
}

export function setFunnelAnswer(current: FunnelAnswers, field: FunnelField, value: FunnelAnswer): FunnelAnswers {
  return { ...current, [field.id]: value };
}

export function withRuntimeHiddenAnswers(fields: FunnelField[], current: FunnelAnswers, context: { search?: string; sourceUrl?: string }): FunnelAnswers {
  const params = new URLSearchParams(context.search ?? ""), next = { ...current };
  for (const field of fields) {
    if (field.type !== "hidden") continue;
    let value = field.defaultValue ?? "";
    if (field.hiddenValueSource === "utm") value = params.get(field.crmField) ?? params.get(`utm_${field.crmField.replace(/^utm_/, "")}`) ?? value;
    if (field.hiddenValueSource === "urlParam") value = params.get(field.crmField) ?? value;
    if (field.hiddenValueSource === "system" && field.crmField === "source_url") value = context.sourceUrl ?? value;
    next[field.id] = value;
  }
  return next;
}

export function funnelRuntimeConsent(fields: FunnelField[], answers: FunnelAnswers) {
  const accepted = (name: string) => fields.some(field => field.type === "consent" && field.crmField === name && answers[field.id] === true);
  return { privacy: accepted("privacy_consent"), analytics: accepted("analytics_consent"), marketing: accepted("marketing_consent") };
}

export function buildFunnelRuntimeSubmission(blueprint: FunnelBlueprint, current: FunnelAnswers, context: { mode: "live" | "test"; search?: string; sourceUrl?: string; userAgent?: string }): FunnelSubmissionPayload {
  const fields = funnelRuntimeFields(blueprint), answers = withRuntimeHiddenAnswers(fields, current, context), params = new URLSearchParams(context.search ?? "");
  return { funnelId: blueprint.id, mode: context.mode, answers, consent: funnelRuntimeConsent(fields, answers), visitor: { ...(params.get("visitorId") ? { id: params.get("visitorId")! } : {}), ...(context.sourceUrl ? { sourceUrl: context.sourceUrl } : {}), ...(context.userAgent ? { userAgent: context.userAgent } : {}) }, utm: Object.fromEntries([...params.entries()].filter(([key]) => key.startsWith("utm_") || key === "gclid" || key === "fbclid")) };
}

/** Preserve every original ID/value; derive business attributes without modifying the submission. */
export function projectFunnelCrmAnswers(blueprint: FunnelBlueprint, answers: FunnelAnswers): FunnelAnswers {
  const projected: FunnelAnswers = Object.create(null);
  for (const field of funnelRuntimeFields(blueprint)) {
    if (!Object.hasOwn(answers, field.id)) continue;
    const value = answers[field.id], key = field.crmField || field.id;
    if (!Object.hasOwn(projected, key) || projected[key] === "" || projected[key] === null) projected[key] = value;
    else if (value !== "" && value !== null && JSON.stringify(projected[key]) !== JSON.stringify(value)) throw new Error("AMBIGUOUS_FUNNEL_MAPPING");
  }
  return projected;
}

export function funnelSubmissionFailure(code: string | undefined, language: string) {
  if (["INVALID_ANSWERS", "REQUIRED_FIELD", "INVALID_ANSWER"].includes(code ?? "")) return language === "de" ? "Das Formular wurde inzwischen geändert oder ist noch nicht vollständig. Bitte prüfe die Angaben oder lade die Seite neu." : "The form has changed or is incomplete. Please check your entries or reload the page.";
  if (code === "IDEMPOTENCY_CONFLICT") return language === "de" ? "Für diese Anfrage ist bereits ein anderer Stand gespeichert. Bitte lade die Seite neu, bevor du eine neue Anfrage sendest." : "A different version of this enquiry is already saved. Please reload before sending a new enquiry.";
  if (["FUNNEL_UNAVAILABLE", "FUNNEL_REVOKED"].includes(code ?? "")) return language === "de" ? "Dieser Anfragelink ist nicht mehr verfügbar. Bitte wende dich an den Anbieter." : "This enquiry link is no longer available. Please contact the provider.";
  return language === "de" ? "Anfrage konnte nicht gespeichert werden. Bitte erneut versuchen." : "The enquiry could not be saved. Please try again.";
}
