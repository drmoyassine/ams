import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { parseCell, type DataColumn } from '@ams/shared';
import { Button } from './ui/button';
import { useTranslation } from '../i18n';

/** A row as typed: what each cell shows, by column key. Checked against the columns as it is typed. */
export type DraftRow = Record<string, string>;

const isBlank = (r: DraftRow | undefined, columns: DataColumn[]) => !r || columns.every((c) => !(r[c.key] ?? '').trim());

/** Keeps exactly one empty row at the end, to type or paste into. */
export function withTrailingRow(rows: DraftRow[], columns: DataColumn[]): DraftRow[] {
  const out = [...rows];
  while (out.length > 1 && isBlank(out[out.length - 1], columns) && isBlank(out[out.length - 2], columns)) out.pop();
  if (!out.length || !isBlank(out[out.length - 1], columns)) out.push({});
  return out;
}

/** Text copied from Excel or Google Sheets: rows by line, cells by tab (quoted cells may hold tabs and line breaks). */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  const s = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

/**
 * The online sheet for data evidence: one input per cell, so it works with screen readers, right-to-left text and the
 * browser's own editing. Paste a block from Excel into any cell to fill from there; Enter and the up/down arrows move
 * between rows. A cell that does not fit its column is shaded red and says why (the server applies the same rules).
 */
export function DataGrid({ columns, rows, onChange, readOnly = false, serverIssues }: {
  columns: DataColumn[]; rows: DraftRow[]; onChange?: (rows: DraftRow[]) => void; readOnly?: boolean;
  /** Problems the server reported, by "row:key". */
  serverIssues?: Map<string, string>;
}) {
  const { t } = useTranslation();
  const table = useRef<HTMLTableElement>(null);
  const shown = readOnly ? rows : withTrailingRow(rows, columns);
  const set = (next: DraftRow[]) => onChange?.(withTrailingRow(next, columns));
  const focus = (r: number, c: number) => {
    requestAnimationFrame(() => table.current?.querySelector<HTMLInputElement>(`input[data-cell="${r}:${c}"]`)?.focus());
  };
  const edit = (r: number, key: string, value: string) => {
    const next = [...shown];
    next[r] = { ...next[r], [key]: value };
    set(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.altKey)) { e.preventDefault(); focus(r + 1, c); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (r > 0) focus(r - 1, c); }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return; // one value: let the input take it
    e.preventDefault();
    const block = parseClipboard(text);
    const next = [...shown];
    block.forEach((cells, i) => {
      const row = { ...(next[r + i] ?? {}) };
      cells.forEach((v, j) => { const col = columns[c + j]; if (col) row[col.key] = v; });
      next[r + i] = row;
    });
    set(next);
    focus(r + block.length - 1, c);
  };

  return (
    <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
      <table ref={table} className="w-full border-collapse text-sm" aria-label={t('grid.data')}>
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th scope="col" className="w-10 border-b border-border px-2 py-1 text-xs font-normal text-muted-foreground">#</th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="min-w-32 border-b border-s border-border px-2 py-1 text-start font-medium">
                <span dir="auto">{c.label}</span>{c.unit ? <span className="text-xs font-normal text-muted-foreground"> ({c.unit})</span> : null}
                {c.required && <span className="text-red-700" title={t('grid.required')}> *</span>}
              </th>
            ))}
            {!readOnly && <th className="w-8 border-b border-border" aria-label={t('common.remove')} />}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => {
            const blank = isBlank(row, columns);
            return (
              <tr key={r} className="border-b border-border">
                <td className="px-2 text-center text-xs text-muted-foreground">{blank && !readOnly ? '' : r + 1}</td>
                {columns.map((c, ci) => {
                  const raw = row[c.key] ?? '';
                  const err = blank ? undefined : (parseCell(c, raw).error ?? serverIssues?.get(`${r}:${c.key}`));
                  const numeric = c.type === 'number' || c.type === 'integer' || c.type === 'percent';
                  return (
                    <td key={c.key} className={`border-s border-border p-0 ${err ? 'bg-red-50' : ''}`}>
                      {readOnly
                        ? <span dir="auto" className={`block px-2 py-1 ${numeric ? 'text-end tabular-nums' : ''}`}>{raw}</span>
                        : (
                          <input
                            data-cell={`${r}:${ci}`} aria-label={`${c.label}, row ${r + 1}`} aria-invalid={err ? true : undefined} title={err}
                            value={raw} dir="auto" list={c.type === 'choice' || c.type === 'yes_no' ? `choices-${c.key}` : undefined}
                            inputMode={numeric ? 'decimal' : undefined} placeholder={c.type === 'date' && blank ? 'yyyy-mm-dd' : undefined}
                            className={`w-full bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-primary ${numeric ? 'text-end tabular-nums' : ''} ${err ? 'text-red-900' : ''}`}
                            onChange={(e) => edit(r, c.key, e.target.value)} onKeyDown={(e) => onKey(e, r, ci)} onPaste={(e) => onPaste(e, r, ci)}
                          />
                        )}
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="text-center">
                    {!blank && <Button type="button" variant="ghost" className="px-1 py-0 text-xs" aria-label={`Remove row ${r + 1}`} onClick={() => set(shown.filter((_, i) => i !== r))}>✕</Button>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {columns.filter((c) => c.type === 'choice' || c.type === 'yes_no').map((c) => (
        <datalist key={c.key} id={`choices-${c.key}`}>
          {(c.type === 'yes_no' ? ['Yes', 'No'] : c.choices ?? []).map((v) => <option key={v} value={v} />)}
        </datalist>
      ))}
    </div>
  );
}
