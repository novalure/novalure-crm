import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { botChannelConnectors, botSelfServeSetup } from "@/lib/bots/omnichannel";
import { getBotPolicyRules, getBotRuntimeControls } from "@/lib/bots/policy";
import {
  listBotChannelAccounts,
  listBotChannelWebhookEvents,
  upsertBotChannelAccount,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";

export const maxDuration = 30;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "bots:run");
  if (!auth.ok) return auth.response;

  const recentWebhookEvents = await listBotChannelWebhookEvents({
    session: auth.session,
    limit: 12,
  });
  const channelAccounts = await listBotChannelAccounts({
    session: auth.session,
  });

  return NextResponse.json({
    autonomyControls: getBotRuntimeControls(),
    channelAccounts,
    connectors: botChannelConnectors,
    policyRules: getBotPolicyRules(),
    recentWebhookEvents,
    selfServeSetup: botSelfServeSetup,
    webhookSecretHeader: "x-novalure-webhook-secret",
  });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const channel = typeof input.channel === "string" ? input.channel : "";
  const connector = botChannelConnectors.find((item) => item.channel === channel);

  if (!connector) {
    return NextResponse.json({ error: "Unsupported bot channel" }, { status: 400 });
  }

  const accessToken = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
  const phoneNumberId = typeof input.phoneNumberId === "string" ? input.phoneNumberId.trim() : "";
  const whatsappBusinessAccountId =
    typeof input.whatsappBusinessAccountId === "string" ? input.whatsappBusinessAccountId.trim() : "";
  const pageId = typeof input.pageId === "string" ? input.pageId.trim() : "";
  const instagramAccountId = typeof input.instagramAccountId === "string" ? input.instagramAccountId.trim() : "";
  const graphVersion =
    typeof input.graphVersion === "string" && input.graphVersion.trim() ? input.graphVersion.trim() : "v23.0";
  const externalAccountId =
    channel === "WhatsApp"
      ? phoneNumberId
      : channel === "Instagram"
        ? instagramAccountId || pageId
        : channel === "Facebook Messenger"
          ? pageId
          : typeof input.externalAccountId === "string"
            ? input.externalAccountId.trim()
            : "";
  const shouldPersist = Boolean(accessToken && externalAccountId);
  const accountId = shouldPersist
    ? await upsertBotChannelAccount({
        active: true,
        accountLabel: typeof input.accountLabel === "string" ? input.accountLabel : connector.provider,
        botId: typeof input.botId === "string" ? input.botId : null,
        channel: connector.channel,
        complianceNote: connector.complianceNote,
        credentials: {
          accessToken,
          graphVersion,
          instagramAccountId,
          pageId,
          phoneNumberId,
          whatsappBusinessAccountId,
        },
        externalAccountId,
        inboundMode: connector.inboundMode,
        metadata: {
          connectedBy: auth.session.email,
          connectedAt: new Date().toISOString(),
          customerOwnedAccount: true,
        },
        outboundMode: connector.outboundMode,
        provider: connector.provider,
        session: auth.session,
        setupStatus: "connected",
        webhookPath: connector.webhookPath,
      })
    : null;
  const connection = {
    id: accountId ?? crypto.randomUUID(),
    active: Boolean(accountId),
    botId: typeof input.botId === "string" ? input.botId : null,
    channel: connector.channel,
    complianceNote: connector.complianceNote,
    externalAccountId: externalAccountId || null,
    inboundMode: connector.inboundMode,
    outboundMode: connector.outboundMode,
    provider: connector.provider,
    setupStatus: accountId ? "connected" : "ready",
    setupSteps: connector.setupSteps,
    webhookPath: connector.webhookPath,
  };

  await writeAuditLog({
    session: auth.session,
    action: "bot_channel.connection_prepared",
    entityType: "bot_channel_account",
    entityId: null,
    after: connection,
  });

  return NextResponse.json({
    connection,
    persisted: Boolean(accountId),
    status: accountId ? "connected" : "ready_for_customer_setup",
  }, { status: 201 });
}
