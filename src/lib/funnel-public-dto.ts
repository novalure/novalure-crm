import type {
  FunnelBlueprint,
  FunnelDevice,
  FunnelElementType,
  FunnelField,
  FunnelFieldType,
  FunnelRule,
  FunnelRuleGroup,
  FunnelRuleOperator,
} from "@/lib/funnel-schema";
import { getFunnelConsentCategories } from "./funnel-consent.js";

type PublicFunnelAnswerValue = string | number | boolean;

export type PublicFunnelRule = {
  field: string;
  operator: FunnelRuleOperator;
  value?: PublicFunnelAnswerValue;
};

export type PublicFunnelRuleGroup = {
  mode: "and" | "or";
  rules: Array<PublicFunnelRule | PublicFunnelRuleGroup>;
};

export type PublicFunnelField = {
  captureSourceUrl?: boolean;
  consentCategories?: {
    analytics: boolean;
    marketing: boolean;
    privacy: boolean;
  };
  defaultValue?: string;
  errorMessage?: string;
  helpText?: string;
  hiddenValueSource?: "static" | "utm" | "urlParam" | "system";
  id: string;
  label: string;
  max?: number;
  min?: number;
  options?: string[];
  placeholder?: string;
  publicQueryParameter?: string;
  required: boolean;
  step?: number;
  type: FunnelFieldType;
  validationPattern?: string;
};

export type PublicFunnelElement = {
  alt?: string;
  condition?: PublicFunnelRuleGroup;
  content?: string;
  ctaLabel?: string;
  fields?: PublicFunnelField[];
  hasMedia?: boolean;
  id: string;
  name: string;
  options?: string[];
  type: FunnelElementType;
  url?: string;
  visibility?: Record<FunnelDevice, boolean>;
};

export type PublicFunnelPage = {
  id: string;
  sections: Array<{
    id: string;
    rows: Array<{
      columns: Array<{
        elements: PublicFunnelElement[];
        id: string;
      }>;
      id: string;
    }>;
  }>;
};

export type PublicFunnelDto = {
  id: string;
  name: string;
  pages: PublicFunnelPage[];
  theme: {
    colors: {
      accent: string;
      background: string;
      text: string;
    };
    logoText: string;
    radii: {
      block: number;
      button: number;
    };
    spacing: Partial<Record<FunnelDevice, number>>;
  };
  tracking: {
    clientAnalyticsEnabled: boolean;
    metaPixelEnabled: boolean;
  };
};

type PublicFieldAliasMap = Map<string, string>;

function normalizeAlias(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function buildPublicFieldAliases(blueprint: FunnelBlueprint) {
  const aliases: PublicFieldAliasMap = new Map();

  for (const page of blueprint.pages) {
    for (const section of page.sections) {
      for (const row of section.rows) {
        for (const column of row.columns) {
          for (const element of column.elements) {
            const elementId = element.id.trim();
            if (element.type === "choice" && elementId) {
              for (const alias of [element.id, element.crmField, element.name]) {
                const normalized = normalizeAlias(alias);
                if (normalized) aliases.set(normalized, elementId);
              }
            }

            for (const field of element.fields ?? []) {
              const fieldId = field.id.trim();
              if (!fieldId) continue;
              for (const alias of [field.id, field.crmField, field.label]) {
                const normalized = normalizeAlias(alias);
                if (normalized) aliases.set(normalized, fieldId);
              }
            }
          }
        }
      }
    }
  }

  return aliases;
}

function rewritePublicTokens(value: string | undefined, aliases: PublicFieldAliasMap) {
  if (!value) return value;
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, token: string) => {
    const publicFieldId = aliases.get(normalizeAlias(token));
    return publicFieldId ? `{{${publicFieldId}}}` : "";
  });
}

function toPublicRule(
  rule: FunnelRule | FunnelRuleGroup,
  aliases: PublicFieldAliasMap,
): PublicFunnelRule | PublicFunnelRuleGroup {
  if ("rules" in rule) {
    return {
      mode: rule.mode,
      rules: rule.rules.map((nestedRule) => toPublicRule(nestedRule, aliases)),
    };
  }

  return {
    field: aliases.get(normalizeAlias(rule.field)) ?? "__redacted_field__",
    operator: rule.operator,
    ...(rule.value === undefined ? {} : { value: rule.value }),
  };
}

