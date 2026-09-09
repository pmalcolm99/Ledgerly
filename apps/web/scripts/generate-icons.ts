/**
 * scripts/generate-icons.ts — generates every PWA raster asset (task 7.9).
 *
 * Run with:  pnpm --filter @ledgerly/web icons
 *
 * The source of truth is `assets/icon-source.png`, committed alongside this
 * script. Every output below is derived from it, so the brand mark exists in
 * exactly one place and a replacement is a one-file swap plus a re-run.
 *
 * Lives under apps/web rather than the repo-root scripts/ because Node
 * resolves a dependency from the importing FILE's location: `sharp` is a
 * dependency of apps/web, and a script at the repo root cannot see it.
 *
 * Outputs, all into apps/web:
 *   src/app/icon.png            favicon (Next metadata convention)
 *   src/app/apple-icon.png      apple-touch-icon (180)
 *   public/icon-192.png         manifest icon, purpose "any"
 *   public/icon-512.png         manifest icon, purpose "any"
 *   public/icon-maskable.png    manifest icon, purpose "maskable"
 *   public/splash/*.png         iOS apple-touch-startup-image set
 *
 * `apple-icon.png` uses Next's file convention deliberately: it emits the
 * right <link rel="apple-touch-icon">, AND the middleware matcher already
 * excludes `apple-icon.png` from the Access gate, while `apple-touch-icon.png`
 * (the hand-rolled name) is NOT excluded and would 403 at install time.
 *
 * ## The three things the source art needs fixing for
 *
 * 1. **iOS paints black behind transparency.** The artwork is a rounded tile
 *    on a transparent field. `apple-icon` must therefore be FLATTENED onto the
 *    tile colour and fill its whole square — iOS applies its own corner mask,
 *    and a transparent-cornered icon shows up with black corners behind it.
 * 2. **Android crops maskable icons to a circle.** The maskable output is
 *    flattened and the artwork scaled into the inner safe area, or the
 *    launcher clips the corners off the design.
 * 3. **The tile is not square and not centred** in the source canvas. It is
 *    measured here from the alpha channel rather than hardcoded, so replacing
 *    `icon-source.png` with differently-padded art still produces a centred
 *    result without editing this file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const WEB = path.join(import.meta.dirname, "..");

/**
 * PNG encoder settings shared by every output.
 *
 * `palette: true` quantises to 256 colours, which cuts the 512px icon from
 * 318KB to 142KB and the splash set by rather more. The art is flat shapes
 * with soft shading rather than a photograph, so the quantisation is
 * invisible: measured mean per-channel error against the full-colour encode
 * is ~5/255, and what error there is lands on the antialiased tile edge.
 * These are assets a browser fetches on install and a phone caches forever,
 * so the halving is worth having.
 */
const PNG_OPTS = { compressionLevel: 9, palette: true } as const;
const SOURCE = path.join(WEB, "assets/icon-source.png");

/** The tile's own background, sampled from the source art. Used wherever the
 *  transparency has to be flattened away (apple-icon, maskable). */
const TILE_BG = { r: 250, g: 244, b: 235, alpha: 1 };

/** iOS launch screen. Deliberately NOT the tile colour: the app's default
 *  theme is dark, and a cream full-screen flash before a dark UI reads as a
 *  broken render. The mark keeps its own tile against it. */
const SPLASH_BG = "#0a0a0a";

/**
 * The smallest square that contains every non-transparent pixel, centred on
 * the artwork's own bounding box.
 *
 * `sharp`'s `.trim()` is not used: it trims to the bounding box, which here is
 * 1133x1115 and off-centre, so the mark would sit visibly high and left at
 * favicon sizes. Measuring the alpha channel directly and re-centring is what
 * makes the output look deliberate at 48px.
 */
async function squareTile(): Promise<Buffer> {
  const { data, info } = await sharp(SOURCE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  // 128 sits in the empty middle of a cleanly bimodal alpha histogram (24% at
  // 0, 75% at 253), so the threshold is not a tuning knob — anything between
  // the two modes gives the same box.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * channels + 3]! >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("generate-icons: source image is fully transparent");

  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Clamped so a mark that sits hard against an edge still yields a valid
  // extract rather than a negative offset.
  const left = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
  const top = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));

  console.log(
    `  source ${w}x${h} -> tile ${side}x${side} at ${left},${top} (bbox ${maxX - minX + 1}x${maxY - minY + 1})`,
  );
  return sharp(SOURCE)
    .ensureAlpha()
    .extract({ left, top, width: side, height: side })
    .png()
    .toBuffer();
}

/** Transparent-cornered output: the tile as drawn, just resized. Correct for
 *  the favicon and for manifest `purpose: "any"`, where the rounded corners
 *  are the intended shape and the platform does not mask. */
async function transparentIcon(tile: Buffer, size: number, out: string): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await sharp(tile).resize(size, size).png(PNG_OPTS).toFile(out);
  console.log(`  ${path.relative(WEB, out)} (${size}px, transparent corners)`);
}

/**
 * Opaque output filling the whole square, with the artwork optionally inset.
 *
 * `inset` is the fraction of the square left as margin on each side. 0 fills
 * it edge to edge (apple-icon — iOS supplies the corner radius); 0.1 pulls the
 * art into Android's maskable safe area, which is the inner 80% circle.
 */
