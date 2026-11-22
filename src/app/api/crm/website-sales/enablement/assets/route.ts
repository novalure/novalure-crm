import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { CrmCommandError, crmRequestMetadata } from '@/lib/crm-command';
import { executeWebsiteSalesAssetUpload, parseWebsiteSalesEnablementCommand } from '@/lib/db/website-sales-enablement-repositories';
import { compactWebsiteSalesOperationsReceipt } from '@/lib/website-sales-operations-receipt';
import { websiteSalesEnablementError } from '@/lib/website-sales-enablement-http';
import { normalizeWebsiteStudioRaster, WebsiteStudioRasterError } from '@/lib/website-sales-studio-raster';
import { readWebExposeUploadForm } from '@/lib/web-expose-media-validation';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:write', capability: 'pipeline:write' });
    if (!auth.ok) return auth.response;
    if (auth.session.serviceIdentity) throw new CrmCommandError('HUMAN_ASSET_ATTESTATION_REQUIRED', 'An authorized person must record image rights', 403);
    let form: FormData;
    try { form = await readWebExposeUploadForm(request); }
    catch { throw new CrmCommandError('INVALID_ASSET_UPLOAD', 'Select a PNG, JPEG or WebP image up to 4 MB', 400); }
    if ([...form.keys()].some(key => !['command', 'file'].includes(key) || form.getAll(key).length !== 1)) throw new CrmCommandError('INVALID_ASSET_UPLOAD', 'Exact image request required', 400);
    const file = form.get('file'), raw = form.get('command');
    if (!(file instanceof File) || typeof raw !== 'string' || Buffer.byteLength(raw) > 120000) throw new CrmCommandError('INVALID_ASSET_UPLOAD', 'Image and original metadata required', 400);
    let body: unknown; try { body = JSON.parse(raw); } catch { throw new CrmCommandError('INVALID_ASSET_COMMAND', 'Original image metadata required', 400); }
    const input = parseWebsiteSalesEnablementCommand(body), meta = crmRequestMetadata(request, input as unknown as Record<string, unknown>);
    if (input.operation !== 'upload_asset' || input.idempotencyKey !== meta.idempotencyKey || input.correlationId !== meta.correlationId || input.payload.originalMime !== file.type || input.payload.originalSizeBytes !== file.size) throw new CrmCommandError('ASSET_METADATA_MISMATCH', 'Image does not match the original request', 400);
    const normalized = await normalizeWebsiteStudioRaster(file);
    if (normalized.originalSha256 !== input.payload.originalSha256) throw new CrmCommandError('ASSET_METADATA_MISMATCH', 'Image does not match the original request', 400);
    return Response.json(compactWebsiteSalesOperationsReceipt(await executeWebsiteSalesAssetUpload(auth.session, input, normalized)), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return websiteSalesEnablementError(error instanceof WebsiteStudioRasterError ? new CrmCommandError(error.code, 'Image could not be verified', 400) : error);
  }
}
