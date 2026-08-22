export const newsletterUnsubscribeUrlToken = "{{NOVALURE_UNSUBSCRIBE_URL}}";
export const resendUnsubscribeUrlToken = "{{{RESEND_UNSUBSCRIBE_URL}}}";

const replaceableNewsletterUnsubscribeTokens = [
  newsletterUnsubscribeUrlToken,
  resendUnsubscribeUrlToken,
] as const;

export function hasReplaceableNewsletterUnsubscribeToken(html: string) {
  return replaceableNewsletterUnsubscribeTokens.some((token) => html.includes(token));
}

export function replaceNewsletterUnsubscribeToken(html: string, unsubscribeUrl: string) {
  return replaceableNewsletterUnsubscribeTokens.reduce(
    (rendered, token) => rendered.replaceAll(token, unsubscribeUrl),
    html,
  );
}
