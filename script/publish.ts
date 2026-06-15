#!/usr/bin/env bun

import { Script } from "@mimo-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

for (const file of pkgjsons) {
  const raw = await Bun.file(file).text()
  const pkg = JSON.parse(raw)
  pkg.version = Script.version
  console.log("updated:", file)
  await Bun.write(file, JSON.stringify(pkg, null, 2) + "\n")
}

await $`bun install`
await $`./packages/sdk/js/script/build.ts`

console.log("\n=== cli ===\n")
await $`bun ./packages/opencode/script/publish.ts`

console.log("\n=== sdk ===\n")
await $`bun ./packages/sdk/js/script/publish.ts`

console.log("\n=== plugin ===\n")
await $`bun ./packages/plugin/script/publish.ts`
