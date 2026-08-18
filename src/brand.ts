/**
 * Shared visual identity for all Worker-rendered HTML pages (public
 * dashboard, privacy policy, internal caller dashboard) — added 2026-08-18
 * from the real logo files the user provided
 * (gradient-decisions-monogram.svg, gradient-decisions-logo-v4.svg).
 *
 * Logos are inlined as SVG markup (not hosted as separate static assets —
 * this Worker has no static-file serving set up, everything is generated
 * HTML strings) with two changes from the source files:
 * 1. The white background `<rect>` is dropped — the source files were
 *    flat white-background exports; inlined into a page that supports
 *    light/dark mode, a hardcoded white box would break dark mode.
 * 2. Gradient `stop-color` uses `currentColor` instead of a hardcoded
 *    black — lets the mark inherit `color` from CSS, so the same markup
 *    renders correctly in both themes via existing `--text`-style
 *    variables rather than needing a second dark-mode SVG asset.
 *
 * Gradient element `id`s take an `idSuffix` param — SVG `id`s must be
 * unique per document; since a mark can appear more than once on one page
 * (e.g. header + footer), each call site passes a distinct suffix rather
 * than relying on any shared/global counter (which would be fragile
 * across concurrent Workers requests sharing an isolate).
 */

export function renderMonogram(idSuffix: string, sizePx = 40): string {
  const h = Math.round(sizePx * (240 / 360));
  return `<svg class="brand-mark" width="${sizePx}" height="${h}" viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gradient Decisions">
    <defs>
      <linearGradient id="gdFadeLR-${idSuffix}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.18"/>
        <stop offset="70%" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="1"/>
      </linearGradient>
      <linearGradient id="gdFadeRL-${idSuffix}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="30%" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="0.18"/>
      </linearGradient>
    </defs>
    <text x="40" y="165" font-family="Poppins, 'Century Gothic', Helvetica, Arial, sans-serif" font-size="130" font-weight="700" fill="url(#gdFadeLR-${idSuffix})">G</text>
    <text x="185" y="165" font-family="Poppins, 'Century Gothic', Helvetica, Arial, sans-serif" font-size="130" font-weight="700" fill="url(#gdFadeRL-${idSuffix})">D</text>
  </svg>`;
}

export function renderWordmark(idSuffix: string, widthPx = 220): string {
  const h = Math.round(widthPx * (220 / 640));
  return `<svg class="brand-wordmark" width="${widthPx}" height="${h}" viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gradient Decisions">
    <defs>
      <linearGradient id="gdWFadeLR-${idSuffix}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.18"/>
        <stop offset="40%" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="1"/>
      </linearGradient>
      <linearGradient id="gdWFadeRL-${idSuffix}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="60%" stop-color="currentColor" stop-opacity="1"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="0.18"/>
      </linearGradient>
    </defs>
    <text x="50" y="100" font-family="Poppins, 'Century Gothic', Helvetica, Arial, sans-serif" font-size="50" font-weight="700" letter-spacing="3" fill="url(#gdWFadeLR-${idSuffix})">GRADIENT</text>
    <text x="50" y="160" font-family="Poppins, 'Century Gothic', Helvetica, Arial, sans-serif" font-size="50" font-weight="700" letter-spacing="3" fill="url(#gdWFadeRL-${idSuffix})">DECISIONS</text>
  </svg>`;
}

/** Google Fonts load — Poppins is the logo's own typeface (see both source SVGs' font-family), used for headings across all pages so the wordmark/monogram don't look like a mismatched sticker on top of a different type system. */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">`;

/**
 * SVG favicon, inlined as a data URI (no static asset hosting available).
 * Solid fill, not the gradient-fade treatment — at 16-32px real favicon
 * render sizes the fade is imperceptible and just costs contrast/legibility,
 * so this is a deliberately simplified mark, not the full logo shrunk down.
 */
const FAVICON_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 240'><text x='40' y='165' font-family='Poppins, Helvetica, Arial, sans-serif' font-size='130' font-weight='700' fill='%234f46e5'>G</text><text x='185' y='165' font-family='Poppins, Helvetica, Arial, sans-serif' font-size='130' font-weight='700' fill='%23111827'>D</text></svg>`;
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${FAVICON_SVG}">`;

/**
 * Shared CSS every page's <style> block should include alongside its own
 * page-specific tokens — just the .brand-mark/.brand-wordmark base rules
 * that make the inlined SVGs above pick up theme color via currentColor
 * rather than needing per-theme markup variants.
 *
 * No gradient-clipped-text utility here on purpose (an earlier version of
 * this file had one) — --brand-gradient (defined per-page, see
 * src/dashboard.ts) is a monochrome fade-to-transparent, matching the
 * actual logo's own letterform treatment rather than an invented color
 * scheme (see that file's comment for the full reasoning). Fading text to
 * transparent risks the tail of a word/number becoming illegible, so it's
 * used for thin decorative accents (a topbar strip) only, never for text.
 */
export const BRAND_CSS = `
  .brand-mark, .brand-wordmark { color: var(--text); display: inline-block; vertical-align: middle; }
`;
