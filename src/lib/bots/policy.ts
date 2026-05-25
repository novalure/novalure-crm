import type { LanguageCode } from "@/lib/i18n";

export type BotActionName =
  | "channel_reply"
  | "crm_upsert"
  | "document_send"
  | "knowledge_search"
  | "meeting_book"
  | "meeting_prepare"
  | "model_reply";

export type BotActionRisk = "low" | "medium" | "high";

export type BotRuntimeControls = {
  killSwitch: boolean;
  testMode: boolean;
  requireHumanApproval: boolean;
  strictKnowledge: boolean;
  disabledReason: string | null;
};

export type BotPolicyDecision = {
  action: BotActionName;
  allowed: boolean;
  auditOnly: boolean;
  mode: "allow" | "block" | "test";
  reason: string;
  requiresHumanApproval: boolean;
  risk: BotActionRisk;
};

export type BotPolicyRule = {
  effect: "allow" | "block" | "test";
  id: string;
  label: string;
};

export type BotPolicyViolation = {
  id: string;
  label: string;
  reason: string;
};

type DocumentPolicyInput = {
  approved?: boolean;
  publicUrl?: string | null;
  recipient?: string | null;
};

type MeetingPolicyInput = {
  contactEmail?: string | null;
  contactName?: string | null;
  selectedDate?: string | null;
  slot?: string | null;
  slug?: string | null;
};

const trueValues = new Set(["1", "true", "yes", "on", "enabled"]);
const falseValues = new Set(["0", "false", "no", "off", "disabled"]);

const forbiddenStatementRules: Array<{
  id: string;
  label: string;
  pattern: RegExp;
  reason: string;
}> = [
  {
    id: "guaranteed_return",
    label: "No guaranteed returns",
    pattern: /\b(garantierte?\s+rendite|renditegarantie|guaranteed\s+return|guaranteed\s+yield|risk-free\s+investment|risikofrei(?:e|es|er)?\s+anlage)\b/i,
    reason: "Bots must not promise guaranteed returns or risk-free investments.",
  },
  {
    id: "financing_guarantee",
    label: "No financing guarantees",
    pattern: /\b(finanzierung\s+(?:ist\s+)??garantiert|finanzierungszusage\s+garantiert|guaranteed\s+financing|mortgage\s+approval\s+is\s+guaranteed)\b/i,
    reason: "Bots must not promise financing, mortgage approval or credit decisions.",
  },
  {
    id: "price_guarantee",
    label: "No price guarantees",
    pattern: /\b(preisgarantie|garantierter\s+verkaufspreis|guaranteed\s+(?:sale\s+)??price)\b/i,
    reason: "Bots must not promise fixed sale prices or valuation guarantees.",
  },
  {
    id: "legal_tax_advice",
    label: "No legal or tax advice",
    pattern: /\b(rechtsverbindliche\s+auskunft|steuerlich\s+verbindlich|legal\s+advice\s+is|tax\s+advice\s+is|notariats??vertrag\s+ist\s+garantiert)\b/i,
    reason: "Bots must not provide binding legal, notarial or tax advice.",
  },
];

const promptSafetyRules: Array<{
  id: string;
  label: string;
  pattern: RegExp;
  reason: string;
}> = [
  {
    id: "prompt_injection",
    label: "Prompt injection blocked",
    pattern:
      /\b(ignoriere|ignore|vergiss|forget|override|bypass|deaktiviere|disable)\b.*\b(regeln|rules|instructions|system prompt|developer message|policy|sicherheitsregeln)\b/i,
    reason: "Customer-facing bots must not follow attempts to override system, policy or knowledge rules.",
  },
  {
    id: "internet_browsing_requested",
    label: "Internet browsing blocked",
    pattern:
      /\b(browse|browser|google|internet|web\s*search|search\s+the\s+web|online\s+recherch|im\s+internet\s+suchen|live\s+preise|aktuelle\s+news)\b/i,
    reason: "Customer-facing bots cannot browse the internet and must use approved workspace or project knowledge.",
  },
];

const knowledgeRequiredPattern =
  /\b(preis|price|kosten|cost|rendite|yield|einheit|unit|verfügbar|verfuegbar|available|expose|expos[eé]|dokument|pdf|unterlage|broschüre|broschuere|brochure|grundriss|floor\s*plan|finanzierung|financing|vertrag|contract|termin|besichtigung|appointment|booking|meeting)\b/i;

