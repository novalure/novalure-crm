import { crmBotTools } from "@/lib/crm-source";
import type { CrmBotTool } from "@/lib/crm-types";

export type CrmBotToolExecution =
  | {
      tool: "search_approved_knowledge";
      query: string;
      sources: Array<{ title: string; url: string; confidence: number }>;
    }
  | {
      tool: "load_conversation_history";
      conversationId?: string;
      contactId?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }
  | {
      tool: "qualify_lead";
      score: number;
      stage: "qualified" | "follow_up";
      summary: string;
    }
  | {
      tool: "capture_customer_data";
      contact: {
        consent: string;
        email?: string;
        name?: string;
        phone?: string;
        preferredChannel?: string;
      };
      status: "captured";
    }
  | {
      tool: "find_meeting_slots";
      meetingPage?: string;
      slots: Array<{ date: string; label: string; value: string }>;
    }
  | {
      tool: "book_meeting";
      booking: {
        contactEmail?: string;
        contactName?: string;
        meetingPage?: string;
        slot?: string;
      };
      status: "ready_to_book";
    }
  | {
      tool: "send_document";
      documentId?: string;
      documentName: string;
      channel: string;
      status: "policy_checked";
    }
  | {
      tool: "send_channel_reply";
      channel: string;
      message: string;
      status: "ready_to_send";
    }
  | {
      tool: "send_whatsapp_template";
      templateName: string;
      status: "template_policy_checked";
      variables: Record<string, string>;
    }
  | {
      tool: "create_email_draft";
      subject: string;
      body: string;
      status: "draft_ready";
    };

export function listCrmBotTools(): CrmBotTool[] {
  return crmBotTools;
}

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function runCrmBotTool(toolName: string, input: Record<string, unknown>): CrmBotToolExecution {
  if (toolName === "search_approved_knowledge") {
    return {
      tool: "search_approved_knowledge",
      query: String(input.query || ""),
      sources: [
        { title: "Wohnpark Graz Expose", url: "/knowledge/wohnpark-graz", confidence: 0.86 },
        { title: "Pricing and units", url: "/knowledge/pricing-units", confidence: 0.8 },
      ],
    };
  }

  if (toolName === "load_conversation_history") {
    return {
      tool: "load_conversation_history",
      conversationId: typeof input.conversationId === "string" ? input.conversationId : undefined,
      contactId: typeof input.contactId === "string" ? input.contactId : undefined,
      messages: [
        { role: "user", content: "I want to understand whether this project fits my budget." },
        { role: "assistant", content: "I will check intent, timing and approved project information first." },
      ],
    };
  }

  if (toolName === "qualify_lead") {
    const budget = String(input.budget || "");
    const need = String(input.need || "Customer needs follow-up.");

    return {
      tool: "qualify_lead",
      score: budget.includes("450") || budget.includes("500") ? 84 : 64,
      stage: budget.includes("450") || budget.includes("500") ? "qualified" : "follow_up",
      summary: `Need: ${need}`,
    };
  }

  if (toolName === "capture_customer_data") {
    return {
      tool: "capture_customer_data",
      contact: {
        consent: asOptionalString(input.consent) ?? "pending",
        email: asOptionalString(input.email),
        name: asOptionalString(input.name) ?? asOptionalString(input.leadName),
        phone: asOptionalString(input.phone),
        preferredChannel: asOptionalString(input.preferredChannel) ?? asOptionalString(input.channel),
      },
      status: "captured",
    };
  }

  if (toolName === "find_meeting_slots") {
    const meetingPage = asOptionalString(input.meetingPage) ?? "pipeline-audit";

    return {
      tool: "find_meeting_slots",
      meetingPage,
      slots: [
        { date: "2026-05-18", label: "18.05.2026, 10:00", value: "2026-05-18T10:00:00+02:00" },
        { date: "2026-05-18", label: "18.05.2026, 14:30", value: "2026-05-18T14:30:00+02:00" },
        { date: "2026-05-19", label: "19.05.2026, 09:30", value: "2026-05-19T09:30:00+02:00" },
      ],
    };
  }

  if (toolName === "book_meeting") {
    return {
      tool: "book_meeting",
      booking: {
        contactEmail: asOptionalString(input.contactEmail) ?? asOptionalString(input.email),
        contactName: asOptionalString(input.contactName) ?? asOptionalString(input.leadName),
        meetingPage: asOptionalString(input.meetingPage) ?? "pipeline-audit",
        slot: asOptionalString(input.slot),
      },
      status: "ready_to_book",
    };
  }

  if (toolName === "send_document") {
    return {
      tool: "send_document",
      channel: asOptionalString(input.channel) ?? "Webchat",
      documentId: asOptionalString(input.documentId) ?? asOptionalString(input.mediaAssetId),
      documentName: asOptionalString(input.documentName) ?? "Freigegebenes Dokument",
      status: "policy_checked",
    };
  }

  if (toolName === "send_channel_reply") {
    return {
      tool: "send_channel_reply",
      channel: asOptionalString(input.channel) ?? "Webchat",
      message: asOptionalString(input.message) ?? asOptionalString(input.prompt) ?? "Danke, ich prüfe das und melde mich mit dem nächsten Schritt.",
      status: "ready_to_send",
    };
  }

  if (toolName === "send_whatsapp_template") {
    return {
      tool: "send_whatsapp_template",
      templateName: asOptionalString(input.templateName) ?? "lead_follow_up",
      status: "template_policy_checked",
      variables: {
        contactName: asOptionalString(input.contactName) ?? asOptionalString(input.leadName) ?? "Kontakt",
        nextStep: asOptionalString(input.nextStep) ?? "Termin abstimmen",
      },
    };
  }

  return {
    tool: "create_email_draft",
    subject: `Next step for ${String(input.leadName || "your enquiry")}`,
    body: `Hello ${String(input.leadName || "there")}, thank you for the context. I suggest ${String(input.nextStep || "a short follow-up call")} as the next step.`,
    status: "draft_ready",
  };
}
