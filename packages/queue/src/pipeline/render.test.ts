import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import sharp from "sharp";
import { receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  exceedsMegapixelCap,
  probeImageDimensions,
  probePdfPageDimensionsAtDpi,
  rasterizePdfFirstPage,
  regenerateExtractionRender,
  renderDisplayAndThumb,
  renderExtraction,
} from "./render";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const RECEIPT_ID = "22222222-2222-2222-2222-222222222222";

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPdfInfo = hasBinary("pdfinfo");
const hasPdfToPpm = hasBinary("pdftoppm");

/** A syntactically valid, header-only PNG declaring an arbitrary size --
 * exactly what the megapixel guard is meant to reject, so the fixture only
 * needs a header too. Never allocates real pixel data (the IDAT chunk
 * wraps a zero-byte deflate stream), which is the whole point: proving the
 * guard runs from the header alone, without decoding. */
function buildOversizedPng(width: number, height: number): Buffer {
  function u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    return Buffer.concat([u32(data.length), body, u32(zlib.crc32(body) >>> 0)]);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk(
    "IHDR",
    Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]),
  );
  const idat = chunk("IDAT", zlib.deflateSync(Buffer.alloc(0)));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** A minimal, valid single-page PDF -- hand-built rather than pulled from a
 * library, so no new dependency is needed just to test the guard/rasterize
 * path. */
