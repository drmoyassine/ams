// The building blocks of the institution's quality management system and the cycle that connects them (DEC-016).
// The blocks are fixed, because the system gives each of them behaviour; the institution names and defines them, and
// switches off the ones it does not use. The cycle is data: stages, the blocks in each, and the flows between blocks.
// The Mermaid diagram is generated from it, never edited by hand, so people, the system and agents read the same model.
import { z } from 'zod';

export const BUILDING_BLOCKS = [
  'policy', 'objective', 'risk', 'opportunity', 'measure', 'procedure', 'evidence', 'internal_review', 'management_review', 'corrective_action',
] as const;
export type BuildingBlock = (typeof BUILDING_BLOCKS)[number];
/** Properties every block carries, defined alongside the blocks. */
export const BLOCK_ATTRIBUTES = ['owner', 'scope'] as const;

const key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower-case letters, digits and _');

export const QmsCycleSchema = z.object({
  stages: z.array(z.object({ key, name: z.string().trim().min(1), blocks: z.array(z.enum(BUILDING_BLOCKS)) }).strict()).min(1),
  flows: z.array(z.object({ from: z.enum(BUILDING_BLOCKS), to: z.enum(BUILDING_BLOCKS), label: z.string().trim().min(1).optional() }).strict()),
}).strict();
export type QmsCycle = z.infer<typeof QmsCycleSchema>;

/** Plan, Do, Check, Act (ISO 9001 and ISO 21001 are built on it): where a new framework starts. */
export const DEFAULT_QMS_CYCLE: QmsCycle = {
  stages: [
    { key: 'plan', name: 'Plan', blocks: ['policy', 'risk', 'opportunity', 'objective', 'measure'] },
    { key: 'do', name: 'Do', blocks: ['procedure', 'evidence'] },
    { key: 'check', name: 'Check', blocks: ['internal_review'] },
    { key: 'act', name: 'Act', blocks: ['corrective_action', 'management_review'] },
  ],
  flows: [
    { from: 'policy', to: 'objective' },
    { from: 'risk', to: 'objective' },
    { from: 'opportunity', to: 'objective' },
    { from: 'objective', to: 'measure' },
    { from: 'objective', to: 'procedure', label: 'carried out by' },
    { from: 'procedure', to: 'evidence' },
    { from: 'measure', to: 'internal_review', label: 'results' },
    { from: 'evidence', to: 'internal_review' },
    { from: 'internal_review', to: 'corrective_action', label: 'gap found' },
    { from: 'corrective_action', to: 'procedure' },
    { from: 'internal_review', to: 'management_review' },
    { from: 'management_review', to: 'policy' },
  ],
};

/** Rules no single schema can see: unique stage keys, each block in one stage at most, flows only between placed blocks. */
export function checkQmsCycle(c: QmsCycle): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const stageKeys = new Set<string>();
  const placed = new Map<string, string>();
  c.stages.forEach((s, i) => {
    if (stageKeys.has(s.key)) issues.push({ path: `stages[${i}].key`, message: `duplicate stage ${s.key}` });
    stageKeys.add(s.key);
    for (const b of s.blocks) {
      if (placed.has(b)) issues.push({ path: `stages[${i}].blocks`, message: `${b} is already in ${placed.get(b)}` });
      placed.set(b, s.name);
    }
  });
  const seen = new Set<string>();
  c.flows.forEach((f, i) => {
    if (!placed.has(f.from) || !placed.has(f.to)) issues.push({ path: `flows[${i}]`, message: `a flow joins blocks that are placed in a stage (${f.from} → ${f.to})` });
    if (f.from === f.to) issues.push({ path: `flows[${i}]`, message: 'a flow joins two different blocks' });
    if (seen.has(`${f.from}>${f.to}`)) issues.push({ path: `flows[${i}]`, message: `duplicate flow ${f.from} → ${f.to}` });
    seen.add(`${f.from}>${f.to}`);
  });
  return issues;
}

const quote = (s: string) => s.replace(/"/g, '#quot;');

/** The cycle as a Mermaid flowchart, with the institution's own names for its blocks. Stable output for the same input. */
export function cycleToMermaid(c: QmsCycle, names: Partial<Record<string, string>> = {}): string {
  const label = (b: string) => quote(names[b] ?? b.replace(/_/g, ' '));
  const lines = ['flowchart LR'];
  for (const s of c.stages) {
    lines.push(`  subgraph ${s.key}["${quote(s.name)}"]`);
    for (const b of s.blocks) lines.push(`    ${b}["${label(b)}"]`);
    lines.push('  end');
  }
  // The layout breaks the loop at the first arrow that reaches back to a block still being laid out. Listing each block's
  // arrows to later stages first makes that the arrow that goes back to an earlier stage, so the stages read left to
  // right in their order. Only the order of lines changes, never what they say.
  const stageOf = new Map(c.stages.flatMap((s, i) => s.blocks.map((b) => [b as string, i] as const)));
  const ordered = c.flows.map((f, i) => ({ f, i })).sort((x, y) =>
    (stageOf.get(y.f.to) ?? 0) - (stageOf.get(x.f.to) ?? 0) || x.i - y.i).map((x) => x.f);
  for (const f of ordered) lines.push(f.label ? `  ${f.from} -->|"${quote(f.label)}"| ${f.to}` : `  ${f.from} --> ${f.to}`);
  return lines.join('\n');
}
