import { z } from 'zod';
import { websiteProspectIdentitySchema } from './website-prospect.js';
import { canonicalWebsiteStudioDigest } from './website-sales-studio.js';

export const websiteSalesConversationContract = 'website-sales-conversation-v1' as const;
export const websiteSalesConversationTopicSchema = z.enum(['SERVICES', 'SCOPE', 'PRICE', 'DISCOUNT', 'TIMING', 'PROCESS', 'PROOF', 'PRIVACY',
  'OBJECTION_PRICE', 'OBJECTION_TIMING', 'OBJECTION_NEED', 'MEETING', 'ACCEPTANCE', 'LEGAL_OR_CONTRACT', 'GENERAL', 'UNKNOWN', 'OPT_OUT', 'OUT_OF_OFFICE']);
export type WebsiteSalesConversationTopic = z.infer<typeof websiteSalesConversationTopicSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/), timestamp = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(1_000), language = z.enum(['de', 'en']);

/** Closed rules are mirrored by the narrow CRM SQL projection and checked against the same corpus.
 * No email body or matched excerpt is returned. Neither a match nor sender text confers authority. */
export const websiteSalesConversationTopicRules: readonly Readonly<{ code: WebsiteSalesConversationTopic; pattern: string }>[] = Object.freeze([
  { code: 'OPT_OUT', pattern: '(unsubscribe|opt[ -]?out|remove me|do not contact|stop emailing|abmelden|keine (weiteren )?(mails|emails|nachrichten)|nicht mehr kontaktieren|widerspreche)' },
  { code: 'OUT_OF_OFFICE', pattern: '(out of office|automatic reply|on leave|abwesenheitsnotiz|nicht im b[üu]ro)' },
  { code: 'LEGAL_OR_CONTRACT', pattern: '(contract|vertrag|signature|legal advice|lawyer|rechtsberatung|haftung)' },
  { code: 'OBJECTION_PRICE', pattern: '(too (expensive|costly)|price (is )?too high|zu teuer|preis.{0,30}zu hoch)' },
  { code: 'OBJECTION_TIMING', pattern: '(no time|not now|kein[e]? zeit|derzeit nicht|sp[äa]ter)' },
  { code: 'OBJECTION_NEED', pattern: '(already have|no need|don.t need|kein(en)? bedarf|haben (bereits|schon)|nicht einverstanden|(ich nehme|wir nehmen).{0,60}nicht an|(i|we) (do not|don.t) (accept|agree)|not agreed)' },
  { code: 'ACCEPTANCE', pattern: '(i accept|we accept|agreed|ich nehme (ihr|das|dieses) (angebot|konzept).{0,40} an|wir nehmen (ihr|das|dieses) (angebot|konzept).{0,40} an|einverstanden)' },
  { code: 'DISCOUNT', pattern: '(discount|rabatt|cheaper|g[üu]nstiger|budget)' },
  { code: 'PRICE', pattern: '(price|pricing|cost|quote|preis|kosten|angebot)' },
  { code: 'PRIVACY', pattern: '(privacy|personal data|data protection|datenschutz|personenbezogen)' },
  { code: 'PROOF', pattern: '(reference|example|portfolio|case study|referenz|beispiel)' },
  { code: 'TIMING', pattern: '(when|timeline|deadline|how long|wann|dauer|lieferzeit|terminplan)' },
  { code: 'MEETING', pattern: '(meeting|appointment|call|gespr[äa]ch|besprechung|termin)' },
  { code: 'SCOPE', pattern: '(included|include|scope|feature|umfang|enthalten|leistung)' },
  { code: 'PROCESS', pattern: '(process|next step|how does|ablauf|n[äa]chste[rs]? schritt|wie funktioniert)' },
  { code: 'SERVICES', pattern: '(service|website|webseite|webdesign|what do you|was bieten)' },
]);
export const websiteSalesConversationUnsafePattern = '(ignore|override|bypass).{0,80}(previous|system|developer|instruction|rule|approval|policy)|system[ ]*prompt|developer[ ]*message|-----begin.{0,30}private key|postgres(ql)?://|sk-[a-z0-9_-]{16,}|bearer[ ]+[a-z0-9._-]{16,}';
export const websiteSalesConversationQuoteHeaderPattern = '^(on .+wrote:|am .+schrieb.*:|le .+[ée]crit.*:|from:|von:|-{2,}[ ]*(original|forwarded|weitergeleitete))';
export interface WebsiteSalesExtractedTopic {
  topicCode: WebsiteSalesConversationTopic; language: 'de' | 'en';
  basis: 'BOUNDED_RULES' | 'UNCLASSIFIED'; blockedReason: 'CONTENT_LIMIT' | 'UNTRUSTED_INSTRUCTION' | 'NO_SUPPORTED_TOPIC' | null;
}
export function extractWebsiteSalesConversationTopic(raw: unknown, preferredLanguage: 'de' | 'en' = 'en'): WebsiteSalesExtractedTopic {
  const selectedLanguage = language.parse(preferredLanguage);
  const unknown = (blockedReason: WebsiteSalesExtractedTopic['blockedReason']): WebsiteSalesExtractedTopic => ({ topicCode: 'UNKNOWN', language: selectedLanguage, basis: 'UNCLASSIFIED', blockedReason });
  if (typeof raw !== 'string' || raw.length > 16_000 || raw.includes('\u0000')) return unknown('CONTENT_LIMIT');
  const lines: string[] = [];
  for (const line of raw.normalize('NFKC').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const trimmed = line.trim();
    if (new RegExp(websiteSalesConversationQuoteHeaderPattern, 'iu').test(trimmed)) break;
    if (!trimmed.startsWith('>')) lines.push(trimmed);
  }
  const candidate = lines.join(' ').replaceAll('’', "'").replace(/\s+/gu, ' ').toLowerCase();
  const optOut = websiteSalesConversationTopicRules[0]!;
  if (new RegExp(optOut.pattern, 'iu').test(candidate)) return { topicCode: 'OPT_OUT', language: selectedLanguage, basis: 'BOUNDED_RULES', blockedReason: null };
  if (new RegExp(websiteSalesConversationUnsafePattern, 'iu').test(candidate)) return unknown('UNTRUSTED_INSTRUCTION');
  const match = websiteSalesConversationTopicRules.slice(1).find(rule => new RegExp(rule.pattern, 'iu').test(candidate));
  return match ? { topicCode: match.code, language: selectedLanguage, basis: 'BOUNDED_RULES', blockedReason: null } : unknown('NO_SUPPORTED_TOPIC');
}

