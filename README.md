# Novalure CLG

Novalure CLG is a Next.js based real estate CRM workspace for buyer, seller and investor lead operations. The current implementation focuses on a central configurable CRM dashboard, lead inbox, deal pipeline, tasks, funnels, newsletter preparation and calendar context.

## Dashboard Features

The central dashboard is implemented in `src/components/dashboard-overview.tsx` and uses the existing mock CRM data from `src/lib/crm-data.ts`.

Implemented dashboard capabilities:

- One central all-in-one dashboard for buyer, seller and investor leads.
- Global filters for lead type, period, employee, region and lead source.
- Widget library opened via `+ Widget hinzuf?gen`.
- Widget settings panel, collapse action and remove action per widget.
- Drag-and-drop and resizeable widget grid via `react-grid-layout`.
- Soft warning when more than 12 widgets are active.
- Preset views: `Meine Tagesansicht`, `Wochen-Review`, `Verk?ufer-Fokus`, `Gesch?ftsf?hrer-Sicht`, `Investor-Akquise`.
- User-saved views in browser storage, with the last selected view restored on return.
- Reset button for the standard dashboard view.
- PDF export of the current dashboard view via `html2canvas` and `jspdf`.

Implemented widgets:

- Active leads with buyer/seller/investor split.
- Pipeline value as expected open commission.
- Monthly closings vs. target.
- Overdue follow-ups.
- Hot leads.
- Conversion rate from inquiry to viewing to closing.
- Average days to closing.
- New requests this week.
- Funnel widget with internal tabs for buyer, seller and investor leads.
- Leads by source with conversion rate per source.
- Request trend over time.
- Status distribution donut.
- Overdue follow-up list with aging color logic.
- Today list from tasks and calendar events.
- Hot leads list.
- New leads this week.
- Expiring broker mandates.
- Cross-pipeline match suggestions from seller listings to buyer and investor profiles.

## Data Model

The lead model in `src/lib/crm-types.ts` now includes structured real estate fields for the three core lead types:

- Buyer profile: budget range, financing status, region, object type, rooms, area, usage and contact dates.
- Seller profile: address, type, area, year built, market value, asking price, selling reason, competing broker, mandate status and commission rate.
- Investor profile: investment volume, yield expectations, investment type, region, financing and previous purchases.

Seller listings are represented as `SellerListing` records and are used by the dashboard match widget.

## Adding A New Widget

1. Add the widget id to the `WidgetId` union in `src/components/dashboard-overview.tsx`.
2. Add title, description and kind to `widgetCatalog`.
3. Add a default grid item if the widget belongs in the standard view.
4. Add a case in `renderWidgetContent`.
5. Keep widget data derived from the global filtered collections unless the widget needs its own internal settings.

Recommended widget rules:

- Use stable ids as React keys.
- Keep calculations in `useMemo` when they depend on larger datasets.
- Keep widgets self-contained so a slow future data source can be isolated behind a loading state.

## Saving Views

Users can configure a view by changing filters, adding or removing widgets, and moving/resizing the grid. Click `View speichern`, enter a name, and the configuration is stored locally for the current browser. The selected view is remembered as the default on the next visit.

The `Standardansicht` button restores the first-login default layout:

- Row 1: Active Leads, Pipeline Value, Monthly Closings, Overdue Follow-ups.
- Row 2: Funnel widget.
- Row 3: Overdue Follow-ups and Today To Do.
- Row 4: Leads by Source.

## Development

```bash
npm run dev
```

Then open the local URL shown in the terminal.

Validation commands:

```bash
npm run lint
npm run build
```

## Dependencies Added

- `react-grid-layout` for drag-and-drop and resizeable widgets.
- `@types/react-grid-layout` for TypeScript support.
- `html2canvas` and `jspdf` for PDF export.

## v2 TODOs

- Persist dashboard views in a real database per authenticated user instead of browser storage.
- Connect HubSpot Starter records through the HubSpot API and map fields to custom properties.
- Add server-side widget data loaders with independent loading/error states per widget.
- Improve mobile to use breakpoint-specific one-column layouts instead of relying on the current responsive container behavior.
- Add true charting primitives for accessible tooltips and legends.
- Add custom date range controls for the `Custom` period.
- Add real broker contract lifecycle records and reminders.
- Add automated match generation when a seller listing is created, including notifications to the assigned agent.
- Add tests for KPI calculations, aging logic and match scoring.
