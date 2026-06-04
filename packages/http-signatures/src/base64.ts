/** Base64 (standard, padded) <-> bytes, plus base64url helpers. */

/** Decode standard padded base64 to bytes. Throws on invalid input. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode bytes as standard padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Encode a UTF-8 string to bytes. */
export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}
