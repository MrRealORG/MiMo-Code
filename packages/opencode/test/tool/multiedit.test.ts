import { afterAll, afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { MultiEditTool } from "../../src/tool/multiedit"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"

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

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterAll(async () => {
  await runtime.dispose()
})

const resolve = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const info = yield* MultiEditTool
      const tool = yield* info.init()
      return tool
    }),
  )

describe("multiedit", () => {
  test("empty edits array returns safe output without crashing", async () => {
    const dir = await tmpdir()
    const filePath = path.join(dir, "test.txt")
    await fs.writeFile(filePath, "hello world\n", "utf-8")

    const tool = await resolve()

    // An empty edits array should fail at schema validation (.min(1)),
    // but even if it bypassed, the runtime guard prevents crash.
    // Test the runtime guard path by calling with a manually crafted input
    // that skips zod (simulates the edge case).
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const info = yield* MultiEditTool
        const edit = yield* info.init()
        // Use the internal execute directly to test the runtime guard
        return yield* edit.execute(
          {
            filePath,
            edits: [],
          },
          ctx as any,
        )
      }),
    )

    expect(result).toBeDefined()
    expect(result.title).toBe("test.txt")
    expect(result.output).toBe("(no edits applied)")
  })
})