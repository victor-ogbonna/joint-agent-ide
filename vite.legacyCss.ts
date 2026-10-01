/**
 * A second stylesheet for older browsers: Chrome before 104 (which is what
 * old Windows 7 and 8 laptops are stuck on, at 109 at most, and older still
 * where updates stopped), Safari before 15.4, Firefox before 97.
 *
 * Tailwind 4 writes CSS for current browsers only:
 *   - every style sits in a cascade layer (@layer), which Chrome supports
 *     from 99: before that the browser drops it all, and the page shows
 *     unstyled, its sign-in box somewhere off at the bottom;
 *   - moving, scaling and turning things uses the translate, scale and
 *     rotate properties (Chrome 104), which centring relies on;
 *   - its palette is in oklch() colours (Chrome 111), so red, green and
 *     orange text shows plain before that;
 *   - :where() and :is() (Chrome 88) in many selectors;
 *   - spacing as padding-inline, margin-inline and inset (Chrome 87).
 *
 * toLegacyCss rewrites the built stylesheet without those, keeping what it
 * means. The page loads it only where the browser lacks layers or those
 * transform properties or those colours (legacyCssSwitch, in index.html),
 * so current browsers get exactly the stylesheet they always had.
 */
import type { Plugin } from "vite";
import postcss, { type AtRule, type Root, type Rule } from "postcss";
import cascadeLayers from "@csstools/postcss-cascade-layers";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import { transform as lightningTransform } from "lightningcss";

/** The oldest browsers the legacy stylesheet is written for. */
const LEGACY_TARGETS = { chrome: 80 << 16, firefox: 78 << 16, safari: (13 << 16) | (1 << 8), edge: 80 << 16 };

/** Custom properties that carry the transform pieces in the legacy stylesheet. */
const PARTS = { translate: "--tw-legacy-translate", rotate: "--tw-legacy-rotate", scale: "--tw-legacy-scale" } as const;
// Each piece falls back to doing nothing. (Not an empty fallback, "var(--x,)":
// older Chrome rejects the whole value over it.)
const COMPOSITE = `var(${PARTS.translate}, translate(0, 0)) var(${PARTS.rotate}, rotate(0deg)) var(${PARTS.scale}, scale(1, 1))`;

/** Splits a property value at its top-level spaces: "var(--a) var(--b)" -> ["var(--a)", "var(--b)"]. */
function topLevelParts(value: string): string[] {
  const parsed = valueParser(value);
  return parsed.nodes.filter((n) => n.type !== "space").map((n) => valueParser.stringify(n));
}

/** translate/scale/rotate property values as transform functions. */
export function asTransformFunction(prop: "translate" | "scale" | "rotate", value: string): string | null {
  const v = value.trim();
  if (!v || /^(none|initial|inherit|unset|revert)$/i.test(v)) return null;
  const parts = topLevelParts(v);
  if (prop === "rotate") {
    // "45deg", or "x 45deg" / "0 0 1 45deg" (an axis, then the angle).
    if (parts.length === 1) return `rotate(${parts[0]})`;
    if (parts.length === 2 && /^[xyz]$/i.test(parts[0])) return `rotate${parts[0].toUpperCase()}(${parts[1]})`;
    if (parts.length === 4) return `rotate3d(${parts.join(", ")})`;
    return null;
  }
  if (prop === "translate") {
    if (parts.length === 1) return `translate(${parts[0]})`;
    if (parts.length === 2) return `translate(${parts[0]}, ${parts[1]})`;
    if (parts.length === 3) return `translate3d(${parts.join(", ")})`;
    return null;
  }
  if (parts.length === 1) return `scale(${parts[0]})`;
  if (parts.length === 2) return `scale(${parts[0]}, ${parts[1]})`;
  if (parts.length === 3) return `scale3d(${parts.join(", ")})`;
  return null;
}

/** "110%" -> "1.1": older browsers take numbers in scale(), not percentages. */
function percentToNumber(value: string): string {
  return value.replace(/(-?\d*\.?\d+)%/g, (_m, n) => String(Math.round((parseFloat(n) / 100) * 10000) / 10000));
}

function insideKeyframes(node: postcss.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && /keyframes$/i.test((p as AtRule).name)) return true;
  }
  return false;
}