export function getBotRuntimeControls(input?: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): BotRuntimeControls {
  const killSwitch =
    readBoolean(input?.killSwitch) ??
    readBoolean(input?.notAus) ??
    readBoolean(env.NOVALURE_BOT_KILL_SWITCH) ??
    readBoolean(env.NOVALURE_BOT_NOT_AUS) ??
    readBoolean(env.NOVALURE_BOT_DISABLED) ??
    false;
  const testMode =
    readBoolean(input?.testMode) ??
    readBoolean(input?.dryRun) ??
    readBoolean(env.NOVALURE_BOT_TEST_MODE) ??
    readBoolean(env.NOVALURE_BOT_DRY_RUN) ??
    false;
  const requireHumanApproval =
    readBoolean(input?.requireHumanApproval) ??
    readBoolean(env.NOVALURE_BOT_REQUIRE_HUMAN_APPROVAL) ??
    false;
  const strictKnowledge =
    readBoolean(input?.strictKnowledge) ??
    readBoolean(env.NOVALURE_BOT_STRICT_KNOWLEDGE) ??
    true;

  return {
    disabledReason: killSwitch ? "NOVALURE_BOT_KILL_SWITCH or NOVALURE_BOT_NOT_AUS is active" : null,
    killSwitch,
    requireHumanApproval,
    strictKnowledge,
    testMode,
  };
}

export function getBotPolicyRules(): BotPolicyRule[] {
  return [
    { effect: "block", id: "signed_webhooks", label: "Inbound channel webhooks need a Meta signature or the Novalure webhook secret." },
    { effect: "allow", id: "idempotency", label: "Duplicate channel webhook messages are stored once and not answered twice." },
    { effect: "allow", id: "reply", label: "Replies are autonomous when policy checks pass." },
    { effect: "allow", id: "crm_upsert", label: "Customer data is saved automatically outside test mode." },
    { effect: "allow", id: "knowledge", label: "Answers use approved workspace/project knowledge only." },
    { effect: "allow", id: "document", label: "Documents send only when approved and reachable through a public URL." },
    { effect: "allow", id: "meeting", label: "Appointments book only with a clear page, slot, date and contact." },
    { effect: "block", id: "forbidden_claims", label: "Guarantees, binding legal/tax advice and financing promises are blocked." },
    { effect: "test", id: "test_mode", label: "Test mode keeps the audit trail but blocks external side effects." },
  ];
}

export function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase();
  if (trueValues.has(normalized)) return true;
  if (falseValues.has(normalized)) return false;

  return undefined;
}

export function findForbiddenStatements(value: string): BotPolicyViolation[] {
  return forbiddenStatementRules
    .filter((rule) => rule.pattern.test(value))
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      reason: rule.reason,
    }));
}

export function findBotPromptViolations(value: string): BotPolicyViolation[] {
  return [...promptSafetyRules, ...forbiddenStatementRules]
    .filter((rule) => rule.pattern.test(value))
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      reason: rule.reason,
    }));
}

export function requiresApprovedKnowledge(prompt: string) {
  return knowledgeRequiredPattern.test(prompt);
}

export function buildSafeBotReply(input: {
  controls?: BotRuntimeControls;
  hasApprovedKnowledge?: boolean;
  language: LanguageCode;
  reason?: string;
  violations?: BotPolicyViolation[];
}) {
  if (input.controls?.killSwitch) {
    return input.language === "de"
      ? "Der Bot ist aktuell gestoppt. Ich habe die Nachricht protokolliert und führe keine automatische Aktion aus."
      : "The bot is currently stopped. I logged the message and will not execute an automated action.";
  }

  if (input.violations?.length) {
    const hasInternetRequest = input.violations.some((violation) => violation.id === "internet_browsing_requested");
    if (hasInternetRequest) {
      return input.language === "de"
        ? "Ich kann für Kundenantworten nicht frei im Internet recherchieren. Ich antworte nur aus freigegebenem Workspace- oder Projektwissen und übergebe die Anfrage bei fehlender Quelle an das Team."
        : "I cannot freely browse the internet for customer answers. I answer only from approved workspace or project knowledge and hand the request to the team when no approved source exists.";
    }

    const hasPromptInjection = input.violations.some((violation) => violation.id === "prompt_injection");
    if (hasPromptInjection) {
      return input.language === "de"
        ? "Diese Anweisung kann ich nicht ausführen. Ich halte mich an die freigegebenen Bot-Regeln und nutze nur geprüftes Workspace- oder Projektwissen."
        : "I cannot follow that instruction. I follow the approved bot rules and use only reviewed workspace or project knowledge.";
    }

    return input.language === "de"
      ? "Dazu kann ich keine verbindliche Zusage machen. Ich kann nur freigegebenes Projektwissen nutzen und bei Bedarf einen sicheren nächsten Schritt vorbereiten."
      : "I cannot make a binding promise on that. I can only use approved project knowledge and prepare a safe next step if needed.";
  }

  if (!input.hasApprovedKnowledge) {
    return input.language === "de"
      ? "Dazu habe ich aktuell keine freigegebene Wissensquelle. Ich kann Ihre Anfrage im CRM speichern und eine kurze Rückfrage oder einen Termin nach klaren Regeln vorbereiten."
      : "I do not currently have an approved knowledge source for that. I can save the enquiry in CRM and prepare a short follow-up question or appointment under clear rules.";
  }

  return input.language === "de"
    ? "Ich kann diese Anfrage nur innerhalb der freigegebenen Bot-Regeln beantworten."
    : "I can only answer this request within the approved bot rules.";
}

