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

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, chmodSync, statSync, writeFileSync } from "node:fs"
import { createWriteStream } from "node:fs"
import { homedir, tmpdir, platform, arch, cpus } from "node:os"
import { join } from "node:path"
import { Process } from "@/util"
import { which } from "@/util/which"
import { encodeWav } from "./voice"

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
  phase: "checking" | "downloading_binary" | "downloading_model" | "done" | "error"
  message: string
  percent: number
  speed?: string
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

    // Phase 1: Check recorder (SoX / arecord)
    onProgress?.({ phase: "checking", message: "Checking microphone recorder...", percent: 0 })

    const hasRecorder = detectRecorder()
    if (!hasRecorder) {
      return {
        success: false,
        error:
          platform() === "darwin"
            ? "Install SoX: brew install sox"
            : platform() === "linux"
              ? "Install SoX: sudo apt install sox"
              : "Install SoX: choco install sox",
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

  // Write WAV to temp file
  const wavBuffer = encodeWav(audio)
  const tmpFile = join(tmpdir(), `mimocode-whisper-${Date.now()}.wav`)
  const outFile = tmpFile.replace(".wav", "")

  try {
    // Write WAV
    const { writeFile } = await import("node:fs/promises")
    await writeFile(tmpFile, Buffer.from(wavBuffer))

    const threads = Math.min(cpus().length, 8)
    const binPath = getWhisperBinPath()

    const proc = Process.spawn(
      [binPath, "-m", MODEL_PATH, "-f", tmpFile, "-t", String(threads), "--no-timestamps", "-ofmt", "txt", "-otxt", outFile],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )

    // Timeout safety — whisper.cpp should not take more than 60s for short clips
    const timeout = setTimeout(() => {
      try { proc.kill("SIGTERM") } catch {}
    }, 60_000)

    let stderr = ""
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })

    const exitCode = await proc.exited
    clearTimeout(timeout)
    if (exitCode !== 0) return null

    // Read output
    try {
      const { readFile, unlink } = await import("node:fs/promises")
      const text = (await readFile(outFile + ".txt", "utf-8")).trim()
      await unlink(outFile + ".txt").catch(() => {})
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

function detectRecorder(): boolean {
  if (which("rec") || which("sox") || which("arecord")) return true
  try {
    execSync("rec --version", { stdio: "pipe" })
    return true
  } catch {}
  try {
    execSync("arecord --version", { stdio: "pipe" })
    return true
  } catch {}
  return false
}

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

  await new Promise<void>((resolve, reject) => {
    function tryURL(u: string) {
      const reqMod = u.startsWith("https") ? https : http
      reqMod.get(u, { timeout: 30_000 }, (res: any) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          if (res.headers.location) {
            tryURL(res.headers.location)
            return
          }
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const total = parseInt(res.headers["content-length"] || "0", 10)
        let downloaded = 0
        const startTime = Date.now()
        const file = createWriteStream(dest)

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
          resolve()
        })

        res.on("error", reject)
        file.on("error", reject)
      }).on("error", () => {
        reject(new Error(`Connection failed: ${u}`))
      })
    }

    tryURL(url)
  })
}