/**
 * translate/scale/rotate become one transform. Each utility sets its own
 * piece, so an element with two of them (moved and scaled) gets both.
 */
function individualTransforms(root: Root) {
  root.walkDecls(/^--tw-scale-[xyz]$/, (decl) => {
    decl.value = percentToNumber(decl.value);
  });
  root.walkRules((rule: Rule) => {
    let touched = false;
    rule.each((node) => {
      if (node.type !== "decl") return;
      const prop = node.prop.toLowerCase();
      if (prop !== "translate" && prop !== "scale" && prop !== "rotate") return;
      const fn = asTransformFunction(prop, prop === "scale" ? percentToNumber(node.value) : node.value);
      if (insideKeyframes(rule)) {
        if (fn) node.cloneBefore({ prop: "transform", value: fn });
        node.remove();
        return;
      }
      node.cloneBefore({ prop: PARTS[prop], value: fn ?? "initial" });
      node.remove();
      touched = true;
    });
    if (touched) rule.append({ prop: "transform", value: COMPOSITE });
  });
  // The pieces are custom properties, which are inherited: reset them on
  // every element, so a child doesn't pick up its parent's.
  root.prepend(postcss.rule({
    selector: "*, ::before, ::after",
    nodes: Object.values(PARTS).map((p) => postcss.decl({ prop: p, value: "initial" })),
  }));
}

/**
 * Tailwind gives browsers without @property their defaults inside an
 * @supports that only matches old Safari and Firefox. Older Chrome needs
 * them as much, so the condition is dropped.
 */
function unwrapPropertyDefaults(root: Root) {
  root.walkAtRules("supports", (at) => {
    if (/-webkit-hyphens\s*:\s*none/.test(at.params) && /margin-trim/.test(at.params)) {
      at.replaceWith(at.nodes ?? []);
    }
  });
}

/**
 * The logical spacing shorthands written out as left/right/top/bottom (the
 * site reads left to right): padding-inline: 1rem -> padding-left: 1rem;
 * padding-right: 1rem.
 */
const LOGICAL: Record<string, (v: string[]) => [string, string][] | null> = {
  "padding-inline": (v) => pair("padding-left", "padding-right", v),
  "padding-block": (v) => pair("padding-top", "padding-bottom", v),
  "margin-inline": (v) => pair("margin-left", "margin-right", v),
  "margin-block": (v) => pair("margin-top", "margin-bottom", v),
  "inset-inline": (v) => pair("left", "right", v),
  "inset-block": (v) => pair("top", "bottom", v),
  "inset-inline-start": (v) => (v.length === 1 ? [["left", v[0]]] : null),
  "inset-inline-end": (v) => (v.length === 1 ? [["right", v[0]]] : null),
  "inset": (v) => {
    if (v.length < 1 || v.length > 4) return null;
    const [t, r = t, b = t, l = r] = v;
    return [["top", t], ["right", r], ["bottom", b], ["left", l]];
  },
};

function pair(first: string, second: string, v: string[]): [string, string][] | null {
  if (v.length === 1) return [[first, v[0]], [second, v[0]]];
  if (v.length === 2) return [[first, v[0]], [second, v[1]]];
  return null;
}

function lowerLogical(root: Root) {
  root.walkDecls((decl) => {
    const lower = LOGICAL[decl.prop.toLowerCase()];
    if (!lower) return;
    const physical = lower(topLevelParts(decl.value));
    if (!physical) return;
    for (const [prop, value] of physical) decl.cloneBefore({ prop, value });
    decl.remove();
  });
}

/** Most selectors one :where()/:is() may expand into before it's left as it is. */
const MAX_EXPANSION = 64;

