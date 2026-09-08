import { describe, expect, it } from "vitest";

import { extensionForType, sniffFileType } from "./fileSniff";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

describe("sniffFileType", () => {
  it("recognizes JPEG", () => {
    expect(sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("jpeg");
  });

  it("recognizes PNG", () => {
    expect(sniffFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe("png");
  });

  it("recognizes WebP", () => {
    const buf = new Uint8Array(16);
    buf.set(ascii("RIFF"), 0);
    buf.set([0x00, 0x00, 0x00, 0x00], 4); // chunk size, irrelevant
    buf.set(ascii("WEBP"), 8);
    expect(sniffFileType(buf)).toBe("webp");
  });

  it("recognizes little-endian TIFF", () => {
    expect(sniffFileType(bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00))).toBe("tiff");
  });

  it("recognizes big-endian TIFF", () => {
    expect(sniffFileType(bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08))).toBe("tiff");
  });

  it("recognizes HEIC by ftyp brand", () => {
    const buf = new Uint8Array(16);
    buf.set([0x00, 0x00, 0x00, 0x18], 0); // box size, irrelevant
    buf.set(ascii("ftyp"), 4);
    buf.set(ascii("heic"), 8);
    expect(sniffFileType(buf)).toBe("heic");
  });

  it("recognizes HEIF's mif1/msf1 brands too", () => {
    const buf = new Uint8Array(16);
    buf.set(ascii("ftyp"), 4);
    buf.set(ascii("mif1"), 8);
    expect(sniffFileType(buf)).toBe("heic");
  });

  it("does not recognize an unaccepted ISO-BMFF brand (e.g. AVIF) as major brand", () => {
    const buf = new Uint8Array(16);
    buf.set(ascii("ftyp"), 4);
    buf.set(ascii("avif"), 8);
    expect(sniffFileType(buf)).toBeNull();
  });

  it("rejects an AVIF file whose major brand is the generic mif1 it shares with HEIC", () => {
    // Real AVIF encoders often declare a generic major brand ("mif1") and
    // list "avif" only among the compatible brands that follow -- checking
    // major brand alone would misidentify this as HEIC.
    const buf = new Uint8Array(24);
    buf.set([0x00, 0x00, 0x00, 0x18], 0); // box size = 24, covers the whole buffer
    buf.set(ascii("ftyp"), 4);
    buf.set(ascii("mif1"), 8); // major brand: generic, shared with real HEIC
    buf.set(ascii("mif1"), 16); // compatible brand 1
    buf.set(ascii("avif"), 20); // compatible brand 2 -- the tell
    expect(sniffFileType(buf)).toBeNull();
  });

  it("still recognizes a real HEIC whose compatible brands contain no AVIF entry", () => {
    const buf = new Uint8Array(24);
    buf.set([0x00, 0x00, 0x00, 0x18], 0);
    buf.set(ascii("ftyp"), 4);
    buf.set(ascii("heic"), 8);
    buf.set(ascii("mif1"), 16);
    buf.set(ascii("heic"), 20);
    expect(sniffFileType(buf)).toBe("heic");
  });

  it("recognizes PDF", () => {
    expect(sniffFileType(new Uint8Array(ascii("%PDF-1.7\n")))).toBe("pdf");
  });

  it("returns null for garbage bytes", () => {
    expect(sniffFileType(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(sniffFileType(new Uint8Array(0))).toBeNull();
  });

  it("returns null for a text file impersonating a JPEG via extension alone", () => {
    // The point of this test: a `.jpg`-named file with none of the actual
    // signatures must sniff as null. The route layer never even looks at
    // the claimed filename/Content-Type, so this module doesn't need to
    // "reject a mismatch" — it just never matches in the first place.
    expect(sniffFileType(new Uint8Array(ascii("<html>not a photo</html>")))).toBeNull();
  });
});

describe("extensionForType", () => {
  it("maps every sniffed type to a stable extension", () => {
    expect(extensionForType("jpeg")).toBe("jpg");
    expect(extensionForType("png")).toBe("png");
    expect(extensionForType("webp")).toBe("webp");
    expect(extensionForType("tiff")).toBe("tiff");
    expect(extensionForType("heic")).toBe("heic");
    expect(extensionForType("pdf")).toBe("pdf");
  });
});
