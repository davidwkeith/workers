// A reference composition root: WebFinger (stateless discovery) + WebAuthn (a
// per-relying-party Durable Object) over the Node binding shims. This is the
// "Worker entry + wrangler.toml" a Cloudflare deployer writes by hand — copy it
// and add the packages/secrets your pod needs. Used by `examples/serve.mjs` (the
// Docker bundle entry) and runnable directly via `dwk-serve ./composition.mjs`.
import { assembleBindings, createDurableObjectNamespace } from "@dwk/server";
import { createWebfinger } from "@dwk/webfinger";
import { createWebAuthn, WebAuthnObject } from "@dwk/webauthn";

/** Build the HostConfig from the environment (the composition root reads env). */
export default function composition() {
  const baseUrl = process.env.DWK_BASE_URL ?? "http://localhost";
  const dataDir = process.env.DWK_DATA_DIR ?? "./data";

  // Node-backed Env: each binding becomes a store under the data dir. The DO
  // namespace is created here (the composition root) and placed into the Env.
  const env = assembleBindings({ dataDir });
  env.WEBAUTHN = createDurableObjectNamespace(WebAuthnObject, {
    dataDir,
    env,
    className: "webauthn",
  });

  return {
    baseUrl,
    dataDir,
    publicDir: process.env.DWK_PUBLIC_DIR,
    env,
    mounts: [
      {
        name: "@dwk/webfinger",
        handler: createWebfinger({ resolve: () => null }),
        reservedPaths: ["/.well-known/webfinger"],
      },
      {
        name: "@dwk/webauthn",
        handler: createWebAuthn({
          rpId: new URL(baseUrl).hostname,
          rpName: "dwk self-host",
          origin: baseUrl,
        }),
        reservedPaths: ["/register", "/authenticate"],
        requires: ["WEBAUTHN"],
      },
    ],
  };
}
