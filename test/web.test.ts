import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/** Every inline <script> in the web pages must at least parse: one stray quote takes the whole terminal down. */
describe("web pages", () => {
  for (const page of ["terminal.html", "recap.html", "creator.html", "index.html"]) {
    it(`${page}: inline scripts parse`, () => {
      const html = readFileSync(new URL(`../web/${page}`, import.meta.url), "utf8");
      const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      for (const code of scripts) expect(() => new vm.Script(code.replace(/\bimport\(/g, "__import("))).not.toThrow();
    });
  }
});

describe("browser bundles", () => {
  // Render runs `npm run build:web`; server-only imports (fs, pg) in shared code break it and stop every deploy.
  it("the in-browser demo bundles for the browser", async () => {
    const { build } = await import("esbuild");
    const r = await build({ entryPoints: ["src/browser/entry.ts", "src/browser/qr.ts"], bundle: true, platform: "browser", format: "esm", target: "es2020", write: false, outdir: "out", logLevel: "silent" });
    expect(r.errors).toHaveLength(0);
  }, 60_000);
});
