import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { requiresLivePropertyFacts } from '../src/lib/bots/agent-tools';
import { isReviewedStudioEstateChunk } from '../src/lib/knowledge-center/studio-estate-reviewed-chunks';
import type { KnowledgeMatch } from '../src/lib/knowledge-center/types';

const workspace = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101';
const project = 'be5ff97d-69ce-4fc1-a35d-a8fe4a0ffb6c';
const area = '10f5f99a-7b18-4468-ba3b-a20e7dcd51d7';
const bot = 'c7cc70e8-0a10-47ce-a085-f3f61186678a';
const other = '00000000-0000-4000-8000-000000000001';
const items = [
  { file: 'scripts/fixtures/studio-estate-public-review/estate-page.txt', sourceId: '36ef5e4a-6150-4998-a24c-a6f4e7a20291', versionId: '2ba93106-38de-4d26-82d5-8a0adc214642', chunks: 5 },
  { file: 'scripts/fixtures/studio-estate-public-review/estate-form.txt', sourceId: '2c641940-8fa3-4989-a4ca-608f7d777e56', versionId: 'aabcfbd2-9efc-47b1-8bd2-254d47b310a7', chunks: 1 },
];

test('only exact reviewed public chunks may pass their fixed Studio scope', async () => {
  for (const item of items) {
    const content = (await readFile(item.file, 'utf8')).trimEnd();
    const chunks = [];
    for (let i = 0; i < content.length; i += 1600) chunks.push(content.slice(i, i + 1600));
    assert.equal(chunks.length, item.chunks);
    for (const chunk of chunks) {
      const match: KnowledgeMatch = { sourceId: item.sourceId, versionId: item.versionId, chunkId: other,
        areaId: area, title: 'Public Studio service', excerpt: chunk, citationUrl: null, score: 1,
        projectDivision: 'WEB_DESIGN', policySourceProjectId: project, policyAreaProjectId: project, policyBotProjectId: project };
      const input = { workspaceId: workspace, assistantId: bot, channel: 'webchat' as const, match };
      assert.equal(requiresLivePropertyFacts(chunk, 'WEB_DESIGN'), true, 'fixture must exercise the existing block');
      assert.equal(isReviewedStudioEstateChunk(input), true);
      for (const bad of [
        { ...input, workspaceId: other }, { ...input, assistantId: other }, { ...input, channel: 'voice' as const },
        { ...input, match: { ...match, areaId: other } }, { ...input, match: { ...match, sourceId: other } },
        { ...input, match: { ...match, versionId: other } }, { ...input, match: { ...match, projectDivision: 'REAL_ESTATE_GROWTH' as const } },
        { ...input, match: { ...match, policySourceProjectId: other } }, { ...input, match: { ...match, policyAreaProjectId: other } },
        { ...input, match: { ...match, policyBotProjectId: other } }, { ...input, match: { ...match, policySourceProjectId: undefined } },
        { ...input, match: { ...match, excerpt: chunk + ' Apartment for sale, price €750,000.' } },
        { ...input, match: { ...match, excerpt: chunk.replace(/./u, '_') } },
      ]) assert.equal(isReviewedStudioEstateChunk(bad), false, 'scope/content mismatches must fail closed');
    }
  }
});

test('the pre-existing property price and availability guards still deny explicit queries', () => {
  for (const q of [
    'What is the price of this apartment?', 'Is this property available?',
    'What are the property prices and availability?', 'Was kostet diese Wohnung?', 'Ist diese Immobilie verfügbar?',
    '¿Cuál es el precio de este piso?', 'Is the apartment for rent?',
  ]) {
    assert.equal(requiresLivePropertyFacts(q, 'WEB_DESIGN'), true, q);
    assert.equal(requiresLivePropertyFacts(q, 'REAL_ESTATE_GROWTH'), true, q);
  }
});
