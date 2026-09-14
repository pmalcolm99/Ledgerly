import sharp from "sharp";
import type { SniffedFileType } from "@ledgerly/shared/fileSniff";

/**
 * packages/queue/src/pipeline/stripMetadata.ts — removes EXIF (and the
 * other metadata blocks that travel with it) from a retained ORIGINAL.
 *
 * Phase 10a finding F-10. `RETAIN_ORIGINALS=true` used to promote the
 * staged upload with a plain `rename` -- untouched bytes, per D-09's intent
 * that an "original" really is the original. The consequence nobody wrote
 * down is that a phone's receipt photo carries a GPS tag, so the stored
 * `original.<ext>` pinned the user's home or workplace, and
 * `GET /api/images/<id>/original` served it to any project member with
 * `manage`. `.env.example` advertised the flag's cost as "~10x storage" and
 * said nothing about that.
 *
 * The derivatives were never affected: `render.ts` goes through sharp,
 * which drops metadata unless `.withMetadata()` is called, and it is not.
 * This file closes the one path that bypassed sharp entirely.
 *
 * ## Why container surgery rather than just re-encoding everything
 *
 * Re-encoding a JPEG or a HEIC through sharp is lossy. Doing that to the
 * file whose whole purpose is fidelity would trade one silent defect for
 * another. So for the three container formats where the metadata is an
 * isolated, skippable block -- JPEG, PNG, WebP -- the blocks are excised
 * and every other byte is copied through verbatim. The pixel data is bit
 * identical; only the metadata is gone.
 *
 * TIFF and HEIC have metadata woven into their structure (IFD offsets;
 * an ISO-BMFF `meta` box referenced from item tables) and cannot be
 * rewritten safely with a few hundred lines of parsing. Those fall back to
 * a sharp re-encode, which is honest about being a re-encode.
 *
 * PDFs have no EXIF. They pass through untouched.
 */

/** JPEG markers whose payload is metadata, not image data. */
const JPEG_METADATA_MARKERS = new Set<number>([
  0xe1, // APP1  -- EXIF and XMP
  0xe2, // APP2  -- ICC in some writers, also FlashPix/MPF
  0xe3, // APP3  -- Kodak/meta
  0xe5, // APP5
  0xe6, // APP6
  0xe7, // APP7
  0xe8, // APP8
  0xe9, // APP9
  0xea, // APP10
  0xeb, // APP11
  0xec, // APP12 -- Picture Info / Ducky
  0xed, // APP13 -- Photoshop IRB / IPTC
  0xee, // APP14 -- Adobe (colour transform); dropped deliberately, see note
  0xef, // APP15
  0xfe, // COM   -- free-text comment
]);

type StripResult = { bytes: Uint8Array; droppedTrailer: boolean };

/**
 * APP0 (JFIF) is deliberately KEPT: it carries density/aspect information
 * some decoders rely on, and holds no personal data.
 *
 * APP14 (Adobe) is dropped even though it can carry a colour-transform
 * hint, because it is also where Adobe tools stash identifying strings. The
 * transform hint only matters for CMYK/YCCK JPEGs, which a phone camera
 * does not produce; the derivative renders are unaffected either way.
 *
 * ## The trailer, which is the whole reason this walks the scan data
 *
 * The first version of this function treated Start-of-Scan as "everything
 * from here to EOF is image data" and copied it verbatim. That is wrong for
 * exactly the files this exists to protect. A modern phone JPEG does not
 * end at its first EOI: Apple appends an MPF gain-map JPEG and Samsung a
 * motion-photo MP4, and an appended JPEG carries its OWN APP1 -- a complete
 * second EXIF block, GPS included. So the strip reported `lossless` while
 * storing the coordinates it was supposed to remove.
 *
 * The scan data is therefore walked to the marker that ends it. Inside
 * entropy-coded data a literal 0xFF is byte-stuffed as `FF 00`, and restart
 * markers `FFD0`-`FFD7` are in-band, so the first `FF xx` that is neither
 * of those is the real end. A progressive JPEG has several scans and this
 * loop handles them: a non-EOI marker simply resumes the segment walk.
 *
 * Anything after the terminating EOI is DROPPED. That is a deliberate
 * choice, not an oversight -- the trailer is appended data rather than part
 * of the primary image, dropping it leaves a valid JPEG, and keeping it
 * would defeat the point. The caller is told, so it can stop claiming the
 * result is byte-identical.
 */
