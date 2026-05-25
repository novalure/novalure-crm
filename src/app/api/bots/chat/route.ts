import { requirePermission } from "@/lib/auth/session";
import { getBotPrompt, runBotChat } from "@/lib/bots/chat-runtime";
import { listBotConversations, listBotMessages } from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { getModelProviderStatus } from "@/lib/integrations/model-provider";

export const maxDuration = 60;

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

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");

  if (conversationId) {
    const messages = await listBotMessages({
      session: auth.session,
      conversationId,
      limit: Number(url.searchParams.get("limit") ?? 50),
    });

    return Response.json({
      conversationId,
      messages,
      provider: getModelProviderStatus(),
      source: "database",
    });
  }

  const conversations = await listBotConversations({
    session: auth.session,
    limit: Number(url.searchParams.get("limit") ?? 25),
  });

  return Response.json({
    conversations,
    provider: getModelProviderStatus(),
    source: "database",
  });
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermission(request, "bots:run");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;

  if (!getBotPrompt(payload)) {
    return Response.json({ error: copy.promptRequired }, { status: 400 });
  }

  const result = await runBotChat({
    language,
    payload,
    requestUrl: request.url,
    session: auth.session,
  });

  return Response.json(result);
}
