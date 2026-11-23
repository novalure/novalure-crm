import { websiteSalesBuyerRoutes } from '@/lib/website-sales-buyer-routes';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  return websiteSalesBuyerRoutes.ASSET(request, (await context.params).assetId);
}
