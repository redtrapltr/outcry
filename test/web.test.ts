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