export const websiteSalesAnswerFactSchema = z.strictObject({
  id: z.uuid(), identity: websiteProspectIdentitySchema, version: z.number().int().positive(), topicCode: websiteSalesConversationTopicSchema,
  kind: z.enum(['SOURCE_FACT', 'CATALOG_FACT', 'PRICE_QUOTE', 'SCOPE_FACT', 'PROCESS_FACT']), text,
  sourceReference: z.string().trim().min(1).max(500), sourceDigest: digest, observedAt: timestamp, validUntil: timestamp,
  approvedBy: z.uuid(), approvedAt: timestamp, classification: z.enum(['PUBLIC_BUSINESS', 'APPROVED_SALES']),
});
export type WebsiteSalesAnswerFact = z.infer<typeof websiteSalesAnswerFactSchema>;
export const websiteSalesConversationQuoteSchema = z.strictObject({
  quoteId: z.uuid(), identity: websiteProspectIdentitySchema, version: z.number().int().positive(), digest,
  offerId: z.uuid(), offerVersion: z.number().int().positive(), scopeDigest: digest,
  netPriceMinor: z.number().int().nonnegative().safe(), currency: z.literal('EUR'), validUntil: timestamp,
});
export type WebsiteSalesConversationQuote = z.infer<typeof websiteSalesConversationQuoteSchema>;
export function websiteSalesConversationQuoteText(raw: unknown, selectedLanguage: 'de' | 'en'): string {
  const quote = websiteSalesConversationQuoteSchema.parse(raw), cents = BigInt(quote.netPriceMinor);
  const amount = `${cents / BigInt(100)}.${(cents % BigInt(100)).toString().padStart(2, '0')}`;
  return `${language.parse(selectedLanguage) === 'de' ? 'Preisvorschlag netto' : 'Proposed net price'}: EUR ${amount}`;
}
export const websiteSalesConversationInputSchema = z.strictObject({
  identity: websiteProspectIdentitySchema, workflowVersion: z.number().int().positive(), evidenceDigest: digest,
  conversationVersion: z.number().int().nonnegative(), expectedFactsDigest: digest,
  topic: z.strictObject({ id: z.uuid(), code: websiteSalesConversationTopicSchema, messageId: z.uuid().nullable(), sourceHash: digest.nullable(),
    sourceKind: z.enum(['CANONICAL_TOPIC_EXTRACTION', 'HUMAN_RECORDED_TOPIC']), language }),
  facts: z.array(websiteSalesAnswerFactSchema).max(100), hardStop: z.boolean(), quoteBinding: websiteSalesConversationQuoteSchema.nullable(),
  previousAnswers: z.array(z.strictObject({ topicTurnId: z.uuid(), messageId: z.uuid().nullable(), sourceHash: digest.nullable(), factsDigest: digest, draftDigest: digest })).max(100),
}).superRefine((value, ctx) => {
  const equal = (other: unknown) => canonicalWebsiteStudioDigest(other) === canonicalWebsiteStudioDigest(value.identity);
  if (value.facts.some(fact => !equal(fact.identity)) || value.quoteBinding && !equal(value.quoteBinding.identity))
    ctx.addIssue({ code: 'custom', message: 'SALES_CONVERSATION_FOREIGN_SCOPE' });
  if (value.topic.sourceKind === 'CANONICAL_TOPIC_EXTRACTION' && (!value.topic.messageId || !value.topic.sourceHash))
    ctx.addIssue({ code: 'custom', message: 'SALES_CONVERSATION_CANONICAL_SOURCE_REQUIRED' });
});
export type WebsiteSalesConversationInput = z.infer<typeof websiteSalesConversationInputSchema>;
export interface WebsiteSalesConversationDraft {
  contractVersion: typeof websiteSalesConversationContract;
  identity: WebsiteSalesConversationInput['identity']; workflowVersion: number; evidenceDigest: string; conversationVersion: number;
  topicTurnId: string; sourceMessageId: string | null; sourceHash: string | null;
  status: 'DRAFT_READY' | 'WAITING_FOR_FACTS' | 'WAITING_FOR_CUSTOMER' | 'STOPPED' | 'HUMAN_REVIEW_REQUIRED';
  nextAction: 'ANSWER_QUESTION' | 'REQUEST_FACTS' | 'PROPOSE_COUNTEROFFER' | 'PROPOSE_MEETING' | 'RECORD_CUSTOMER_ATTESTATION' | 'REVIEW_LEGAL' | 'AWAIT_CUSTOMER' | 'REVIEW_ABSENCE' | 'STOP_CONTACT';
  language: 'de' | 'en'; body: string | null; factsDigest: string; factReferences: { id: string; version: number; sourceDigest: string }[];
  quoteBinding: WebsiteSalesConversationQuote | null; requiresOfferApproval: boolean; canSend: false;
  duplicateOfDigest: string | null; draftDigest: string;
}

