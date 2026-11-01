/**
 * ES2023 array methods for older Android web views.
 *
 * The editor (BlockNote) calls `toReversed`; the build does not rewrite library
 * code, so on a web view older than Chrome 110 tapping a link in a page threw
 * "toReversed is not a function". Only added where missing; behaviour as in the
 * specification (copies, never mutating the original).
 */
type Arr<T> = T[] & Record<string, unknown>;
const proto = Array.prototype as unknown as Record<string, unknown>;

function define(name: string, fn: (...args: never[]) => unknown) {
  if (typeof proto[name] !== "function") {
    Object.defineProperty(Array.prototype, name, { value: fn, writable: true, configurable: true });
  }
}

define("toReversed", function <T>(this: Arr<T>) {
  return Array.prototype.slice.call(this).reverse();
});
define("toSorted", function <T>(this: Arr<T>, compare?: (a: T, b: T) => number) {
  return Array.prototype.slice.call(this).sort(compare);
});
define("toSpliced", function <T>(this: Arr<T>, start: number, deleteCount?: number, ...items: T[]) {
  const copy = Array.prototype.slice.call(this) as T[];
  if (arguments.length === 1) copy.splice(start);
  else copy.splice(start, deleteCount ?? 0, ...items);
  return copy;
});
define("with", function <T>(this: Arr<T>, index: number, value: T) {
  const len = this.length;
  const i = Math.trunc(index) + (index < 0 ? len : 0);
  if (i < 0 || i >= len) throw new RangeError("Invalid index");
  const copy = Array.prototype.slice.call(this) as T[];
  copy[i] = value;
  return copy;
});
define("findLast", function <T>(this: Arr<T>, pred: (v: T, i: number, a: T[]) => unknown) {
  for (let i = this.length - 1; i >= 0; i--) if (pred(this[i], i, this)) return this[i];
  return undefined;
});
define("findLastIndex", function <T>(this: Arr<T>, pred: (v: T, i: number, a: T[]) => unknown) {
  for (let i = this.length - 1; i >= 0; i--) if (pred(this[i], i, this)) return i;
  return -1;
});

export {};
