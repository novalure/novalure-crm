import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { neon } from '@neondatabase/serverless';

// Only schema metadata is read. Never export credentials or customer records.
export function mediaSchemaContract(source) {
  const parsed = ts.createSourceFile('media-lifecycle.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['knownReferences', 'referenceCatalogSql', 'hasCompleteMediaReferenceVisibility']);
  const selected = parsed.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && names.has(item.name.text))));
  if (selected.length !== 3) throw Error('Media schema contract unavailable');
  const code = ts.transpileModule(selected.map(node => node.getText(parsed)).join('\n') + '\nexport { referenceCatalogSql };', {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const exports = {};
  vm.runInNewContext(code,{exports},{timeout:1000});
  if (!/^select\s/.test(exports.referenceCatalogSql) || /;/.test(exports.referenceCatalogSql)) throw Error('Not a single catalog select');
  return exports;
}

export async function runProductionMediaPreflight({env=process.env, makeSql=neon, source=readFileSync(new URL('../src/lib/media-lifecycle.ts',import.meta.url),'utf8')}={}) {
  if (env.VERCEL_ENV !== 'production') return {status:'SKIPPED_NON_PRODUCTION'};
  const clean = value => (value || '').trim().replace(/^['"]|['"]$/g,'').replace(/^[A-Z0-9_]+=(?=postgres(?:ql)?:\/\/)/,'');
  const connectionString = clean(env.DATABASE_URL) || clean(env.POSTGRES_URL) || clean(env.POSTGRES_DATABASE_URL) || clean(env.POSTGRES_PRISMA_URL);
  if (!connectionString || !new URL(connectionString).hostname.endsWith('.neon.tech')) throw Error('Production database unavailable');
  const contract = mediaSchemaContract(source);
  const sql = makeSql(connectionString);
  const [identity, references] = await sql.transaction([
    sql.query("select current_setting('transaction_read_only') as read_only"),
    sql.query(contract.referenceCatalogSql),
  ],{readOnly:true,fetchOptions:{signal:AbortSignal.timeout(20000)}});
  if (identity[0]?.read_only !== 'on' || !contract.hasCompleteMediaReferenceVisibility(references)) throw Error('Production media schema contract not satisfied');
  return {status:'PASS_PRODUCTION_READ_ONLY_MEDIA_SCHEMA',referenceCount:references.length,contractSha256:createHash('sha256').update(source).digest('hex')};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runProductionMediaPreflight())); }
  catch { console.error('Production media schema preflight failed. No storage or database writes were attempted.'); process.exitCode=1; }
}
