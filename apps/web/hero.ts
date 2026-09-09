import { heroui } from "@heroui/theme";

/**
 * apps/web/hero.ts — the HeroUI theme definition (Phase 7 task 7.1).
 *
 * DEVIATION from docs/PHASES.md task 7.1, which names
 * `apps/web/tailwind.config.js`: Tailwind 4 has no JS config file. The theme
 * is a plugin loaded from CSS via `@plugin "../../hero.ts"` in
 * `src/app/globals.css`, and this file is that plugin. Recorded as D-32.
 *
 * Structure, token names and the five-theme shape are Forkd's
 * (`docs/reference/FORKD_UI.md` §Colors), so the two apps share a design
 * system. `midnight`, `amber` and `plum` are ported verbatim — they are named
 * for their own accents, so changing those would be pointless. `dark` and
 * `light` carry Ledgerly's accent instead of Forkd's `#3d7a52` green: a muted
 * teal at the same lightness progression, so the apps are distinguishable at a
 * glance in an app switcher while every other token matches (D-31).
 *
 * FORKD_UI.md records only the 50 and 900 endpoints for the three ported
 * themes; the intermediate steps here are interpolated along those endpoints
 * and are monotonic in lightness, which is the property the ramp is actually
 * used for.
 */

export default heroui({
  themes: {
    // ---- Ledgerly Dark (default) -------------------------------------
    dark: {
      extend: "dark",
      colors: {
        background: "#0a0a0a",
        foreground: "#ededed",
        divider: "rgba(255,255,255,0.1)",
        focus: "#3f9c9e",
        content1: "#141414",
        content2: "#1e1e1e",
        content3: "#262626",
        content4: "#2e2e2e",
        primary: {
          50: "#0a2d2e",
          100: "#0f4042",
          200: "#175f61",
          300: "#1f7d80",
          400: "#2e9497",
          500: "#40abae",
          600: "#57bcbf",
          700: "#7fcacc",
          800: "#a3d9da",
          900: "#ccebec",
          DEFAULT: "#2f7d80",
          foreground: "#ffffff",
        },
        secondary: { DEFAULT: "#484848", foreground: "#ededed" },
      },
    },

    // ---- Midnight (ported verbatim from Forkd) -----------------------
    midnight: {
      extend: "dark",
      colors: {
        background: "#0b1020",
        foreground: "#e6ebf5",
        divider: "rgba(255,255,255,0.1)",
        focus: "#3b82f6",
        content1: "#121a2e",
        content2: "#1a2440",
        content3: "#233056",
        content4: "#2c3a66",
        primary: {
          50: "#0b1f3a",
          100: "#102a52",
          200: "#17407c",
          300: "#1f56a6",
          400: "#2a6bc9",
          500: "#4785dc",
          600: "#6ba0e6",
          700: "#93bcee",
          800: "#b6d2f6",
          900: "#d7e6fe",
          DEFAULT: "#2f6fd0",
          foreground: "#ffffff",
        },
        secondary: { DEFAULT: "#3a4566", foreground: "#e6ebf5" },
      },
    },

    // ---- Amber (ported verbatim from Forkd) --------------------------
    amber: {
      extend: "dark",
      colors: {
        background: "#161310",
        foreground: "#f0e9e0",
        divider: "rgba(255,255,255,0.1)",
        focus: "#d97706",
        content1: "#211c16",
        content2: "#2b251d",
        content3: "#352d23",
        content4: "#3f3529",
        primary: {
          50: "#2a1c06",
          100: "#3d2a09",
          200: "#5c400d",
          300: "#7d5711",
          400: "#a06d12",
          500: "#c68a15",
          600: "#e0a52c",
          700: "#eab949",
          800: "#f5d271",
          900: "#fde68a",
          DEFAULT: "#d97706",
          foreground: "#ffffff",
        },
        secondary: { DEFAULT: "#4a4035", foreground: "#f0e9e0" },
      },
    },

    // ---- Plum (ported verbatim from Forkd) ---------------------------
    plum: {
      extend: "dark",
      colors: {
        background: "#140d18",
        foreground: "#ece6f0",
        divider: "rgba(255,255,255,0.1)",
        focus: "#a855f7",
        content1: "#1e1424",
        content2: "#281a30",
        content3: "#33223e",
        content4: "#3e2a4b",
        primary: {
          50: "#2a1640",
          100: "#3a1f59",
          200: "#522d7d",
          300: "#6b3ba1",
          400: "#8149bd",
          500: "#9861d2",
          600: "#ac7ddc",
          700: "#c29ce7",
          800: "#d8bff2",
          900: "#efe0fe",
          DEFAULT: "#9450d6",
          foreground: "#ffffff",
        },
        secondary: { DEFAULT: "#473a52", foreground: "#ece6f0" },
      },
    },

    // ---- Ledgerly Beige (default, D-41) ------------------------------
    //
    // Both colours are sampled from the app icon rather than invented:
    // `#faf4eb` is the tile, `#324136` is the mark. Before this the light
    // theme was plain white with the teal accent, and the icon looked like it
    // belonged to a different product.
    //
    // The content ramp goes UP in lightness from the page (`content1` is
    // lighter than `background`), which is the opposite of the dark themes and
    // is what makes a card read as raised on a warm ground rather than as a
    // hole cut in it.
    light: {
      extend: "light",
      colors: {
        background: "#faf4eb",
        foreground: "#26302a",
        divider: "rgba(50,65,54,0.14)",
        focus: "#324136",
        content1: "#fffdf8",
        content2: "#f3ecdf",
        content3: "#e8e0d0",
        content4: "#dbd2be",
        primary: {
          50: "#eef2ef",
          100: "#d9e2dc",
          200: "#b6c5bb",
          300: "#90a89a",
          400: "#6d8b79",
          500: "#4f705d",
          600: "#3d5846",
          700: "#324136",
          800: "#26322a",
          900: "#1a231d",
          DEFAULT: "#324136",
          foreground: "#faf4eb",
        },
        secondary: { DEFAULT: "#ddd3c0", foreground: "#26302a" },
      },
    },
  },
});
