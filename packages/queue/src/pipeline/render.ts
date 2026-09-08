import "server-only";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { readReceiptFile, receiptFilePath } from "@ledgerly/api/storage";

/**
 * packages/queue/src/pipeline/render.ts — the image/PDF render pipeline
 * (tasks 5.3-5.6, ARCHITECTURE.md §5, D-10, D-11).
 *
 * Two families of function here:
 *   - header-only PROBES (`probeImageDimensions`,
 *     `probePdfPageDimensionsAtDpi`) — called from the upload route's guard
 *     chain, BEFORE any receipt row exists, BEFORE any decode.
 *   - the actual PIPELINE (`rasterizePdfFirstPage`, `renderDisplayAndThumb`,
 *     `renderExtraction`, `regenerateExtractionRender`) — called from the
 *     `receipt-ingest` worker, after guards have already passed.
 */

const execFileAsync = promisify(execFile);

export type Dimensions = { width: number; height: number };

// D-10: the pipeline's one fixed rasterization DPI for PDF page 1.
const PDF_RASTER_DPI = 200;

const DISPLAY_MAX_EDGE = 1600;
const THUMB_MAX_EDGE = 320;
const EXTRACTION_MAX_EDGE = 2200;
const DISPLAY_WARN_BYTES = 300_000; // "target under 300 KB" -- a tuning signal, not a hard failure

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// ---------------------------------------------------------------------------
// Guards -- header-only, no decode
// ---------------------------------------------------------------------------

/**
 * Reads dimensions from an image's header/IFD without decoding pixel data
 * (task 5.2's "read the header dimensions before decoding, do not decode
 * and then check"). `limitInputPixels: false` affects only this metadata
 * read, which never allocates decoded pixels regardless -- every actual
 * decode elsewhere in this module keeps sharp's own ~268MP default limit
 * in force, as TOCTOU defense in depth on top of this guard.
 *
 * Returns `null` for anything sharp can't even parse a header from --
 * callers treat that as a guard failure, same as an oversized image.
 */
