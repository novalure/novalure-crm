import type { WebsiteSalesAdvisoryCommand } from './website-sales-advisory-types';

export const websiteSalesAdvisoryPath = '/api/crm/website-sales/advisory';
export type WebsiteSalesAdvisoryScope = Pick<WebsiteSalesAdvisoryCommand, 'projectId' | 'companyId' | 'locationId'>;