function stripJpeg(bytes: Uint8Array): StripResult | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const keep: Array<[number, number]> = [[0, 2]]; // SOI
  let cursor = 2;
  let sawScan = false;
  let sawEoi = false;
  let droppedTrailer = false;

  while (cursor + 1 < bytes.length) {
    if (bytes[cursor] !== 0xff) return null; // not on a marker boundary

    // Fill bytes: a marker may be padded with any number of 0xFF.
    let markerAt = cursor + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    if (markerAt >= bytes.length) return null;
    const marker = bytes[markerAt]!;

    if (marker === 0xd9) {
      keep.push([cursor, markerAt + 1]);
      sawEoi = true;
      droppedTrailer = markerAt + 1 < bytes.length;
      break;
    }

    // Standalone markers: no length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push([cursor, markerAt + 1]);
      cursor = markerAt + 1;
      continue;
    }

    const hi = bytes[markerAt + 1];
    const lo = bytes[markerAt + 2];
    if (hi === undefined || lo === undefined) return null;
    const length = (hi << 8) | lo;
    if (length < 2) return null;
    const segmentEnd = markerAt + 1 + length;
    if (segmentEnd > bytes.length) return null;

    if (marker === 0xda) {
      // Walk the entropy-coded data to the marker that ends this scan.
      let at = segmentEnd;
      while (at + 1 < bytes.length) {
        if (bytes[at] === 0xff) {
          const next = bytes[at + 1]!;
          const stuffed = next === 0x00;
          const fill = next === 0xff;
          const restart = next >= 0xd0 && next <= 0xd7;
          if (!stuffed && !fill && !restart) break;
        }
        at += 1;
      }
      // The SOS header and its scan data are contiguous; keep both.
      keep.push([cursor, at]);
      cursor = at;
      sawScan = true;
      continue;
    }

    if (!JPEG_METADATA_MARKERS.has(marker)) keep.push([cursor, segmentEnd]);
    cursor = segmentEnd;
  }

  // Structural minimum. Without this a truncated or malformed file yields a
  // 2-byte "JPEG" (SOI alone) that is dutifully stored and served.
  if (!sawScan || !sawEoi) return null;

  return { bytes: concatRanges(bytes, keep), droppedTrailer };
}

/** PNG ancillary chunks that can carry metadata or identifying text. */
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/**
 * Whole chunks are dropped, so the per-chunk CRCs of the chunks that remain
 * are still correct and are deliberately left untouched.
 */
function stripPng(bytes: Uint8Array): StripResult | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== signature[i]) return null;

  const keep: Array<[number, number]> = [[0, 8]];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 8;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;

  while (cursor + 8 <= bytes.length) {
    const length = view.getUint32(cursor);
    const type = String.fromCharCode(
      bytes[cursor + 4]!,
      bytes[cursor + 5]!,
      bytes[cursor + 6]!,
      bytes[cursor + 7]!,
    );
    const chunkEnd = cursor + 12 + length; // 4 length + 4 type + data + 4 CRC
    if (chunkEnd > bytes.length) return null;

    if (type === "IHDR") sawHeader = true;
    if (type === "IDAT") sawData = true;
    if (type === "IEND") sawEnd = true;

    if (!PNG_METADATA_CHUNKS.has(type)) keep.push([cursor, chunkEnd]);
    cursor = chunkEnd;
    if (type === "IEND") break;
  }

  if (!sawHeader || !sawData || !sawEnd) return null;
  // Anything after IEND is not part of the PNG and is not copied through, so
  // say so rather than letting the caller report bit-identity it lost.
  return { bytes: concatRanges(bytes, keep), droppedTrailer: cursor < bytes.length };
}

/** RIFF/WebP chunks that carry metadata. */
const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP "]);

// VP8X flag bits, in the first byte of that chunk's payload.
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

/**
 * Removing the EXIF/XMP chunks is only half the job: a VP8X header declares
 * which optional chunks are present, and leaving its EXIF bit set describes
 * a file that no longer exists. libwebp tolerates the mismatch; stricter
 * demuxers do not, and the stale bit is itself a signal. So the flags are
 * rewritten to match what was actually kept.
 */
