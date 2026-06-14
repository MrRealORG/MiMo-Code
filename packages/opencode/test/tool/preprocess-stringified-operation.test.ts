import { describe, expect, test } from "bun:test"
import z from "zod"

// Minimal schemas matching the actor discriminated union shape
const runSchema = z.object({
  action: z.literal("run"),
  prompt: z.string(),
  subagent_type: z.string(),
  description: z.string(),
})

const statusSchema = z.object({
  action: z.literal("status"),
  actor_id: z.string(),
})

const cancelSchema = z.object({
  action: z.literal("cancel"),
  actor_id: z.string(),
})

// Reproduce the exact schema pattern from actor.ts
const makeOperationSchema = () =>
  z.preprocess(
    (val) => {
      if (typeof val === "string") {
        try {
          return JSON.parse(val)
        } catch {
          return val
        }
      }
      return val
    },
    z.discriminatedUnion("action", [runSchema, statusSchema, cancelSchema]),
  )

const makeParametersSchema = () =>
  z.strictObject({
    operation: makeOperationSchema(),
  })

describe("actor/task z.preprocess stringified operation", () => {
  const parameters = makeParametersSchema()

  test("accepts a valid object operation", () => {
    const result = parameters.safeParse({
      operation: { action: "run", prompt: "do stuff", subagent_type: "explore", description: "d" },
    })
    expect(result.success).toBe(true)
  })

  test("parses a stringified JSON operation into the discriminated union", () => {
    const result = parameters.safeParse({
      operation: '{"action":"run","prompt":"do stuff","subagent_type":"explore","description":"d"}',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.operation.action).toBe("run")
      expect(result.data.operation.prompt).toBe("do stuff")
    }
  })

  test("parses stringified status operation", () => {
    const result = parameters.safeParse({
      operation: '{"action":"status","actor_id":"abc-123"}',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.operation.action).toBe("status")
    }
  })

  test("rejects invalid JSON string (not a valid operation object)", () => {
    const result = parameters.safeParse({
      operation: "not valid json {{{",
    })
    expect(result.success).toBe(false)
  })

  test("rejects valid JSON but wrong shape", () => {
    const result = parameters.safeParse({
      operation: '{"action":"delete","actor_id":"x"}',
    })
    expect(result.success).toBe(false)
  })

  test("rejects empty string", () => {
    const result = parameters.safeParse({
      operation: "",
    })
    expect(result.success).toBe(false)
  })
})