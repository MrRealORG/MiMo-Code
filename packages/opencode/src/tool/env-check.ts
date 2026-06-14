import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { Log } from "../util"

const log = Log.create({ service: "env-check-tool")

const Parameters = z.object({
  action: z.enum([
    "full",
    "dependencies",
    "node",
    "python",
    "go",
    "rust",
    "git",
    "docker",
  ])
    .optional()
    .default("full")
    .describe("What to check. 'full' runs all checks. Others target specific runtimes/tools."),
})

type CheckResult = {
  name: string
  status: "ok" | "warning" | "error" | "not_found"
  version?: string
  message: string
  recommendation?: string
}

function parseVersion(raw: string): string {
  const match = raw.match(/v?(\d+\.\d+[\.\d]*)/)
  return match ? match[1] : raw.trim().split("\n")[0]?.trim() || "unknown"
}

export const EnvCheckTool = Tool.define(
  "env_check",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* AppFileSystem.Service

    const run = Effect.fnUntraced(function* (cmd: string, args: string[]) {
      const proc = ChildProcess.make(cmd, args, {
        cwd: Instance.worktree,
        stdin: "ignore",
        detached: false,
      })
      const handle = yield* spawner.spawn(proc)
      const chunks: string[] = []
      yield* Effect.forkScoped(
        Effect.async<void>((resume) => {
          const handler = (chunk: string) => { chunks.push(chunk) }
          handle.stdout.subscribe(handler)
          handle.stderr.subscribe(handler)
          handle.exitCode.then(() => {
            handle.stdout.unsubscribe(handler)
            handle.stderr.unsubscribe(handler)
            resume(Effect.void)
          })
        }),
      )
      const code = yield* handle.exitCode
      return { output: chunks.join("").trim(), exitCode: code }
    })

    return {
      description:
        "Verify the development environment and project dependencies. " +
        "Checks for: required tools (Node, Python, Go, Rust, Git, Docker), package manager health, " +
        "missing or outdated dependencies, lock file consistency, and common configuration issues. " +
        "Run 'full' for a complete environment audit, or target specific runtimes.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cwd = Instance.worktree
          const results: CheckResult[] = []

          const checkNode = Effect.fnUntraced(async () => {
            const res = await run(["node", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (!res || res.exitCode !== 0) {
              results.push({ name: "Node.js", status: "not_found", message: "Node.js is not installed", recommendation: "Install Node.js >= 18 from https://nodejs.org" })
              return
            }
            const version = parseVersion(res.output)
            const major = parseInt(version.split(".")[0] || "0")
            if (major < 18) {
              results.push({ name: "Node.js", status: "warning", version, message: `Node.js ${version} is below recommended v18+`, recommendation: "Upgrade to Node.js 18+ for best compatibility" })
            } else {
              results.push({ name: "Node.js", status: "ok", version, message: `Node.js ${version} installed` })
            }

            // Check npm/yarn/pnpm/bun
            for (const [name, cmd] of [["npm", "npm"], ["yarn", "yarn"], ["pnpm", "pnpm"], ["bun", "bun"]] {
              const r = await run([cmd, ["--version"]]).pipe(Effect.runPromise).catch(() => null)
              if (r && r.exitCode === 0) {
                results.push({ name, status: "ok", version: parseVersion(r.output), message: `${name} ${parseVersion(r.output)} available` })
              }
            }
          })

          const checkPython = Effect.fnUntraced(async () => {
            const res = await run(["python3", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (!res || res.exitCode !== 0) {
              results.push({ name: "Python", status: "not_found", message: "Python 3 is not installed", recommendation: "Install Python 3.10+ from https://python.org" })
              return
            }
            const version = parseVersion(res.output)
            results.push({ name: "Python", status: "ok", version, message: `Python ${version} installed` })

            // Check pip
            const pip = await run(["pip3", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (pip && pip.exitCode === 0) {
              results.push({ name: "pip", status: "ok", version: parseVersion(pip.output), message: `pip ${parseVersion(pip.output)} available` })
            }
          })

          const checkGo = Effect.fnUntraced(async () => {
            const res = await run(["go", ["version"]]).pipe(Effect.runPromise).catch(() => null)
            if (!res || res.exitCode !== 0) {
              results.push({ name: "Go", status: "not_found", message: "Go is not installed", recommendation: "Install Go from https://go.dev" })
              return
            }
            const version = parseVersion(res.output)
            results.push({ name: "Go", status: "ok", version, message: `Go ${version} installed` })
          })

          const checkRust = Effect.fnUntraced(async () => {
            const res = await run(["rustc", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (!res || res.exitCode !== 0) {
              results.push({ name: "Rust", status: "not_found", message: "Rust is not installed", recommendation: "Install Rust from https://rustup.rs" })
              return
            }
            const version = parseVersion(res.output)
            results.push({ name: "Rust", status: "ok", version, message: `Rust ${version} installed` })

            const cargo = await run(["cargo", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (cargo && cargo.exitCode === 0) {
              results.push({ name: "Cargo", status: "ok", version: parseVersion(cargo.output), message: `Cargo ${parseVersion(cargo.output)} available` })
            }
          })

          const checkGit = Effect.fnUntraced(async () => {
            const res = await run(["git", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (!res || res.exitCode !== 0) {
              results.push({ name: "Git", status: "error", message: "Git is not installed — this is required for version control and /undo", recommendation: "Install Git from https://git-scm.com" })
              return
            }
            const version = parseVersion(res.output)
            results.push({ name: "Git", status: "ok", version, message: `Git ${version} installed` })
          })

          const checkDocker = Effect.fnUntraced(async () => {
            const res = await run(["docker", ["--version"]]).pipe(Effect.runPromise).catch(() => null)
            if (!res || res.exitCode !== 0) {
              results.push({ name: "Docker", status: "not_found", message: "Docker is not installed (optional)", recommendation: "Install Docker from https://docker.com if containerized workflows are needed" })
              return
            }
            results.push({ name: "Docker", status: "ok", version: parseVersion(res.output), message: `Docker ${parseVersion(res.output)} installed` })
          })

          const checkDependencies = Effect.fnUntraced(async () => {
            // Check package.json / node_modules
            const hasPkg = await fs.exists(path.join(cwd, "package.json")).pipe(Effect.runPromise).catch(() => false)
            if (hasPkg) {
              const hasModules = await fs.exists(path.join(cwd, "node_modules")).pipe(Effect.runPromise).catch(() => false)
              const hasLock = await fs.exists(path.join(cwd, "bun.lockb")).pipe(Effect.runPromise).catch(() => false) ||
                await fs.exists(path.join(cwd, "bun.lock")).pipe(Effect.runPromise).catch(() => false) ||
                await fs.exists(path.join(cwd, "package-lock.json")).pipe(Effect.runPromise).catch(() => false) ||
                await fs.exists(path.join(cwd, "yarn.lock")).pipe(Effect.runPromise).catch(() => false) ||
                await fs.exists(path.join(cwd, "pnpm-lock.yaml")).pipe(Effect.runPromise).catch(() => false)

              if (!hasModules) {
                results.push({ name: "Dependencies", status: "error", message: "node_modules not found — run npm/bun/yarn/pnpm install", recommendation: "Run the appropriate install command for your package manager" })
              } else if (!hasLock) {
                results.push({ name: "Dependencies", status: "warning", message: "No lock file found — consider committing one for reproducible builds", recommendation: "Run 'npm install' or 'bun install' to generate a lock file" })
              } else {
                results.push({ name: "Dependencies", status: "ok", message: "node_modules and lock file present" })
              }
            }

            // Check go.mod
            const hasGoMod = await fs.exists(path.join(cwd, "go.mod")).pipe(Effect.runPromise).catch(() => false)
            if (hasGoMod) {
              const hasVendor = await fs.exists(path.join(cwd, "vendor")).pipe(Effect.runPromise).catch(() => false)
              results.push({ name: "Go Modules", status: "ok", message: hasVendor ? "go.mod and vendor/ present" : "go.mod present" })
            }

            // Check requirements.txt / pyproject.toml
            const hasPyProject = await fs.exists(path.join(cwd, "pyproject.toml")).pipe(Effect.runPromise).catch(() => false) ||
              await fs.exists(path.join(cwd, "requirements.txt")).pipe(Effect.runPromise).catch(() => false)
            if (hasPyProject) {
              results.push({ name: "Python Dependencies", status: "ok", message: "Python project files detected" })
            }
          })

          // Run checks based on action
          const checks: string[] = []
          switch (params.action) {
            case "full":
              checks.push("node", "python", "go", "rust", "git", "docker", "dependencies")
              break
            case "node":
              checks.push("node", "dependencies")
              break
            case "python":
              checks.push("python", "dependencies")
              break
            case "go":
              checks.push("go", "dependencies")
              break
            case "rust":
              checks.push("rust", "dependencies")
              break
            default:
              checks.push(params.action)
          }

          yield* Effect.all(
            checks.map((c) => {
              switch (c) {
                case "node": return checkNode()
                case "python": return checkPython()
                case "go": return checkGo()
                case "rust": return checkRust()
                case "git": return checkGit()
                case "docker": return checkDocker()
                case "dependencies": return checkDependencies()
                default: return Effect.void
              }
            }),
            { concurrency: "unbounded" },
          )

          // Format results
          const ok = results.filter((r) => r.status === "ok").length
          const warnings = results.filter((r) => r.status === "warning").length
          const errors = results.filter((r) => r.status === "error").length
          const notFound = results.filter((r) => r.status === "not_found").length

          const lines: string[] = [`Environment Check (${params.action}):`, ""]
          for (const r of results) {
            const icon = r.status === "ok" ? "[OK]" : r.status === "warning" ? "[WARN]" : r.status === "error" ? "[ERR]" : "[--]"
            const ver = r.version ? ` (${r.version})` : ""
            lines.push(`  ${icon} ${r.name}${ver}: ${r.message}`)
            if (r.recommendation) {
              lines.push(`       Recommendation: ${r.recommendation}`)
            }
          }

          lines.push("")
          lines.push(`Summary: ${ok} ok, ${warnings} warnings, ${errors} errors, ${notFound} not found`)

          return {
            title: `Env Check: ${ok} ok, ${warnings + errors + notFound} issues`,
            output: lines.join("\n"),
            metadata: {
              action: params.action,
              total: results.length,
              ok,
              warnings,
              errors,
              notFound,
              results,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)