/**
 * Local Whisper transcription backend for MiMoCode.
 *
 * Provides offline speech-to-text using whisper.cpp + Whisper Small model.
 * Downloads and caches everything to ~/.mimocode/voice/ (lifetime storage).
 *
 * Usage:
 *   await LocalWhisper.ensureSetup(onProgress)  // one-time setup
 *   const text = await LocalWhisper.transcribe(audioInt16Array)
 */

import { existsSync, mkdirSync, chmodSync, statSync, writeFileSync, unlinkSync, renameSync, createWriteStream, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir, platform, arch, cpus } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { Process } from "@/util"
import { encodeWav, isAvailable as isRecorderAvailable, registerExtraRecorder } from "./voice"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const VOICE_DIR = join(homedir(), ".mimocode", "voice")
const CONFIG_PATH = join(VOICE_DIR, "local-config.json")
const MODEL_PATH = join(VOICE_DIR, "ggml-small.bin")

function getWhisperBinName(): string {
  if (platform() === "win32") return "whisper-cli.exe"
  return "whisper-cli"
}

function getWhisperBinPath(): string {
  return join(VOICE_DIR, getWhisperBinName())
}

// ---------------------------------------------------------------------------
// Model download URLs (multiple mirrors for reliability)
// ---------------------------------------------------------------------------

const MODEL_URLS = [
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/v1.7.6/ggml-small.bin",
]

function getBinaryURLs(): string[] {
  const p = platform()
  const a = arch() === "arm64" || arch() === "aarch64" ? "arm64" : "x64"
  let osName: string
  if (p === "win32") osName = "windows"
  else if (p === "darwin") osName = "macos"
  else osName = "linux"

  return [
    `https://github.com/ggerganov/whisper.cpp/releases/download/v1.7.6/whisper-${osName}-${a}`,
    `https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-${osName}-${a}`,
  ]
}

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

export type SetupProgress = {
  phase: "checking" | "installing_recorder" | "downloading_binary" | "downloading_model" | "done" | "error"
  message: string
  percent: number
  speed?: string
}

// ---------------------------------------------------------------------------
// Portable ffmpeg recorder download
// ---------------------------------------------------------------------------

function getFFmpegBinName(): string {
  if (platform() === "win32") return "ffmpeg.exe"
  return "ffmpeg"
}

function getFFmpegBinPath(): string {
  return join(VOICE_DIR, getFFmpegBinName())
}

function isFFmpegDownloaded(): boolean {
  const p = getFFmpegBinPath()
  return existsSync(p) && statSync(p).size > 1_000_000
}

function getFFmpegDownloadURLs(): string[] {
  const p = platform()
  const a = arch() === "arm64" || arch() === "aarch64" ? "arm64" : "amd64"

  if (p === "darwin") {
    return [
      "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
      "https://evermeet.cx/ffmpeg/getrelease/ffmpeg",
    ]
  }
  if (p === "linux") {
    return [
      `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${a}-static.tar.xz`,
    ]
  }
  if (p === "win32") {
    return [
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    ]
  }
  return []
}

/** Recursively find a file by name in a directory. */
function findFile(dir: string, name: string): string | null {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (!entry.isDirectory() && entry.name === name) return full
      if (entry.isDirectory()) {
        const found = findFile(full, name)
        if (found) return found
      }
    }
  } catch {}
  return null
}

