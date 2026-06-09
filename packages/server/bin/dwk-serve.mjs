#!/usr/bin/env node
// The `dwk-serve` executable: boot a host from a composition-root config module.
//   dwk-serve [./config.js] [--port 3000] [--host 0.0.0.0]
// See `@dwk/server` README + spec/self-hosting.md §10. On Node 22 `node:sqlite`
// prints an experimental warning; Node ≥ 24 runs it flag-free.
import { main } from "../dist/cli.js";

const write = (stream) => (event, fields) =>
  stream.write(
    `dwk-serve ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`,
  );

const logger = {
  debug: () => {},
  info: write(process.stdout),
  warn: write(process.stderr),
  error: write(process.stderr),
};

main({ logger }).catch((err) => {
  process.stderr.write(
    `dwk-serve: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