export function sanitizeBotReply(input: {
  controls: BotRuntimeControls;
  hasApprovedKnowledge: boolean;
  hasOperationalContext?: boolean;
  customerFacing?: boolean;
  language: LanguageCode;
  prompt: string;
  text: string;
}) {
  const outputViolations = findForbiddenStatements(input.text);
  const promptViolations = findBotPromptViolations(input.prompt);
  const promptRequiresKnowledge = requiresApprovedKnowledge(input.prompt);

  if (input.controls.killSwitch) {
    return {
      blocked: true,
      text: buildSafeBotReply({ controls: input.controls, language: input.language }),
      violations: outputViolations,
    };
  }

  if (promptViolations.length) {
    return {
      blocked: true,
      text: buildSafeBotReply({ language: input.language, violations: promptViolations }),
      violations: promptViolations,
    };
  }

  if (outputViolations.length) {
    return {
      blocked: true,
      text: buildSafeBotReply({ language: input.language, violations: outputViolations }),
      violations: outputViolations,
    };
  }

  if (
    input.controls.strictKnowledge &&
    (promptRequiresKnowledge || input.customerFacing) &&
    !input.hasApprovedKnowledge &&
    !input.hasOperationalContext
  ) {
    return {
      blocked: true,
      text: buildSafeBotReply({
        hasApprovedKnowledge: false,
        language: input.language,
        reason: "approved_knowledge_required",
      }),
      violations: [],
    };
  }

  return {
    blocked: false,
    text: input.text,
    violations: [],
  };
}

export function evaluateBotAction(input: {
  action: BotActionName;
  controls: BotRuntimeControls;
  document?: DocumentPolicyInput;
  hasApprovedKnowledge?: boolean;
  meeting?: MeetingPolicyInput;
  risk?: BotActionRisk;
}) {
  const risk = input.risk ?? defaultRiskForAction(input.action);
  const base: BotPolicyDecision = {
    action: input.action,
    allowed: true,
    auditOnly: true,
    mode: "allow",
    reason: "policy_allowed",
    requiresHumanApproval: input.controls.requireHumanApproval,
    risk,
  };

  if (input.controls.killSwitch) {
    return {
      ...base,
      allowed: false,
      mode: "block" as const,
      reason: "kill_switch_active",
      requiresHumanApproval: false,
    };
  }

  if (input.action !== "model_reply" && input.controls.testMode) {
    return {
      ...base,
      allowed: true,
      mode: "test" as const,
      reason: "test_mode_no_external_side_effects",
      requiresHumanApproval: false,
    };
  }

  if (
    input.controls.requireHumanApproval &&
    ["channel_reply", "crm_upsert", "document_send", "meeting_book"].includes(input.action)
  ) {
    return {
      ...base,
      allowed: false,
      mode: "block" as const,
      reason: "manual_approval_override",
      requiresHumanApproval: true,
    };
  }

  if (input.action === "knowledge_search") {
    return base;
  }

  if (input.action === "document_send") {
    if (!input.document?.approved) {
      return block(base, "document_not_approved");
    }

    if (!isPublicDocumentUrl(input.document.publicUrl)) {
      return block(base, "document_not_publicly_reachable");
    }

    if (!input.document.recipient) {
      return block(base, "document_recipient_missing");
    }
  }

  if (input.action === "meeting_book") {
    const meeting = input.meeting;
    if (!meeting?.slug || !meeting.selectedDate || !meeting.slot || !meeting.contactEmail || !meeting.contactName) {
      return block(base, "meeting_booking_rules_incomplete");
    }
  }

  if (
    input.controls.strictKnowledge &&
    ["channel_reply", "document_send", "meeting_book", "meeting_prepare"].includes(input.action) &&
    input.hasApprovedKnowledge === false &&
    input.action !== "meeting_book"
  ) {
    return {
      ...base,
      reason: "allowed_with_generic_safe_response_no_knowledge",
    };
  }

  return base;
}

export function isPublicDocumentUrl(value: string | null | undefined) {
  if (!value) return false;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;

    return !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

export function documentApprovedFromPayload(input: Record<string, unknown>) {
  return (
    input.documentApproved === true ||
    input.approved === true ||
    input.approval === "approved" ||
    input.approval === "Freigegeben" ||
    input.documentStatus === "approved"
  );
}

function block(decision: BotPolicyDecision, reason: string): BotPolicyDecision {
  return {
    ...decision,
    allowed: false,
    mode: "block",
    reason,
    requiresHumanApproval: false,
  };
}

function isPrivateOrLocalHostname(value: string) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;

  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function defaultRiskForAction(action: BotActionName): BotActionRisk {
  if (action === "document_send" || action === "meeting_book") return "high";
  if (action === "crm_upsert" || action === "meeting_prepare" || action === "channel_reply") return "medium";
  return "low";
}
