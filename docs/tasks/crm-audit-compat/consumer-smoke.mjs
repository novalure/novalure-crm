// Optional, task-specific compatibility evidence. No live network or credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'package.json'));
const { satisfies } = require('semver');
for (const consumer of ['@vercel/blob', '@ai-sdk/provider-utils']) {
  const local = createRequire(require.resolve(consumer));
  const version = local('undici/package.json').version;
  const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', consumer, 'package.json'), 'utf8'));
  assert.ok(satisfies(version, manifest.dependencies.undici), `${consumer}: declared range`);
  assert.ok(satisfies(version, consumer === '@vercel/blob' ? '>=6.29.1 <7' : '>=7.30.1 <8'));
  const { MockAgent, fetch } = local('undici');
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get('https://dependency.example.invalid').intercept({path: '/probe', method: 'GET'}).reply(200, '{"synthetic":true}');
  try {
    assert.deepEqual(await (await fetch('https://dependency.example.invalid/probe', {dispatcher: agent})).json(), {synthetic: true});
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
  console.log(`${consumer}: undici ${version}, declared range and isolated transport PASS`);
}
const { z } = require('zod');
const { zodSchema, safeValidateTypes } = await import('@ai-sdk/provider-utils');
const schema = zodSchema(z.object({name: z.string(), items: z.array(z.string()).max(2)}));
assert.equal(schema.jsonSchema.properties.items.maxItems, 2);
assert.equal((await safeValidateTypes({schema, value: {name: 'SYNTHETIC', items: ['ok']}})).success, true);
assert.equal((await safeValidateTypes({schema, value: {name: 1, items: []}})).success, false);
const cli = require('@vercel/cli-config');
assert.deepEqual(cli.parseGlobalConfig({currentTeam: 'synthetic-team', credStorage: 'file', unknown: 'preserved'}), {currentTeam: 'synthetic-team', credStorage: 'file', unknown: 'preserved'});
assert.throws(() => cli.parseGlobalConfig({credStorage: 'not-a-storage-mode'}));
assert.deepEqual(cli.parseAuthConfig({}), {});
assert.deepEqual(cli.parseAuthFileConfig({}), {});
console.log(`AI SDK Zod ${require('zod/package.json').version}: schema/validation PASS; CLI parsers PASS`);
console.log(`CLI bundled Zod remains ${Object.values(cli.globalConfigSchema._zod.version).join('.')}; dependency override does not replace bundled code`);
