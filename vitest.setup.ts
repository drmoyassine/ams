// jsdom 30 under vitest 2 leaves window.localStorage undefined, so the browser-hint reads and writes (the
// language hint, the glossary's Terms choice) would die or silently lose their value. Install an in-memory
// stand-in only where Storage is missing — node-environment tests never reach past the guard.
if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
}
