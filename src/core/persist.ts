/**
 * Persistence: the services keep their state in memory for speed, and this
 * module snapshots it to a store and restores it on boot, so deploys and
 * restarts no longer wipe users, agents, tickets or history.
 *
 * Stores:
 * - PostgresStore (DATABASE_URL): one JSONB snapshot row + an append-only audit table.
 * - FileStore (OUTCRY_STATE_FILE): a JSON file, for local development.
 */
import type { AuditEntry } from "./infra.js";

// ---------------------------------------------------------------------------
// Encoding (Maps and Sets survive JSON)
// ---------------------------------------------------------------------------

export function encode(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x instanceof Map) return { __map: [...x.entries()] };
    if (x instanceof Set) return { __set: [...x.values()] };
    return x;
  });
}

export function decode<T = unknown>(s: string): T {
  return JSON.parse(s, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      if ("__map" in x) return new Map(x.__map);
      if ("__set" in x) return new Set(x.__set);
    }
    return x;
  }) as T;
}

// ---------------------------------------------------------------------------
// Which fields of which services hold state
// ---------------------------------------------------------------------------

type Holder = { obj: object; fields: string[] };

/** Snapshot the listed fields of each holder (private fields included). */
export function snapshot(holders: Record<string, Holder>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, h] of Object.entries(holders)) {
    out[name] = {};
    for (const f of h.fields) out[name]![f] = (h.obj as Record<string, unknown>)[f];
  }
  return out;
}

/** Restore fields in place. Maps are refilled (not replaced) so readonly references stay valid. */
export function restore(holders: Record<string, Holder>, data: Record<string, Record<string, unknown>>) {
  for (const [name, h] of Object.entries(holders)) {
    const saved = data[name];
    if (!saved) continue;
    const o = h.obj as Record<string, unknown>;
    for (const f of h.fields) {
      if (!(f in saved)) continue;
      const cur = o[f];
      const val = saved[f];
      if (cur instanceof Map && val instanceof Map) {
        cur.clear();
        for (const [k, v] of val) cur.set(k, v);
      } else if (Array.isArray(cur) && Array.isArray(val)) {
        cur.splice(0, cur.length, ...val);
      } else {
        o[f] = val;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export interface StateStore {
  readonly kind: string;
  load(): Promise<{ state?: string; audit: AuditEntry[] }>;
  save(state: string, newAudit: AuditEntry[]): Promise<void>;
  close?(): Promise<void>;
}

export class FileStore implements StateStore {
  readonly kind = "file";
  constructor(private path: string) {}
  async load() {
    const fs = await import("node:fs/promises");
    try {
      const raw = JSON.parse(await fs.readFile(this.path, "utf8")) as { state: string; audit: AuditEntry[] };
      return { state: raw.state, audit: raw.audit ?? [] };
    } catch {
      return { audit: [] };
    }
  }
  private audit: AuditEntry[] | undefined;
  async save(state: string, newAudit: AuditEntry[]) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    this.audit ??= (await this.load()).audit;
    this.audit.push(...newAudit);
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ state, audit: this.audit }));
    await fs.rename(tmp, this.path);
  }
}

interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export class PostgresStore implements StateStore {
  readonly kind = "postgres";
  private ready: Promise<void>;
  constructor(private pool: PgLike) {
    this.ready = this.migrate();
  }

  static async connect(url: string): Promise<PostgresStore> {
    const pg = await import("pg");
    const Pool = (pg.default ?? pg).Pool;
    // Render's internal URL (host without dots, e.g. dpg-xxx-a) needs no TLS; external hosts do.
    const host = new URL(url).hostname;
    const local = !host.includes(".") || host === "localhost" || host.startsWith("127.");
    const pool = new Pool({ connectionString: url, max: 3, ssl: local ? undefined : { rejectUnauthorized: false } });
    return new PostgresStore(pool as unknown as PgLike);
  }

  private async migrate() {
    await this.pool.query(`create table if not exists outcry_state (id text primary key, data text not null, updated_at timestamptz not null default now())`);
    await this.pool.query(`create table if not exists outcry_audit (seq integer primary key, entry text not null)`);
  }

  async load() {
    await this.ready;
    const s = await this.pool.query(`select data from outcry_state where id = 'main'`);
    const a = await this.pool.query(`select entry from outcry_audit order by seq`);
    // Entries are stored as exact text: jsonb would reorder keys and break the hash chain.
    return { state: s.rows[0]?.data as string | undefined, audit: a.rows.map((r) => (typeof r.entry === "string" ? JSON.parse(r.entry) : r.entry) as AuditEntry) };
  }

  async save(state: string, newAudit: AuditEntry[]) {
    await this.ready;
    await this.pool.query("begin");
    try {
      await this.pool.query(
        `insert into outcry_state (id, data, updated_at) values ('main', $1, now()) on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [state],
      );
      for (let i = 0; i < newAudit.length; i += 200) {
        const chunk = newAudit.slice(i, i + 200);
        const params: unknown[] = [];
        const values = chunk.map((e, j) => {
          params.push(e.seq, JSON.stringify(e));
          return `($${j * 2 + 1}, $${j * 2 + 2})`;
        });
        await this.pool.query(`insert into outcry_audit (seq, entry) values ${values.join(",")} on conflict (seq) do nothing`, params);
      }
      await this.pool.query("commit");
    } catch (e) {
      await this.pool.query("rollback").catch(() => {});
      throw e;
    }
  }

  async close() {
    await this.pool.end();
  }
}

export async function storeFromEnv(env: Record<string, string | undefined> = process.env): Promise<StateStore | undefined> {
  if (env.DATABASE_URL) return PostgresStore.connect(env.DATABASE_URL);
  if (env.OUTCRY_STATE_FILE) return new FileStore(env.OUTCRY_STATE_FILE);
  return undefined;
}
