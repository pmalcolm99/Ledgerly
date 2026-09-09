# Vendored fonts

## DancingScript-Bold-latin.woff2

The app wordmark (`Header.tsx`), loaded via `next/font/local`.

**Why vendored rather than `next/font/google`.** `next/font/google` fetches
the font at BUILD time. Ledgerly is self-hosted and builds in CI and in a
Docker image; a build that reaches out to `fonts.googleapis.com` fails when
that host is unreachable, and adds a third party to a deployment whose whole
point is that it has none. A committed subset builds offline, forever, and is
byte-identical every time.

Latin subset only (25 KB) — the wordmark is one ASCII word. Regenerate with:

```
curl -sS -A "<a modern browser UA>" \
  "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&display=swap" \
  | grep -A6 '/\* latin \*/' | grep -o 'https://fonts.gstatic.com[^)]*' \
  | xargs curl -sS -o apps/web/src/app/fonts/DancingScript-Bold-latin.woff2
```

**Licence.** Dancing Script is © the Impallari Type project, licensed under
the SIL Open Font License 1.1 <https://scripts.sil.org/OFL>. The OFL permits
redistribution and bundling in this form; the font is not sold, and it is not
distributed under a reserved font name.
