#!/usr/bin/env node
// The `dwk-migrate` executable: mechanical local ↔ central data migration.
//   dwk-migrate to-central ./dwk.migrate.js [--data-dir ./data]
//   dwk-migrate to-local   ./dwk.migrate.js [--data-dir ./data]
// See `@dwk/server` README "Local ↔ central migration" + spec/scale-out.md §13.
import { main } from "../dist/migrate.js";

const write = (stream) => (event, fields) =>
  stream.write(
    `dwk-migrate ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`,
  );

const logger = {
  debug: () => {},
  info: write(process.stdout),
  warn: write(process.stderr),
  error: write(process.stderr),
};

main({ logger }).catch((err) => {
  process.stderr.write(
    `dwk-migrate: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
