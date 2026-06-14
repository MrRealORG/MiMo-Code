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
const MAX_LOG_SIZE = 50 * 1024 * 1024 // 50 MB per log file

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

/** Update the log level after initialisation (e.g. from config file). */
export function setLevel(l: Level) {
  level = l
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
export function file() {
  return logpath
}
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}

let currentStream: WriteStream | null = null
let currentSize = 0
let rotating = false

async function rotate() {
  if (rotating || !logpath) return
  rotating = true
  try {
    // Flush and close current stream
    if (currentStream) {
      await new Promise<void>((resolve) => currentStream!.end(() => resolve()))
      currentStream = null
    }

    // Rotate: .log -> .log.1, .log.1 -> .log.2, etc. up to (keep) backups
    for (let i = keep - 1; i >= 1; i--) {
      const src = i === 1 ? logpath : `${logpath}.${i - 1}`
      const dst = `${logpath}.${i}`
      await fs.rename(src, dst).catch(() => {})
    }

    // Start fresh
    await fs.truncate(logpath).catch(() => {})
    currentStream = createWriteStream(logpath, { flags: "a" })
    currentSize = 0
    write = async (msg: any) => {
      return new Promise((resolve, reject) => {
        currentStream!.write(msg, (err) => {
          if (err) reject(err)
          else {
            currentSize += typeof msg === "string" ? msg.length : 0
            resolve(msg.length)
          }
        })
      })
    }
  } finally {
    rotating = false
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
  currentSize = (await fs.stat(logpath).catch(() => ({ size: 0 }))).size
  currentStream = createWriteStream(logpath, { flags: "a" })
  write = async (msg: any) => {
    const len = typeof msg === "string" ? msg.length : 0
    // Check if we need to rotate BEFORE writing
    if (currentSize + len > MAX_LOG_SIZE) {
      await rotate()
    }
    return new Promise((resolve, reject) => {
      currentStream!.write(msg, (err) => {
        if (err) reject(err)
        else {
          currentSize += len
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