# Knowledge Hub Frontend Redesign

## Aesthetic Direction: 墨烬 · Ink & Ember Archive

A cinematic dark archive for a knowledge governance console. The interface is imagined as a curator's desk in a vast nocturnal library: deep ink backgrounds, warm ember accents, refined serif typography, and subtle paper grain. The goal is to transform a dense technical dashboard into an authoritative, memorable command center without changing the underlying component logic.

## Design Decisions

- **Tone:** Dark, refined, archival, slightly editorial. Not playful, not corporate-default.
- **Color:**
  - Background: `#0c0b09` (deep espresso ink)
  - Surface: `#141311` (elevated cards)
  - Text: `#f5e6c8` (parchment)
  - Muted: `#9e9686`
  - Accent: `#e8a838` (ember amber)
  - Success: `#8a9a5b` (moss)
  - Warning: `#d4a03a`
  - Error: `#c86b4a` (rust)
- **Typography:**
  - Display / headings: `Cormorant Garamond` (English) + `Noto Serif SC` (Chinese)
  - Body / UI: `Work Sans` (English) + `Noto Sans SC` (Chinese)
  - Code: `JetBrains Mono`
- **Background Atmosphere:**
  - Subtle SVG noise/grain overlay
  - Radial vignette
  - Very faint grid lines
- **Spatial Composition:**
  - Keep sidebar + main structure
  - Increase negative space and border radius
  - Asymmetric page headers with oversized serif titles
  - Elevated cards with inner ember glow on hover
- **Motion:**
  - CSS-only page fade-in with staggered reveal
  - Nav hover glow
  - Card hover lift + border glow
  - Ambient pulse on running states
- **Branding:**
  - Deerflow mark as subtle amber monogram "DF" in bottom-right corner with tooltip

## Scope

- Modify `src/client/index.html` to load Google Fonts.
- Rewrite `src/client/src/styles.css` with the new design system.
- Make minimal class-name additions in `src/client/src/ui/App.tsx` to support animations and refined layout hooks.
- Preserve all existing functionality, API calls, and component structure.

## Verification

- `npm run typecheck` passes.
- `npm run build` produces a valid `dist/client`.
- Visual inspection via `npm run dev:web` (optional).
