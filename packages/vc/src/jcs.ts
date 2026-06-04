/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * The `*-jcs-*` Data Integrity cryptosuites canonicalize a credential and its
 * proof configuration with JCS — not RDF Dataset Canonicalization — so the proof
 * pipeline needs no JSON-LD expansion or URDNA2015 implementation. That keeps
 * the package within the Worker script-size budget (no `jsonld.js`/Comunica) and
 * makes proof construction a pure, plain-data transform that unit-tests without a
 * Workers runtime.
 *
 * JCS ordering and escaping line up with the ECMAScript primitives this uses:
 * object members are sorted by the UTF-16 code units of their keys (the default
 * `Array.prototype.sort` order), and string escaping matches `JSON.stringify`.
 * Number serialization uses the ECMAScript `Number`-to-string algorithm
 * (`String(n)`); credentials carry small integers and simple decimals, well
 * within where that agrees with RFC 8785.
 *
 * @see https://www.rfc-editor.org/rfc/rfc8785
 */

/** A JSON value accepted by {@link canonicalize}. */
export type JcsValue =
  | null
  | boolean
  | number
  | string
  | JcsValue[]
  | { [key: string]: JcsValue | undefined };

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("@dwk/vc: cannot canonicalize a non-finite number");
  }
  // String(-0) === "0", matching JCS's requirement that -0 serialize as "0".
  return String(value);
}

function serialize(value: JcsValue): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return serializeNumber(value as number);
  if (type === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    // Mirror JSON.stringify: an `undefined` element serializes as `null`.
    const items = value.map((item) =>
      item === undefined ? "null" : serialize(item),
    );
    return `[${items.join(",")}]`;
  }

  if (type === "object") {
    const obj = value as { [key: string]: JcsValue | undefined };
    // Drop members whose value is `undefined`, then sort by UTF-16 code unit.
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const members = keys.map(
      (key) => `${JSON.stringify(key)}:${serialize(obj[key]!)}`,
    );
    return `{${members.join(",")}}`;
  }

  throw new Error(`@dwk/vc: cannot canonicalize value of type ${type}`);
}

/**
 * Canonicalize a JSON value to its RFC 8785 string form. Throws on values JSON
 * cannot represent (non-finite numbers, `undefined` at the top level, functions).
 */
export function canonicalize(value: JcsValue): string {
  if (value === undefined) {
    throw new Error("@dwk/vc: cannot canonicalize `undefined`");
  }
  return serialize(value);
}

/** Canonicalize a value and return its UTF-8 bytes (the hash input). */
export function canonicalizeToBytes(value: JcsValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
