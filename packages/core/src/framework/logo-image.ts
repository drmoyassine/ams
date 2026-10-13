// The rules for a logo image, shared by the accreditor's logo and the institution's: only small raster images are
// accepted, and the type comes from the bytes, never from what the caller says. SVG can carry script, so it is refused.
import { ValidationError } from '../ctx.js';

export const MAX_LOGO_BYTES = 512 * 1024;
export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** The image type the bytes really are (not what the caller says), or null. */
export function sniffLogo(b: Uint8Array): LogoMime | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Refuses an empty, oversized or non-PNG/JPEG/WebP file; returns the type the bytes are. */
export function checkLogoBytes(bytes: Uint8Array): LogoMime {
  if (bytes.byteLength === 0) throw new ValidationError('the file is empty');
  if (bytes.byteLength > MAX_LOGO_BYTES) throw new ValidationError(`the logo is larger than ${MAX_LOGO_BYTES / 1024} KB`);
  const mime = sniffLogo(bytes);
  if (!mime) throw new ValidationError('the logo must be a PNG, JPEG or WebP image');
  return mime;
}
