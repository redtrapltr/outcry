/**
 * Invite-only access: the app (terminal + its API) is locked behind an access
 * password. Set OUTCRY_ACCESS_PASSWORD for one shared password, or
 * OUTCRY_ACCESS_CODES="code-for-anna,code-for-ben" to give each person their own
 * (remove one to lock that person out). Unset = open to everyone.
 *
 * Entering a code sets a signed, HttpOnly cookie for 180 days. The cookie is
 * tied to the code it was issued for, so changing or removing a code locks out
 * everyone who used it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GATE_COOKIE = "outcry_gate";
const MAX_AGE_S = 180 * 86_400;

/** Paths anyone can open without the password. */
const PUBLIC_PATHS = new Set(["/", "/index.html", "/gate.html", "/creator.html", "/recap.html", "/api/gate", "/api/health", "/api/status"]);
const PUBLIC_PREFIXES = ["/api/creators/", "/api/recap/"];
/** Static assets (scripts, styles, images, fonts) carry no user data. */
const ASSET = /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|webmanifest|map)$/i;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class AccessGate {
  private codes: { code: string; id: string; key: string }[];
  private tries = new Map<string, { window: number; n: number }>();

  constructor(codes: string[], salt = "") {
    this.codes = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].map((code) => ({
      code,
      id: sha(`id:${code}`).slice(0, 16),
      key: sha(`outcry-gate:${salt}:${code}`),
    }));
    if (!this.codes.length) throw new Error("AccessGate needs at least one code");
  }

  static fromEnv(env: Record<string, string | undefined> = process.env) {
    const list = [env.OUTCRY_ACCESS_PASSWORD ?? "", ...(env.OUTCRY_ACCESS_CODES ?? "").split(",")].map((s) => s.trim()).filter(Boolean);
    return list.length ? new AccessGate(list, env.OUTCRY_GATE_SECRET ?? "") : undefined;
  }

  get size() {
    return this.codes.length;
  }

  isPublic(path: string) {
    return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p)) || ASSET.test(path);
  }

  private sign(c: { id: string; key: string }) {
    return `${c.id}.${createHmac("sha256", c.key).update(c.id).digest("base64url")}`;
  }

  /** Does this Cookie header carry a valid pass? */
  allows(cookieHeader: string | undefined) {
    const v = parseCookie(cookieHeader)[GATE_COOKIE];
    if (!v) return false;
    const c = this.codes.find((x) => v.startsWith(`${x.id}.`));
    if (!c) return false;
    const want = Buffer.from(this.sign(c));
    const got = Buffer.from(v);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** 10 tries per 15 minutes per address. */
  limited(ip: string, now = Date.now()) {
    const w = Math.floor(now / 900_000);
    const e = this.tries.get(ip);
    const n = e && e.window === w ? e.n + 1 : 1;
    this.tries.set(ip, { window: w, n });
    if (this.tries.size > 10_000) for (const [k, x] of this.tries) if (x.window !== w) this.tries.delete(k);
    return n > 10;
  }

  /** A Set-Cookie value when the code is right, else null. */
  enter(code: string, secure: boolean) {
    const given = sha(`id:${code.trim()}`).slice(0, 16);
    const c = this.codes.find((x) => timingSafeEqual(Buffer.from(x.id), Buffer.from(given)) && x.code === code.trim());
    if (!c) return null;
    return `${GATE_COOKIE}=${this.sign(c)}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }
}

export function parseCookie(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
