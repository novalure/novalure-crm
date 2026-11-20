import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decideWebsiteInvestment, qualifyWebsiteProspect, websiteProspectIdentitySchema,
  type WebsiteInvestmentInput, type WebsiteProspectIdentity, type WebsiteProspectInput } from './website-prospect.js';

export const websiteStudioContract = 'website-sales-studio-v1' as const;
const sha = z.hash('sha256');
const at = z.iso.datetime({ offset: true });
const privateContent = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk-)[a-zA-Z0-9_-]{20,}|(?:postgres(?:ql)?|mysql|mongodb):\/\/|\b(?:password|secret|api[_ -]?key|authorization|cookie|access_token)\s*[:=]|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
const text = z.string().trim().min(1).max(1_000).refine(value => !privateContent.test(value), 'Private or credential content is not allowed');
const list = z.array(text).min(1).max(12);
const claim = z.strictObject({ text, evidenceIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20) });
const scope = z.strictObject({ included: list, excluded: list });
const revision = z.strictObject({ version: z.number().int().positive().max(100_000), previousArtifactDigest: sha.nullable() })
  .refine(value => value.version === 1 ? value.previousArtifactDigest === null : value.previousArtifactDigest !== null, 'Revision predecessor required');
const decision = z.strictObject({ stage: z.enum(['DIAGNOSIS', 'CONCEPT', 'DEMO']), requestedStageAllowed: z.boolean(),
  reasons: z.array(z.string()), estimatedMarginBasisPoints: z.number().int().nullable(), externalEffectAllowed: z.literal(false), spendAuthorized: z.literal(false) });
const assetPolicy = { mode: 'ORIGINAL_PLACEHOLDERS_ONLY' as const, customerAssetsIncluded: false as const,
  reference: 'Customer assets are excluded; only original local placeholders may be rendered' as const };
const assetPolicySchema = z.strictObject({ mode: z.literal(assetPolicy.mode), customerAssetsIncluded: z.literal(false), reference: z.literal(assetPolicy.reference) });
const base = { contractVersion: z.literal(websiteStudioContract), identity: websiteProspectIdentitySchema, identityKey: sha, evidenceDigest: sha,
  version: revision.shape.version, previousArtifactDigest: sha.nullable(), parentArtifactDigest: sha.nullable(), createdAt: at, validUntil: at,
  artifactDigest: sha, externalEffectAllowed: z.literal(false), spendAuthorized: z.literal(false) };
const diagnosisContent = z.strictObject({ companyName: text, locationLabel: text, findings: z.array(claim).min(1).max(50),
  recommendations: z.array(claim).min(1).max(12), scope, assetPolicy: assetPolicySchema, investmentPlan: z.unknown(), investmentDecision: decision });
const conceptContent = z.strictObject({ companyName: text, locationLabel: text, objective: text, hero: claim,
  sections: z.array(z.strictObject({ title: text, body: claim })).min(1).max(6), scope,
  visualDirection: z.enum(['STUDIO_BLUE', 'BOTANICAL_GREEN', 'CRAFT_OCHRE']), assetPolicy: assetPolicySchema, investmentPlan: z.unknown(), investmentDecision: decision });
export const websiteDiagnosisArtifactSchema = z.strictObject({ ...base, kind: z.literal('DIAGNOSIS'), content: diagnosisContent });
export const websiteConceptArtifactSchema = z.strictObject({ ...base, kind: z.literal('CONCEPT'), content: conceptContent });
const assetSchema = z.strictObject({ path: z.enum(['studio.css', 'placeholder.svg']), mediaType: z.enum(['text/css', 'image/svg+xml']),
  body: z.string().min(1).max(20_000), sha256: sha,
  rights: z.strictObject({ basis: z.enum(['ORIGINAL_NOVALURE', 'PLACEHOLDER']), reference: text }) });
