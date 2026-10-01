/**
 * Stand-ins for a few newer browser functions that the app's libraries call,
 * for older browsers that lack them: old Windows 7 and 8 laptops, for one,
 * can't run Chrome past 109. Each is added only where it's missing, so a
 * current browser runs its own. Imported first, before anything else runs
 * (src/main.tsx).
 *
 *   Object.hasOwn      Chrome 93
 *   Array/String .at   Chrome 92
 *   structuredClone    Chrome 98
 */
function define(target: object, name: string, value: unknown) {
  if (name in target) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

define(Object, "hasOwn", function hasOwn(object: unknown, key: PropertyKey): boolean {
  if (object === null || object === undefined) throw new TypeError("Cannot convert undefined or null to object");
  return Object.prototype.hasOwnProperty.call(Object(object), key);
});

function at(this: ArrayLike<unknown>, index: number) {
  const length = this.length >>> 0;
  let i = Math.trunc(Number(index)) || 0;
  if (i < 0) i += length;
  if (i < 0 || i >= length) return undefined;
  return this[i];
}
define(Array.prototype, "at", at);
define(String.prototype, "at", function (this: string, index: number) {
  return at.call(String(this), index);
});
const TypedArray = Object.getPrototypeOf(Int8Array.prototype);
if (TypedArray) define(TypedArray, "at", at);

function cloneError(message: string): Error {
  try {
    return new DOMException(message, "DataCloneError");
  } catch {
    return new TypeError(message);
  }
}

function deepClone(value: any, seen: Map<any, any>): any {
  if (typeof value === "function" || typeof value === "symbol") throw cloneError(`${String(value)} could not be cloned.`);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  let copy: any;
  if (value instanceof Date) copy = new Date(value.getTime());
  else if (value instanceof RegExp) copy = new RegExp(value.source, value.flags);
  else if (value instanceof ArrayBuffer) copy = value.slice(0);
  else if (value instanceof DataView) copy = new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
  else if (ArrayBuffer.isView(value)) copy = new (value.constructor as any)(value);
  else if (typeof Blob !== "undefined" && value instanceof Blob) copy = value;
  else if (value instanceof Map) {
    copy = new Map();
    seen.set(value, copy);
    value.forEach((v, k) => copy.set(deepClone(k, seen), deepClone(v, seen)));
    return copy;
  } else if (value instanceof Set) {
    copy = new Set();
    seen.set(value, copy);
    value.forEach((v) => copy.add(deepClone(v, seen)));
    return copy;
  } else if (value instanceof Error) {
    const Ctor: any = [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].find((E) => value instanceof E) || Error;
    copy = new Ctor(value.message);
    copy.name = value.name;
    if (value.stack) copy.stack = value.stack;
    seen.set(value, copy);
    if ("cause" in value) copy.cause = deepClone((value as any).cause, seen);
    return copy;
  } else if (Array.isArray(value)) {
    copy = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) if (i in value) copy[i] = deepClone(value[i], seen);
    return copy;
  } else {
    copy = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) copy[key] = deepClone(value[key], seen);
    return copy;
  }
  seen.set(value, copy);
  return copy;
}

if (typeof (globalThis as any).structuredClone !== "function") {
  define(globalThis, "structuredClone", function structuredClone(value: unknown) {
    return deepClone(value, new Map());
  });
}

export {};
