// Browser-safe (no Node imports): used by services that also run in the in-browser demo.

/**
 * A Map that remembers which keys changed since the last save. Big, per-user
 * collections (chat transcripts, saved strategies) use it so each save writes
 * only the rows that changed instead of re-serialising everything.
 * Mutating a value in place doesn't mark it: call `touch(key)` (or `set` again).
 */
export class DirtyMap<V> extends Map<string, V> {
  private changed?: Set<string>;
  override set(k: string, v: V) {
    (this.changed ??= new Set()).add(k);
    return super.set(k, v);
  }
  override delete(k: string) {
    (this.changed ??= new Set()).add(k);
    return super.delete(k);
  }
  override clear() {
    for (const k of this.keys()) (this.changed ??= new Set()).add(k);
    super.clear();
  }
  touch(k: string) {
    (this.changed ??= new Set()).add(k);
  }
  /** Keys changed since the last call (and forget them). */
  drain(): string[] {
    const out = [...(this.changed ?? [])];
    this.changed?.clear();
    return out;
  }
  /** Load without marking dirty (boot). */
  load(k: string, v: V) {
    super.set(k, v);
    this.changed?.delete(k);
  }
}

/** One changed row of a keyed collection; `data: null` deletes it. */
export type Row = { ns: string; key: string; data: string | null };
