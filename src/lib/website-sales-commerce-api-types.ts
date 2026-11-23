import type { WebsiteSalesCommerceCommand } from './website-sales-commerce-types';

export const websiteSalesCommercePath = '/api/crm/website-sales/commerce';
export type WebsiteSalesCommerceScope = Pick<WebsiteSalesCommerceCommand, 'projectId' | 'companyId' | 'locationId'>;
