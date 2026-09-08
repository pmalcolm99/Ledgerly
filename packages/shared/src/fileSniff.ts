// packages/shared/src/fileSniff.ts — Phase 5 task 5.1's magic-byte sniff.
// Pure and isomorphic (operates on Uint8Array, never Buffer or fs) — see
// index.ts's header comment: this package must never import a Node built-in
// or a server-only dependency.
//
// The upload route treats this module's result as THE type of a file. The
// client `Content-Type` header and the filename extension are never read
// anywhere in the guard chain — not even to cross-check against this
// result. A crafted file whose bytes don't match any signature below is
// rejected outright, regardless of what it claims to be.

export type SniffedFileType = "jpeg" | "png" | "webp" | "tiff" | "heic" | "pdf";

// ISO-BMFF (HEIF/HEIC) brand allowlist. `mif1`/`msf1` are generic
// still-image/sequence brands HEIC photos commonly declare; `heic`/`heix`/
// `heim`/`heis` are HEVC-still brands, `hevc`/`hevx`/`hevm`/`hevs` are the
// HEVC-sequence variants. Deliberately excludes `avif`/`avis`/`mp42` and
// friends — those decode via the same box structure but are not among the
// formats this app accepts.
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

// AVIF encoders commonly declare a GENERIC major brand ("mif1"/"msf1" — the
// same ones real HEIC photos use) and list "avif"/"avis" only among the
// COMPATIBLE brands that follow. Checking the major brand alone (review
// finding LOW) lets an AVIF file through as "heic" whenever it happens to
// share that generic major brand — it would then be stored as `.heic` and
// served as `image/heic`, neither of which is true. Any "avif"/"avis"
// anywhere in the ftyp box — major or compatible — is a hard exclusion.
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** Reads the big-endian uint32 box-size field at the start of an ISO-BMFF
 * box (here, always offset 0 — `ftyp` is the first box in a HEIC/AVIF
 * file). Returns 0 if the buffer is too short to contain one. */
function readBoxSize(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  return (
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0
  );
}

/** True if the ftyp box's major brand (bytes 8-11) OR any compatible brand
 * (4-byte entries starting at byte 16, up to the box's declared size) is
 * an AVIF brand. */
function ftypDeclaresAvif(bytes: Uint8Array): boolean {
  if (AVIF_BRANDS.has(asciiAt(bytes, 8, 4))) return true;
  const boxSize = readBoxSize(bytes);
  const scanEnd = boxSize > 0 ? Math.min(boxSize, bytes.length) : bytes.length;
  for (let offset = 16; offset + 4 <= scanEnd; offset += 4) {
    if (AVIF_BRANDS.has(asciiAt(bytes, offset, 4))) return true;
  }
  return false;
}

function bytesEqual(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

/**
 * Inspects the leading bytes of `bytes` and returns the file type they
 * signature-match, or `null` if nothing matches. Never throws — a short or
 * garbage buffer just fails every check and returns `null`.
 */
export function sniffFileType(bytes: Uint8Array): SniffedFileType | null {
  // JPEG: FF D8 FF
  if (bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";

  // WebP: "RIFF" .... "WEBP"
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "webp";

  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (bytesEqual(bytes, 0, [0x49, 0x49, 0x2a, 0x00])) return "tiff";
  if (bytesEqual(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";

  // HEIC/HEIF: an ISO-BMFF file whose first box is "ftyp" (bytes 4-7) with
  // a recognized still-image brand at bytes 8-11, and no AVIF brand
  // anywhere in the box (see ftypDeclaresAvif's comment).
  if (
    asciiAt(bytes, 4, 4) === "ftyp" &&
    HEIC_BRANDS.has(asciiAt(bytes, 8, 4)) &&
    !ftypDeclaresAvif(bytes)
  ) {
    return "heic";
  }

  // PDF: "%PDF-"
  if (asciiAt(bytes, 0, 5) === "%PDF-") return "pdf";

  return null;
}

/** The storage-path extension for a sniffed type — never derived from the
 * client's filename. */
export function extensionForType(type: SniffedFileType): string {
  switch (type) {
    case "jpeg":
      return "jpg";
    case "png":
      return "png";
    case "webp":
      return "webp";
    case "tiff":
      return "tiff";
    case "heic":
      return "heic";
    case "pdf":
      return "pdf";
  }
}