function safeFact(fact: WebsiteSalesAnswerFact, now: number): boolean {
  const reference = fact.sourceReference;
  if (!/^(https:\/\/|crm[-:]|operator-approved:)/u.test(reference)) return false;
  if (reference.startsWith('https://')) {
    try { const url = new URL(reference); if (url.username || url.password || url.hash || url.search) return false; } catch { return false; }
  }
  const guardedText = `${fact.text} ${reference}`;
  if (new RegExp(websiteSalesConversationUnsafePattern, 'iu').test(guardedText) || /\b(?:api[_ -]?key|password|secret|token)\s*[:=]/iu.test(guardedText)) return false;
  return Date.parse(fact.observedAt) <= now && Date.parse(fact.approvedAt) <= now && Date.parse(fact.validUntil) > now
    && Date.parse(fact.validUntil) > Date.parse(fact.observedAt);
}
export function websiteSalesConversationFactsDigest(rawFacts: unknown, rawQuote: unknown, now: string): string {
  const time = Date.parse(timestamp.parse(now)), facts = z.array(websiteSalesAnswerFactSchema).max(100).parse(rawFacts);
  const quote = websiteSalesConversationQuoteSchema.nullable().parse(rawQuote);
  if (new Set(facts.map(fact => fact.id)).size !== facts.length) throw new Error('SALES_CONVERSATION_DUPLICATE_FACT');
  return canonicalWebsiteStudioDigest({ facts: facts.filter(fact => safeFact(fact, time)).sort((a, b) => a.id.localeCompare(b.id)),
    quoteBinding: quote && Date.parse(quote.validUntil) > time ? quote : null });
}

