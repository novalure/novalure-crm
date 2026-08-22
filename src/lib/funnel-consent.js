/**
 * @typedef {{ analytics: boolean, marketing: boolean, privacy: boolean }} FunnelConsentCategories
 */

/**
 * Keep public rendering and server persistence on the same consent classifier.
 *
 * @param {{ crmField: string, helpText?: string, label: string }} field
 * @returns {Readonly<FunnelConsentCategories>}
 */
export function getFunnelConsentCategories(field) {
  const intent = `${field.crmField} ${field.label} ${field.helpText ?? ""}`.toLowerCase();
  const analytics = /(analytics|tracking|cookie|pixel|capi|utm|analyse)/iu.test(intent);
  const marketing = /(marketing|newsletter|whatsapp|instagram|outreach|werbung|kampagne)/iu.test(intent);
  const explicitPrivacy = /(privacy|datenschutz|dsgvo|gdpr|terms|bedingungen)/iu.test(intent);

  return {
    analytics,
    marketing,
    privacy: explicitPrivacy || (!analytics && !marketing),
  };
}
