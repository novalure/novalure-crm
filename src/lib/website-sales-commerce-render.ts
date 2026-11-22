import 'server-only';
import { parseOfferContent } from './offer-workflow';
/** Every approved offer field is included. No provider or caller supplies the rendered terms. */
export function renderCanonicalWebsiteSalesOffer(raw: unknown, total: string | number) {
 const c = parseOfferContent(raw), money = (amount: number | string) => { const n = BigInt(amount); return `${n / BigInt(100)}.${String(n % BigInt(100)).padStart(2, '0')} EUR net`; };
 return [c.subject, `${c.recipientName}\n${c.recipientEmail}`, `Scope\n${c.scope}`, `Items\n${c.items.map(item => `${item.quantity} × ${item.description} — ${money(item.unitNetCents)} per unit`).join('\n')}`,
  `Net total\n${money(total)}`, `Discounts\n${c.discounts}`, `Payment plan\n${c.paymentPlan}`, `Special terms\n${c.specialTerms}`, `Risk and compliance notes\n${c.riskComplianceNotes}`, `Terms\n${c.terms}`, `Valid until\n${c.validUntil}`].join('\n\n');
}