/** Uses only server-assembled approved facts and topic metadata. No private mail, tools or provider is needed. */
export function prepareWebsiteSalesConversationDraft(raw: unknown, now: string): WebsiteSalesConversationDraft {
  const input = websiteSalesConversationInputSchema.parse(raw), time = Date.parse(timestamp.parse(now));
  const factsDigest = websiteSalesConversationFactsDigest(input.facts, input.quoteBinding, now);
  if (factsDigest !== input.expectedFactsDigest) throw new Error('SALES_CONVERSATION_FACTS_CHANGED');
  const duplicate = input.previousAnswers.find(prior => prior.factsDigest === factsDigest && prior.sourceHash === input.topic.sourceHash
    && prior.messageId === input.topic.messageId && (prior.topicTurnId === input.topic.id || input.topic.messageId !== null));
  const common = { contractVersion: websiteSalesConversationContract, identity: input.identity, workflowVersion: input.workflowVersion,
    evidenceDigest: input.evidenceDigest, conversationVersion: input.conversationVersion, topicTurnId: input.topic.id,
    sourceMessageId: input.topic.messageId, sourceHash: input.topic.sourceHash, language: input.topic.language,
    factsDigest, factReferences: [] as WebsiteSalesConversationDraft['factReferences'], quoteBinding: null as WebsiteSalesConversationQuote | null,
    requiresOfferApproval: false, canSend: false as const, duplicateOfDigest: null as string | null };
  const finish = (details: Pick<WebsiteSalesConversationDraft, 'status' | 'nextAction' | 'body'> & Partial<Pick<WebsiteSalesConversationDraft,
    'factReferences' | 'quoteBinding' | 'requiresOfferApproval' | 'duplicateOfDigest'>>): WebsiteSalesConversationDraft => {
    const draft = { ...common, ...details }; return { ...draft, draftDigest: canonicalWebsiteStudioDigest(draft) };
  };
  if (input.hardStop || input.topic.code === 'OPT_OUT') return finish({ status: 'STOPPED', nextAction: 'STOP_CONTACT', body: null });
  if (duplicate) return finish({ status: 'WAITING_FOR_CUSTOMER', nextAction: 'AWAIT_CUSTOMER', body: null, duplicateOfDigest: duplicate.draftDigest });
  if (input.topic.code === 'OUT_OF_OFFICE') return finish({ status: 'WAITING_FOR_CUSTOMER', nextAction: 'REVIEW_ABSENCE', body: null });
  if (input.topic.code === 'LEGAL_OR_CONTRACT') return finish({ status: 'HUMAN_REVIEW_REQUIRED', nextAction: 'REVIEW_LEGAL', body: null });
  if (input.topic.code === 'ACCEPTANCE') return finish({ status: 'HUMAN_REVIEW_REQUIRED', nextAction: 'RECORD_CUSTOMER_ATTESTATION', body: null });
  const de = input.topic.language === 'de';
  const clarification = () => finish({ status: 'WAITING_FOR_FACTS', nextAction: 'REQUEST_FACTS',
    body: de ? 'Danke für Ihre Nachricht. Welche konkrete Frage oder Anforderung sollen wir als Nächstes klären?' : 'Thank you for your message. Which specific question or requirement should we clarify next?' });
  if (input.topic.code === 'UNKNOWN' || input.topic.code === 'GENERAL') return clarification();
  const aliases: Partial<Record<WebsiteSalesConversationTopic, WebsiteSalesConversationTopic>> = {
    OBJECTION_PRICE: 'PRICE', DISCOUNT: 'PRICE', OBJECTION_TIMING: 'TIMING', OBJECTION_NEED: 'SCOPE', MEETING: 'PROCESS' };
  const selectedTopic = aliases[input.topic.code] ?? input.topic.code;
  const priceTopic = ['PRICE', 'DISCOUNT', 'OBJECTION_PRICE'].includes(input.topic.code);
  const quote = input.quoteBinding && Date.parse(input.quoteBinding.validUntil) > time ? input.quoteBinding : null;
  const matching = input.facts.filter(fact => safeFact(fact, time) && fact.topicCode === selectedTopic
    && (!priceTopic || fact.kind === 'PRICE_QUOTE' && quote && fact.sourceReference === `crm-quote:${quote.quoteId}:v${quote.version}`
      && fact.sourceDigest === quote.digest)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 3);
  if (!matching.length) return clarification();
  const introduction = de ? 'Danke für Ihre Rückfrage. Folgende Angaben sind für diesen Vorgang belegt:' : 'Thank you for your question. The following information is supported for this enquiry:';
  const closing = de ? 'Passt dieser nächste Schritt zu Ihrem Vorhaben?' : 'Does this next step fit your plans?';
  const priceNotice = priceTopic ? de ? '\n\nUnverbindlicher Entwurf; ein finales Angebot benötigt die zugehörige Freigabe.' : '\n\nNon-binding draft; a final offer requires its corresponding approval.' : '';
  const supportedText = priceTopic ? websiteSalesConversationQuoteText(quote, input.topic.language) : matching.map(fact => fact.text).join('\n\n');
  return finish({ status: 'DRAFT_READY', nextAction: ['OBJECTION_PRICE', 'DISCOUNT'].includes(input.topic.code) ? 'PROPOSE_COUNTEROFFER'
    : input.topic.code === 'MEETING' ? 'PROPOSE_MEETING' : 'ANSWER_QUESTION', body: `${introduction}\n\n${supportedText}${priceNotice}\n\n${closing}`,
    factReferences: matching.map(fact => ({ id: fact.id, version: fact.version, sourceDigest: fact.sourceDigest })),
    quoteBinding: priceTopic ? quote : null, requiresOfferApproval: priceTopic });
}
