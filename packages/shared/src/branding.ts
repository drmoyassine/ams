// Branding rules shared by the API (to refuse a colour) and the SPA (to preview it).

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** Contrast ratio of white text on this colour (1 to 21). Primary buttons use near-white text. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/** The accent colour becomes the background of buttons with white text, so it must be dark enough to read (WCAG AA, 4.5). */
export const MIN_ACCENT_CONTRAST = 4.5;
export const isReadableAccent = (hex: string) => /^#[0-9a-fA-F]{6}$/.test(hex) && contrastWithWhite(hex) >= MIN_ACCENT_CONTRAST;
