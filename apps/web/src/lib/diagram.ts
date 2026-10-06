// The one place the SPA uses Mermaid (one import point per heavy library). Loaded on demand, rendered with the
// library's strict security level, so a label can never inject markup.
let ready: Promise<typeof import('mermaid').default> | null = null;
let n = 0;

export async function renderMermaid(text: string): Promise<string> {
  ready ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', flowchart: { htmlLabels: false } });
    return m.default;
  });
  const mermaid = await ready;
  n += 1;
  const { svg } = await mermaid.render(`qms-diagram-${n}`, text);
  return svg;
}
