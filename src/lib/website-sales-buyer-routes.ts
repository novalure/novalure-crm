import 'server-only';
import { createWebsiteSalesBuyerHttp } from './website-sales-buyer-http';
import { CrmCommandError } from './crm-command';
import { readWebsiteSalesBuyerRoom, confirmWebsiteSalesBuyerStep, reconcileWebsiteSalesBuyerStep,
  readWebsiteSalesBuyerAsset } from './db/website-sales-advisory-buyer';

/** Only native authenticated account context reaches the private buyer store. */
export const websiteSalesBuyerRoutes = createWebsiteSalesBuyerHttp({
  read: async (token, session) => {
    const room = await readWebsiteSalesBuyerRoom(token, { session: session ?? undefined });
    if (!room) throw new CrmCommandError('BUYER_ACCESS_UNAVAILABLE', 'Buyer access unavailable', 404);
    return room;
  },
  confirm: (session, token, command) => confirmWebsiteSalesBuyerStep(session, { token, ...command }),
  reconcile: (session, token, command) => reconcileWebsiteSalesBuyerStep(session, { token, ...command }),
  asset: async (token, assetId, session) => {
    const asset = await readWebsiteSalesBuyerAsset(token, assetId, { session: session ?? undefined });
    if (!asset) throw new CrmCommandError('BUYER_ACCESS_UNAVAILABLE', 'Buyer access unavailable', 404);
    return asset;
  },
});
