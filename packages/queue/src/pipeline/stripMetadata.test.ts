import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { stripMetadataForOriginal } from "./stripMetadata";

/**
 * Phase 10a finding F-10. `RETAIN_ORIGINALS=true` promoted the staged
 * upload with a bare `rename`, so a retained `original.<ext>` kept the full
 * EXIF block -- including the GPS tag a phone writes onto a receipt photo,
 * which is typically the user's home.
 *
 * These build images that genuinely carry EXIF (via sharp's
 * `.withMetadata()`, the one place in this repo it is legitimate to call)
 * and assert it is gone afterwards, rather than asserting on byte offsets.
 */

const GPS_EXIF = {
  IFD0: { Copyright: "ledgerly-test" },
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "51/1 30/1 0/1",
    GPSLongitudeRef: "W",
    GPSLongitude: "0/1 7/1 0/1",
  },
} as const;

async function jpegWithGps(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg()
    .withMetadata({ exif: GPS_EXIF as unknown as Record<string, Record<string, string>> })
    .toBuffer();
  return new Uint8Array(buf);
}

async function pngWithText(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 120, b: 220 } },
  })
    .png()
    .withMetadata({ exif: GPS_EXIF as unknown as Record<string, Record<string, string>> })
    .toBuffer();
  return new Uint8Array(buf);
}

async function webpWithExif(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 200, b: 90 } },
  })
    .webp()
    .withMetadata({ exif: GPS_EXIF as unknown as Record<string, Record<string, string>> })
    .toBuffer();
  return new Uint8Array(buf);
}

