# Forkd UI Design System

## Visual Character

Forkd is a dark-first, theme-switchable PWA with a premium, minimalist aesthetic. The default "Forkd Dark" theme pairs a near-black background (#0a0a0a) with a brand green accent (#3d7a52), creating high contrast with warmth. The interface prioritizes readability and accessibility with generous whitespace, crisp typography, and a hand-rolled service worker that keeps the app functional offline. The overall feel is purposeful and efficient — no decorative flourishes, icons are from a lightweight library, and the design adapts fluidly to phones, tablets, and desktops.

---

## Colors

Forkd uses **HeroUI v2** theme system with five selectable themes. Each theme is defined as a CSS class applied to the `<html>` element. Colors are configured in `/apps/web/tailwind.config.js` (lines 1–171) via the `heroui()` plugin.

### Theme Definitions

#### Dark (Default)
- **Background**: #0a0a0a
- **Foreground**: #ededed
- **Divider**: rgba(255,255,255,0.1)
- **Focus**: #4d9970
- **Content1**: #141414 (card/content background)
- **Content2**: #1e1e1e
- **Content3**: #262626
- **Content4**: #2e2e2e
- **Primary** (green accent):
  - 50: #0f2d1e | 100: #15402b | 200: #1f5f3e | 300: #2a7d53 | 400: #3a9468
  - **500**: #4aab7c | **600**: #5fbc8e | **700**: #7fcaa5 | **800**: #a3d9bf | **900**: #ccebd8
  - DEFAULT: #3d7a52 | foreground: #ffffff
- **Secondary**: DEFAULT: #484848 | foreground: #ededed

#### Midnight
- **Background**: #0b1020
- **Foreground**: #e6ebf5
- **Divider**: rgba(255,255,255,0.1)
- **Focus**: #3b82f6
- **Content1**: #121a2e | Content2: #1a2440 | Content3: #233056 | Content4: #2c3a66
- **Primary** (blue accent): 50: #0b1f3a → 900: #d7e6fe | DEFAULT: #2f6fd0
- **Secondary**: DEFAULT: #3a4566 | foreground: #e6ebf5

#### Amber
- **Background**: #161310
- **Foreground**: #f0e9e0
- **Divider**: rgba(255,255,255,0.1)
- **Focus**: #d97706
- **Content1**: #211c16 | Content2: #2b251d | Content3: #352d23 | Content4: #3f3529
- **Primary** (amber accent): 50: #2a1c06 → 900: #fde68a | DEFAULT: #d97706
- **Secondary**: DEFAULT: #4a4035 | foreground: #f0e9e0

#### Plum
- **Background**: #140d18
- **Foreground**: #ece6f0
- **Divider**: rgba(255,255,255,0.1)
- **Focus**: #a855f7
- **Content1**: #1e1424 | Content2: #281a30 | Content3: #33223e | Content4: #3e2a4b
- **Primary** (purple accent): 50: #2a1640 → 900: #efe0fe | DEFAULT: #9450d6
- **Secondary**: DEFAULT: #473a52 | foreground: #ece6f0

#### Light
- **Background**: #ffffff
- **Foreground**: #18181b
- **Divider**: rgba(0,0,0,0.12)
- **Focus**: #3d7a52 (green, same as dark default)
- **Content1**: #ffffff | Content2: #f4f4f5 | Content3: #e4e4e7 | Content4: #d4d4d8
- **Primary** (green): 50: #ecf6f0 → 900: #15301f | DEFAULT: #3d7a52
- **Secondary**: DEFAULT: #d4d4d8 | foreground: #18181b

### Theme Selection & Persistence

Themes are defined in `/packages/shared/src/themes.ts` as an array:
```typescript
export const THEMES = [
  { id: "dark", label: "Forkd Dark", background: "#0a0a0a", isDark: true },
  { id: "midnight", label: "Midnight", background: "#0b1020", isDark: true },
  { id: "amber", label: "Amber", background: "#161310", isDark: true },
  { id: "plum", label: "Plum", background: "#140d18", isDark: true },
  { id: "light", label: "Forkd Light", background: "#ffffff", isDark: false },
] as const;
```

**Theme Application**:
- The active theme class is read server-side in `/apps/web/src/app/layout.tsx` (lines 23–40) via `await caller.auth.me()`, which fetches the user's stored preference.
- The theme class is applied to `<html className={theme}>` (line 64).
- Client-side, `/apps/web/src/lib/applyTheme.ts` swaps the theme class on `document.documentElement` for instant preview before save (removes all theme classes, then adds the new one).
- The PWA chrome (browser bar) color matches the theme background via the viewport `themeColor` metadata.

**Dark Mode Handling**:
All five themes are explicitly dark (isDark: true) except Light. The server detects the user's theme and applies it; there is no automatic light/dark mode switching based on OS preference.

---

## Typography

### Font Stack
System fonts (no custom typeface download):
```css
font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

### Type Scale & Sizing
Forkd relies on HeroUI's built-in type scale. Common sizes observed in components:
- **Logo/Title**: text-xl (1.25rem) font-bold
- **Heading (h1)**: text-2xl (1.5rem) font-bold
- **Heading (h2)**: text-lg (1.125rem) font-semibold
- **Body copy**: base (1rem)
- **Small text**: text-sm (0.875rem)
- **Caption/meta**: text-xs (0.75rem)

### Line Heights
- Body: line-height: 1.5 (set in globals.css)
- Headings: default HeroUI (typically 1.2–1.25)

### Font Weights
- Regular: 400 (default)
- Semibold: 600 (headings, labels)
- Bold: 700 (logos, primary headings)

### iOS Input Fix
Inputs, textareas, and selects are forced to at least 16px to prevent iOS Safari auto-zoom on focus:
```css
input, textarea, select {
  font-size: max(16px, 1em);
}
```

---

## Spacing & Layout

### Spacing Scale
Forkd uses Tailwind's default spacing scale. Common utility usage:
- Padding: p-3, p-4, p-5, px-4, py-3, pb-[calc(...)] (safe-area-adjusted)
- Margin: m-0, mb-2, mb-6, mt-0.5
- Gap: gap-1, gap-2, gap-3, gap-4, gap-6

### Border Radius
- Buttons: rounded-lg (0.5rem in offline.html; HeroUI defaults apply elsewhere)
- Cards: HeroUI default (0.75rem observed in InstallPrompt, OnboardingCard)

### Shadows
- InstallPrompt card: shadow-lg
- Offline page: no shadows (hand-rolled styling for simplicity)

### Container Widths
- Guest bill-split page: max-width: 34rem (544px) with `max-width: 22rem` for the centered card in offline.html
- Navbar: maxWidth="xl" (HeroUI default = 1280px)
- General content wrapper: max-width: sm (640px) observed in WelcomeForm

### Safe-Area Inset Handling
All four safe-area insets are applied **globally** to the `<body>` (not per-component):
```css
body {
  overflow-x: clip; /* prevent horizontal scroll without establishing a scroll container */
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);
}
```

The **top** inset is handled by the Navbar's `pt-[env(safe-area-inset-top)]` class (Header.tsx line 82), so the dark header fills behind the status bar and the logo sits below it. This prevents a flash of background color on page load.

### Breakpoints
Tailwind defaults are used:
- sm: 640px (Header uses `sm:hidden` to show mobile menu toggle and `sm:flex` for desktop nav)
- md: 768px
- lg: 1024px
- xl: 1280px
- 2xl: 1536px

---

## Component Patterns

### Component Library
**HeroUI v2.7.8** (Tailwind-based component library) is the sole component source. Components live in node_modules and are imported directly:
```typescript
import { Navbar, NavbarBrand, Button, Card, CardBody, Input, Select, Dropdown, ... } from "@heroui/react";
```

No shadcn, no hand-rolled component library (beyond rare custom wrappers). `/packages/ui/` contains only one custom component: RestaurantMap.tsx.

### Common Component Examples

#### Button
- **Variants**: `variant="light"` (no background), `variant="flat"` (muted bg), default (solid)
- **Sizes**: `size="sm"` (compact), `size="lg"` (full)
- **Icon buttons**: `isIconOnly={true}`
- **Colors**: `color="primary"`, `color="danger"` (semantic)
- **States**: `isDisabled={bool}`, `isLoading={bool}`

Example (Header.tsx lines 139–149):
```tsx
<Button
  as={NextLink}
  href="/restaurants/new"
  isIconOnly
  variant="light"
  size="sm"
  aria-label="Add restaurant"
