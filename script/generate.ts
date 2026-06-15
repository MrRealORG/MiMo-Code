#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

const output = await $`bun dev generate`.cwd("packages/opencode").text()
await Bun.write("packages/sdk/openapi.json", output)

await $`./script/format.ts`
