/**
 * `@dwk/solid-pod` — edge-native Solid Pod.
 *
 * A stateless Worker front door over a per-pod Durable Object that is the
 * consistency, authz, and notification authority, with R2 for blob bodies. This
 * is the only `@dwk` package that ships a Durable Object.
 *
 * The package is **not** protocol-agnostic: it is the Solid Protocol endpoint,
 * composing the reusable libs `@dwk/dpop` (edge DPoP validation), `@dwk/rdf`
 * (Turtle/JSON-LD content negotiation), `@dwk/wac` (access control), and
 * `@dwk/store` (DO-SQLite quads + R2 copy-on-write blobs). v1 is a **Resource
 * Server only** (no OIDC OP) and runs **one Durable Object per pod** (no
 * sharding).
 *
 * @see spec/packages/solid-pod.md
 * @packageDocumentation
 */

export { createSolidPod, type SolidPodHandler } from "./handler";
export { createSolidPodGc, type SolidPodGcHandler } from "./gc";
export { SolidPodObject } from "./pod";

export {
  type SolidPodConfig,
  type SolidPodEnv,
  type SolidPodGcEnv,
  type AuthContext,
  type Jwks,
} from "./config";

export { SolidPodLogEvent } from "./log";
export type { Logger, Metrics } from "@dwk/log";
