import type { NewsletterDraftState } from "./newsletter-workspace";
import { newsletterVariableIssues } from "./newsletter-message-variables";
export type MarketingLanguage = "de" | "en" | "es";
export type MarketingSelection = {
  version: 1;
  countries: Array<"AT" | "DE" | "ES" | "IE">;
  languages: MarketingLanguage[];
  tagIds: string[];
  tagMatch: "all" | "any";
};
export const emptyMarketingSelection = (): MarketingSelection => ({
  version: 1,
  countries: [],
  languages: [],
  tagIds: [],
  tagMatch: "all",
});
export type MarketingTemplateVariant = Pick<
  NewsletterDraftState,
  "subject" | "previewText" | "contentBlocks"
>;
export type MarketingTemplate = {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  variants: Partial<Record<MarketingLanguage, MarketingTemplateVariant>>;
};
export type MarketingTag = {
  id: string;
  projectId: string;
  name: string;
  revision: number;
};
export type MarketingAudience = {
  id: string;
  projectId: string;
  name: string;
  audience: string;
  selection: MarketingSelection;
  revision: number;
};
export type MarketingSource = {
  kind: "newsletter" | "automation" | "funnel" | "expose" | "form";
  id: string;
  propertyId?: string;
  projectId: string;
  name: string;
  status: string;
  results: Record<string, number>;
};
export function marketingSelectionMatches(
  selection: MarketingSelection,
  contact: {
    countryCode: string | null;
    preferredLanguage: string | null;
    tagIds: string[];
  },
) {
  return (
    (!selection.countries.length ||
      selection.countries.includes(contact.countryCode as never)) &&
    (!selection.languages.length ||
      selection.languages.includes(contact.preferredLanguage as never)) &&
    (!selection.tagIds.length ||
      (selection.tagMatch === "all"
        ? selection.tagIds.every((id) => contact.tagIds.includes(id))
        : selection.tagIds.some((id) => contact.tagIds.includes(id))))
  );
}
export function normalizeMarketingSelection(
  value: unknown,
): MarketingSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Geprüfte Zielgruppenregeln fehlen.");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        !["version", "countries", "languages", "tagIds", "tagMatch"].includes(
          k,
        ),
    ) ||
    v.version !== 1 ||
    !["all", "any"].includes(String(v.tagMatch))
  )
    throw new Error("Unbekannte Zielgruppenregel.");
  for (const key of ["countries", "languages", "tagIds"])
    if (
      !Array.isArray(v[key]) ||
      (v[key] as unknown[]).length > 40 ||
      (v[key] as unknown[]).some((x) => typeof x !== "string")
    )
      throw new Error("Ungültige Zielgruppenliste.");
  if (
    (v.countries as string[]).some(
      (x) => !["AT", "DE", "ES", "IE"].includes(x),
    ) ||
    (v.languages as string[]).some((x) => !["de", "en", "es"].includes(x)) ||
    (v.tagIds as string[]).some((x) => !/^[0-9a-f-]{36}$/i.test(x))
  )
    throw new Error("Land, Sprache oder Tag ist ungültig.");
  return {
    version: 1,
    countries: [...new Set(v.countries as MarketingSelection["countries"])],
    languages: [...new Set(v.languages as MarketingLanguage[])],
    tagIds: [...new Set(v.tagIds as string[])].sort(),
    tagMatch: v.tagMatch as "all" | "any",
  };
}
export function missingNewsletterVariables(
  draft: NewsletterDraftState,
  context: { contactName?: string; projectName?: string; agentName?: string },
) {
  const tokens = JSON.stringify(draft).match(/\{\{[^}]+\}\}/g) ?? [],
    values: Record<string, string | undefined> = {
      "{{contact.name}}": context.contactName,
      "{{project.name}}": context.projectName,
      "{{agent.name}}": context.agentName,
    };
  return [
    ...new Set([
      ...tokens.filter(
        (token) => !Object.hasOwn(values, token) || !values[token]?.trim(),
      ),
      ...newsletterVariableIssues(JSON.stringify(draft)),
    ]),
  ];
}
export function starterMarketingVariants(): MarketingTemplate["variants"] {
  return Object.fromEntries(
    (["de", "en", "es"] as const).map((language) => [
      language,
      {
        subject:
          language === "de"
            ? "Neuigkeiten zu {{project.name}}"
            : language === "es"
              ? "Novedades de {{project.name}}"
              : "News from {{project.name}}",
        previewText:
          language === "de"
            ? "Aktuelle Informationen zu Ihrem Immobilieninteresse"
            : language === "es"
              ? "Información actual sobre su interés inmobiliario"
              : "An update on your property interests",
        contentBlocks: [
          {
            id: "greeting",
            type: "text",
            text:
              language === "de"
                ? "Guten Tag {{contact.name}},\nwir haben Neuigkeiten zu {{project.name}}. Bei Fragen erreichen Sie uns über die Antwortadresse.\nFreundliche Grüße\n{{agent.name}}"
                : language === "es"
                  ? "Hola {{contact.name}},\ntenemos novedades de {{project.name}}. Si tiene preguntas, puede responder a este mensaje.\nUn saludo,\n{{agent.name}}"
                  : "Hello {{contact.name}},\nwe have news from {{project.name}}. Please reply if you have any questions.\nKind regards,\n{{agent.name}}",
          },
        ],
      },
    ]),
  );
}
