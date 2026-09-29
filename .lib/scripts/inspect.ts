#!/usr/bin/env bun
import "../globals";
import path from "node:path";

const entrypoint = process.argv[2] ?? "constellation/index.ts";
const mod = await import(path.resolve(process.cwd(), entrypoint));
const { default: _d, ...nodes } = mod;

const replacer = (_: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v;

console.log("exports:", Object.keys(nodes).join(", "));
for (const [k, v] of Object.entries(nodes)) {
  console.log(`\n--- ${k} ---`);
  console.log(JSON.stringify(v, replacer, 2));
}