async function opaqueIcon(tile: Buffer, size: number, inset: number, out: string): Promise<void> {
  const inner = Math.round(size * (1 - inset * 2));
  const art = await sharp(tile).resize(inner, inner).png().toBuffer();
  await mkdir(path.dirname(out), { recursive: true });
  await sharp({ create: { width: size, height: size, channels: 4, background: TILE_BG } })
    .composite([{ input: art, gravity: "centre" }])
    .flatten({ background: TILE_BG })
    .png(PNG_OPTS)
    .toFile(out);
  console.log(
    `  ${path.relative(WEB, out)} (${size}px, opaque, ${Math.round(inset * 100)}% inset)`,
  );
}

/**
 * iOS splash screens. Safari matches these by exact device-width/height and
 * pixel ratio, so the list is a set of literal device geometries rather than
 * anything derivable — an unmatched device simply gets a white flash, which
 * is the cost of leaving one out.
 */
const SPLASH: Array<{ w: number; h: number; name: string }> = [
  { w: 1320, h: 2868, name: "iphone-16-pro-max" },
  { w: 1206, h: 2622, name: "iphone-16-pro" },
  { w: 1290, h: 2796, name: "iphone-15-pro-max" },
  { w: 1179, h: 2556, name: "iphone-15-pro" },
  { w: 1170, h: 2532, name: "iphone-13" },
  { w: 1125, h: 2436, name: "iphone-x" },
  { w: 1242, h: 2688, name: "iphone-11-pro-max" },
  { w: 828, h: 1792, name: "iphone-11" },
  { w: 1242, h: 2208, name: "iphone-8-plus" },
  { w: 750, h: 1334, name: "iphone-8" },
  { w: 1536, h: 2048, name: "ipad-9-7" },
  { w: 1668, h: 2388, name: "ipad-pro-11" },
  { w: 2048, h: 2732, name: "ipad-pro-12-9" },
];

async function splash(tile: Buffer, w: number, h: number, out: string): Promise<void> {
  const logo = Math.round(Math.min(w, h) * 0.28);
  const mark = await sharp(tile).resize(logo, logo).png().toBuffer();
  await mkdir(path.dirname(out), { recursive: true });
  await sharp({ create: { width: w, height: h, channels: 4, background: SPLASH_BG } })
    .composite([{ input: mark, gravity: "centre" }])
    .png(PNG_OPTS)
    .toFile(out);
}

async function main(): Promise<void> {
  console.log("source:");
  const tile = await squareTile();

  console.log("icons:");
  await transparentIcon(tile, 512, path.join(WEB, "public/icon-512.png"));
  await transparentIcon(tile, 192, path.join(WEB, "public/icon-192.png"));
  await transparentIcon(tile, 48, path.join(WEB, "src/app/icon.png"));
  // Fills its square: iOS masks the corners itself and paints black behind
  // any transparency it is given.
  await opaqueIcon(tile, 180, 0, path.join(WEB, "src/app/apple-icon.png"));
  // Android crops maskable icons to a circle inscribed in the middle 80%.
  await opaqueIcon(tile, 512, 0.1, path.join(WEB, "public/icon-maskable.png"));

  console.log("splash screens:");
  for (const entry of SPLASH) {
    const out = path.join(WEB, `public/splash/${entry.name}.png`);
    await splash(tile, entry.w, entry.h, out);
    console.log(`  splash/${entry.name}.png (${entry.w}x${entry.h})`);
  }

  // The <link> tags the layout needs, emitted here so the media queries and
  // the generated filenames can never disagree.
  // Shape is Next's `AppleImageDescriptor` — { url, media } — not the raw
  // <link rel/href> attributes; Next emits the rel itself.
  const links = SPLASH.map(
    (entry) =>
      `  { url: "/splash/${entry.name}.png", media: "screen and (device-width: ${Math.round(entry.w / dpr(entry))}px) and (device-height: ${Math.round(entry.h / dpr(entry))}px) and (-webkit-device-pixel-ratio: ${dpr(entry)})" },`,
  ).join("\n");
  await writeFile(path.join(WEB, "src/app/splashLinks.generated.ts"), splashLinksFile(links));
  console.log("wrote src/app/splashLinks.generated.ts");
}

/** Device pixel ratio per geometry. 3 for the Plus/Pro/Max phone line, 2 for
 *  everything else including every iPad. */
function dpr(entry: { w: number; h: number; name: string }): number {
  const threeX = [
    "iphone-16-pro-max",
    "iphone-16-pro",
    "iphone-15-pro-max",
    "iphone-15-pro",
    "iphone-13",
    "iphone-x",
    "iphone-11-pro-max",
    "iphone-8-plus",
  ];
  return threeX.includes(entry.name) ? 3 : 2;
}

function splashLinksFile(links: string): string {
  return `// GENERATED by scripts/generate-icons.ts — do not edit by hand.
// Regenerate with: pnpm exec tsx scripts/generate-icons.ts
//
// iOS only honours apple-touch-startup-image when the media query matches the
// device exactly, so these are emitted alongside the images themselves and can
// never drift from the filenames on disk.
export const SPLASH_LINKS = [
${links}
] as const;
`;
}

void main();
