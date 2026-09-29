#!/usr/bin/env bun
// `zodiac push`, after setting up the globals the constellation relies on.
// Takes the same arguments: `[entrypoint] [-c, --config <path>] [--no-open]`.
import "../globals";
import { parseArgs } from "node:util";
import { pushEntrypoint } from "@zodiaceco/sdk/cli/push";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    "no-open": { type: "boolean" },
  },
  allowPositionals: true,
});

await pushEntrypoint({
  entrypoint: positionals[0],
  config: values.config,
  openInBrowser: !values["no-open"],
});
