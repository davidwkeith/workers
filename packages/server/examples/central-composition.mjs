// A reference `central`-mode composition (spec/scale-out.md, #431/#432):
// WebFinger + IndieAuth (Tier 1, over centralized D1/R2) and WebAuthn (Tier 2,
// a per-RP Durable Object over an embedded-replica libSQL database), so this
// composition can run identically across N replicas behind a load balancer.
// Unlike `composition.mjs` (local mode — the default and recommended path for
// a single-owner deployment), this is illustrative: it is a standalone
// runnable script (`node examples/central-composition.mjs`), not a
// `dwk-serve` config module — `dwk-serve`'s `startServer` calls `createServer`
// directly and doesn't yet know about `createCentralServer`'s preflight
// sequence (a follow-up). It is not run by this package's own tests, and the
// libSQL/S3 client libraries it references (`@libsql/client`, `libsql`,
// `aws4fetch`) stay out of `@dwk/server`'s runtime `dependencies` — a
// deployer's own composition-root choice, per every other central-mode
// seam's "the composing app injects an already-connected client" posture —
// but are `devDependencies` here (phase 5, #434) so this script can double as
// the docker-compose reference's bundled entry (`../docker-compose.yml`,
// `pnpm --filter @dwk/server bundle examples/central-composition.mjs`) and a
// live-verification test bed, not just a documentation snippet.
//
// Composition order matters here (spec/scale-out.md §9.2/§9.3): build the
// coordination KV client, assemble the Env, then call `createCentralServer`
// — NOT `createServer` directly — so the mode-marker + startup-probe checks
// are guaranteed to run before the server accepts any request.
import { createClient } from "@libsql/client";
import Database from "libsql";
import { AwsClient } from "aws4fetch";
import {
  assembleCentralBindings,
  createCentralDurableObjectNamespace,
  createCentralServer,
  CentralFleetPoller,
  LibsqlKv,
  loadDwkEnv,
} from "@dwk/server";
import { createWebfinger } from "@dwk/webfinger";
import { createIndieAuth, createIndieAuthStore } from "@dwk/indieauth";
import { createWebAuthn, WebAuthnObject } from "@dwk/webauthn";

loadDwkEnv();

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

// `service`/`region` are required (not inferable) for a non-AWS S3-compatible
// endpoint such as MinIO or Backblaze B2 — aws4fetch's own inference only
// works for `*.amazonaws.com`-shaped hostnames.
const s3 = new AwsClient({
  accessKeyId: process.env.DWK_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.DWK_S3_SECRET_ACCESS_KEY,
  service: "s3",
  region: process.env.DWK_S3_REGION ?? "us-east-1",
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

// Tier 2 (spec/scale-out.md §6, #432): a per-RP `WebAuthnObject`, unmodified,
// over an embedded-replica libSQL database — one logical database per object
// id at the primary (`getStorageClient(idHex)`), synced from the primary on
// every dispatch (`createCentralDurableObjectNamespace`'s non-optional
// sync-before-serve rule). The replica file under `replicaDir` is a
// rebuildable cache; ephemeral scratch disk is sufficient.
const replicaDir = process.env.DWK_REPLICA_DIR ?? "./replicas";
env.WEBAUTHN = createCentralDurableObjectNamespace(WebAuthnObject, {
  kv: coordinationKv,
  className: "webauthn",
  env,
  getStorageClient: (idHex) =>
    new Database(`${replicaDir}/webauthn/${idHex}.db`, {
      syncUrl: process.env.DWK_LIBSQL_URL,
      authToken: process.env.DWK_LIBSQL_AUTH_TOKEN,
    }),
});

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
    {
      name: "@dwk/webauthn",
      handler: createWebAuthn({
        rpId: new URL(baseUrl).hostname,
        rpName: "Example",
        origin: baseUrl,
      }),
      reservedPaths: ["/register", "/authenticate"],
      requires: ["WEBAUTHN"],
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

// Every replica MUST run this: @dwk/deno-host's Durable Object namespace
// never arms a timer of its own (spec/scale-out.md §6.3) — without a poller,
// `env.WEBAUTHN`'s scheduled alarms (and the coordination KV's expired-row
// sweep) never fire on this replica. (No queue bindings in this example, so
// `queues` is omitted — see spec/scale-out.md §7.1 for a queue-bearing
// composition.)
const fleetPoller = new CentralFleetPoller({
  namespaces: [env.WEBAUTHN],
  kv: coordinationKv,
});
fleetPoller.start();

// Graceful drain (spec/scale-out.md §12): stop accepting connections, stop
// the fleet poller, drain outstanding waitUntil work, close WebSockets, then
// exit — in that order. Wire this to SIGTERM/SIGINT in a real deployment.
process.once("SIGTERM", () => {
  void server.closeCentral([fleetPoller]).then(() => process.exit(0));
});
