#!/usr/bin/env node
const puppeteer = require("puppeteer");
const { marked } = require("marked");
const path = require("path");
const fs = require("fs");

// ── Resolve paths relative to *this* script (renderer/) ──
const RENDERER_DIR = __dirname;
const RESUME_CSS_PATH = path.join(RENDERER_DIR, "resume.css");
const COVER_LETTER_CSS_PATH = path.join(RENDERER_DIR, "cover-letter.css");
const STAMP_PATH = path.join(RENDERER_DIR, "Assets", "Stamp.png");

/**
 * Detect if the input is a cover letter based on filename
 */
function isCoverLetter(filePath) {
  return filePath.toLowerCase().includes("cover-letter");
}

/**
 * Wrap raw HTML body content in a full document with the shared stylesheet.
 * Uses absolute file:// URLs for all assets so Puppeteer can resolve them.
 */
function wrapInDocument(bodyHtml, title, closingHtml = "", lang = "se", isCover = false) {
  const cssPath = isCover ? COVER_LETTER_CSS_PATH : RESUME_CSS_PATH;
  const cssText = fs.readFileSync(cssPath, "utf-8");

  // Embed font files as base64 data URIs
  // (Puppeteer setContent blocks ALL file:// resources — fonts included)
  const absoluteCss = cssText.replace(
    /url\(['"]?(Assets\/[^'")\s]+\.otf)['"]?\)\s*format\(['"]opentype['"]\)/g,
    (_, relPath) => {
      const fontPath = path.join(RENDERER_DIR, relPath);
      const fontData = fs.readFileSync(fontPath).toString("base64");
      return `url('data:font/opentype;base64,${fontData}') format('opentype')`;
    }
  );

  // Embed stamp as base64 data URI (Puppeteer setContent blocks file:// images)
  const stampData = fs.readFileSync(STAMP_PATH).toString("base64");
  const stampSrc = `data:image/png;base64,${stampData}`;

  if (isCover) {
    // Cover letter format - structured letter layout
    return `<!DOCTYPE html>
<html lang="${lang === "en" ? "en" : "sv"}">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>${absoluteCss}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  } else {
    // Resume format - with closing block
    return `<!DOCTYPE html>
<html lang="${lang === "en" ? "en" : "sv"}">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>${absoluteCss}</style>
</head>
<body>
${bodyHtml}

<!-- closing functionality -->
<div class="closing-block">
  <div class="sign-off-left">
    <div class="closing-statement">
      ${closingHtml}
    </div>
    <div class="sign-off-name">Anton Kinnander</div>
  </div>
  <div class="sign-off-stamp">
    <img src="${stampSrc}" alt="AK stamp">
  </div>
</div>
</body>
</html>`;
  }
}

/**
 * Pre-process markdown before parsing:
 *  - Strip trailing personal notes (everything after the last --- if it
 *    contains a ⚠️ flag or similar internal annotation)
 *  - Convert consecutive non-blank lines that start with a label like
 *    "Design:", "Webb:", "Övrigt:" into separate <br>-delimited lines
 *    so they don't collapse into one paragraph.
 */
function preprocessMarkdown(md) {
  // Normalize non-standard dashes to regular hyphen
  md = md.replace(/[\u2014\u2013\u2012\u2015]/g, '-');

  let closingText = "";
  const parts = md.split(/\n---\s*\n/);

  if (parts.length > 1) {
    let lastPart = parts[parts.length - 1];
    // Strip flagged section
    if (/⚠️|Flagga|FLAGG/i.test(lastPart)) {
      parts.pop();
    }
  }

  if (parts.length > 1) {
    let lastPart = parts[parts.length - 1];
    // If the last part has no headings, treat it as the closing statement
    if (!/^#/m.test(lastPart)) {
      closingText = parts.pop().trim();
    }
  }

  md = parts.join("\n---\n") + "\n";

  // Strip trailing "Anton Kinnander" — PDF template adds it in the closing block
  if (closingText) {
    closingText = closingText.replace(/,?\s*\n*Anton Kinnander\s*$/i, '').trim();
  }
  md = md.replace(/\n*Anton Kinnander\s*$/, '').trim() + '\n';

  return { md, closingText };
}

/**
 * Render an HTML or Markdown file to A4 PDF.
 */
async function render(inputPath) {
  const absolute = path.resolve(inputPath);
  const ext = path.extname(absolute).toLowerCase();
  const outputPdf = absolute.replace(/\.(html?|md)$/i, ".pdf");

  // Detect if this is a cover letter
  const isCover = isCoverLetter(absolute);
  const docType = isCover ? "Cover Letter" : "Resume";

  console.log(`Input:  ${absolute}`);
  console.log(`Output: ${outputPdf}`);
  console.log(`Type:   ${docType}`);

  let htmlContent;

  if (ext === ".md") {
    // ── Markdown path: pre-process → parse → wrap in styled document ──
    let rawMd = fs.readFileSync(absolute, "utf-8");

    // For cover letters, we need different preprocessing
    let md, closingHtml, title;
    let senderName = "Anton Kinnander";
    let senderContact = "Jönköping · 072-889 33 91 · a.kinnander@icloud.com · antonkinnander.se";
    let letterDate = new Date().toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' });

    if (isCover) {
      // Cover letter preprocessing - extract structured info
      md = preprocessCoverLetter(rawMd);
      title = (rawMd.match(/^#\s+(.+)/m) || [, "Cover Letter"])[1];
    } else {
      // Resume preprocessing
      const preprocessed = preprocessMarkdown(rawMd);
      md = preprocessed.md;
    }

    // Configure marked for GFM (tables, strikethrough, etc.)
    // breaks:true → single newlines become <br> (fixes Kompetenser, Utbildning etc.)
    marked.setOptions({ gfm: true, breaks: true });

    // Determine language from filename (e.g. resume-en.md or cover-letter-en.md)
    const lang = absolute.toLowerCase().includes("-en") ? "en" : "se";

    const bodyHtml = marked.parse(md);

    if (isCover) {
      // Cover letter uses a simpler closing - just the body content
      htmlContent = wrapInDocument(bodyHtml, title, "", lang, true);
    } else {
      // Resume needs closing block
      const preprocessed = preprocessMarkdown(rawMd);
      if (preprocessed.closingText) {
        closingHtml = marked.parse(preprocessed.closingText);
      } else {
        const greetingPath = path.join(RENDERER_DIR, `greeting-${lang}.md`);
        if (fs.existsSync(greetingPath)) {
          closingHtml = marked.parse(fs.readFileSync(greetingPath, "utf-8"));
        }
      }

      title = (md.match(/^#\s+(.+)/m) || [, "Resume"])[1];
      htmlContent = wrapInDocument(bodyHtml, title, closingHtml, lang, false);
    }
  } else {
    // ── HTML path: use file directly ──
    htmlContent = null;
  }

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  if (htmlContent) {
    // For markdown-generated HTML, set content directly
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    fs.writeFileSync(outputPdf.replace(/\.pdf$/i, ".html"), htmlContent);
  } else {
    // For .html files, navigate to the file so relative paths work as authored
    await page.goto(`file:///${absolute.replace(/\\/g, "/")}`, {
      waitUntil: "networkidle0",
    });
  }

  // Wait for @font-face to load
  await page.evaluateHandle("document.fonts.ready");

  // Cover letters don't need dynamic margin adjustment
  if (isCover) {
    await page.pdf({
      path: outputPdf,
      format: "A4",
      printBackground: true,
      margin: {
        top: "25mm",
        right: "25mm",
        bottom: "25mm",
        left: "25mm",
      },
    });
    console.log(`✔ PDF saved → ${outputPdf}`);
  } else {
    // --- Dynamic Layout Adjustments for Resume ---
    // We want the closing statement and signature to ideally sit at the bottom of the last page.
    // CSS doesn't support "grow to fit remaining page" natively, so we iteratively test margins
    // via a quick binary search to find the maximum possible margin without creating a new page.
    const tryMargin = async (m) => {
      await page.evaluate((margin) => {
        const el = document.querySelector('.closing-block');
        if (el) el.style.marginTop = margin + 'pt';
      }, m);
      return await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" },
      });
    };

    let finalMargin = 24; // fallback

    try {
      const { PDFDocument } = require("pdf-lib");
      const MIN_MARGIN = 0; // Minimum safe margin
      const MAX_MARGIN = 36; // Cap the margin at 36pt

      // Measure base number of pages with minimum margin
      let basePdf = await tryMargin(MIN_MARGIN);
      let baseDoc = await PDFDocument.load(basePdf);
      let targetPages = baseDoc.getPageCount();

      let low = MIN_MARGIN;
      let high = MAX_MARGIN;
      let bestMargin = MIN_MARGIN;

      // Binary search for maximum margin that doesn't trigger an extra page
      while (low <= high) {
        let mid = Math.floor((low + high) / 2);
        let tempPdf = await tryMargin(mid);
        let tempDoc = await PDFDocument.load(tempPdf);

        if (tempDoc.getPageCount() === targetPages) {
          bestMargin = mid; // fits perfectly on target pages
          low = mid + 1; // can we push it further?
        } else {
          high = mid - 1; // triggered an extra page
        }
      }

      // Back off by 2pt just to be safe from rounding errors
      finalMargin = Math.max(MIN_MARGIN, bestMargin - 2);
    } catch (err) {
      console.warn("Could not dynamically calculate margin, falling back to 24pt:", err.message);
    }

    // Apply the final chosen margin
    await page.evaluate((margin) => {
      const el = document.querySelector('.closing-block');
      if (el) el.style.marginTop = margin + 'pt';
    }, finalMargin);

    // Render the final PDF
    await page.pdf({
      path: outputPdf,
      format: "A4",
      printBackground: true,
      margin: {
        top: "20mm",
        right: "20mm",
        bottom: "20mm",
        left: "20mm",
      },
    });

    console.log(`✔ PDF saved → ${outputPdf} (Margin auto-adjusted to ${finalMargin}pt)`);
  }

  await browser.close();
}

/**
 * Preprocess cover letter markdown
 */
function preprocessCoverLetter(md) {
  // Normalize dashes
  md = md.replace(/[\u2014\u2013\u2012\u2015]/g, '-');

  // Strip closing signature - it's added by the template
  md = md.replace(/\n*(Med vänliga hälsningar|Best regards|Vänliga hälsningar),?\s*\n*Anton Kinnander\s*$/gi, '');
  md = md.replace(/\n*Anton Kinnander\s*$/gi, '');

  return md.trim();
}

// ── CLI ─────────────────────────────────────────────────
const input =
  process.argv[2] ||
  path.join(__dirname, "..", "InDesign", "IRMA-resume.html");

render(input).catch((err) => {
  console.error(err);
  process.exit(1);
});