/** :where(a, b) and :is(a, b) written out as plain selectors. */
export function expandWhereIs(selector: string): string {
  if (!/:(where|is)\(/i.test(selector)) return selector;
  let out: string[] = [];
  try {
    const ast = selectorParser().astSync(selector);
    const results: string[] = [];
    for (const sel of ast.nodes) {
      let variants = [sel.toString()];
      for (let guard = 0; guard < 8; guard++) {
        const next: string[] = [];
        let changed = false;
        for (const v of variants) {
          const vAst = selectorParser().astSync(v);
          let target: any = null;
          vAst.walkPseudos((p) => {
            if (!target && /^:(where|is)$/i.test(p.value) && p.nodes.length) target = p;
          });
          if (!target) {
            next.push(v);
            continue;
          }
          changed = true;
          for (const alternative of target.nodes) {
            const clone = selectorParser().astSync(v);
            let replaced = false;
            clone.walkPseudos((p) => {
              if (replaced || !/^:(where|is)$/i.test(p.value) || !p.nodes.length) return;
              replaced = true;
              const inner = selectorParser().astSync(alternative.toString().trim());
              p.replaceWith(...(inner.nodes[0].nodes as any[]));
            });
            next.push(clone.toString());
          }
        }
        variants = next;
        if (!changed || variants.length > MAX_EXPANSION) break;
      }
      if (variants.length > MAX_EXPANSION) return selector;
      results.push(...variants);
    }
    out = results;
  } catch {
    return selector;
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))].join(",");
}

function expandSelectors(root: Root) {
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    rule.selector = expandWhereIs(rule.selector);
  });
}

/** The built stylesheet, rewritten for older browsers (see the top of this file). */
export function toLegacyCss(css: string): string {
  const lowered = lightningTransform({
    filename: "legacy.css",
    code: Buffer.from(css),
    targets: LEGACY_TARGETS,
    minify: true,
    errorRecovery: true,
  }).code.toString();
  const root = postcss.parse(lowered);
  unwrapPropertyDefaults(root);
  const flattened = postcss([cascadeLayers()]).process(root, { from: undefined }).root;
  individualTransforms(flattened);
  lowerLogical(flattened);
  expandSelectors(flattened);
  return flattened.toString();
}

/**
 * Runs first in <head>: where the browser lacks cascade layers, the
 * translate property or oklch() colours, each stylesheet the build made is
 * swapped for its legacy copy before it's used. Plain ES5, so the oldest
 * browsers run it.
 */
export function legacyCssSwitch(): string {
  return `<script>(function(){try{var d=document,s=d.createElement("style");s.textContent="@layer jalegacy{:root{--ja-layer-probe:1}}";d.head.appendChild(s);var layers=getComputedStyle(d.documentElement).getPropertyValue("--ja-layer-probe").trim()==="1";s.parentNode.removeChild(s);var css=window.CSS&&CSS.supports;var moves=!!(css&&CSS.supports("translate","1px"));var colors=!!(css&&CSS.supports("color","oklch(0% 0 0)"));if(layers&&moves&&colors)return;var links=d.querySelectorAll('link[rel="stylesheet"][data-legacy]');for(var i=0;i<links.length;i++){links[i].href=links[i].getAttribute("data-legacy");}d.documentElement.className+=" legacy-css";}catch(e){}})();</script>`;
}

/** The Vite plugin: writes NAME-legacy.css next to each built stylesheet and adds the switch to the page. */
export function legacyCss(): Plugin {
  return {
    name: "joint-agent-legacy-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const legacyFor = new Map<string, string>();
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "asset" || !fileName.endsWith(".css")) continue;
        const source = typeof chunk.source === "string" ? chunk.source : Buffer.from(chunk.source).toString("utf8");
        const legacyName = fileName.replace(/\.css$/, "-legacy.css");
        this.emitFile({ type: "asset", fileName: legacyName, source: toLegacyCss(source) });
        legacyFor.set(fileName, legacyName);
      }
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "asset" || !chunk.fileName.endsWith(".html")) continue;
        let html = typeof chunk.source === "string" ? chunk.source : Buffer.from(chunk.source).toString("utf8");
        let marked = false;
        html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (tag) => {
          const href = /href="\/?([^"]+)"/.exec(tag)?.[1];
          const legacy = href ? legacyFor.get(href) : undefined;
          if (!legacy) return tag;
          marked = true;
          return tag.replace(/\s*\/?>$/, ` data-legacy="/${legacy}">`);
        });
        if (marked) {
          // Straight after the stylesheet links, before anything renders.
          const lastLink = html.lastIndexOf("data-legacy=");
          const end = html.indexOf(">", lastLink) + 1;
          html = html.slice(0, end) + legacyCssSwitch() + html.slice(end);
        }
        chunk.source = html;
      }
    },
  };
}
