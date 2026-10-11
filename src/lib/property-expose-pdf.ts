import { readFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { PDFDocument as EditablePdf, PDFName, type PDFPage } from "pdf-lib";
import type { PropertyExposeDocument, PropertyExposeFact, PropertyExposeImage } from "@/lib/property-expose";

const PAGE = { width: 595.28, height: 841.89, margin: 44, top: 88, bottom: 782 };
const WIDTH = PAGE.width - PAGE.margin * 2;
const COLOR = { paper: "#faf9f7", ink: "#292a26", muted: "#66685f", line: "#e3e2db", accent: "#f5df79", white: "#ffffff" };
const COPY = {
  de: { eyebrow: "IMMOBILIENEXPOSÉ", facts: "Auf einen Blick", costs: "Kosten", energy: "Energie & Gebäude", gallery: "Einblicke", floorplans: "Grundrisse", contact: "Ihr Kontakt", notices: "Hinweise", reference: "Objekt", date: "Stand", page: "Seite", photo: "Objektansicht", plan: "Grundriss", compact: "Die ausgewählten Inhalte passen nicht auf zwei Seiten. Bitte kürzen Sie den Exposétext, wählen Sie weniger Bilder oder verwenden Sie die vollständige Vorlage.", long: "Der Inhalt ist zu umfangreich für ein Exposé. Bitte reduzieren Sie die Auswahl.", glyph: "Der Exposétext enthält Zeichen, die die PDF-Schrift nicht unterstützt. Bitte ersetzen Sie diese Zeichen:", image: "Ein ausgewähltes Bild kann nicht im PDF dargestellt werden. Bitte laden Sie es erneut als JPEG oder PNG hoch." },
  en: { eyebrow: "PROPERTY DETAILS", facts: "At a glance", costs: "Costs", energy: "Energy & building", gallery: "A closer look", floorplans: "Floor plans", contact: "Your contact", notices: "Notes", reference: "Reference", date: "As of", page: "Page", photo: "Property photograph", plan: "Floor plan", compact: "The selected content does not fit on two pages. Shorten the brochure text, select fewer images or use the full template.", long: "There is too much content for one brochure. Please reduce the selection.", glyph: "The brochure text contains characters that the PDF font does not support. Please replace these characters:", image: "A selected image cannot be displayed in the PDF. Please upload it again as a JPEG or PNG." },
};

export class PropertyExposePdfError extends Error {
  constructor(public readonly code: "COMPACT_OVERFLOW" | "EXPOSE_TOO_LONG" | "UNSUPPORTED_CHARACTERS" | "INVALID_IMAGE" | "INVALID_DOCUMENT" | "INVALID_FLOORPLAN", message: string) {
    super(message);
    this.name = "PropertyExposePdfError";
  }
}

/** Plain text only. No HTML, links, fetching, database access or record filtering here. */
function clean(value: string): string {
  return value.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").replace(/[\u2010-\u2015]/gu, "-").replace(/\t/gu, " ").trim();
}

/**
 * Generates a tagged, selectable-text A4 PDF from the caller's snapshot.
 * The server must explicitly confirm public content before calling this function;
 * the renderer neither grants approval nor decides which record fields are public.
 * Font files must be included in the route's Next.js output-file trace.
 * Tagging is provided; PDF/UA certification is deliberately not asserted.
 */
export async function renderPropertyExposePdf(document: PropertyExposeDocument): Promise<Uint8Array> {
  const copy = COPY[document.language];
  const compact = document.template === "compact";
  if (!copy || !["compact", "full"].includes(document.template) || !clean(document.title) || !Number.isFinite(Date.parse(document.createdAt))) {
    throw new PropertyExposePdfError("INVALID_DOCUMENT", "Invalid property brochure document.");
  }
  const [font, semibold] = await Promise.all([
    readFile(path.join(process.cwd(), "src/lib/property-expose-assets/figtree-regular.ttf")),
    readFile(path.join(process.cwd(), "src/lib/property-expose-assets/figtree-semibold.ttf")),
  ]);
  const date = new Intl.DateTimeFormat(document.language === "de" ? "de-AT" : "en-GB", { dateStyle: "medium", timeZone: "Europe/Vienna" }).format(new Date(document.createdAt));
  const pdfPlans: { page: PDFPage; caption: string; width: number; height: number; rotation: number; box: { left: number; bottom: number; right: number; top: number } }[] = [];
  for (const source of document.floorPlanPdfs || []) {
    try {
      const input = await EditablePdf.load(source.bytes, { updateMetadata: false });
      if (input.getPageCount() !== source.pageCount || input.getPageCount() < 1 || input.getPageCount() > 20) throw new Error("Invalid floor plan page count");
      for (const [index, page] of input.getPages().entries()) {
        const crop = page.getCropBox(), rotation = ((page.getRotation().angle % 360) + 360) % 360;
        if (![0, 90, 180, 270].includes(rotation) || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) throw new Error("Invalid floor plan dimensions");
        pdfPlans.push({ page, width: crop.width, height: crop.height, rotation,
          box: { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
          caption: `${clean(source.caption) || copy.plan}${source.pageCount > 1 ? ` - ${copy.page} ${index + 1} / ${source.pageCount}` : ""}` });
      }
    } catch { throw new PropertyExposePdfError("INVALID_FLOORPLAN", document.language === "de" ? "Ein PDF-Grundriss konnte nicht gelesen werden. Bitte prüfen Sie die Datei." : "A PDF floor plan could not be read. Please check the file."); }
  }
  if (pdfPlans.length > 40) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
  const placements: { outputPage: number; source: typeof pdfPlans[number]; name: string }[] = [];

  const pdfBytes = await new Promise<Uint8Array>((resolve, reject) => {
    const pdf = new PDFDocument({
      autoFirstPage: false, bufferPages: true, size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pdfVersion: "1.7", tagged: true, displayTitle: true, lang: document.language === "de" ? "de-AT" : "en-GB",
      info: { Title: clean(document.title), Author: clean(document.contact?.company || "Novalure"), Subject: `${copy.eyebrow} - ${clean(document.reference)}`, Creator: "Novalure CRM", CreationDate: new Date(document.createdAt), ModDate: new Date(document.createdAt) },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    pdf.on("error", reject);

    try {
      pdf.registerFont("Figtree", font).registerFont("FigtreeSemibold", semibold).font("Figtree");
      // PDFKit's embedded-font adapter exposes fontkit's glyph check. Fail closed
      // when an uncommon name/emoji is outside this existing Latin font subset.
      const embedded = (pdf as unknown as { _font: { font: { hasGlyphForCodePoint: (point: number) => boolean } } })._font.font;
      const visibleText = [document.title, document.reference, document.address, document.price,
        ...document.facts.flatMap((fact) => [fact.label, fact.value]), ...document.costs.flatMap((fact) => [fact.label, fact.value]),
        ...document.energy.flatMap((fact) => [fact.label, fact.value]), ...document.sections.flatMap((section) => [section.heading, section.text]),
        ...Object.values(document.contact || {}), ...document.images.map((image) => image.caption), ...pdfPlans.map((plan) => plan.caption), ...document.notices].filter((value): value is string => typeof value === "string");
      if (visibleText.reduce((sum, text) => sum + text.length, 0) > 100_000 || document.images.length > 28) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
      const unsupported = [...new Set(Array.from(visibleText.map(clean).join(" ")).filter((character) => !/\s/u.test(character) && !embedded.hasGlyphForCodePoint(character.codePointAt(0)!)))];
      if (unsupported.length) throw new PropertyExposePdfError("UNSUPPORTED_CHARACTERS", `${copy.glyph} ${unsupported.slice(0, 12).join(" ")}`);

      const root = pdf.struct("Document");
      pdf.addStructure(root);
      let current = root;
      let y = PAGE.top;
      let pageCount = 0;

      const artifact = (draw: () => void, pagination = false) => {
        pdf.markContent("Artifact", { type: pagination ? "Pagination" : "Layout" });
        draw();
        pdf.endMarkedContent();
      };
      const fontSize = (size: number) => pdf.font("Figtree").fontSize(size);
      const wrap = (value: string, size: number, width = WIDTH, bold = false): string[] => {
        fontSize(size).font(bold ? "FigtreeSemibold" : "Figtree");
        const lines: string[] = [];
        for (const paragraph of clean(value).split("\n")) {
          if (!paragraph.trim()) { lines.push(""); continue; }
          let line = "";
          for (const word of paragraph.trim().split(/\s+/u)) {
            const candidate = line ? `${line} ${word}` : word;
            if (pdf.widthOfString(candidate) <= width) { line = candidate; continue; }
            if (line) { lines.push(line); line = ""; }
            for (const character of Array.from(word)) {
              if (line && pdf.widthOfString(line + character) > width) { lines.push(line); line = ""; }
              line += character;
            }
          }
          if (line) lines.push(line);
        }
        return lines;
      };
      const text = (value: string, x: number, top: number, size: number, width = WIDTH, tag = "P", color = COLOR.ink, lineHeight = size * 1.45): number => {
        const lines = wrap(value, size, width, tag.startsWith("H"));
        if (top + lines.length * lineHeight > PAGE.bottom + 0.01) throw new PropertyExposePdfError(document.template === "compact" ? "COMPACT_OVERFLOW" : "EXPOSE_TOO_LONG", document.template === "compact" ? copy.compact : copy.long);
        current.add(pdf.struct(tag, {}, () => {
          fontSize(size).font(tag.startsWith("H") ? "FigtreeSemibold" : "Figtree").fillColor(color);
          lines.forEach((line, index) => pdf.text(`${line} `, x, top + index * lineHeight, { lineBreak: false }));
        }));
        return lines.length * lineHeight;
      };
      const newPage = () => {
        if (document.template === "compact" && pageCount >= 2) throw new PropertyExposePdfError("COMPACT_OVERFLOW", copy.compact);
        if (pageCount >= 50) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
        pdf.addPage(); pageCount++; y = PAGE.top;
        artifact(() => {
          pdf.rect(0, 0, PAGE.width, PAGE.height).fill(COLOR.paper);
          pdf.roundedRect(PAGE.margin, 34, 16, 16, 4).fill(COLOR.accent);
          fontSize(13).fillColor(COLOR.ink).text("novalure", PAGE.margin + 24, 32, { lineBreak: false });
          pdf.moveTo(PAGE.margin, 66).lineTo(PAGE.width - PAGE.margin, 66).lineWidth(0.6).stroke(COLOR.line);
        }, true);
      };
      const ensure = (height: number) => { if (y + height > PAGE.bottom) newPage(); };
      const section = () => { current = pdf.struct("Sect"); root.add(current); };
      const heading = (value: string, followingHeight = 36) => {
        if (!clean(value)) return;
        const size = compact ? 14 : 16, lineHeight = compact ? 20 : 22, gap = compact ? 8 : 12;
        const height = wrap(value, size, WIDTH, true).length * lineHeight;
        if (height > 160) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
        ensure(height + gap + followingHeight);
        y += text(value, PAGE.margin, y, size, WIDTH, "H2", COLOR.ink, lineHeight) + gap;
      };
      const paragraph = (value: string, size = 10.5, color = COLOR.ink) => {
        const lineHeight = size * 1.5;
        const lines = wrap(value, size);
        while (lines.length) {
          ensure(lineHeight * Math.min(2, lines.length));
          const take = Math.min(lines.length, Math.floor((PAGE.bottom - y) / lineHeight));
          const block = lines.splice(0, take);
          current.add(pdf.struct("P", {}, () => {
            fontSize(size).fillColor(color);
            block.forEach((line, index) => pdf.text(`${line} `, PAGE.margin, y + index * lineHeight, { lineBreak: false }));
          }));
          y += block.length * lineHeight;
          if (lines.length) newPage();
        }
        y += compact ? 10 : 16;
      };
      const factRowHeight = (items: PropertyExposeFact[], columns: number) => {
        const cellWidth = (WIDTH - 12 * (columns - 1)) / columns;
        return Math.max(...items.slice(0, columns).map((item) => wrap(item.label, 8.5, cellWidth - 24).length * 12 + wrap(item.value, 12.5, cellWidth - 24).length * 17 + 28)) + 10;
      };
      const facts = (items: PropertyExposeFact[], columns = 3) => {
        const gap = 12, cellWidth = (WIDTH - gap * (columns - 1)) / columns;
        for (let offset = 0; offset < items.length; offset += columns) {
          const row = items.slice(offset, offset + columns);
          const heights = row.map((item) => wrap(item.label, 8.5, cellWidth - 24).length * 12 + wrap(item.value, 12.5, cellWidth - 24).length * 17 + 28);
          const height = Math.max(...heights);
          if (height > PAGE.bottom - PAGE.top) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
          ensure(height + 10);
          row.forEach((item, index) => {
            const x = PAGE.margin + index * (cellWidth + gap);
            artifact(() => pdf.roundedRect(x, y, cellWidth, height, 8).fill(COLOR.white));
            const itemStructure = pdf.struct("P", { actual: `${clean(item.label)}: ${clean(item.value)} ` });
            current.add(itemStructure);
            const previous = current; current = itemStructure;
            const labelHeight = text(item.label, x + 12, y + 11, 8.5, cellWidth - 24, "Span", COLOR.muted, 12);
            text(item.value, x + 12, y + 15 + labelHeight, 12.5, cellWidth - 24, "Span", COLOR.ink, 17);
            current = previous; itemStructure.end();
          });
          y += height + (compact ? 10 : 12);
        }
        y += compact ? 6 : 10;
      };
      const photo = (image: PropertyExposeImage, x: number, top: number, width: number, height: number, contain: boolean) => {
        const alt = clean(image.caption) || (contain ? copy.plan : copy.photo);
        artifact(() => pdf.roundedRect(x, top, width, height, 8).fill(COLOR.white));
        try {
          const options = { alt, bbox: [x, top, x + width, top + height] as [number, number, number, number] };
          current.add(pdf.struct("Figure", options, () => {
            pdf.save();
            pdf.roundedRect(x, top, width, height, 8).clip();
            pdf.image(Buffer.from(image.bytes), x, top, { ...(contain ? { fit: [width, height] as [number, number] } : { cover: [width, height] as [number, number] }), align: "center", valign: "center" });
            pdf.restore();
          }));
        } catch { throw new PropertyExposePdfError("INVALID_IMAGE", copy.image); }
      };

      newPage(); section();
      y += text(copy.eyebrow, PAGE.margin, y, 9, WIDTH, "P", COLOR.muted) + (compact ? 6 : 10);
      const titleLines = wrap(document.title, document.template === "compact" ? 27 : 30, WIDTH, true);
      if (titleLines.length > 5) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
      y += text(document.title, PAGE.margin, y, compact ? 27 : 30, WIDTH, "H1", COLOR.ink, compact ? 33 : 36) + (compact ? 6 : 9);
      if (document.address) y += text(document.address, PAGE.margin, y, 11, WIDTH, "P", COLOR.muted) + (compact ? 5 : 8);
      y += text(`${copy.reference}: ${document.reference}`, PAGE.margin, y, 9, WIDTH, "P", COLOR.muted) + (compact ? 8 : 14);
      if (document.price) {
        const padding = compact ? 16 : 20;
        const height = wrap(document.price, 17, WIDTH - 28).length * 23 + padding;
        ensure(height + 16);
        artifact(() => pdf.roundedRect(PAGE.margin, y, WIDTH, height, 8).fill(COLOR.accent));
        text(document.price, PAGE.margin + 14, y + padding / 2, 17, WIDTH - 28, "P", COLOR.ink, 23);
        y += height + (compact ? 12 : 18);
      }
      const photographs = document.images.filter((image) => image.kind === "image");
      const plans = document.images.filter((image) => image.kind === "floorplan");
      const hero = photographs[0];
      if (hero) {
        const height = compact ? 144 : 238;
        const captionHeight = clean(hero.caption) ? wrap(hero.caption, 8.5).length * 12 + 6 : 0;
        ensure(height + captionHeight + 20);
        photo(hero, PAGE.margin, y, WIDTH, height, false); y += height + 6;
        if (captionHeight) y += text(hero.caption, PAGE.margin, y, 8.5, WIDTH, "Caption", COLOR.muted, 12);
        y += compact ? 10 : 18;
      }
      if (document.facts.length) { heading(copy.facts, factRowHeight(document.facts, 3)); facts(document.facts); }
      for (const entry of document.sections) {
        if (!clean(entry.text)) continue;
        section(); heading(entry.heading); paragraph(entry.text);
      }
      for (const [label, values] of [[copy.costs, document.costs], [copy.energy, document.energy]] as const) {
        if (values.length) { section(); heading(label, factRowHeight(values, 2)); facts(values, 2); }
      }
      // Keep the public contact/notes with the descriptive content, before
      // the optional image appendix. This avoids a notes-only trailing page.
      const contactLines = document.contact ? [document.contact.company, document.contact.name, document.contact.phone, document.contact.email].filter((value): value is string => !!value && !!clean(value)) : [];
      if (contactLines.length) {
        section();
        if (compact && document.contact) {
          // Two independently measured columns keep every contact field readable
          // while avoiding a near-empty second page for a short listing.
          const columns = [[document.contact.company, document.contact.name], [document.contact.phone, document.contact.email]]
            .map((values) => values.filter((value): value is string => !!value && !!clean(value)).join("\n"));
          const width = (WIDTH - 18) / 2;
          const height = Math.max(...columns.map((value) => value ? wrap(value, 10.5, width).length * 15.75 : 0));
          heading(copy.contact, height);
          columns.forEach((value, index) => { if (value) text(value, PAGE.margin + index * (width + 18), y, 10.5, width, "P", COLOR.ink, 15.75); });
          y += height + 10;
        } else {
          heading(copy.contact, Math.min(300, wrap(contactLines.join("\n"), 10.5).length * 15.75)); paragraph(contactLines.join("\n"));
        }
      }
      if (document.notices.length) { section(); heading(copy.notices); for (const notice of document.notices) if (clean(notice)) paragraph(notice, 9, COLOR.muted); }
      const gallery = photographs.slice(1);
      if (gallery.length) {
        if (document.template === "full" && y > PAGE.top) newPage();
        section(); heading(copy.gallery);
        const gap = 14, width = (WIDTH - gap) / 2;
        const imageHeight = document.template === "compact" ? 116 : 180;
        for (let offset = 0; offset < gallery.length; offset += 2) {
          const row = gallery.slice(offset, offset + 2);
          const captionHeight = Math.max(0, ...row.map((image) => clean(image.caption) ? wrap(image.caption, 9, width).length * 13 : 0));
          const rowHeight = imageHeight + captionHeight + 24;
          if (rowHeight > PAGE.bottom - PAGE.top) throw new PropertyExposePdfError("EXPOSE_TOO_LONG", copy.long);
          ensure(rowHeight);
          row.forEach((image, index) => {
            const x = PAGE.margin + index * (width + gap);
            photo(image, x, y, width, imageHeight, false);
            if (clean(image.caption)) text(image.caption, x, y + imageHeight + 7, 9, width, "Caption", COLOR.muted, 13);
          });
          y += rowHeight;
        }
      }
      for (const [index, plan] of plans.entries()) {
        const height = document.template === "compact" ? 248 : 516;
        const captionHeight = clean(plan.caption) ? wrap(plan.caption, 9).length * 13 : 0;
        if (document.template === "full" && y > PAGE.top) newPage();
        else ensure(height + captionHeight + 66);
        section(); heading(plans.length > 1 ? `${copy.floorplans} ${index + 1}` : copy.floorplans);
        photo(plan, PAGE.margin, y, WIDTH, height, true); y += height + 10;
        if (captionHeight) y += text(plan.caption, PAGE.margin, y, 9, WIDTH, "Caption", COLOR.muted, 13);
        y += 18;
      }
      for (const source of pdfPlans) {
        const height = document.template === "compact" ? 260 : 516;
        const captionHeight = wrap(source.caption, 9).length * 13;
        if (document.template === "full" && y > PAGE.top) newPage();
        else ensure(height + captionHeight + 66);
        section(); heading(copy.floorplans);
        const x = PAGE.margin, top = y, pad = 12;
        const rotated = source.rotation === 90 || source.rotation === 270;
        const effectiveWidth = rotated ? source.height : source.width;
        const effectiveHeight = rotated ? source.width : source.height;
        const scale = Math.min((WIDTH - pad * 2) / effectiveWidth, (height - pad * 2) / effectiveHeight);
        const left = x + (WIDTH - effectiveWidth * scale) / 2;
        const upper = top + (height - effectiveHeight * scale) / 2;
        const name = `NovalurePlan${placements.length}`;
        artifact(() => pdf.roundedRect(x, top, WIDTH, height, 8).fill(COLOR.white));
        const options = { alt: source.caption, bbox: [left, upper, left + effectiveWidth * scale, upper + effectiveHeight * scale] as [number, number, number, number] };
        current.add(pdf.struct("Figure", options, () => {
          pdf.save();
          if (source.rotation === 90) pdf.transform(0, scale, scale, 0, left, upper);
          else if (source.rotation === 180) pdf.transform(-scale, 0, 0, scale, left + source.width * scale, upper);
          else if (source.rotation === 270) pdf.transform(0, -scale, -scale, 0, left + source.height * scale, upper + source.width * scale);
          else pdf.transform(scale, 0, 0, -scale, left, upper + source.height * scale);
          // The validated source is later attached as a Form XObject. Keeping
          // this Do operation here retains PDFKit's Figure/MCID reading order.
          pdf.addContent(`/${name} Do`);
          pdf.restore();
        }));
        placements.push({ outputPage: pageCount - 1, source, name });
        y += height + 10;
        y += text(source.caption, PAGE.margin, y, 9, WIDTH, "Caption", COLOR.muted, 13) + 18;
      }
      for (let index = 0; index < pageCount; index++) {
        pdf.switchToPage(index);
        artifact(() => {
          pdf.moveTo(PAGE.margin, 800).lineTo(PAGE.width - PAGE.margin, 800).lineWidth(0.6).stroke(COLOR.line);
          fontSize(8).fillColor(COLOR.muted).text(`${copy.date}: ${date}`, PAGE.margin, 810, { lineBreak: false });
          const label = `${copy.page} ${index + 1} / ${pageCount}`;
          pdf.text(label, PAGE.width - PAGE.margin - pdf.widthOfString(label), 810, { lineBreak: false });
        }, true);
      }
      root.end();
      pdf.end();
    } catch (error) {
      // Abandon the in-memory stream; a partial document is never returned.
      pdf.destroy();
      reject(error);
    }
  });
  if (!placements.length) return pdfBytes;
  const result = await EditablePdf.load(pdfBytes, { updateMetadata: false });
  for (const placement of placements) {
    // embedPage copies page artwork/resources only, never page-level actions,
    // links, form widgets, attachments or source-document metadata/catalogs.
    // pdf-lib's copier visits the source page before creating the Form. Strip
    // unused page dictionaries too, so even orphan annotation/action objects
    // never enter the output context. Source bytes remain unchanged.
    const allowedPageKeys = new Set(["/Type", "/Parent", "/Contents", "/Resources", "/MediaBox", "/CropBox", "/Rotate", "/UserUnit"]);
    for (const key of placement.source.page.node.keys()) if (!allowedPageKeys.has(key.toString())) placement.source.page.node.delete(key);
    const embedded = await result.embedPage(placement.source.page, placement.source.box);
    result.getPage(placement.outputPage).node.normalizedEntries().XObject.set(PDFName.of(placement.name), embedded.ref);
  }
  return result.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
