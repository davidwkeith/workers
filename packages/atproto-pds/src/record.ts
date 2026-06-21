/**
 * Conversion between the JSON records clients send over XRPC and the DAG-CBOR
 * blocks stored in the repository. AT Protocol records travel as JSON on the
 * wire but are content-addressed as DAG-CBOR, so the two link/byte types that
 * JSON cannot represent natively use the IPLD DAG-JSON conventions:
 * `{"$link": "<cid>"}` for a CID and `{"$bytes": "<base64>"}` for bytes.
 *
 * Pure and runtime-free.
 */

import type { CborValue } from "./cbor.js";
import { CID } from "./cid.js";

/** Any JSON value (records are JSON on the wire). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Convert an incoming JSON record into its DAG-CBOR value model. */
export function jsonToCbor(value: JsonValue): CborValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(jsonToCbor);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$link") {
    const link = (value as { $link: JsonValue }).$link;
    if (typeof link !== "string")
      throw new Error("record: $link must be a string");
    return CID.parse(link);
  }
  if (keys.length === 1 && keys[0] === "$bytes") {
    const b = (value as { $bytes: JsonValue }).$bytes;
    if (typeof b !== "string")
      throw new Error("record: $bytes must be a string");
    return base64Decode(b);
  }
  const out: { [key: string]: CborValue } = {};
  for (const key of keys) {
    out[key] = jsonToCbor(
      (value as { [k: string]: JsonValue })[key] as JsonValue,
    );
  }
  return out;
}

/** Convert a stored DAG-CBOR value back into JSON for an XRPC response. */
export function cborToJson(value: CborValue): JsonValue {
  if (value instanceof CID) return { $link: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: base64Encode(value) };
  if (Array.isArray(value)) return value.map(cborToJson);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, v] of Object.entries(value)) out[key] = cborToJson(v);
    return out;
  }
  return value;
}

/** The repository path (`collection/rkey`) used as an MST key. */
export function recordPath(collection: string, rkey: string): string {
  return `${collection}/${rkey}`;
}

/** Build an `at://` record URI. */
export function atUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}
