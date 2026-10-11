// The list of models an account's provider offers (DEC-025), fetched on the server so the key never reaches the browser.
// This is a METADATA call, not inference: nothing from the institution is sent, no tokens are spent, and it needs no AI
// scope (the same kind of exception as "Test connection"). It uses plain fetch against the providers' list endpoints;
// no model names or prices are written in the repository: whatever the provider returns is what the screen offers.
import { OPENROUTER_BASE_URL, type AiModelInfo, type AiModelKind, type AiProvider } from '@ams/shared';

export interface ModelSource {
  provider: AiProvider;
  /** `openai_compatible` only. */
  baseUrl?: string | null;
  apiKey: string;
}

export interface ModelListResult {
  models: AiModelInfo[];
  fetchedAt: string;
  cached: boolean;
}

/** The list could not be fetched; the message is safe to show (it never holds the key). */
export class ModelListError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelListError'; }
}

const TIMEOUT_MS = 15_000;
/** How long a fetched list is reused (per account, in memory). The Refresh button skips it. */
export const MODEL_CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED = 200;

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---- Classification --------------------------------------------------------------------------------------------------
const NOT_CHAT = /(^|[-_/.:])(tts|whisper|dall-?e|moderation|transcribe|realtime|audio|image|imagen|veo|sora|rerank|guard|davinci|babbage|aqa)(?=$|[-_/.:\d])/i;

/** A guess from the model id alone, for providers whose list says nothing about what a model does. */
export function classifyModelId(id: string): AiModelKind {
  if (/embed/i.test(id)) return 'embedding';
  if (NOT_CHAT.test(id)) return 'other';
  return 'chat';
}

/** USD per million tokens from a per-token price (OpenRouter style: a decimal string). A negative or odd value is unknown. */
function perMTok(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}
function withPricing(info: AiModelInfo, pricing: unknown): AiModelInfo {
  if (!isObj(pricing)) return info;
  const input = perMTok(pricing.prompt);
  const output = perMTok(pricing.completion);
  // A USD cap needs both, so a half-known price is treated as unknown.
  return input !== undefined && output !== undefined ? { ...info, inputUsdPerMTok: input, outputUsdPerMTok: output } : info;
}

// ---- Fetching --------------------------------------------------------------------------------------------------------
async function getJson(url: string, headers: Record<string, string>, secret: string): Promise<unknown> {
  const clean = (m: string) => (secret ? m.split(secret).join('[key]') : m);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const host = (() => { try { return new URL(url).host; } catch { return 'the provider'; } })();
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ModelListError(timedOut ? `${host} did not answer in time` : clean(`could not reach ${host}${e instanceof Error && e.message ? ` (${e.message})` : ''}`).slice(0, 300));
  }
  if (!res.ok) {
    const why = res.status === 401 || res.status === 403 ? 'the provider did not accept the key'
      : res.status === 404 ? 'the address was not found (check the Base URL)'
        : res.status === 429 ? 'the provider is limiting requests; try again in a minute'
          : 'the provider could not list its models';
    throw new ModelListError(`${why} (HTTP ${res.status})`);
  }
  try { return await res.json(); } catch { throw new ModelListError('the provider answered with something that is not a model list'); }
}

