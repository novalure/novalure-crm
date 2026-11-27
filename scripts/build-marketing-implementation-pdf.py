"""Build the short implementation proof from its editable Markdown source.

The explicit source marker prevents accidental publication of a pending review.
Original QA images remain untouched; selected regions are clipped at PDF layout time.
"""
from pathlib import Path
from html import escape
import re

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer,
    Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/Livelisted-Umsetzung-Novalure-2026-11-04.md"
OUTPUT = ROOT / "output/pdf/Livelisted-Umsetzung-Novalure-2026-11-04.pdf"
PAGE_WIDTH, PAGE_HEIGHT = 595.28, 841.89
WIDTH = PAGE_WIDTH - 92
INK = colors.HexColor("#182B3B")
TEAL = colors.HexColor("#166E70")
MUTED = colors.HexColor("#536777")


def inline(text):
    text = escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    return text


class ScreenshotRegion(Flowable):
    def __init__(self, path, crop=None, maxh=330):
        super().__init__()
        self.reader = ImageReader(str(path))
        self.iw, self.ih = self.reader.getSize()
        self.crop = crop or (0, 0, self.iw, self.ih)
        left, top, right, bottom = self.crop
        self.scale = min(WIDTH / (right - left), maxh / (bottom - top))
        self.width = (right - left) * self.scale
        self.height = (bottom - top) * self.scale

    def draw(self):
        left, top, right, bottom = self.crop
        self.canv.saveState()
        clip = self.canv.beginPath()
        clip.rect(0, 0, self.width, self.height)
        self.canv.clipPath(clip, stroke=0, fill=0)
        self.canv.drawImage(
            self.reader, -left * self.scale,
            -(self.ih - bottom) * self.scale,
            width=self.iw * self.scale, height=self.ih * self.scale,
        )
        self.canv.restoreState()
        self.canv.setStrokeColor(colors.HexColor("#D9E2E7"))
        self.canv.rect(0, 0, self.width, self.height, stroke=1, fill=0)


def main():
    source = SOURCE.read_text(encoding="utf-8")
    if "<!-- PDF_STATUS: FINAL_LOCAL_ACCEPTANCE -->" not in source:
        raise SystemExit("No PDF written: source still awaits final local acceptance.")
    if "wird vor der PDF-Ausgabe" in source or "PENDING" in source:
        raise SystemExit("No PDF written: pending acceptance text remains.")
    for name, filename in [("Novalure", "arial.ttf"), ("NovalureBold", "arialbd.ttf")]:
        pdfmetrics.registerFont(TTFont(name, str(Path("C:/Windows/Fonts") / filename)))
    pdfmetrics.registerFontFamily(
        "Novalure", normal="Novalure", bold="NovalureBold",
        italic="Novalure", boldItalic="NovalureBold",
    )
    styles = {
        "title": ParagraphStyle("title", fontName="NovalureBold", fontSize=23,
                                leading=28, textColor=INK, spaceAfter=13),
        "head": ParagraphStyle("head", fontName="NovalureBold", fontSize=19,
                               leading=23, textColor=INK, spaceAfter=13),
        "section": ParagraphStyle("section", fontName="NovalureBold", fontSize=11.1,
                                  leading=15, textColor=TEAL, spaceBefore=10,
                                  spaceAfter=6, keepWithNext=True),
        "body": ParagraphStyle("body", fontName="Novalure", fontSize=9.2,
                               leading=13.3, textColor=INK, spaceAfter=8),
        "caption": ParagraphStyle("caption", fontName="Novalure", fontSize=7.7,
                                  leading=10.2, textColor=MUTED, spaceAfter=10),
        "cell": ParagraphStyle("cell", fontName="Novalure", fontSize=8,
                               leading=11.2, textColor=INK),
        "cellhead": ParagraphStyle("cellhead", fontName="NovalureBold", fontSize=8,
                                   leading=11.2, textColor=colors.white),
    }
    lines = source.splitlines()
    story = []
    first_heading = True
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line.startswith("<!-- PDF_STATUS"):
            i += 1
            continue
        if line == "<!-- PAGE -->":
            story.append(PageBreak())
            i += 1
            continue
        if line.startswith("# "):
            style = "title" if first_heading else "head"
            first_heading = False
            story.append(Paragraph(inline(line[2:]), styles[style]))
            i += 1
            continue
        if line.startswith("## "):
            story.append(Paragraph(inline(line[3:]), styles["section"]))
            i += 1
            continue
        if line.startswith("!["):
            match = re.fullmatch(r'!\[(.*?)\]\((\S+?)(?: "(.*?)")?\)', line)
            if not match:
                raise ValueError(f"Malformed screenshot: {line}")
            caption, relative, options = match.groups()
            path = (SOURCE.parent / relative).resolve()
            crop, maxh = None, 330
            for item in (options or "").split(";"):
                if item.startswith("crop="):
                    crop = tuple(float(v) for v in item[5:].split(","))
                if item.startswith("maxh="):
                    maxh = float(item[5:])
            story.append(KeepTogether([
                ScreenshotRegion(path, crop, maxh), Spacer(1, 5),
                Paragraph(inline(caption), styles["caption"]),
            ]))
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                raw = [cell.strip() for cell in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", cell) for cell in raw):
                    rows.append(raw)
                i += 1
            data = [[Paragraph(inline(cell), styles["cellhead" if ri == 0 else "cell"])
                     for cell in row] for ri, row in enumerate(rows)]
            table = Table(data, colWidths=[102, WIDTH - 102], repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), INK),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1),
                 [colors.HexColor("#EEF5F5"), colors.white]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3,
                 colors.HexColor("#D6E1E6")),
            ]))
            story.append(table)
            story.append(Spacer(1, 5))
            continue
        paragraphs = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "<!--", "![", "|")):
            paragraphs.append(lines[i].strip())
            i += 1
        text = " ".join(paragraphs)
        style = "caption" if text.startswith("4. November 2026 |") else "body"
        story.append(Paragraph(inline(text), styles[style]))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#CFDEE3"))
        canvas.line(46, 42, PAGE_WIDTH - 46, 42)
        canvas.setFont("Novalure", 7.6)
        canvas.setFillColor(MUTED)
        canvas.drawString(46, 28, "NOVALURE | Lokaler Umsetzungsnachweis | 04.11.2026")
        canvas.drawRightString(PAGE_WIDTH - 46, 28, str(doc.page))
        canvas.restoreState()

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT), pagesize=(PAGE_WIDTH, PAGE_HEIGHT),
        leftMargin=46, rightMargin=46, topMargin=42, bottomMargin=57,
        title="Novalure: Marketing und Exposés - Umsetzungsnachweis",
        author="Novalure CRM",
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    from pypdf import PdfReader
    count = len(PdfReader(OUTPUT).pages)
    if count > 4:
        raise SystemExit(f"PDF needs layout revision: {count} pages, maximum is 4.")
    print(f"{OUTPUT}\nPages: {count}")


if __name__ == "__main__":
    main()
