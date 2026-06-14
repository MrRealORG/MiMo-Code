import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { MultiEditTool } from "../../src/tool/multiedit"
import { Instance } from "../../src/project/instance"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-multiedit-empty"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("MultiEditToolTest.init")(function* () {
  const info = yield* MultiEditTool
  return yield* info.init()
})

const run = Effect.fn("MultiEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("multiedit", () => {
  describe("schema validation", () => {
    it.effect("rejects empty edits array via .min(1) Zod guard", () =>
      Effect.gen(function* () {
        const info = yield* MultiEditTool
        const tool = yield* info.init()
        const result = tool.parameters.safeParse({
          filePath: "/tmp/test.txt",
          edits: [],
        })

        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues[0]?.message).toMatch(/Too small/)
        }
      }),
    )

    it.effect("accepts non-empty edits array", () =>
      Effect.gen(function* () {
        const info = yield* MultiEditTool
        const tool = yield* info.init()
        const result = tool.parameters.safeParse({
          filePath: "/tmp/test.txt",
          edits: [{ filePath: "/tmp/test.txt", oldString: "a", newString: "b" }],
        })

        expect(result.success).toBe(true)
      }),
    )
  })

  describe("execution", () => {
    it.live("applies multiple edits sequentially to a file", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filePath = path.join(dir, "test.txt")
          yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8"))

          const result = yield* run({
            filePath,
            edits: [
              { filePath, oldString: "alpha", newString: "ALPHA" },
              { filePath, oldString: "gamma", newString: "GAMMA" },
            ],
          })

          expect(result.output).toContain("Edit applied successfully")

          const content = yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))
          expect(content).toBe("ALPHA\nbeta\nGAMMA\n")
        }),
      ),
    )

    it.live("returns relative path as title", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filePath = path.join(dir, "src", "app.ts")
          yield* Effect.promise(() => fs.mkdir(path.dirname(filePath), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(filePath, "old content\n", "utf-8"))

          const result = yield* run({
            filePath,
            edits: [{ filePath, oldString: "old content", newString: "new content" }],
          })

          expect(result.title).toEndWith(path.join("src", "app.ts"))
        }),
      ),
    )
  })
})