const bearer = (key: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

async function fromAnthropic(src: ModelSource): Promise<AiModelInfo[]> {
  const body = await getJson(ANTHROPIC_MODELS_URL, { 'x-api-key': src.apiKey, 'anthropic-version': '2023-06-01' }, src.apiKey);
  return arr(isObj(body) ? body.data : undefined).flatMap((m) => {
    if (!isObj(m) || !str(m.id)) return [];
    const caps = isObj(m.capabilities) ? m.capabilities : undefined;
    const image = caps && isObj(caps.image_input) && typeof caps.image_input.supported === 'boolean' ? caps.image_input.supported : undefined;
    const info: AiModelInfo = { id: m.id as string, kind: 'chat', ...(str(m.display_name) ? { name: str(m.display_name)! } : {}), ...(image !== undefined ? { supportsImages: image } : {}) };
    return [info];
  });
}

async function fromOpenAi(src: ModelSource): Promise<AiModelInfo[]> {
  const body = await getJson(OPENAI_MODELS_URL, bearer(src.apiKey), src.apiKey);
  return arr(isObj(body) ? body.data : undefined).flatMap((m) => (isObj(m) && str(m.id) ? [{ id: m.id as string, kind: classifyModelId(m.id as string) } satisfies AiModelInfo] : []));
}

async function fromGoogle(src: ModelSource): Promise<AiModelInfo[]> {
  const out: AiModelInfo[] = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = pageToken ? `${GOOGLE_MODELS_URL}&pageToken=${encodeURIComponent(pageToken)}` : GOOGLE_MODELS_URL;
    const body = await getJson(url, { 'x-goog-api-key': src.apiKey }, src.apiKey);
    if (!isObj(body)) break;
    for (const m of arr(body.models)) {
      if (!isObj(m) || !str(m.name)) continue;
      const id = (m.name as string).replace(/^models\//, '');
      const methods = arr(m.supportedGenerationMethods).filter((x): x is string => typeof x === 'string');
      // Google says what each model can do; fall back to the id only when it says nothing.
      const kind: AiModelKind = methods.length === 0 ? classifyModelId(id)
        : methods.some((x) => /^(embedContent|embedText|batchEmbedContents)$/.test(x)) ? 'embedding'
          : methods.includes('generateContent') && classifyModelId(id) !== 'other' ? 'chat' : 'other';
      out.push({ id, kind, ...(str(m.displayName) ? { name: str(m.displayName)! } : {}), ...(kind === 'chat' && /^gemini/i.test(id) ? { supportsImages: true } : {}) });
    }
    pageToken = str(body.nextPageToken) ?? '';
    if (!pageToken) break;
  }
  return out;
}

/** The OpenRouter / OpenAI-compatible list shape: `data` (or `models`) of objects with an id; OpenRouter adds modalities and pricing. */
function fromListBody(body: unknown, forceKind?: AiModelKind): AiModelInfo[] {
  const list = isObj(body) ? (arr(body.data).length ? arr(body.data) : arr(body.models)) : arr(body);
  return list.flatMap((m) => {
    if (!isObj(m)) return [];
    const id = str(m.id) ?? str(m.model) ?? str(m.name);
    if (!id) return [];
    const arch = isObj(m.architecture) ? m.architecture : undefined;
    const outputs = arch ? arr(arch.output_modalities).filter((x): x is string => typeof x === 'string') : [];
    const inputs = arch ? arr(arch.input_modalities).filter((x): x is string => typeof x === 'string') : [];
    const kind: AiModelKind = forceKind ?? (outputs.includes('embeddings') ? 'embedding' : outputs.length && !outputs.includes('text') ? 'other' : classifyModelId(id));
    let info: AiModelInfo = { id, kind, ...(str(m.name) && str(m.name) !== id ? { name: str(m.name)! } : {}), ...(inputs.length ? { supportsImages: inputs.includes('image') } : {}) };
    info = withPricing(info, m.pricing);
    return [info];
  });
}

async function fromOpenRouter(src: ModelSource): Promise<AiModelInfo[]> {
  const chat = fromListBody(await getJson(`${OPENROUTER_BASE_URL}/models`, bearer(src.apiKey), src.apiKey));
  // OpenRouter lists embedding models separately; if that call is unavailable the chat list still stands.
  const embeddings = await getJson(`${OPENROUTER_BASE_URL}/embeddings/models`, bearer(src.apiKey), src.apiKey).then((b) => fromListBody(b, 'embedding'), () => []);
  const byId = new Map(chat.map((m) => [m.id, m]));
  for (const e of embeddings) byId.set(e.id, e);
  return [...byId.values()];
}

async function fromCompatible(src: ModelSource): Promise<AiModelInfo[]> {
  if (!src.baseUrl) throw new ModelListError('this account has no Base URL');
  return fromListBody(await getJson(`${src.baseUrl.replace(/\/+$/, '')}/models`, bearer(src.apiKey), src.apiKey));
}

const FETCHERS: Record<AiProvider, (src: ModelSource) => Promise<AiModelInfo[]>> = {
  anthropic: fromAnthropic, openai: fromOpenAi, google: fromGoogle, openrouter: fromOpenRouter, openai_compatible: fromCompatible,
};

// ---- Cache -----------------------------------------------------------------------------------------------------------
const cache = new Map<string, { at: number; models: AiModelInfo[] }>();
export const clearModelCache = () => cache.clear();

/**
 * The provider's model list, normalised and sorted. `cacheKey` identifies the account and its current settings, so
 * editing the account (a new key, another Base URL) starts a fresh list; `refresh` skips the cache.
 */
export async function listProviderModels(src: ModelSource, opts: { cacheKey?: string; refresh?: boolean } = {}): Promise<ModelListResult> {
  const hit = opts.cacheKey && !opts.refresh ? cache.get(opts.cacheKey) : undefined;
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return { models: hit.models, fetchedAt: new Date(hit.at).toISOString(), cached: true };
  const fetched = await FETCHERS[src.provider](src);
  const seen = new Set<string>();
  const models = fetched.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).sort((a, b) => a.id.localeCompare(b.id));
  const at = Date.now();
  if (opts.cacheKey) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(opts.cacheKey, { at, models });
  }
  return { models, fetchedAt: new Date(at).toISOString(), cached: false };
}
