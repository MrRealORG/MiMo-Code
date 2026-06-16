import { z } from "zod"
import { Log } from "@/util"

export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  const result = (input: z.infer<T>) => {
    let parsed
    try {
      parsed = schema.parse(input)
    } catch (e) {
      const log = Log.create({ service: "fn" })
      log.error("schema validation failure", { input, error: e instanceof z.ZodError ? e.issues : e })
      throw e
    }

    return cb(parsed)
  }
  result.force = (input: z.infer<T>) => cb(input)
  result.schema = schema
  return result
}