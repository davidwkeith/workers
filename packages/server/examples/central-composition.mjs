// A reference `central`-mode composition (spec/scale-out.md, #431): WebFinger
// + IndieAuth mounted over centralized D1/R2 stores instead of local SQLite
// files, so this composition can run identically across N replicas behind a
// load balancer. Unlike `composition.mjs` (local mode — the default and
// recommended path for a single-owner deployment), this is illustrative: it
// is a standalone runnable script (`node examples/central-composition.mjs`),
// not a `dwk-serve` config module — `dwk-serve`'s `startServer` calls
// `createServer` directly and doesn't yet know about `createCentralServer`'s
// preflight sequence (a follow-up, not this PR's Tier-1 scope). It is not
// bundled/run by this package's own build or tests, and the libSQL/S3 client
// libraries it references (`@libsql/client`, `aws4fetch`) are the deployer's
// own dependencies to add, not `@dwk/server`'s.
//
// Composition order matters here (spec/scale-out.md §9.2/§9.3): build the
// coordination KV client, assemble the Env, then call `createCentralServer`
// — NOT `createServer` directly — so the mode-marker + startup-probe checks
// are guaranteed to run before the server accepts any request.
import { createClient } from "@libsql/client";
import { AwsClient } from "aws4fetch";
import {
  assembleCentralBindings,
  createCentralServer,
  LibsqlKv,
} from "@dwk/server";
import { createWebfinger } from "@dwk/webfinger";
import { createIndieAuth, createIndieAuthStore } from "@dwk/indieauth";

const baseUrl = process.env.DWK_BASE_URL ?? "https://example.com";
const dataDir = process.env.DWK_DATA_DIR ?? "./data";

// One libSQL/Turso connection backs both the coordination KV and the D1
// binding below — see spec/scale-out.md §9's "Update (issue #431)" note on
// why `storage.kv` takes an already-constructed client rather than a raw
// connection descriptor.
const libsql = createClient({
  url: process.env.DWK_LIBSQL_URL,
  authToken: process.env.DWK_LIBSQL_AUTH_TOKEN,
});
const coordinationKv = new LibsqlKv(libsql);

const s3 = new AwsClient({
  accessKeyId: process.env.DWK_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.DWK_S3_SECRET_ACCESS_KEY,
});

const env = assembleCentralBindings({
  d1: { AUTH_DB: libsql },
  r2: {
    MEDIA: {
      client: { fetch: s3.fetch.bind(s3) },
      endpoint: process.env.DWK_R2_ENDPOINT,
    },
  },
  secrets: { TOKEN_SIGNING_KEY: process.env.DWK_TOKEN_SIGNING_KEY },
});
await createIndieAuthStore(env).init();

const config = {
  baseUrl,
  dataDir,
  publicDir: process.env.DWK_PUBLIC_DIR,
  env,
  storage: {
    mode: "central",
    kv: coordinationKv,
    objectStore: { client: s3, endpoint: process.env.DWK_R2_ENDPOINT },
  },
  mounts: [
    {
      name: "@dwk/webfinger",
      handler: createWebfinger({ resolve: () => null }),
      reservedPaths: ["/.well-known/webfinger"],
    },
    {
      name: "@dwk/indieauth",
      handler: createIndieAuth({
        baseUrl,
        approveAuthorization: async () => {
          throw new Error("wire up your own approval flow");
        },
      }),
      reservedPaths: [
        "/.well-known/oauth-authorization-server",
        "/authorize",
        "/token",
        "/revocation",
      ],
      requires: ["AUTH_DB", "TOKEN_SIGNING_KEY"],
    },
  ],
};

// `createCentralServer` (not `createServer`) runs the mode-marker +
// startup-probe checks first, against exactly the bindings just assembled —
// every replica in the fleet runs this same script and each performs its own
// check against the shared coordination store.
const server = await createCentralServer(config, {
  d1: { AUTH_DB: env.AUTH_DB },
});
const { port } = await server.listen(process.env.PORT ?? 3000);
process.stdout.write(`dwk-serve (central mode) listening on :${port}\n`);
