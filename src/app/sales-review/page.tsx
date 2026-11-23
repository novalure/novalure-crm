import type { Metadata } from 'next';
import { WebsiteSalesBuyerRoom } from '@/components/website-sales-buyer-room';

export const metadata: Metadata = {
  title: 'Ihre Entscheidungsmappe | Novalure',
  description: 'Freigegebene Informationen und gemeinsame nächste Schritte.',
  robots: { index: false, follow: false, noarchive: true },
  referrer: 'no-referrer',
};
export const dynamic = 'force-dynamic';
export default function SalesReviewPage() { return <WebsiteSalesBuyerRoom/>; }
