/**
 * The stylesheet for older browsers (vite.legacyCss.ts): what it rewrites,
 * and how the page picks it. Checked in real old Chromium (86, 91) while it
 * was written; this keeps the rewriting itself from drifting.
 */
import { toLegacyCss, expandWhereIs, asTransformFunction, legacyCssSwitch, legacyCss } from "../vite.legacyCss.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

console.log("Selectors");
check(expandWhereIs(".a:where(.b,.c) .d") === ".a.b .d,.a.c .d", ":where(a, b) written out as two selectors");
check(expandWhereIs(":where(.space-x-2>:not(:last-child))") === ".space-x-2>:not(:last-child)", "a :where() around a whole selector");
check(expandWhereIs(".x:is(.y,.z)") === ".x.y,.x.z", ":is() too");
check(expandWhereIs(".escaped\\:where\\(x\\)") === ".escaped\\:where\\(x\\)" && expandWhereIs(".plain") === ".plain", "escaped class names and plain selectors are left alone");

console.log("Transforms");
check(asTransformFunction("translate", "var(--x) var(--y)") === "translate(var(--x), var(--y))", "translate: x y");
check(asTransformFunction("scale", "1.1 1.1") === "scale(1.1, 1.1)" && asTransformFunction("rotate", "180deg") === "rotate(180deg)", "scale and rotate");
check(asTransformFunction("rotate", "none") === null, "none is no transform");

console.log("A Tailwind-shaped stylesheet");
const css = `@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after{--tw-translate-x:0;--tw-translate-y:0;--tw-scale-x:1;--tw-scale-y:1}}}
@layer theme{:root{--color-red-500:oklch(63.7% .237 25.331);--spacing:.25rem}}
@layer base{*,:after,:before{box-sizing:border-box;margin:0}:where(button){color:inherit}}
@layer utilities{.text-red-500{color:var(--color-red-500)}.px-3{padding-inline:calc(var(--spacing)*3)}.inset-0{inset:calc(var(--spacing)*0)}.mx-auto{margin-inline:auto}.-translate-y-1\\/2{--tw-translate-y:-50%;translate:var(--tw-translate-x) var(--tw-translate-y)}.scale-110{--tw-scale-x:110%;--tw-scale-y:110%;scale:var(--tw-scale-x) var(--tw-scale-y)}.rotate-180{rotate:180deg}}
.mine{color:#123}
@keyframes spin{to{rotate:360deg}}`;
const out = toLegacyCss(css);
check(!/@layer/.test(out), "no cascade layers left (Chrome before 99 drops them)");
check(/:not\(#\\#\)/.test(out), "their order kept by specificity instead");
check(/--color-red-500:#fb2c36/.test(out), "oklch() colours have a plain fallback (Chrome before 111)");
check(!/(^|[;{])(translate|scale|rotate):/.test(out.replace(/@keyframes[^}]*}[^}]*}/g, "")), "no translate/scale/rotate properties (Chrome before 104)");
check(/--tw-legacy-translate:translate\(var\(--tw-translate-x\), var\(--tw-translate-y\)\)/.test(out) && /transform:var\(--tw-legacy-translate, translate\(0, 0\)\)/.test(out),
  "a transform built from each piece, never an empty fallback");
check(/--tw-scale-x:1\.1/.test(out), "scale percentages as numbers");
check(/@keyframes spin\{to\{transform:rotate\(360deg\)\}\}/.test(out), "keyframes turn straight into transforms");
check(!/(padding|margin)-inline:|(^|[;{])inset:/.test(out) && /padding-left:calc\(var\(--spacing\)\*3\)/.test(out) && /margin-(left|inline-start):auto/.test(out) && /top:calc\(var\(--spacing\)\*0\)/.test(out),
  "the padding-inline, margin-inline and inset shorthands written out (Chrome before 87)");
check(!/-webkit-hyphens/.test(out) && /--tw-translate-x:0/.test(out), "Tailwind's defaults apply to every older browser, not only old Safari");
check(!/:where\(/.test(out) && /button:not\(#\\#\)/.test(out), "no :where() (Chrome before 88)");
check(/\.mine:not\(#\\#\)[^{]*\{color:#123\}/.test(out), "the site's own CSS still wins over Tailwind's");

console.log("Choosing it on the page");
const sw = legacyCssSwitch();
check(sw.includes("@layer") && sw.includes('CSS.supports("translate","1px")') && sw.includes('CSS.supports("color","oklch(0% 0 0)")'), "it checks for layers, the translate property and oklch()");
check(!/=>|\blet\b|\bconst\b|`/.test(sw), "in plain ES5, so the oldest browsers run it");

const plugin = legacyCss();
const emitted = [];
const bundle = {
  "assets/index-abc.css": { type: "asset", fileName: "assets/index-abc.css", source: css },
  "index.html": { type: "asset", fileName: "index.html", source: '<head><link rel="stylesheet" href="https://cdn.example/katex.css" /><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head>' },
};
plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) }, {}, bundle);
const html = bundle["index.html"].source;
check(emitted.length === 1 && emitted[0].fileName === "assets/index-abc-legacy.css" && emitted[0].source === toLegacyCss(css), "the build writes NAME-legacy.css beside the stylesheet");
check(html.includes('href="/assets/index-abc.css" data-legacy="/assets/index-abc-legacy.css">') && !html.includes('katex.css" data-legacy'), "the page's own stylesheet link is marked, other links aren't");
check(html.indexOf("<script>") > html.indexOf("data-legacy"), "the switch runs straight after it");

console.log(bad ? `\n${bad} check(s) failed.` : "\nAll legacy stylesheet checks passed.");
process.exit(bad ? 1 : 0);
