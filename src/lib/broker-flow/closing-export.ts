import { jsPDF } from "jspdf";

export type ClosingExportRecord = Record<string, unknown>;

const csvColumns: Array<[keyof ClosingExportRecord, string]> = [
  ["id", "id"],
  ["projectId", "project_id"],
  ["targetKind", "target_kind"],
  ["targetId", "target_id"],
  ["dealId", "deal_id"],
  ["buyerContactId", "buyer_contact_id"],
  ["sellerContactId", "seller_contact_id"],
  ["status", "status"],
  ["paymentStatus", "payment_status"],
  ["contractType", "contract_type"],
  ["contractDate", "contract_date"],
  ["closingDate", "closing_date"],
  ["currency", "currency"],
  ["baseAmountMinor", "base_amount_minor"],
  ["buyerCommissionMinor", "buyer_commission_minor"],
  ["sellerCommissionMinor", "seller_commission_minor"],
  ["netCommissionMinor", "net_commission_minor"],
  ["taxMinor", "tax_minor"],
  ["grossCommissionMinor", "gross_commission_minor"],
  ["participants", "participants_json"],
  ["commissionSplits", "commission_splits_json"],
  ["updatedAt", "updated_at"],
];

function exportValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function closingCsvCell(value: unknown) {
  const raw = exportValue(value);
  // Excel and compatible tools evaluate cells that start with these characters.
  const safe = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildClosingCsv(items: ClosingExportRecord[]) {
  const header = csvColumns.map(([, heading]) => closingCsvCell(heading)).join(",");
  const body = items.map((item) => (
    csvColumns.map(([key]) => closingCsvCell(item[key])).join(",")
  ));
  return `\uFEFF${[header, ...body].join("\r\n")}\r\n`;
}

function pdfText(value: unknown) {
  return exportValue(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\x20-\x7E]/gu, "?")
    .slice(0, 4_000);
}

export function buildClosingPdf(
  items: ClosingExportRecord[],
  generatedAt: Date = new Date(),
) {
  const document = new jsPDF({ compress: true, format: "a4", unit: "pt" });
  document.setProperties({
    author: "Novalure CRM",
    creator: "Novalure CRM",
    subject: "Operational closing and commission report",
    title: "Novalure closing and commission report",
  });
  document.setCreationDate(generatedAt);

  const margin = 42;
  const pageHeight = document.internal.pageSize.getHeight();
  const contentWidth = document.internal.pageSize.getWidth() - (margin * 2);
  let y = margin;

  const ensureRoom = (height: number) => {
    if (y + height <= pageHeight - 48) return;
    document.addPage();
    y = margin;
  };
  const writeLine = (label: string, value: unknown, indent = 0) => {
    const line = `${label}: ${pdfText(value)}`;
    const lines = document.splitTextToSize(line, contentWidth - indent) as string[];
    ensureRoom((lines.length * 12) + 3);
    document.text(lines, margin + indent, y);
    y += (lines.length * 12) + 3;
  };

  document.setFont("helvetica", "bold");
  document.setFontSize(16);
  document.text("Novalure closing and commission report", margin, y);
  y += 23;
  document.setFont("helvetica", "normal");
  document.setFontSize(9);
  document.text("Operational report only - not an invoice or signed contract PDF.", margin, y);
  y += 14;
  document.text(`Generated: ${generatedAt.toISOString()} | Records: ${items.length}`, margin, y);
  y += 24;

  items.forEach((item, index) => {
    ensureRoom(120);
    document.setFont("helvetica", "bold");
    document.setFontSize(11);
    document.text(`Closing ${index + 1} - ${pdfText(item.id)}`, margin, y);
    y += 16;
    document.setFont("helvetica", "normal");
    document.setFontSize(9);
    writeLine("Project", item.projectId);
    writeLine("Status", item.status);
    writeLine("Payment", item.paymentStatus);
    writeLine("Contract", `${pdfText(item.contractType)} | ${pdfText(item.contractDate)} | ${pdfText(item.closingDate)}`);
    writeLine("Amount", `${pdfText(item.baseAmountMinor)} ${pdfText(item.currency)} (minor units)`);
    writeLine("Commission buyer/seller", `${pdfText(item.buyerCommissionMinor)} / ${pdfText(item.sellerCommissionMinor)}`);
    writeLine("Commission net/tax/gross", `${pdfText(item.netCommissionMinor)} / ${pdfText(item.taxMinor)} / ${pdfText(item.grossCommissionMinor)}`);

    const splits = Array.isArray(item.commissionSplits) ? item.commissionSplits : [];
    writeLine("Commission allocations", splits.length);
    for (const split of splits.slice(0, 100)) {
      writeLine("- Allocation", split, 12);
    }
    y += 9;
    document.setDrawColor(203, 213, 225);
    document.line(margin, y, margin + contentWidth, y);
    y += 17;
  });

  const pages = document.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page);
    document.setFont("helvetica", "normal");
    document.setFontSize(8);
    document.setTextColor(71, 85, 105);
    document.text(`Novalure CRM | Page ${page} of ${pages}`, margin, pageHeight - 24);
  }

  return document.output("arraybuffer");
}