function stripWebp(bytes: Uint8Array): StripResult | null {
  if (bytes.length < 12) return null;
  const tag = (at: number) =>
    String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Bound the walk at the DECLARED payload, not at the buffer.
  //
  // The chunk loop used to run to `bytes.length`, so anything concatenated
  // after the RIFF payload was parsed as further top-level chunks, kept
  // (its tag is not EXIF/XMP), and then covered by the rewritten size field
  // below -- a second WebP appended to the first would have had its whole
  // EXIF block preserved and blessed as a lossless strip. That is the same
  // trailer defect the JPEG walker above was just fixed for; it was present
  // here too.
  const declaredEnd = Math.min(12 + view.getUint32(4, true), bytes.length);
  const droppedTrailer = bytes.length > declaredEnd;

  const kept: Uint8Array[] = [];
  let cursor = 12;
  let sawImage = false;
  let droppedExif = false;
  let droppedXmp = false;

  while (cursor + 8 <= declaredEnd) {
    const type = tag(cursor);
    const size = view.getUint32(cursor + 4, true);
    const chunkEnd = cursor + 8 + size + (size % 2); // padded to even
    if (chunkEnd > declaredEnd) return null;

    // ANMF counts: an animated WebP keeps its frame data in ANMF sub-chunks
    // rather than a top-level VP8/VP8L, and rejecting it here sent it to the
    // sharp fallback -- which, without `{ animated: true }`, reads page 0
    // and silently flattens the animation to a single still frame.
    if (type === "VP8 " || type === "VP8L" || type === "ANMF") sawImage = true;
    if (type === "EXIF") droppedExif = true;
    if (type === "XMP ") droppedXmp = true;

    if (!WEBP_METADATA_CHUNKS.has(type)) {
      // Copy, so rewriting the VP8X flags below cannot mutate the input.
      kept.push(Uint8Array.prototype.slice.call(bytes, cursor, chunkEnd) as Uint8Array);
    }
    cursor = chunkEnd;
  }

  if (!sawImage) return null;

  const payloadLength = kept.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(12 + payloadLength);
  out.set(bytes.subarray(0, 12), 0);
  let at = 12;
  for (const chunk of kept) {
    if (
      String.fromCharCode(chunk[0]!, chunk[1]!, chunk[2]!, chunk[3]!) === "VP8X" &&
      chunk.byteLength >= 9
    ) {
      if (droppedExif) chunk[8] = chunk[8]! & ~VP8X_FLAG_EXIF;
      if (droppedXmp) chunk[8] = chunk[8]! & ~VP8X_FLAG_XMP;
    }
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  // The RIFF size field counts everything after it, so it must be rewritten
  // to match what we actually kept -- a stale size makes the file invalid.
  new DataView(out.buffer).setUint32(4, out.byteLength - 8, true);
  return { bytes: out, droppedTrailer };
}

function concatRanges(bytes: Uint8Array, ranges: ReadonlyArray<[number, number]>): Uint8Array {
  const total = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [start, end] of ranges) {
    out.set(bytes.subarray(start, end), at);
    at += end - start;
  }
  return out;
}

/**
 * Returns `bytes` with metadata removed, plus the type the result actually
 * IS -- which is not always the type that went in.
 *
 * The caller must use the returned `type` to name the file. A HEIC that
 * falls back to a JPEG re-encode has to be stored as `original.jpg`, or the
 * extension lies about the contents and the image route serves it with the
 * wrong `Content-Type`.
 *
 * Never throws and never returns something unreadable: if the lossless path
 * cannot parse the container (a truncated or unusual file), it falls back
 * to sharp; if sharp cannot read it either, the ORIGINAL bytes are returned
 * unchanged with `method: "passthrough"`, so the caller can decide what to
 * do. Refusing to store anything would be worse -- it would lose the
 * upload, which CLAUDE.md forbids.
 */
export async function stripMetadataForOriginal(
  bytes: Uint8Array,
  type: SniffedFileType,
): Promise<{
  bytes: Uint8Array;
  type: SniffedFileType;
  method: "lossless" | "lossless-trailer-dropped" | "reencoded" | "passthrough";
}> {
  // PDFs carry no EXIF. Nothing to do.
  if (type === "pdf") return { bytes, type, method: "passthrough" };

  const lossless =
    type === "jpeg"
      ? stripJpeg(bytes)
      : type === "png"
        ? stripPng(bytes)
        : type === "webp"
          ? stripWebp(bytes)
          : null;
  if (lossless !== null) {
    return {
      bytes: lossless.bytes,
      type,
      // An appended gain-map or motion-photo trailer was removed, so the
      // file is no longer byte-for-byte the upload minus a metadata block.
      // The PRIMARY image is still bit-identical; say which happened rather
      // than claim the stronger thing for both.
      method: lossless.droppedTrailer ? "lossless-trailer-dropped" : "lossless",
    };
  }

  // TIFF and HEIC, or a JPEG/PNG/WebP whose container would not parse.
  //
  // No `.withMetadata()` anywhere below -- sharp drops metadata by default,
  // which is exactly what is wanted.
  try {
    // Same format first: for TIFF this is lossless, and it keeps the
    // extension honest.
    const sameFormat = await sharp(bytes, { failOn: "none" }).toBuffer();
    return { bytes: new Uint8Array(sameFormat), type, method: "reencoded" };
  } catch {
    // Falls here mainly for HEIC: decoding needs libheif, which the runner
    // image installs, but ENCODING HEIF is frequently not compiled into
    // libvips, so a same-format round trip throws. JPEG at quality 100 is
    // the closest thing that is guaranteed available -- and the returned
    // type changes to match, so the file is named `original.jpg`.
    try {
      const asJpeg = await sharp(bytes, { failOn: "none" }).jpeg({ quality: 100 }).toBuffer();
      return { bytes: new Uint8Array(asJpeg), type: "jpeg", method: "reencoded" };
    } catch {
      // Unreadable by sharp entirely. Keep the upload rather than lose it;
      // the caller logs this and can choose not to retain it.
      return { bytes, type, method: "passthrough" };
    }
  }
}
