const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The title worth showing next to a code: none when it only repeats the code ("CFR 1.1" / "CFR 1.1"), or when the code already
 * ends with it ("Standard 1 - Integrity and Transparency" / "Integrity and Transparency").
 */
export function distinctTitle(code: string, title: string): string | null {
  const c = norm(code);
  const t = norm(title);
  if (!t || t === c || c.endsWith(t) || t.startsWith(c)) return t.startsWith(c) && t !== c ? title.trim().slice(code.trim().length).replace(/^[\s:.\-—–]+/, '') || null : null;
  return title.trim();
}

/** "CFR 1.1" alone, or "Criterion 3(1) Student outcome (1)" when the title adds something. */
export function requirementLabel(code: string, title: string, separator = ' '): string {
  const extra = distinctTitle(code, title);
  return extra ? `${code}${separator}${extra}` : code;
}