/** Download and extract portable ffmpeg into VOICE_DIR, then register it. */
async function ensureFFmpegRecorder(onProgress?: (p: SetupProgress) => void): Promise<boolean> {
  if (isFFmpegDownloaded()) {
    // Already downloaded — just re-register it as a recorder
    registerDownloadedFFmpeg()
    return true
  }

  const urls = getFFmpegDownloadURLs()
  if (urls.length === 0) return false

  // Download archive
  onProgress?.({ phase: "installing_recorder", message: "Downloading ffmpeg recorder...", percent: 1 })

  const archivePath = getFFmpegBinPath() + ".dl"
  let downloaded = false
  for (const url of urls) {
    try {
      await downloadFile(url, archivePath)
      if (existsSync(archivePath) && statSync(archivePath).size > 100_000) {
        downloaded = true
        break
      }
    } catch {}
  }
  if (!downloaded) {
    try { unlinkSync(archivePath) } catch {}
    return false
  }

  // Extract
  onProgress?.({ phase: "installing_recorder", message: "Extracting ffmpeg...", percent: 3 })
  const binName = getFFmpegBinName()
  const tmpDir = join(VOICE_DIR, "ffmpeg-extract")
  let success = false

  try {
    const p = platform()
    if (p === "win32") {
      // Windows: zip extraction via PowerShell
      mkdirSync(tmpDir, { recursive: true })
      const ps = Process.spawn(
        ["powershell", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force`],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      await ps.exited
      const found = findFile(tmpDir, binName)
      if (found) {
        renameSync(found, getFFmpegBinPath())
        success = true
      }
    } else if (archivePath.endsWith(".zip")) {
      // macOS: zip (from evermeet.cx)
      mkdirSync(tmpDir, { recursive: true })
      const unzip = Process.spawn(["unzip", "-o", archivePath, "-d", tmpDir], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      await unzip.exited
      // The zip may contain the binary directly or in a subdir
      let found = findFile(tmpDir, binName)
      if (!found) found = findFile(tmpDir, "ffmpeg") // macOS binary has no extension
      if (found) {
        renameSync(found, getFFmpegBinPath())
        chmodSync(getFFmpegBinPath(), 0o755)
        success = true
      }
    } else {
      // Linux: tar.xz
      mkdirSync(tmpDir, { recursive: true })
      const tar = Process.spawn(["tar", "xf", archivePath, "-C", tmpDir], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      await tar.exited
      const found = findFile(tmpDir, "ffmpeg")
      if (found) {
        renameSync(found, getFFmpegBinPath())
        chmodSync(getFFmpegBinPath(), 0o755)
        success = true
      }
    }
  } catch {}

  // Cleanup
  try { unlinkSync(archivePath) } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  if (success) {
    registerDownloadedFFmpeg()
    return true
  }
  return false
}

/** Register the downloaded ffmpeg as a recording backend in voice.ts. */
function registerDownloadedFFmpeg() {
  const ffmpegPath = getFFmpegBinPath()
  const p = platform()

  // Build platform-specific ffmpeg input args
  let inputArgs: string[]
  if (p === "darwin") {
    inputArgs = ["-f", "avfoundation", "-i", ":0"]
  } else if (p === "linux") {
    inputArgs = ["-f", "alsa", "-i", "default"]
  } else {
    inputArgs = ["-f", "dshow", "-i", "audio="]
  }

  const extraFlags = ["-nostdin", "-hide_banner", "-loglevel", "error"]
  const outputFlags = ["-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]

  registerExtraRecorder(() => {
    if (!existsSync(ffmpegPath)) return null
    return {
      cmd: ffmpegPath,
      pipeArgs: () => [...inputArgs, ...extraFlags, ...outputFlags],
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isSetupComplete(): boolean {
  return existsSync(getWhisperBinPath()) && existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > 1_000_000
}

export async function ensureSetup(
  onProgress?: (p: SetupProgress) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    mkdirSync(VOICE_DIR, { recursive: true })

    // Phase 1: Check recorder — use system recorder or download portable ffmpeg
    onProgress?.({ phase: "checking", message: "Checking microphone recorder...", percent: 0 })

    if (!isRecorderAvailable()) {
      const ok = await ensureFFmpegRecorder((p) => {
        onProgress?.(p)
      })
      if (!ok) {
        return {
          success: false,
          error: "Failed to download ffmpeg recorder. Check your internet connection.",
        }
      }
    }

    // Phase 2: Download whisper.cpp binary
    const binPath = getWhisperBinPath()
    if (existsSync(binPath) && statSync(binPath).size > 100_000) {
      onProgress?.({ phase: "checking", message: "whisper.cpp binary found", percent: 30 })
    } else {
      onProgress?.({ phase: "downloading_binary", message: "Downloading whisper.cpp...", percent: 5 })
      const binOk = await downloadWithProgress(getBinaryURLs(), binPath, (dl) => {
        onProgress?.({
          phase: "downloading_binary",
          message: `Downloading whisper.cpp: ${dl.percent}%`,
          percent: Math.round(5 + dl.percent * 0.25),
          speed: dl.speed,
        })
      })
      if (!binOk) {
        return { success: false, error: "Failed to download whisper.cpp binary" }
      }
      if (platform() !== "win32") chmodSync(binPath, 0o755)
    }

    // Phase 3: Download Whisper Small model (~500MB)
    if (existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > 1_000_000) {
      onProgress?.({ phase: "checking", message: "Whisper Small model found", percent: 100 })
    } else {
      onProgress?.({ phase: "downloading_model", message: "Downloading Whisper Small model (~500MB)...", percent: 30 })
      const modelOk = await downloadWithProgress(MODEL_URLS, MODEL_PATH, (dl) => {
        onProgress?.({
          phase: "downloading_model",
          message: `Downloading Whisper Small: ${dl.percent}%`,
          percent: Math.round(30 + dl.percent * 0.7),
          speed: dl.speed,
        })
      })
      if (!modelOk) {
        return { success: false, error: "Failed to download Whisper Small model" }
      }
    }

    // Save config
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ model: "small", setupDate: new Date().toISOString() }, null, 2),
    )

    onProgress?.({ phase: "done", message: "Voice ready! Hold Ctrl+Space to talk.", percent: 100 })
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ phase: "error", message: `Setup failed: ${msg}`, percent: 0 })
    return { success: false, error: msg }
  }
}

/**
 * Transcribe audio using local whisper.cpp.
 * Takes Int16Array (16kHz mono) — same format as VAD segments.
 */
export async function transcribe(audio: Int16Array): Promise<string | null> {
  if (!isSetupComplete()) return null

  // Write WAV to temp file (UUID avoids collision across concurrent calls)
  const wavBuffer = encodeWav(audio)
  const id = randomUUID()
  const tmpFile = join(tmpdir(), `mimocode-whisper-${id}.wav`)
  const outTxtFile = join(tmpdir(), `mimocode-whisper-${id}.txt`)

  try {
    // Write WAV
    const { writeFile } = await import("node:fs/promises")
    await writeFile(tmpFile, Buffer.from(wavBuffer))

    const threads = Math.min(cpus().length, 4)
    const binPath = getWhisperBinPath()
    const outFileBase = tmpFile.replace(/\.wav$/, "")

    const proc = Process.spawn(
      [binPath, "-m", MODEL_PATH, "-f", tmpFile, "-t", String(threads), "--no-timestamps", "-ofmt", "txt", "-otxt", outFileBase],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )

    // Timeout proportional to audio length (3x realtime, min 30s, max 120s)
    const audioSeconds = audio.length / 16000
    const timeoutMs = Math.max(30_000, Math.min(120_000, Math.ceil(audioSeconds * 3000)))
    const timeout = setTimeout(() => {
      try { proc.kill("SIGTERM") } catch {}
    }, timeoutMs)

    let stderr = ""
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })

    const exitCode = await proc.exited
    clearTimeout(timeout)
    if (exitCode !== 0) return null

    // Read output
    try {
      const { readFile } = await import("node:fs/promises")
      const text = (await readFile(outTxtFile, "utf-8")).trim()
      await import("node:fs/promises").then(fs => fs.unlink(outTxtFile).catch(() => {}))
      return text || null
    } catch {
      return null
    }
  } finally {
    // Cleanup temp WAV
    try {
      const { unlink } = await import("node:fs/promises")
      await unlink(tmpFile).catch(() => {})
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type DLProgress = { percent: number; speed: string }

async function downloadWithProgress(urls: string[], dest: string, onProgress: (p: DLProgress) => void): Promise<boolean> {
  for (const url of urls) {
    try {
      await downloadFile(url, dest, onProgress)
      if (existsSync(dest) && statSync(dest).size > 1000) return true
    } catch {
      continue
    }
  }
  return false
}

async function downloadFile(url: string, dest: string, onProgress: (p: DLProgress) => void): Promise<void> {
  const https = await import("node:https")
  const http = await import("node:http")

  // Download to a .tmp file first; rename on success to prevent partial corruption
  const tmpDest = dest + ".tmp"
  // Clean up any leftover tmp from previous failed attempts
  try { unlinkSync(tmpDest) } catch {}

  await new Promise<void>((resolve, reject) => {
    const MAX_REDIRECTS = 5
    let redirectCount = 0

    function cleanup() {
      try { unlinkSync(tmpDest) } catch {}
    }

    function tryURL(u: string) {
      const reqMod = u.startsWith("https") ? https : http
      reqMod.get(u, { timeout: 30_000 }, (res: any) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          if (res.headers.location) {
            redirectCount++
            if (redirectCount > MAX_REDIRECTS) {
              cleanup()
              reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`))
              return
            }
            tryURL(res.headers.location)
            return
          }
        }
        if (res.statusCode !== 200) {
          cleanup()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const total = parseInt(res.headers["content-length"] || "0", 10)
        let downloaded = 0
        const startTime = Date.now()
        const file = createWriteStream(tmpDest)

        res.on("data", (chunk: Buffer) => {
          downloaded += chunk.length
          file.write(chunk)

          const elapsed = (Date.now() - startTime) / 1000
          const speed = downloaded / elapsed
          const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0

          const speedStr =
            speed >= 1024 * 1024
              ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s`
              : speed >= 1024
                ? `${(speed / 1024).toFixed(0)} KB/s`
                : `${speed.toFixed(0)} B/s`

          onProgress({ percent: pct, speed: speedStr })
        })

        res.on("end", () => {
          file.end()
          // Rename .tmp → final dest only on successful download
          try {
            renameSync(tmpDest, dest)
          } catch {
            cleanup()
            reject(new Error("Failed to rename downloaded file"))
            return
          }
          resolve()
        })

        res.on("error", () => {
          cleanup()
          reject(new Error(`Stream error`))
        })
        file.on("error", () => {
          cleanup()
          reject(new Error("Write error"))
        })
      }).on("error", () => {
        cleanup()
        reject(new Error(`Connection failed: ${u}`))
      })
    }

    tryURL(url)
  })
}