function buildMinimalPdf(): Buffer {
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>>>endobj",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj + "\n";
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

describe("probeImageDimensions", () => {
  it("reads header dimensions from a normal image without decoding pixels", async () => {
    const bytes = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    expect(await probeImageDimensions(bytes)).toEqual({ width: 40, height: 20 });
  });

  it("reads dimensions from a header-only oversized PNG without allocating real pixels", async () => {
    const bytes = buildOversizedPng(20000, 20000);
    expect(bytes.length).toBeLessThan(500); // proves this is header-only, not a real image
    expect(await probeImageDimensions(bytes)).toEqual({ width: 20000, height: 20000 });
  });

  it("returns null for garbage bytes", async () => {
    expect(await probeImageDimensions(Buffer.from([0, 1, 2, 3]))).toBeNull();
  });
});

describe("exceedsMegapixelCap", () => {
  it("rejects a 20000x20000 image against a 100MP cap", () => {
    expect(exceedsMegapixelCap({ width: 20000, height: 20000 }, 100)).toBe(true);
  });

  it("admits a normal photo-sized image", () => {
    expect(exceedsMegapixelCap({ width: 4032, height: 3024 }, 100)).toBe(false);
  });
});

describe("renderDisplayAndThumb -- EXIF orientation + strip", () => {
  it("auto-orients from EXIF orientation 6 and strips all EXIF from the output", async () => {
    // A landscape (100x50) image explicitly tagged orientation 6 -- the
    // viewer must rotate 90deg CW to display correctly, i.e. the CORRECT
    // display dimensions are 50x100 (swapped).
    const raw = await sharp({
      create: { width: 100, height: 50, channels: 3, background: { r: 200, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    const oriented = await sharp(raw).withMetadata({ orientation: 6 }).jpeg().toBuffer();

    // Confirm the fixture itself actually carries the tag before testing
    // that our pipeline removes it.
    const setupMeta = await sharp(oriented).metadata();
    expect(setupMeta.orientation).toBe(6);

    const { display } = await renderDisplayAndThumb(oriented, RECEIPT_ID, 100);
    const outMeta = await sharp(display).metadata();

    // Rotation was applied: physical dimensions are swapped to match
    // correct display orientation.
    expect(outMeta.width).toBe(50);
    expect(outMeta.height).toBe(100);

    // EXIF is gone entirely -- orientation is normalized away (not just
    // "corrected to 1" as a lingering tag), and no exif blob survives at
    // all. GPS coordinates live inside that same EXIF blob, so proving no
    // EXIF survives is exactly what "no GPS in the output" reduces to.
    expect(outMeta.orientation).toBeUndefined();
    expect(outMeta.exif).toBeUndefined();
  });

  it("produces both display and thumb within their target longest edge", async () => {
    const bytes = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();

    const { display, thumb } = await renderDisplayAndThumb(bytes, RECEIPT_ID, 100);

    const displayMeta = await sharp(display).metadata();
    const thumbMeta = await sharp(thumb).metadata();
    expect(Math.max(displayMeta.width ?? 0, displayMeta.height ?? 0)).toBeLessThanOrEqual(1600);
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(320);
    expect(displayMeta.format).toBe("webp");
    expect(thumbMeta.format).toBe("webp");
  });

  it("never upscales a small source", async () => {
    const bytes = await sharp({
      create: { width: 50, height: 30, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .jpeg()
      .toBuffer();
    const { display } = await renderDisplayAndThumb(bytes, RECEIPT_ID, 100);
    const meta = await sharp(display).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(30);
  });
});

describe("renderExtraction", () => {
  it("produces a JPEG within the 2200px longest edge, never written by this test to any storage path", async () => {
    const bytes = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .jpeg()
      .toBuffer();
    const extraction = await renderExtraction(bytes, 100);
    const meta = await sharp(extraction).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2200);
  });
});

describe("regenerateExtractionRender", () => {
  let uploadsDir: string;

  beforeEach(async () => {
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-render-test-"));
  });

  afterEach(async () => {
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  it("regenerates from the original when retained, with no quality warning", async () => {
    const original = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer();
    await writeReceiptFile(
      receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "original", "jpg"),
      original,
    );

    const result = await regenerateExtractionRender({
      uploadsDir,
      projectId: PROJECT_ID,
      receiptId: RECEIPT_ID,
      hasOriginal: true,
      originalExt: "jpg",
      maxMegapixels: 100,
    });

    expect(result.source).toBe("original");
    expect(result.warning).toBeUndefined();
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("falls back to the display render with a quality warning when the original wasn't retained", async () => {
    const display = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 3, g: 3, b: 3 } },
    })
      .webp({ quality: 72 })
      .toBuffer();
    await writeReceiptFile(
      receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "display", "webp"),
      display,
    );

    const result = await regenerateExtractionRender({
      uploadsDir,
      projectId: PROJECT_ID,
      receiptId: RECEIPT_ID,
      hasOriginal: false,
      originalExt: null,
      maxMegapixels: 100,
    });

    expect(result.source).toBe("display");
    expect(result.warning).toMatch(/quality is reduced/);
  });
});

describe("PDF page-size probe and rasterization", () => {
  let minimalPdf: Buffer;

  beforeAll(() => {
    minimalPdf = buildMinimalPdf();
  });

  it.skipIf(!hasPdfInfo)("reads the first page's dimensions at the pipeline DPI", async () => {
    const result = await probePdfPageDimensionsAtDpi(minimalPdf, 200);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // MediaBox is 200x100 pts -> at 200 DPI: 200/72*200 ~= 556, 100/72*200 ~= 278
      expect(result.dimensions.width).toBeGreaterThan(500);
      expect(result.dimensions.width).toBeLessThan(600);
      expect(result.dimensions.height).toBeGreaterThan(250);
      expect(result.dimensions.height).toBeLessThan(300);
    }
  });

  it("reports 'unavailable' rather than throwing when pdfinfo is missing", async () => {
    if (hasPdfInfo) return; // this environment has it -- nothing to prove here
    const result = await probePdfPageDimensionsAtDpi(minimalPdf, 200);
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it.skipIf(!hasPdfToPpm)("rasterizes the first page to a decodable PNG", async () => {
    const result = await rasterizePdfFirstPage(minimalPdf, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const meta = await sharp(result.bytes).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBeGreaterThan(0);
    }
  });

  it("reports 'unavailable' rather than throwing when pdftoppm is missing", async () => {
    if (hasPdfToPpm) return;
    const result = await rasterizePdfFirstPage(minimalPdf, 100);
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