>
  <Plus className="h-5 w-5" />
</Button>
```

#### Navbar
- **Responsive**: Hamburger menu hides on mobile (NavbarMenuToggle), desktop nav hidden on mobile.
- **Structure**: NavbarContent for layout zones, NavbarBrand for logo, NavbarMenu for mobile drawer.
- **Safe-area**: Navbar applies `pt-[env(safe-area-inset-top)]` to base and menu.

Example (Header.tsx):
```tsx
<Navbar isBordered isMenuOpen={isMenuOpen} onMenuOpenChange={setIsMenuOpen} maxWidth="xl">
  <NavbarContent>
    <NavbarMenuToggle className="sm:hidden" />
    <NavbarBrand><Link href="/" className="text-xl font-bold">Forkd</Link></NavbarBrand>
  </NavbarContent>
  <NavbarContent className="hidden sm:flex gap-6">...</NavbarContent>
  <NavbarContent justify="end">...</NavbarContent>
  <NavbarMenu>{/* mobile drawer */}</NavbarMenu>
</Navbar>
```

#### Card
- **Structure**: `<Card>` > `<CardBody className="gap-4 p-5">` > content
- **Styling**: HeroUI applies bg-content1 (darker background), border, shadow
- **Usage**: OnboardingCard (info box with dismissal), InstallPrompt card (fixed bottom)

Example (OnboardingCard.tsx lines 31–56):
```tsx
<Card className="mb-6">
  <CardBody className="gap-4 p-5">
    <div className="flex items-start justify-between gap-3">
      <h2 className="text-lg font-semibold">👋 Welcome to Forkd</h2>
      <Button isIconOnly size="sm" variant="light" aria-label="Dismiss" onPress={dismiss}>
        <X className="h-4 w-4" />
      </Button>
    </div>
    <ul className="flex flex-col gap-2 text-sm">
      {STEPS.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
    <Button size="sm" color="primary" onPress={dismiss}>Got it</Button>
  </CardBody>
</Card>
```

#### Form Inputs
- **Input**: HeroUI's `<Input label="..." value={} onValueChange={} isRequired />`
- **Select**: HeroUI's `<Select label="..." selectedKeys={new Set([val])} onSelectionChange={keys => ...} >`
- **Error display**: Simple `<p className="rounded bg-danger-50 p-3 text-sm text-danger">`

Example (WelcomeForm.tsx lines 47–65):
```tsx
<form onSubmit={handleSubmit} className="flex flex-col gap-4">
  <div className="flex gap-3">
    <Input label="First Name" value={firstName} onValueChange={setFirstName} isRequired />
    <Input label="Last Name" value={lastName} onValueChange={setLastName} isRequired />
  </div>
  <Select label="Theme" selectedKeys={new Set([theme])} onSelectionChange={...}>
    {THEMES.map((t) => <SelectItem key={t.id}>{t.label}</SelectItem>)}
  </Select>
  <Button type="submit" color="primary" isLoading={updateProfile.isPending} className="mt-2">
    Save
  </Button>
</form>
```

#### Dropdown Menu
- **Trigger**: `<DropdownTrigger>` wraps the button
- **Menu**: `<DropdownMenu items={items} onAction={key => ...}>`
- **Items**: Mapped with `<DropdownItem key={} color={} className={}>`
- **Danger state**: `color="danger"` for destructive actions (sign-out)

Example (Header.tsx lines 152–177):
```tsx
<Dropdown>
  <DropdownTrigger>
    <Button variant="flat" size="sm">{userName ?? "Menu"}</Button>
  </DropdownTrigger>
  <DropdownMenu aria-label="User menu" items={dropdownItems} onAction={(key) => {...}}>
    {(item) => (
      <DropdownItem key={item.key} color={item.danger ? "danger" : "default"} className={item.danger ? "text-danger" : ""}>
        {item.label}
      </DropdownItem>
    )}
  </DropdownMenu>
</Dropdown>
```

#### Loading & Empty States
- **Spinner**: HeroUI `<Spinner size="lg" />` centered in a flex container
- **Empty/offline**: Static HTML card (not a React component), with centered content, logo, heading, text, and button

Example offline page (public/offline.html):
```html
<div className="card">
  <div className="logo">Forkd</div>
  <h1>You're offline</h1>
  <p>Forkd needs a connection to load your restaurants...</p>
  <button onclick="location.reload()">Retry</button>
</div>
```

---

## PWA Configuration

### Manifest
Located at `/apps/web/src/app/manifest.ts` (generated dynamically by Next.js):
```typescript
{
  name: "Forkd",
  short_name: "Forkd",
  description: "Family restaurant tracker",
  start_url: "/",
  display: "standalone",
  background_color: "#0a0a0a", // dark theme background
  theme_color: "#0a0a0a", // matches active theme via layout.tsx
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  share_target: {
    action: "/import",
    method: "GET",
    params: { title: "title", text: "text", url: "url" },
  },
}
```

**Notes**:
- `display: "standalone"` hides browser chrome
- `theme_color` is updated server-side per the active theme (line 39 of layout.tsx)
- Icons are PNG files in `/public/` (192×192, 512×512 regular + maskable variant)
- `share_target` allows the installed app to appear in Android's share sheet

### Service Worker
Located at `/public/sw.js`. **Hand-rolled, no library dependencies.**

**Caching Strategy**:
1. **Navigations** (HTML pages): Network-first with navigation preload; fallback to `/offline.html` when offline
2. **Immutable build assets** (`/_next/static/*`): Cache-first (content-hashed, never expires)
3. **Precached shell**: `/offline.html`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`
4. **Everything else** (tRPC, /api/*, photos, RSC): Network-only, never cached (keeps data fresh)

**Cache Name**: `forkd-shell-v2` (updated on major changes; old caches are cleaned during activate)

**Skip-Waiting**: Enabled on install; new service worker takes over immediately

**Navigation Preload**: Enabled on activate to fetch the next page while the service worker processes the request

### Install Prompt
Component: `/apps/web/src/components/InstallPrompt.tsx`

**Behavior**:
- Detects `beforeinstallprompt` event (Android/Chrome) and shows an "Install" button
- Detects iOS (via user agent) and shows manual instructions: "Tap Share then Add to Home Screen"
- Shows once per session unless dismissed or already installed
- Dismissal state stored in localStorage (`forkd_install_dismissed`)
- Skipped if app is already running in standalone mode (`window.matchMedia("(display-mode: standalone)")`)

**Placement**: Fixed to bottom, with safe-area-inset-bottom clearance, z-index 1100, max-width 448px

---

## Mobile Layout

### Viewport Meta Tag
Set in layout.tsx via generateViewport():
```typescript
{
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // extends content under notches and home indicators
  themeColor: getThemeBackground(theme),
}
```

### Safe-Area Handling
- **Body**: All four insets applied via padding (left, right, bottom). Top is handled by Navbar.
- **Sticky header**: Navbar applies top inset to stay below status bar and notch
- **Fixed overlays**: InstallPrompt, sheet modals apply `pb-[calc(env(safe-area-inset-bottom) + ...)]`
- **Guest page**: Generous bottom padding (`calc(env(safe-area-inset-bottom) + 140px)`) to prevent fixed footer overlap

### Mobile-First Approach
- **Hidden on mobile by default**: `className="hidden sm:flex"` for desktop nav in Navbar
- **Shown on mobile only**: `className="sm:hidden"` for hamburger menu toggle
- **Mobile nav drawer**: NavbarMenu slides up, also applies `pt-[env(safe-area-inset-top)]`
- **Touch targets**: Icon buttons are h-4 w-4 to h-5 w-5; larger on mobile (HeroUI's `size="sm"` is ~32px, fine for fingers)

### Mobile-Specific Patterns
- **Install prompt**: Sticky card at bottom with icon, text, and CTA; high z-index to float above nav
- **Offline page**: Centered card layout with generous padding, large button (0.7rem padding, 1rem font)
- **Menu drawer**: Full-width, slides from left, closes on navigation
- **Bottom nav in guest page**: Fixed bar (sticky header) with sticky calculation, not floating bottom sheet

### Orientation
- No explicit orientation lock; app adapts to all rotations
- Landscape notch and home-bar insets handled by safe-area-inset-left/right

---

## Icons

### Icon Library
**Lucide React v1.17.0** is the sole icon source. Icons are tree-shakeable, SVG-based, 24px by default.

### Common Icon Usage
- `<Plus />`, `<X />`, `<RotateCw />`, `<Download />` in Header and InstallPrompt
- `<Search />`, `<Sparkles />`, `<Star />`, `<MapPin />` in OnboardingCard
- `<Share />` for iOS install instructions (shown inline at 3.5px for tight spacing)

### Size Convention
- Standard: `h-5 w-5` (20px) for most icons
- Large: `h-6 w-6` (24px) for emphasis
- Small: `h-4 w-4` (16px) for inline or compact contexts (e.g., error icons, step bullets)
- Extra-small: `h-3.5 w-3.5` (14px) for tight inline text (e.g., iOS share instructions)

### Colors
Icons inherit text color by default; explicit coloring via `className` or Tailwind:
- Primary action: `text-primary` (green in dark theme)
- Muted: `text-default-500` (gray)
- Danger: `text-danger` (red)
- Animated: `animate-spin` (Header's refresh button)

### Import Pattern
```typescript
import { Plus, X, RotateCw, Download, Search, Share, Sparkles, Star, MapPin } from "lucide-react";
```

---

## Design System Inconsistencies & Smells

1. **One-off Container Widths**: Guest page uses `max-width: 34rem` (line 91 of guestPageHtml.ts), while WelcomeForm uses `max-width: sm`. Standardize on a single "content" container breakpoint.

2. **Inline Styles in Offline HTML**: The offline.html (public/offline.html) redefines font stack, colors (#0a0a0a, #ededed, #a1a1aa), and spacing inline. This duplicates values from the main theme instead of importing or referencing them. If offline styling ever needs to change, two places must be updated.

3. **Gap Convention Variance**: Some components use `gap-1`, others `gap-4`; there is no documented spacing scale rule (e.g., "gap scales in units of 0.25rem, use gap-3 for primary spacing").

4. **HeroUI Color Tokens Not Fully Documented**: Components use `color="danger"`, `color="primary"` but the semantic meaning of each color beyond primary/secondary is undefined (e.g., what is "warning"? "success"?). Explicit color usage in HeroUI's theme config would clarify.

5. **No Theme Preload**: The initial theme is fetched server-side, preventing a FOUC. However, if server render fails (auth error), the default theme applies without client-side override. A theme state provider on the client could ensure the user's stored theme loads before hydration even if the server misses it.

---

## Implementation Checklist for Ledgerly

- [ ] Copy tailwind.config.js structure and HeroUI plugin configuration
- [ ] Define `<APP_HOSTNAME>` and theme `background` colors in manifest.ts (do not hardcode hostnames or real theme colors)
- [ ] Apply safe-area-inset padding to body; handle top via Navbar/Header component
- [ ] Use HeroUI v2+ for all components; do not mix shadcn or hand-rolled
- [ ] Implement InstallPrompt component with beforeinstallprompt listener (Android) and iOS detection
- [ ] Hand-roll service worker or use Workbox with cache-first for build assets, network-first for navigations
- [ ] Use Lucide React for all icons; no custom SVG or icon fonts
- [ ] Test all safe-area combinations on notched devices (iOS and Android)
- [ ] Verify offline.html is in public/ and precached in sw.js PRECACHE array