function getPublicQueryParameter(field: FunnelField) {
  if (field.type !== "hidden") return undefined;
  if (field.hiddenValueSource !== "utm" && field.hiddenValueSource !== "urlParam") return undefined;
  const candidate = field.crmField.trim();
  return /^[a-z0-9_.~-]{1,128}$/iu.test(candidate) ? candidate : undefined;
}

function toPublicField(field: FunnelField): PublicFunnelField {
  return {
    ...(field.type === "hidden" && field.hiddenValueSource === "system" && field.crmField === "source_url"
      ? { captureSourceUrl: true }
      : {}),
    ...(field.type === "consent" ? { consentCategories: getFunnelConsentCategories(field) } : {}),
    ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    ...(field.errorMessage === undefined ? {} : { errorMessage: field.errorMessage }),
    ...(field.helpText === undefined ? {} : { helpText: field.helpText }),
    ...(field.hiddenValueSource === undefined
      ? {}
      : {
          hiddenValueSource:
            field.hiddenValueSource === "system" && field.crmField !== "source_url"
              ? "static" as const
              : field.hiddenValueSource,
        }),
    id: field.id,
    label: field.label,
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.options === undefined ? {} : { options: [...field.options] }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(getPublicQueryParameter(field) === undefined ? {} : { publicQueryParameter: getPublicQueryParameter(field) }),
    required: field.required,
    ...(field.step === undefined ? {} : { step: field.step }),
    type: field.type,
    ...(field.validationPattern === undefined ? {} : { validationPattern: field.validationPattern }),
  };
}

function toPublicElement(
  element: FunnelBlueprint["pages"][number]["sections"][number]["rows"][number]["columns"][number]["elements"][number],
  aliases: PublicFieldAliasMap,
): PublicFunnelElement {
  return {
    ...(element.alt === undefined ? {} : { alt: element.alt }),
    ...(element.condition === undefined ? {} : { condition: toPublicRule(element.condition, aliases) as PublicFunnelRuleGroup }),
    ...(element.content === undefined ? {} : { content: rewritePublicTokens(element.content, aliases) }),
    ...(element.ctaLabel === undefined ? {} : { ctaLabel: element.ctaLabel }),
    ...(element.fields === undefined ? {} : { fields: element.fields.map(toPublicField) }),
    ...(element.type === "video" ? { hasMedia: Boolean(element.url) } : {}),
    id: element.id,
    name: element.name,
    ...(element.options === undefined ? {} : { options: [...element.options] }),
    type: element.type,
    ...(element.type === "image" && element.url !== undefined ? { url: element.url } : {}),
    ...(element.visibility === undefined ? {} : { visibility: { ...element.visibility } }),
  };
}

/**
 * Creates the only blueprint shape allowed to cross the public RSC-to-client boundary.
 * Every property is copied explicitly so future internal FunnelBlueprint fields remain
 * server-only until they are deliberately reviewed and added here.
 */
export function toPublicFunnelDto(blueprint: FunnelBlueprint): PublicFunnelDto {
  const aliases = buildPublicFieldAliases(blueprint);

  return {
    id: blueprint.id,
    name: blueprint.name,
    pages: blueprint.pages.map((page) => ({
      id: page.id,
      sections: page.sections.map((section) => ({
        id: section.id,
        rows: section.rows.map((row) => ({
          columns: row.columns.map((column) => ({
            elements: column.elements.map((element) => toPublicElement(element, aliases)),
            id: column.id,
          })),
          id: row.id,
        })),
      })),
    })),
    theme: {
      colors: {
        accent: blueprint.theme.colors.accent,
        background: blueprint.theme.colors.background,
        text: blueprint.theme.colors.text,
      },
      logoText: blueprint.theme.logoText,
      radii: {
        block: blueprint.theme.radii.block,
        button: blueprint.theme.radii.button,
      },
      spacing: {
        ...(blueprint.theme.spacing.desktop === undefined ? {} : { desktop: blueprint.theme.spacing.desktop }),
        ...(blueprint.theme.spacing.mobile === undefined ? {} : { mobile: blueprint.theme.spacing.mobile }),
        ...(blueprint.theme.spacing.tablet === undefined ? {} : { tablet: blueprint.theme.spacing.tablet }),
      },
    },
    tracking: {
      clientAnalyticsEnabled: blueprint.tracking.consentMode === "active",
      metaPixelEnabled: blueprint.tracking.consentMode === "active" && Boolean(blueprint.tracking.metaPixelId),
    },
  };
}
