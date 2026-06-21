/**
 * The unified signing entry point. Dispatches on the wire profile and returns
 * the header(s) to merge into the outbound request.
 */

import { signCavage } from "./cavage.js";
import { signRfc9421 } from "./rfc9421.js";
import type {
  HttpMessage,
  SignatureAlgorithm,
  SignatureProfile,
} from "./types.js";

/** Inputs for {@link signMessage}. */
export interface SignParams {
  /** Wire profile. Defaults to `"rfc9421"`. */
  profile?: SignatureProfile;
  /** The private {@link CryptoKey}, imported by the caller for `alg`. */
  key: CryptoKey;
  /** The `keyid` advertised so the verifier can resolve the public half. */
  keyId: string;
  /** Signature algorithm; must be in the allow-list. */
  alg: SignatureAlgorithm;
  /**
   * Covered components, in signing order. For `"rfc9421"`: derived names like
   * `@method`, `@target-uri`, `@authority`, plus lowercase header names. For
   * `"cavage"`: `(request-target)`, `(created)`, `(expires)`, and lowercase
   * header names.
   */
  components: string[];
  /** Signature creation time, epoch seconds. Defaults to now. */
  created?: number;
  /** Signature expiry, epoch seconds. Omitted when absent. */
  expires?: number;
  /** Anti-replay nonce (RFC 9421 only). */
  nonce?: string;
  /** Application tag (RFC 9421 only). */
  tag?: string;
  /** Signature label (RFC 9421 only). Defaults to `"sig1"`. */
  label?: string;
  /** Override "now" for the `created` default, epoch seconds (deterministic tests). */
  now?: number;
}

/**
 * Sign `message`, returning the headers to add to the request. The caller is
 * responsible for having already set (and listed among `components`) any
 * `content-digest` / `digest` header it wants covered — see
 * {@link createContentDigest} / {@link createDigest}.
 *
 * @returns A map of header name → value (RFC 9421: `Signature-Input` and
 *   `Signature`; cavage: a single `Signature`).
 */
export function signMessage(
  message: HttpMessage,
  params: SignParams,
): Promise<Record<string, string>> {
  if (params.profile === "cavage") {
    return signCavage(message, {
      key: params.key,
      keyId: params.keyId,
      alg: params.alg,
      components: params.components,
      created: params.created,
      expires: params.expires,
    });
  }
  return signRfc9421(message, {
    key: params.key,
    keyId: params.keyId,
    alg: params.alg,
    components: params.components,
    created: params.created ?? params.now ?? Math.floor(Date.now() / 1000),
    expires: params.expires,
    nonce: params.nonce,
    tag: params.tag,
    label: params.label ?? "sig1",
  });
}
