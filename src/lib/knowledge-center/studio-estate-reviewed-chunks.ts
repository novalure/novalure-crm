import 'server-only';
import { createHash } from 'node:crypto';
import type { KnowledgeChannel, KnowledgeMatch } from './types';

// Exact public marketing chunks reviewed on 2026-11-24. These hashes do not
// authorize a source, a channel, a tenant, a visitor question, or a new source
// version. They only prevent a known content-level false positive after all
// normal publication, tenant, project, bot and channel checks have succeeded.
// Any content/version change must be separately reviewed; unknown data deny.
const workspaceId = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101';
const projectId = 'be5ff97d-69ce-4fc1-a35d-a8fe4a0ffb6c';
const areaId = '10f5f99a-7b18-4468-ba3b-a20e7dcd51d7';
const assistantId = 'c7cc70e8-0a10-47ce-a085-f3f61186678a';
const reviewed = new Map<string, ReadonlySet<string>>([
  ['36ef5e4a-6150-4998-a24c-a6f4e7a20291/2ba93106-38de-4d26-82d5-8a0adc214642', new Set([
    '646c55cad5ec9bd80439000847ce1e532d5741e9b6f6e56cf1f667d964972603',
    '0b454aab2a15dba855248c14679ae638eed84c76df5330d04bd97af365884c45',
    'd2f6c92b535b59e6ef98163769c6a87ed6f941f6b41a3f3952ea57b824a6e294',
    '3032f89f8e0bbe1e38c83ec4e78961cba233fa11646dec334dcae42eb3b7e987',
    'bbcb3d2fec12cb4d3dd9b8250295b80d20a52b705a9f2456c8825bf30891309d',
  ])],
  ['2c641940-8fa3-4989-a4ca-608f7d777e56/aabcfbd2-9efc-47b1-8bd2-254d47b310a7', new Set([
    '8a8d2e9ad4f1c5dfae4a11199204342045dd33ea6a78e548f0ac5f1594ba6ac9',
  ])],
]);

/** Only this existing Studio webchat may receive the extra scope evidence. */
export function isStudioEstatePolicyRequest(workspace: string, assistant: string | null | undefined, channel: KnowledgeChannel | null): boolean {
  return workspace === workspaceId && assistant === assistantId && channel === 'webchat';
}

/** Called only for a chunk that the generic live-property guard rejected. */
export function isReviewedStudioEstateChunk(input: Readonly<{
  workspaceId: string;
  assistantId: string;
  channel: KnowledgeChannel;
  match: KnowledgeMatch;
}>): boolean {
  const { match } = input;
  if (!isStudioEstatePolicyRequest(input.workspaceId, input.assistantId, input.channel) ||
      match.projectDivision !== 'WEB_DESIGN' || match.areaId !== areaId ||
      match.policySourceProjectId !== projectId || match.policyAreaProjectId !== projectId ||
      match.policyBotProjectId !== projectId || typeof match.excerpt !== 'string') return false;
  const acceptedHashes = reviewed.get(`${match.sourceId}/${match.versionId}`);
  if (!acceptedHashes) return false;
  return acceptedHashes.has(createHash('sha256').update(match.excerpt).digest('hex'));
}