const demoContent = z.strictObject({ concept: websiteConceptArtifactSchema, acceptanceId: z.uuid(), acceptedAt: at,
  html: z.string().min(1).max(100_000), htmlDigest: sha, assets: z.array(assetSchema).length(2), assetManifestDigest: sha,
  investmentPlan: z.unknown(), investmentDecision: decision,
  interactions: z.literal('INERT_SIMULATIONS_ONLY'), indexable: z.literal(false), externallyAccessible: z.literal(false) });
export const websiteDemoArtifactSchema = z.strictObject({ ...base, kind: z.literal('DEMO'), content: demoContent });
/** Structural parsing alone is not approval. Always use verifyWebsiteStudioArtifact and current server-owned parent/acceptance rows. */
export const websiteStudioArtifactSchema = z.discriminatedUnion('kind', [websiteDiagnosisArtifactSchema, websiteConceptArtifactSchema, websiteDemoArtifactSchema]);
export type WebsiteDiagnosisArtifact = z.infer<typeof websiteDiagnosisArtifactSchema>;
export type WebsiteConceptArtifact = z.infer<typeof websiteConceptArtifactSchema>;
export type WebsiteDemoArtifact = z.infer<typeof websiteDemoArtifactSchema>;
export type WebsiteStudioArtifact = z.infer<typeof websiteStudioArtifactSchema>;
export type WebsiteStudioClaim = z.infer<typeof claim>;
export type WebsiteStudioScope = z.infer<typeof scope>;
export type WebsiteStudioRevision = z.infer<typeof revision>;
export type WebsiteStudioAsset = z.infer<typeof assetSchema>;
export class WebsiteStudioError extends Error { constructor(readonly code: string) { super(code); this.name = 'WebsiteStudioError'; } }
function fail(code: string): never { throw new WebsiteStudioError(code); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function canonicalWebsiteStudioDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function websiteStudioTextDigest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function websiteStudioAssetManifestDigest(assets: readonly Pick<WebsiteStudioAsset, 'path' | 'mediaType' | 'sha256'>[]): string {
  return canonicalWebsiteStudioDigest([...assets].map(({ path, mediaType, sha256 }) => ({ path, mediaType, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function facts(claims: readonly WebsiteStudioClaim[], prospect: WebsiteProspectInput): void {
  for (const item of claims) {
    claim.parse(item);
    if (new Set(item.evidenceIds).size !== item.evidenceIds.length) fail('STUDIO_DUPLICATE_SOURCE');
    const sources = item.evidenceIds.map(id => prospect.evidence.find(source => source.evidenceId === id));
    if (sources.some(source => !source) || !sources.some(source => source!.finding.includes(item.text))) fail('STUDIO_UNSUPPORTED_FACT');
  }
}
function seal(value: Omit<WebsiteStudioArtifact, 'artifactDigest'>): WebsiteStudioArtifact {
  const artifact = { ...value, artifactDigest: canonicalWebsiteStudioDigest(value) };
  return immutable(websiteStudioArtifactSchema.parse(artifact));
}
function envelope(prospect: WebsiteProspectInput, rev: WebsiteStudioRevision, now: string, parentArtifactDigest: string | null) {
  revision.parse(rev); at.parse(now);
  const current = qualifyWebsiteProspect(prospect, now);
  if (current.status !== 'READY') fail('STUDIO_CURRENT_QUALIFICATION_REQUIRED');
  return { contractVersion: websiteStudioContract, identity: current.identity, identityKey: current.identityKey, evidenceDigest: current.evidenceDigest,
    ...rev, parentArtifactDigest, createdAt: now, validUntil: current.validUntil, externalEffectAllowed: false as const, spendAuthorized: false as const };
}
function plan(raw: unknown, prospect: WebsiteProspectInput, now: string, stage: 'DIAGNOSIS' | 'CONCEPT' | 'DEMO',
  parent: WebsiteDiagnosisArtifact | WebsiteConceptArtifact | null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('STUDIO_INVESTMENT_REQUIRED');
  const supplied = structuredClone(raw) as WebsiteInvestmentInput;
  // Completion is derived from the verified artifact, not a caller-supplied completed/approved flag.
  const completedStage = parent?.kind ?? 'NONE';
  const input: WebsiteInvestmentInput = { ...supplied, requestedStage: stage, completedStage,
    completedStageEvidence: parent ? { stage: parent.kind, identityKey: parent.identityKey, evidenceDigest: parent.evidenceDigest,
      reference: parent.artifactDigest, completedAt: parent.createdAt } : null };
  const investmentDecision = decideWebsiteInvestment(input, qualifyWebsiteProspect(prospect, now), now);
  if (!investmentDecision.requestedStageAllowed) fail(`STUDIO_INVESTMENT_BLOCKED:${investmentDecision.reasons.join(',')}`);
  return { investmentPlan: input, investmentDecision: decision.parse(investmentDecision) };
}
export interface CreateWebsiteDiagnosisInput {
  prospect: WebsiteProspectInput; companyName: string; locationLabel: string; recommendations: readonly WebsiteStudioClaim[];
  scope: WebsiteStudioScope; investmentPlan: WebsiteInvestmentInput; revision: WebsiteStudioRevision;
}
export function createWebsiteDiagnosis(input: CreateWebsiteDiagnosisInput, now: string): WebsiteDiagnosisArtifact {
  const current = qualifyWebsiteProspect(input.prospect, now);
  const findings = current.input.evidence.map(item => ({ text: item.finding, evidenceIds: [item.evidenceId] }));
  facts([...findings, ...input.recommendations], current.input);
  const content = diagnosisContent.parse({ companyName: input.companyName, locationLabel: input.locationLabel, findings,
    recommendations: input.recommendations, scope: input.scope, assetPolicy, ...plan(input.investmentPlan, current.input, now, 'DIAGNOSIS', null) });
  return seal({ ...envelope(current.input, input.revision, now, null), kind: 'DIAGNOSIS', content }) as WebsiteDiagnosisArtifact;
}
export interface CreateWebsiteConceptInput {
  prospect: WebsiteProspectInput; diagnosis: WebsiteDiagnosisArtifact; objective: string; hero: WebsiteStudioClaim;
  sections: readonly { title: string; body: WebsiteStudioClaim }[]; visualDirection: z.infer<typeof conceptContent>['visualDirection'];
  scope: WebsiteStudioScope; investmentPlan: WebsiteInvestmentInput; revision: WebsiteStudioRevision;
}
export function createWebsiteConcept(input: CreateWebsiteConceptInput, now: string): WebsiteConceptArtifact {
  const diagnosis = verifyWebsiteStudioArtifact(input.diagnosis, input.prospect, now);
  if (diagnosis.kind !== 'DIAGNOSIS') fail('STUDIO_DIAGNOSIS_REQUIRED');
  facts([input.hero, ...input.sections.map(section => section.body)], input.prospect);
  const content = conceptContent.parse({ companyName: diagnosis.content.companyName, locationLabel: diagnosis.content.locationLabel,
    objective: input.objective, hero: input.hero, sections: input.sections, visualDirection: input.visualDirection, scope: input.scope, assetPolicy,
    ...plan(input.investmentPlan, input.prospect, now, 'CONCEPT', diagnosis) });
  return seal({ ...envelope(input.prospect, input.revision, now, diagnosis.artifactDigest), kind: 'CONCEPT', content }) as WebsiteConceptArtifact;
}
export interface AcceptedWebsiteConcept { identity: WebsiteProspectIdentity; artifactDigest: string; acceptanceId: string; acceptedAt: string }
/** Must be composed by the authenticated host from current authoritative CRM rows, never from request JSON. */
export interface WebsiteStudioAcceptancePort { resolveAcceptedConcept(identity: WebsiteProspectIdentity, artifactDigest: string): Promise<AcceptedWebsiteConcept | null> }
const accepted = z.strictObject({ identity: websiteProspectIdentitySchema, artifactDigest: sha, acceptanceId: z.uuid(), acceptedAt: at });
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!)); }
const palettes = { STUDIO_BLUE: ['#102f50', '#1760a5', '#eaf2f8'], BOTANICAL_GREEN: ['#183e36', '#286b56', '#ecf4ee'], CRAFT_OCHRE: ['#412d18', '#775016', '#f6f0e4'] } as const;
function render(concept: WebsiteConceptArtifact): { html: string; assets: WebsiteStudioAsset[] } {
  const c = concept.content, colors = palettes[c.visualDirection], e = escapeHtml;
  const css = `:root{color-scheme:light;--ink:${colors[0]};--accent:${colors[1]};--wash:${colors[2]}}*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:18px/1.65 Georgia,serif}a{color:var(--accent);text-underline-offset:.24em}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:5px}.skip{position:absolute;left:1rem;top:-6rem;background:#fff;padding:1rem}.skip:focus{top:1rem}header,main,footer{max-width:1160px;margin:auto;padding:24px clamp(20px,5vw,64px)}header{display:flex;justify-content:space-between;gap:24px;align-items:center;border-bottom:1px solid #d0dbe2}.brand{font:bold 1.25rem/1.3 system-ui,sans-serif;overflow-wrap:anywhere}nav{display:flex;gap:24px}nav a{min-height:44px;display:inline-flex;align-items:center}.notice{font:14px/1.5 system-ui,sans-serif;background:var(--wash);padding:12px 20px}.hero{display:grid;grid-template-columns:1.2fr 1fr;gap:48px;align-items:center;padding:56px 0}h1{font-size:clamp(2.2rem,5vw,4.4rem);line-height:1.08;letter-spacing:-.035em;margin:.3em 0}h2{font-size:clamp(1.6rem,3vw,2.3rem);line-height:1.2}h3{font:600 1.15rem/1.4 system-ui,sans-serif}.measure{max-width:66ch}img{display:block;width:100%;height:auto}figure{margin:0}figcaption,.meta{font:14px/1.5 system-ui,sans-serif;margin-top:12px}.sections{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:40px 0}.section{border-top:2px solid var(--accent);padding-top:20px}.scope{background:var(--wash);padding:28px;margin:36px 0}.scope ul{padding-left:24px}details{margin:28px 0;border-block:1px solid #d0dbe2;padding:16px 0}summary{cursor:pointer;min-height:44px}footer{border-top:1px solid #d0dbe2;font:14px/1.6 system-ui,sans-serif}p,li,h1,h2,h3{overflow-wrap:anywhere}section{scroll-margin-top:24px}@media(max-width:700px){header{align-items:flex-start;flex-direction:column;gap:8px}.hero,.sections{grid-template-columns:1fr;gap:28px}.hero{padding:32px 0}nav{flex-wrap:wrap}body{font-size:17px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="680" viewBox="0 0 800 680" role="img" aria-label="Clearly labelled original concept placeholder"><rect width="800" height="680" fill="${colors[2]}"/><path d="M0 520L260 200L470 400L650 170L800 370V680H0Z" fill="${colors[0]}"/><circle cx="610" cy="130" r="48" fill="${colors[1]}"/><rect x="52" y="55" width="390" height="86" rx="8" fill="#fff"/><text x="76" y="109" font-family="sans-serif" font-size="30" fill="${colors[0]}">Concept placeholder</text></svg>`;
  const assets: WebsiteStudioAsset[] = [{ path: 'studio.css', mediaType: 'text/css', body: css, sha256: websiteStudioTextDigest(css), rights: { basis: 'ORIGINAL_NOVALURE', reference: 'Deterministic local stylesheet; no external fonts or resources' } },
    { path: 'placeholder.svg', mediaType: 'image/svg+xml', body: svg, sha256: websiteStudioTextDigest(svg), rights: { basis: 'PLACEHOLDER', reference: 'Original geometric illustration; not a company photo, logo or testimonial' } }];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'none'; script-src 'none'"><title>${e(c.companyName)} — concept preview</title><link rel="stylesheet" href="./assets/studio.css"></head><body><a class="skip" href="#main">Skip to content</a><div class="notice">Private concept preview. Proposed structure only; no booking, message, payment or customer action is available.</div><header><span class="brand">${e(c.companyName)}</span><nav aria-label="Concept navigation"><a href="#proposal">Proposal</a><a href="#scope">Scope</a></nav></header><main id="main"><section class="hero" aria-labelledby="title"><div><p class="meta">Proposed website direction for ${e(c.locationLabel)}</p><h1 id="title">${e(c.companyName)}</h1><p class="measure">${e(c.hero.text)}</p><p class="meta">Sourced observation shown for concept context; this is not a customer testimonial.</p><a href="#proposal">Explore the proposed structure</a></div><figure><img src="./assets/placeholder.svg" width="800" height="680" alt="Original geometric placeholder illustration for the proposed website"><figcaption>Explicit placeholder. Company photography and branding require verified usage rights.</figcaption></figure></section><section id="proposal" aria-labelledby="proposal-title"><h2 id="proposal-title">Proposed direction</h2><p class="measure">${e(c.objective)}</p><div class="sections">${c.sections.map(section => `<article class="section"><h3>${e(section.title)}</h3><p>${e(section.body.text)}</p><p class="meta">Research basis; final wording subject to review.</p></article>`).join('')}</div></section><section id="scope" class="scope" aria-labelledby="scope-title"><h2 id="scope-title">Proposed scope</h2><ul>${c.scope.included.map(item => `<li>${e(item)}</li>`).join('')}</ul><details><summary>Exclusions and assumptions</summary><ul>${c.scope.excluded.map(item => `<li>${e(item)}</li>`).join('')}</ul></details></section><section aria-labelledby="simulation-title"><h2 id="simulation-title">Interaction preview</h2><p class="measure">Contact, chat, booking and payment are intentionally represented by this explanation. No details are collected and no external action can run.</p></section></main><footer>Concept version ${concept.version}. Internal review artifact. Access, acceptance and publication are controlled separately.</footer></body></html>`;
  return { html, assets };
}
export interface BuildWebsiteDemoInput { prospect: WebsiteProspectInput; concept: WebsiteConceptArtifact; investmentPlan: WebsiteInvestmentInput; revision: WebsiteStudioRevision }
export async function buildWebsiteDemo(input: BuildWebsiteDemoInput, authority: WebsiteStudioAcceptancePort, now: string): Promise<WebsiteDemoArtifact> {
  const concept = verifyWebsiteStudioArtifact(input.concept, input.prospect, now);
  if (concept.kind !== 'CONCEPT') fail('STUDIO_CONCEPT_REQUIRED');
  const row = accepted.parse(await authority.resolveAcceptedConcept(concept.identity, concept.artifactDigest));
  if (canonicalWebsiteStudioDigest(row.identity) !== concept.identityKey || row.artifactDigest !== concept.artifactDigest
    || Date.parse(row.acceptedAt) < Date.parse(concept.createdAt) || Date.parse(row.acceptedAt) > Date.parse(now)) fail('STUDIO_CURRENT_ACCEPTANCE_REQUIRED');
  const rendered = render(concept);
  const content = { concept, acceptanceId: row.acceptanceId, acceptedAt: row.acceptedAt, ...rendered,
    htmlDigest: websiteStudioTextDigest(rendered.html), assetManifestDigest: websiteStudioAssetManifestDigest(rendered.assets),
    ...plan(input.investmentPlan, input.prospect, now, 'DEMO', concept), interactions: 'INERT_SIMULATIONS_ONLY' as const, indexable: false as const, externallyAccessible: false as const };
  return seal({ ...envelope(input.prospect, input.revision, now, concept.artifactDigest), kind: 'DEMO', content }) as WebsiteDemoArtifact;
}
/** Content integrity/currentness only; server separately enforces authenticated actor, immutable version chain and current persisted acceptance. */
export function verifyWebsiteStudioArtifact(raw: unknown, prospect: WebsiteProspectInput, now: string): WebsiteStudioArtifact {
  at.parse(now);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 200_000) fail('STUDIO_ARTIFACT_TOO_LARGE');
  const artifact = websiteStudioArtifactSchema.parse(raw), { artifactDigest, ...unsigned } = artifact;
  revision.parse({ version: artifact.version, previousArtifactDigest: artifact.previousArtifactDigest });
  const current = qualifyWebsiteProspect(prospect, now);
  if (current.status !== 'READY' || artifact.identityKey !== current.identityKey || artifact.evidenceDigest !== current.evidenceDigest
    || canonicalWebsiteStudioDigest(artifact.identity) !== current.identityKey || artifact.validUntil !== current.validUntil
    || Date.parse(artifact.createdAt) > Date.parse(now) || Date.parse(artifact.createdAt) < Math.max(...current.input.evidence.map(item => Date.parse(item.observedAt)))
    || Date.parse(artifact.validUntil) <= Date.parse(now)) fail('STUDIO_CURRENT_EVIDENCE_REQUIRED');
  if (canonicalWebsiteStudioDigest(unsigned) !== artifactDigest) fail('STUDIO_ARTIFACT_DIGEST_MISMATCH');
  if (artifact.kind === 'DIAGNOSIS') {
    if (artifact.parentArtifactDigest !== null) fail('STUDIO_PARENT_MISMATCH');
    facts([...artifact.content.findings, ...artifact.content.recommendations], current.input);
  } else if (!artifact.parentArtifactDigest) fail('STUDIO_PARENT_REQUIRED');
  if (artifact.kind === 'CONCEPT') facts([artifact.content.hero, ...artifact.content.sections.map(section => section.body)], current.input);
  const recomputed = decideWebsiteInvestment(artifact.content.investmentPlan, current, now);
  if (recomputed.stage !== artifact.kind || !recomputed.requestedStageAllowed || canonicalWebsiteStudioDigest(recomputed) !== canonicalWebsiteStudioDigest(artifact.content.investmentDecision)) fail('STUDIO_INVESTMENT_INVALID');
  const storedPlan = artifact.content.investmentPlan as WebsiteInvestmentInput;
  if (artifact.kind === 'DIAGNOSIS' ? storedPlan.completedStage !== 'NONE' || storedPlan.completedStageEvidence !== null
    : storedPlan.completedStage !== (artifact.kind === 'CONCEPT' ? 'DIAGNOSIS' : 'CONCEPT')
      || storedPlan.completedStageEvidence?.reference !== artifact.parentArtifactDigest
      || Date.parse(storedPlan.completedStageEvidence.completedAt) > Date.parse(artifact.createdAt)) fail('STUDIO_STAGE_EVIDENCE_MISMATCH');
  if (artifact.kind === 'DEMO') {
    const concept = verifyWebsiteStudioArtifact(artifact.content.concept, current.input, now);
    if (concept.kind !== 'CONCEPT' || concept.artifactDigest !== artifact.parentArtifactDigest) fail('STUDIO_PARENT_MISMATCH');
    const rendered = render(concept);
    if (artifact.content.html !== rendered.html || canonicalWebsiteStudioDigest(artifact.content.assets) !== canonicalWebsiteStudioDigest(rendered.assets)
      || artifact.content.htmlDigest !== websiteStudioTextDigest(rendered.html) || artifact.content.assetManifestDigest !== websiteStudioAssetManifestDigest(rendered.assets)
      || Date.parse(artifact.content.acceptedAt) < Date.parse(concept.createdAt) || Date.parse(artifact.content.acceptedAt) > Date.parse(artifact.createdAt)) fail('STUDIO_RENDER_MISMATCH');
  }
  return immutable(artifact);
}