describe("stripMetadataForOriginal (F-10)", () => {
  it("removes a GPS EXIF block from a JPEG, losslessly", async () => {
    const input = await jpegWithGps();
    // Guard the fixture itself: if sharp stopped embedding EXIF this test
    // would pass vacuously.
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await stripMetadataForOriginal(input, "jpeg");

    expect(result.method).toBe("lossless");
    expect(result.type).toBe("jpeg");
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  });

  it("keeps the JPEG pixel data bit-identical while stripping", async () => {
    // The whole reason for container surgery rather than a re-encode: D-09
    // wants an original that really is the original.
    const input = await jpegWithGps();
    const result = await stripMetadataForOriginal(input, "jpeg");

    const before = await sharp(input).raw().toBuffer();
    const after = await sharp(result.bytes).raw().toBuffer();
    expect(Buffer.compare(before, after)).toBe(0);
    expect(result.bytes.byteLength).toBeLessThan(input.byteLength);
  });

  it("produces a JPEG that still decodes to the original dimensions", async () => {
    const input = await jpegWithGps();
    const result = await stripMetadataForOriginal(input, "jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
  });

  it("removes metadata from a PNG, losslessly", async () => {
    const input = await pngWithText();
    const result = await stripMetadataForOriginal(input, "png");

    expect(result.method).toBe("lossless");
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    const before = await sharp(input).raw().toBuffer();
    const after = await sharp(result.bytes).raw().toBuffer();
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("removes the EXIF chunk from a WebP and rewrites the RIFF size", async () => {
    const input = await webpWithExif();
    const result = await stripMetadataForOriginal(input, "webp");

    expect(result.method).toBe("lossless");
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    // A stale RIFF length makes the file unreadable, so decoding at all is
    // the assertion that the size field was fixed.
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(32);
  });

  it("passes a PDF through untouched -- there is no EXIF to remove", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const result = await stripMetadataForOriginal(pdf, "pdf");
    expect(result.method).toBe("passthrough");
    expect(result.bytes).toBe(pdf);
  });

  it("falls back to sharp for a container it cannot walk, and still strips", async () => {
    const input = await jpegWithGps();
    // Claim TIFF for JPEG bytes: no lossless walker matches, so this takes
    // the sharp fallback path.
    const result = await stripMetadataForOriginal(input, "tiff");
    expect(result.method).toBe("reencoded");
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  });

  /**
   * The defect the first version of this file shipped with. Start-of-Scan
   * was treated as "everything from here to EOF is image data", so an
   * appended image -- Apple's MPF gain map, Samsung's motion photo -- was
   * copied verbatim along with its OWN EXIF block. For a phone receipt
   * photo, which is exactly what this function exists for, the strip
   * reported success and stored the GPS coordinates anyway.
   */
  it("removes EXIF from a JPEG that has a second JPEG appended after its EOI", async () => {
    const primary = await jpegWithGps();
    const trailer = await jpegWithGps();
    const combined = new Uint8Array(primary.byteLength + trailer.byteLength);
    combined.set(primary, 0);
    combined.set(trailer, primary.byteLength);

    // The fixture must genuinely carry the marker twice, or this proves
    // nothing.
    expect(Buffer.from(combined).toString("latin1").split("ledgerly-test")).toHaveLength(3);

    const result = await stripMetadataForOriginal(combined, "jpeg");

    expect(Buffer.from(result.bytes).toString("latin1")).not.toContain("ledgerly-test");
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    // And it says what it did, rather than claiming byte-identity it no
    // longer has.
    expect(result.method).toBe("lossless-trailer-dropped");
  });

  it("still decodes after the trailer is dropped", async () => {
    const primary = await jpegWithGps();
    const combined = new Uint8Array(primary.byteLength * 2);
    combined.set(primary, 0);
    combined.set(primary, primary.byteLength);
    const result = await stripMetadataForOriginal(combined, "jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
  });

  /**
   * Each of these produced a structurally empty file that was reported as
   * `lossless` and written to disk: a 2-byte "JPEG" (SOI only), an 8-byte
   * "PNG" (signature only), a 12-byte "WebP" (RIFF header only). The image
   * route then served them with a real Content-Type.
   */
  it.each([
    [
      "a JPEG with no scan",
      "jpeg" as const,
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x41, 0x42, 0xff, 0xd9]),
    ],
    [
      "a PNG with no IHDR or IDAT",
      "png" as const,
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x74, 0x45, 0x58,
        0x74, 0x00, 0x00, 0x00, 0x00,
      ]),
    ],
    [
      "a WebP with no image chunk",
      "webp" as const,
      (() => {
        const b = new Uint8Array(24);
        b.set(new TextEncoder().encode("RIFF"), 0);
        new DataView(b.buffer).setUint32(4, 16, true);
        b.set(new TextEncoder().encode("WEBP"), 8);
        b.set(new TextEncoder().encode("EXIF"), 12);
        new DataView(b.buffer).setUint32(16, 1, true);
        return b;
      })(),
    ],
  ])("refuses to call %s losslessly stripped", async (_label, type, bytes) => {
    const result = await stripMetadataForOriginal(bytes, type);
    // It must fall through to sharp (which will also fail) and end at
    // passthrough -- never claim a lossless strip of a file it destroyed.
    expect(result.method).not.toBe("lossless");
    expect(result.method).not.toBe("lossless-trailer-dropped");
  });

  /**
   * The JPEG trailer defect, present in the WebP walker too and missed the
   * first time round. The chunk loop was bounded by the buffer rather than
   * by the RIFF size at offset 4, so an appended WebP was parsed as more
   * top-level chunks, kept (its tag is not EXIF/XMP), and then covered by
   * the rewritten size field.
   */
  it("drops an appended WebP rather than keeping its EXIF", async () => {
    const primary = await webpWithExif();
    const trailer = await webpWithExif();
    const combined = new Uint8Array(primary.byteLength + trailer.byteLength);
    combined.set(primary, 0);
    combined.set(trailer, primary.byteLength);

    const result = await stripMetadataForOriginal(combined, "webp");

    expect(Buffer.from(result.bytes).toString("latin1")).not.toContain("ledgerly-test");
    expect(result.bytes.byteLength).toBeLessThan(combined.byteLength);
    expect(result.method).toBe("lossless-trailer-dropped");
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  });

  it("reports a dropped PNG trailer instead of claiming bit-identity", async () => {
    const primary = await pngWithText();
    const combined = new Uint8Array(primary.byteLength + 40);
    combined.set(primary, 0);
    combined.fill(0x41, primary.byteLength);

    const result = await stripMetadataForOriginal(combined, "png");

    expect(result.method).toBe("lossless-trailer-dropped");
    expect((await sharp(result.bytes).metadata()).width).toBe(32);
  });

  it("clears the VP8X EXIF flag when it drops the EXIF chunk", async () => {
    const input = await webpWithExif();
    const result = await stripMetadataForOriginal(input, "webp");

    // Find VP8X in the output and check its flags byte. Leaving the bit set
    // describes a chunk that is no longer in the file.
    const out = Buffer.from(result.bytes);
    const vp8x = out.indexOf("VP8X", 12, "latin1");
    if (vp8x !== -1) {
      const flags = out[vp8x + 8]!;
      expect(flags & 0x08).toBe(0); // EXIF bit clear
    }
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  });

  it("never throws on bytes it cannot read at all", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await stripMetadataForOriginal(garbage, "heic");
    expect(result.method).toBe("passthrough");
    expect(result.bytes).toBe(garbage);
  });
});
