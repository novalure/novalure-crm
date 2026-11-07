#!/usr/bin/env node
/** Explicit operator entry point; --plan is the default and performs no remote I/O. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BACKUP_SCOPE, CrmBackupError, backupProviderDiagnostics, defaultCrmBackupConfig, validateBackupConfig, runCrmFullBackup, planBackupRetention } from './lib/crm-full-backup.mjs';

function parseArguments(argv) {
  const result = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan' || arg === '--execute') {
      if (result.modeSpecified) throw new CrmBackupError('CONFLICTING_BACKUP_MODE');
      result.modeSpecified = true; result.execute = arg === '--execute';
    }
    else if (['--config', '--snapshot', '--point-in-time', '--pitr-branch-limit', '--backup-id', '--retention-index'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new CrmBackupError('BACKUP_ARGUMENT_VALUE_REQUIRED');
      const key = { '--config': 'configFile', '--snapshot': 'snapshotId', '--point-in-time': 'pointInTime', '--pitr-branch-limit': 'pitrBranchLimit',
        '--backup-id': 'backupId', '--retention-index': 'retentionIndex' }[arg];
      if (key in result) throw new CrmBackupError('DUPLICATE_BACKUP_ARGUMENT');
      result[key] = argv[++i];
    } else throw new CrmBackupError('UNKNOWN_BACKUP_ARGUMENT');
  }
  if (result.execute && result.retentionIndex) throw new CrmBackupError('RETENTION_IS_PLAN_ONLY');
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env, output = value => process.stdout.write(JSON.stringify(value) + '\n')) {
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new CrmBackupError('NODE24_REQUIRED');
    const args = parseArguments(argv);
    let supplied = {};
    if (args.configFile) {
      const bytes = await readFile(args.configFile);
      if (bytes.length > 16384) throw new CrmBackupError('BACKUP_CONFIG_TOO_LARGE');
      supplied = JSON.parse(bytes.toString('utf8'));
    }
    const copyMode = env.CRM_FULL_BACKUP_COPY_MODE;
    if (copyMode !== undefined && !['snapshot', 'point-in-time'].includes(copyMode)) throw new CrmBackupError('INVALID_BACKUP_COPY_MODE');
    const pointInTime = args.pointInTime ?? supplied.pointInTime ?? (copyMode === 'point-in-time' && !args.retentionIndex
      ? new Date(new Date().setUTCHours(3, 0, 0, 0)).toISOString().replace('.000Z', 'Z') : undefined);
    const limitText = args.pitrBranchLimit ?? (pointInTime !== undefined ? env.CRM_FULL_BACKUP_PITR_BRANCH_LIMIT : undefined);
    if (limitText !== undefined && !/^[1-9]\d?$/u.test(limitText)) throw new CrmBackupError('INVALID_PITR_BRANCH_LIMIT');
    const config = validateBackupConfig({ ...defaultCrmBackupConfig, ...supplied, ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
      ...(pointInTime !== undefined ? { pointInTime } : {}),
      ...(limitText !== undefined ? { pitrBranchLimit: Number(limitText) } : {}) });
    if (args.retentionIndex) {
      const bytes = await readFile(args.retentionIndex);
      if (bytes.length > 10 * 1024 * 1024) throw new CrmBackupError('BACKUP_INDEX_TOO_LARGE');
      output(planBackupRetention(JSON.parse(bytes.toString('utf8')), { now: new Date(), keepDays: config.retentionDays, sourceStoreId: config.sourceStoreId, targetStoreId: config.targetStoreId, prefix: config.prefix }));
      return 0;
    }
    const { createCrmBackupProviderPorts } = await import('./lib/crm-full-backup-providers.mjs');
    const ports = await createCrmBackupProviderPorts(config, { env });
    const ready = await ports.credentialsReady();
    const missing = [];
    if (ready.neonApiKey !== true) missing.push('NEON_API_KEY: project-scoped Neon management credential');
    if (ready.productionOidc !== true || ready.projectId !== config.backupProjectId || ready.teamId !== config.teamId || ready.environment !== 'production') missing.push('VERCEL_OIDC_TOKEN: legitimate Production token for the exact backup project and team');
    if (!args.execute) {
      output({ mode: 'PLAN_ONLY_NO_REMOTE_IO', status: missing.length ? 'BLOCKED' : 'READY_FOR_EXPLICIT_EXECUTION', scope: BACKUP_SCOPE,
        source: { projectId: config.neonProjectId, branchId: config.sourceBranchId, protectedEndpointId: config.productionEndpointId, storeId: config.sourceStoreId },
        target: { projectId: config.backupProjectId, storeId: config.targetStoreId, prefix: config.prefix },
        ...(config.pointInTime ? { pointInTime: config.pointInTime } :
          { snapshot: config.snapshotId ?? 'Latest available snapshot of the exact source branch; never created by this runner' }),
        missing, retentionDays: config.retentionDays, retentionMode: 'PLAN_ONLY', changesApplied: 0,
        sourceSqlConnections: 0, sourceBlobOperations: ['get', 'list'], restoreFinalize: false,
        wholeApplicationBackup: false, existingSchedulesChanged: false });
      return 0;
    }
    if (missing.length) {
      output({ status: 'BLOCKED', scope: BACKUP_SCOPE, missing, remoteRequests: 0 });
      return 2;
    }
    const result = await runCrmFullBackup({ config, ports, ...(args.backupId ? { backupId: args.backupId } : {}) });
    // File names, object paths, data, connection strings and credentials are not
    // emitted. The detailed manifest exists only in the private target store.
    output({ status: result.status, scope: result.scope, backupId: result.backupId,
      ...(result.recoveryPoint ? { pointInTime: result.recoveryPoint.requestedAt } : { snapshotId: result.snapshotId }),
      isolatedBranchId: result.isolatedBranchId, fileCount: result.fileCount, fileBytes: result.fileBytes,
      historicalReferenceCount: result.historicalReferenceCount, manifestSha256: result.manifestSha256,
      cleanup: result.cleanup.status, completedAt: result.completedAt, wholeApplicationBackup: false });
    return 0;
  } catch (error) {
    output({ status: 'INCOMPLETE', code: error instanceof CrmBackupError ? error.code : 'BACKUP_CONFIGURATION_OR_IO_FAILED',
      ...backupProviderDiagnostics(error), fullBackupClaimed: false });
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
