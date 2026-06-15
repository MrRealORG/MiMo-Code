import { z } from "zod"
import { Log } from "."

const log = Log.create({ service: "util/fn" })

export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  const result = (input: z.infer<T>) => {
    let parsed
    try {
      parsed = schema.parse(input)
    } catch (e) {
      if (e instanceof z.ZodError) {
        log.error("schema validation issues", { issues: e.issues })
      } else {
        log.error("schema validation failure", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
      throw e
    }

    return cb(parsed)
  }
  result.force = (input: z.infer<T>) => cb(input)
  result.schema = schema
  return result
}