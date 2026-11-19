import 'server-only';
import type {IntegrationConfiguration} from './crm-integrations';
import {resendWebhookConfigured} from './resend-webhooks';
export function integrationConfiguration(env:NodeJS.ProcessEnv=process.env):IntegrationConfiguration{
 const shared=!!env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim()&&Buffer.byteLength(env.OAUTH_STATE_SECRET?.trim()??'','utf8')>=32;
 return {google:shared&&!!env.GOOGLE_CLIENT_ID?.trim()&&!!env.GOOGLE_CLIENT_SECRET?.trim(),microsoft:shared&&!!env.MICROSOFT_CLIENT_ID?.trim()&&!!env.MICROSOFT_CLIENT_SECRET?.trim(),resend:!!env.RESEND_API_KEY?.trim(),resendWebhook:resendWebhookConfigured(env.RESEND_WEBHOOK_SECRET??'')};
}