export async function probeImageDimensions(bytes: Buffer): Promise<Dimensions | null> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
    if (!meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

export type PdfProbeResult =
  | { ok: true; dimensions: Dimensions }
  | { ok: false; reason: "unavailable" | "no_pages" | "probe_failed" };

/**
 * Header-only probe for a PDF's first page, converted to the pixel
 * dimensions it will rasterize to at `PDF_RASTER_DPI`. This is NOT
 * redundant with a fixed rasterization DPI: a crafted `/MediaBox` can
 * declare an arbitrarily large page independent of actual page content --
 * e.g. a page declared 300in x 300in rasterizes at 200 DPI to 60000x60000px
 * (3.6 gigapixels) no matter what's drawn on it. Runs `pdfinfo`, never
 * `pdftoppm` -- metadata only, no rasterization, so this stays cheap even
 * for a maliciously large declared page.
 *
 * Missing `pdfinfo` (ENOENT) is a dev-only condition -- the production
 * runner image always installs `poppler-utils` (D-11) -- so it logs and
 * returns `{ok:false, reason:"unavailable"}` rather than throwing; the
 * caller treats "unavailable" as "skip this guard", never as "reject".
 */
export async function probePdfPageDimensionsAtDpi(
  bytes: Buffer,
  dpi: number = PDF_RASTER_DPI,
): Promise<PdfProbeResult> {
  const tmpFile = path.join(os.tmpdir(), `ledgerly-pdfprobe-${randomUUID()}.pdf`);
  // mode 0o600: this is an uploaded receipt's raw bytes, written to a
  // shared temp directory on the request path -- default umask-derived
  // permissions could leave it group/world-readable (review finding LOW).
  await fs.writeFile(tmpFile, bytes, { mode: 0o600 });
  try {
    // 10s timeout: a hung pdfinfo (e.g. a password-protected or
    // adversarially malformed PDF) must not tie up an ingest worker slot
    // forever.
    const { stdout } = await execFileAsync("pdfinfo", ["-f", "1", "-l", "1", tmpFile], {
      timeout: 10_000,
    });
    // poppler's real output is "Page    1 size:  200 x 100 pts" -- the page
    // number and column padding are both present, not "Page size:" as the
    // docs sometimes paraphrase it.
    const match = /^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
    if (!match?.[1] || !match[2]) return { ok: false, reason: "no_pages" };
    const widthPts = Number(match[1]);
    const heightPts = Number(match[2]);
    const width = Math.round((widthPts / 72) * dpi);
    const height = Math.round((heightPts / 72) * dpi);
    return { ok: true, dimensions: { width, height } };
  } catch (error) {
    if (isEnoent(error)) {
      console.warn(
        "[ledgerly] pdfinfo not found -- skipping PDF page-size guard (dev only; " +
          "poppler-utils ships in the production image, D-11)",
      );
      return { ok: false, reason: "unavailable" };
    }
    return { ok: false, reason: "probe_failed" };
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

export function exceedsMegapixelCap(dimensions: Dimensions, maxMegapixels: number): boolean {
  return dimensions.width * dimensions.height > maxMegapixels * 1_000_000;
}

// ---------------------------------------------------------------------------
// Pipeline -- runs in the receipt-ingest worker, after guards have passed
// ---------------------------------------------------------------------------

export type RasterizeResult =
  { ok: true; bytes: Buffer } | { ok: false; reason: "unavailable" | "rasterize_failed" };

/**
 * `pdftoppm -f 1 -l 1 -r 200 -png` (D-10). `-singlefile` is added beyond
 * the literal ARCHITECTURE.md command so the output filename is
 * deterministic (`<prefix>.png`) rather than depending on poppler's
 * page-numbered-output naming convention for a 1-page range.
 */
export async function rasterizePdfFirstPage(
  bytes: Buffer,
  dpi: number = PDF_RASTER_DPI,
): Promise<RasterizeResult> {
  const id = randomUUID();
  const inputFile = path.join(os.tmpdir(), `ledgerly-pdfin-${id}.pdf`);
  const outputPrefix = path.join(os.tmpdir(), `ledgerly-pdfout-${id}`);
  await fs.writeFile(inputFile, bytes, { mode: 0o600 });
  try {
    // 30s timeout -- rasterization is slower than the metadata-only
    // pdfinfo probe, but a hung pdftoppm still must not hold a worker slot
    // forever. The page-size guard already ran before this job was
    // enqueued, so this isn't defending against a huge *declared* page --
    // just a pathological PDF structure.
    await execFileAsync(
      "pdftoppm",
      ["-f", "1", "-l", "1", "-r", String(dpi), "-png", "-singlefile", inputFile, outputPrefix],
      { timeout: 30_000 },
    );
    const raster = await fs.readFile(`${outputPrefix}.png`);
    return { ok: true, bytes: raster };
  } catch (error) {
    if (isEnoent(error)) {
      console.warn("[ledgerly] pdftoppm not found -- cannot rasterize PDF (dev only, D-11)");
      return { ok: false, reason: "unavailable" };
    }
    return { ok: false, reason: "rasterize_failed" };
  } finally {
    await fs.rm(inputFile, { force: true });
    await fs.rm(`${outputPrefix}.png`, { force: true });
  }
}

export type RenderSet = {
  display: Buffer;
  thumb: Buffer;
  displayBytes: number;
  thumbBytes: number;
};

/**
 * Produces renders B (display) and C (thumb) from already-rasterized image
 * bytes (a photo's native format, or a PDF page already turned into a PNG
 * by `rasterizePdfFirstPage`).
 *
 * `sharp(bytes).rotate()` with no arguments auto-orients from EXIF and
 * normalizes to orientation 1 -- this is task 5.5's "apply EXIF
 * orientation" step. GPS/EXIF/ICC/XMP are dropped by sharp's *default*
 * behavior: neither `.toBuffer()` call below ever calls `.withMetadata()`,
 * and that absence is the entire strip mechanism -- there is no separate
 * scrubbing step to audit. `.clone()` off the one decoded+rotated base
 * avoids decoding the source twice per receipt.
 *
 * `maxMegapixels` is passed as `limitInputPixels` on the actual decode --
 * review finding M-1: the upload route's header-only probe rejects an
 * oversized file before a receipt row even exists, but every decode in
 * this module previously used sharp's own ~268MP default regardless of
 * the operator-configured cap, which could be far lower. This is the
 * enforcement point that guard was meant to back up, not just a TOCTOU
 * nicety: a rasterized PDF page (never probed by `sharp.metadata()`, only
 * by `probePdfPageDimensionsAtDpi`'s separate `pdfinfo` estimate) or any
 * source reaching this function when the PDF page-size guard was skipped
 * (`pdfinfo` unavailable, dev-only) is now bounded here too.
 */
export async function renderDisplayAndThumb(
  sourceBytes: Buffer,
  receiptId: string,
  maxMegapixels: number,
): Promise<RenderSet> {
  const base = sharp(sourceBytes, { limitInputPixels: maxMegapixels * 1_000_000 }).rotate();

  const display = await base
    .clone()
    .resize({
      width: DISPLAY_MAX_EDGE,
      height: DISPLAY_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();

  const thumb = await base
    .clone()
    .resize({
      width: THUMB_MAX_EDGE,
      height: THUMB_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 60 })
    .toBuffer();

  // "Log the actual sizes so we can tune" (brief §3).
  console.log("[ledgerly] receipt render", {
    receiptId,
    displayBytes: display.length,
    thumbBytes: thumb.length,
  });
  if (display.length > DISPLAY_WARN_BYTES) {
    console.warn(
      `[ledgerly] receipt ${receiptId}: display render exceeded the 300 KB target ` +
        `(${display.length} bytes)`,
    );
  }

  return { display, thumb, displayBytes: display.length, thumbBytes: thumb.length };
}

/**
 * The render-A transform: longest edge 2200, JPEG q88. Phase 5's own
 * ingest job never calls this -- nothing consumes render A yet (Phase 6
 * doesn't exist). Exported ready for Phase 6 to call directly, or via
 * `regenerateExtractionRender` below, without re-deriving this pipeline.
 */
export async function renderExtraction(
  sourceBytes: Buffer,
  maxMegapixels: number,
): Promise<Buffer> {
  return sharp(sourceBytes, { limitInputPixels: maxMegapixels * 1_000_000 })
    .rotate()
    .resize({
      width: EXTRACTION_MAX_EDGE,
      height: EXTRACTION_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88 })
    .toBuffer();
}

export type RegenerateExtractionResult = {
  buffer: Buffer;
  source: "original" | "display";
  warning?: string;
};

/**
 * Phase 6's on-demand entry point for render A, for a receipt whose
 * extraction render was already discarded after Phase 6's own AI call.
 * Regenerates from `original.<ext>` when retained (full quality); when
 * not retained, re-derives from the ALREADY-COMPRESSED `display.webp`
 * (1600px/q72) instead -- lossier than a fresh render from the original,
 * so this path logs and returns an explicit quality warning rather than
 * silently degrading extraction accuracy.
 */
export async function regenerateExtractionRender(params: {
  uploadsDir: string;
  projectId: string;
  receiptId: string;
  hasOriginal: boolean;
  originalExt: string | null;
  maxMegapixels: number;
}): Promise<RegenerateExtractionResult> {
  const { uploadsDir, projectId, receiptId, hasOriginal, originalExt, maxMegapixels } = params;

  if (hasOriginal && originalExt) {
    const originalPath = receiptFilePath(uploadsDir, projectId, receiptId, "original", originalExt);
    const bytes = await readReceiptFile(originalPath);
    return { buffer: await renderExtraction(bytes, maxMegapixels), source: "original" };
  }

  const displayPath = receiptFilePath(uploadsDir, projectId, receiptId, "display", "webp");
  const bytes = await readReceiptFile(displayPath);
  const warning =
    "regenerated from the display render; the original was not retained, quality is reduced";
  console.warn(`[ledgerly] receipt ${receiptId}: ${warning}`);
  return { buffer: await renderExtraction(bytes, maxMegapixels), source: "display", warning };
}
