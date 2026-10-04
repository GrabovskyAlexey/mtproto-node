type Status = { state: 'disabled' | 'connected' | 'disconnected' | 'stopped' | 'unknown'; checkedAt: string | null; latencyMs?: number };
type Dependencies = {
  inspect: (name: string) => Promise<{ running: boolean; identity: string }>;
  probe: (name: string) => Promise<number | void>;
  now?: () => number;
};

function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Status check timed out')), 5000);
  })]).finally(() => clearTimeout(timer));
}

export function createVpnStatusChecker({ inspect, probe, now = Date.now }: Dependencies) {
  const cache = new Map<string, { identity: string; expires: number; status: Status }>();
  const pending = new Map<string, Promise<Status>>();
  async function perform(name: string): Promise<Status> {
    let container;
    try { container = await bounded(inspect(name)); }
    catch { return { state: 'unknown', checkedAt: new Date(now()).toISOString() }; }
    const checkedAt = new Date(now()).toISOString();
    if (!container.running) { cache.delete(name); return { state: 'stopped', checkedAt }; }
    const cached = cache.get(name);
    if (cached && cached.identity === container.identity && cached.expires > now()) return { ...cached.status };
    let status: Status;
    const started = now();
    try {
      const latency = await bounded(probe(name));
      status = { state: 'connected', checkedAt, latencyMs: typeof latency === 'number' ? latency : Math.max(0, now() - started) };
    } catch { status = { state: 'disconnected', checkedAt }; }
    for (const [key, entry] of cache) if (entry.expires <= now()) cache.delete(key);
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(name, { identity: container.identity, expires: now() + 30000, status });
    return { ...status };
  }
  return { async check(name?: string, configured = false): Promise<Status> {
    if (!configured) return { state: 'disabled', checkedAt: null };
    if (!name) return { state: 'unknown', checkedAt: null };
    const existing = pending.get(name);
    if (existing) return { ...await existing };
    if (pending.size >= 100) return { state: 'unknown', checkedAt: null };
    const operation = perform(name).finally(() => pending.delete(name));
    pending.set(name, operation);
    return operation;
  } };
}
