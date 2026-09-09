/**
 * scripts/generate-icons.ts — generates every PWA raster asset (task 7.9).
 *
 * Committed as a script rather than hand-drawn binaries so the icons are
 * reviewable, reproducible, and re-generatable when the brand colour changes.
 * Run with:  pnpm --filter @ledgerly/web icons
 *
 * Lives under apps/web rather than the repo-root scripts/ because Node
 * resolves a dependency from the importing FILE's location: `sharp` is a
 * dependency of apps/web, and a script at the repo root cannot see it.
 *
 * Outputs, all into apps/web:
 *   src/app/icon.png            favicon (Next metadata convention)
 *   src/app/apple-icon.png      apple-touch-icon (180)
 *   public/icon-192.png         manifest icon
 *   public/icon-512.png         manifest icon
 *   public/icon-maskable.png    manifest icon, purpose "maskable"
 *   public/splash/*.png         iOS apple-touch-startup-image set
 *
 * `apple-icon.png` uses Next's file convention deliberately: it emits the
 * right <link rel="apple-touch-icon">, AND the middleware matcher already
 * excludes `apple-icon.png` from the Access gate, while `apple-touch-icon.png`
 * (the hand-rolled name) is NOT excluded and would 403 at install time.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const BRAND = "#2f7d80";
const BRAND_DARK = "#1f5f61";
const INK = "#ffffff";
const SPLASH_BG = "#0a0a0a";

const WEB = path.join(import.meta.dirname, "..");

/** The Ledgerly mark: a receipt with a torn bottom edge and a ledger rule.
 *  Drawn on a 512 grid; `inset` shrinks it for maskable safe-area. */
function markSvg(size: number, inset: number, background: string | null): string {
  const s = 512;
  const pad = inset * s;
  const w = s - pad * 2;
  // Receipt body occupies the middle 62% of the safe area.
  const rw = w * 0.52;
  const rh = w * 0.66;
  const rx = pad + (w - rw) / 2;
  const ry = pad + (w - rh) / 2;
  const teeth = 6;
  const toothW = rw / teeth;
  let tear = `M ${rx} ${ry + rh}`;
  for (let i = 0; i < teeth; i += 1) {
    const x0 = rx + i * toothW;
    tear += ` L ${x0 + toothW / 2} ${ry + rh - toothW * 0.42} L ${x0 + toothW} ${ry + rh}`;
  }
  tear += ` L ${rx + rw} ${ry} L ${rx} ${ry} Z`;

  const lineX = rx + rw * 0.16;
  const lineW = rw * 0.68;
  const lines = [0.24, 0.42, 0.6]
    .map(
      (t, i) =>
        `<rect x="${lineX}" y="${ry + rh * t}" width="${i === 2 ? lineW * 0.55 : lineW}" height="${rh * 0.055}" rx="${rh * 0.027}" fill="${BRAND}" opacity="0.85"/>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${s} ${s}">
  ${background ? `<rect width="${s}" height="${s}" rx="${s * 0.22}" fill="url(#g)"/>` : ""}
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${BRAND}"/><stop offset="1" stop-color="${BRAND_DARK}"/>
  </linearGradient></defs>
  <path d="${tear}" fill="${INK}"/>
  ${lines}
</svg>`;
}

async function png(svg: string, size: number, out: string): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log(`  ${path.relative(WEB, out)}`);
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

async function splash(w: number, h: number, out: string): Promise<void> {
  const logo = Math.round(Math.min(w, h) * 0.28);
  const mark = await sharp(Buffer.from(markSvg(logo, 0.06, "brand")))
    .resize(logo, logo)
    .png()
    .toBuffer();
  await mkdir(path.dirname(out), { recursive: true });
  await sharp({
    create: { width: w, height: h, channels: 4, background: SPLASH_BG },
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toFile(out);
}

async function main(): Promise<void> {
  console.log("icons:");
  await png(markSvg(512, 0.06, "brand"), 512, path.join(WEB, "public/icon-512.png"));
  await png(markSvg(512, 0.06, "brand"), 192, path.join(WEB, "public/icon-192.png"));
  // Maskable: content inside the middle 80%, because Android crops to a
  // circle and anything outside that radius can be cut off.
  await png(markSvg(512, 0.18, "brand"), 512, path.join(WEB, "public/icon-maskable.png"));
  await png(markSvg(512, 0.06, "brand"), 180, path.join(WEB, "src/app/apple-icon.png"));
  await png(markSvg(512, 0.06, "brand"), 48, path.join(WEB, "src/app/icon.png"));

  console.log("splash screens:");
  for (const entry of SPLASH) {
    const out = path.join(WEB, `public/splash/${entry.name}.png`);
    await splash(entry.w, entry.h, out);
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
