import path from "path"
import fs from "fs/promises"
import { createWriteStream, type WriteStream } from "fs"
import { Global } from "../global"
import z from "zod"
import { Glob } from "@mimo-ai/shared/util/glob"

export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
export type Level = z.infer<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10

// Log rotation: rotate when the current log file exceeds this size (100 MB)
const MAX_LOG_SIZE = 100 * 1024 * 1024
// Maximum number of rotated parts to keep per log file
const MAX_ROTATED_PARTS = 3

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
let currentStream: WriteStream | null = null
let currentSize = 0
let rotatedCount = 0

export function file() {
  return logpath
}
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}

/**
 * Rotate the current log file if it has exceeded MAX_LOG_SIZE.
 * Renames the active file to <logpath>.1, shifts older parts (.2, .3, ...),
 * and opens a fresh write stream.
 */
async function rotateIfNeeded(): Promise<void> {
  if (currentSize < MAX_LOG_SIZE) return
  if (!logpath) return

  // Close the current stream
  const old = currentStream
  currentStream = null
  await new Promise<void>((resolve) => {
    if (!old || old.destroyed) return resolve()
    old.end(() => resolve())
  })

  // Shift rotated parts: .3 -> delete, .2 -> .3, .1 -> .2
  for (let i = MAX_ROTATED_PARTS; i >= 1; i--) {
    const src = i === 1 ? logpath : `${logpath}.${i - 1}`
    const dst = `${logpath}.${i}`
    if (i === MAX_ROTATED_PARTS) {
      // Remove the oldest rotated file
      await fs.unlink(dst).catch(() => {})
    }
    await fs.rename(src, dst).catch(() => {})
  }

  // Reset size counter and open fresh stream
  currentSize = 0
  rotatedCount++
  const fresh = createWriteStream(logpath, { flags: "a" })
  currentStream = fresh
  write = async (msg: any) => {
    return new Promise((resolve, reject) => {
      currentStream?.write(msg, (err) => {
        if (err) reject(err)
        else resolve(msg.length)
      })
    })
  }
}

export async function init(options: Options) {
  if (options.level) level = options.level
  void cleanup(Global.Path.log)
  if (options.print) return
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  if (options.dev) {
    // Preserve previous dev.log as dev.log.<timestamp> for hang/incident
    // forensics. cleanup() above already prunes old timestamped logs.
    try {
      const stat = await fs.stat(logpath).catch(() => null)
      if (stat && stat.size > 0) {
        const stamp = new Date().toISOString().split(".")[0].replace(/:/g, "")
        await fs.rename(logpath, `${logpath}.${stamp}`).catch(() => {})
      }
    } catch {}
  } else {
    await fs.truncate(logpath).catch(() => {})
  }
  // Initialize size tracking
  const stat = await fs.stat(logpath).catch(() => null)
  currentSize = stat?.size ?? 0
  rotatedCount = 0

  const stream = createWriteStream(logpath, { flags: "a" })
  currentStream = stream
  write = async (msg: any) => {
    // Check rotation before writing
    await rotateIfNeeded().catch(() => {})
    return new Promise((resolve, reject) => {
      currentStream?.write(msg, (err) => {
        if (err) reject(err)
        else {
          currentSize += (typeof msg === "string" ? msg.length : 0)
          resolve(msg.length)
        }
      })
    })
  }
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}