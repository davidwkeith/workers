// The esbuild bundle's entry: the baked composition + the host lifecycle, built
// into one file by `pnpm --filter @dwk/server bundle`. `cloudflare:workers` is
// aliased at build time, so the bundle needs no loader hook. (To run unbundled,
// prefer the `dwk-serve` bin pointed at `composition.mjs` as a config module.)
import { startServer } from "@dwk/server/cli";
import composition from "./composition.mjs";

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

startServer(composition(), { logger }).catch((err) => {
  process.stderr.write(`dwk-serve: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
