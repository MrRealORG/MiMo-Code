import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Log } from "../util"
import { Instance } from "../project/instance"

const log = Log.create({ service: "test-runner-tool" })

const Parameters = z.object({
  command: z
    .string()
    .optional()
    .describe(
      "Test command to run (e.g., 'npm test', 'pytest', 'go test ./...'). If not provided, auto-detects the test framework.",
    ),
  filter: z
    .string()
    .optional()
    .describe("Filter/spec pattern to run only specific tests (e.g., 'should handle auth')"),
  retry: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .default(0)
    .describe("Number of retries on failure (0-3). Useful for flaky tests."),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds for the test run"),
})

type TestResult = {
  name: string
  status: "passed" | "failed" | "skipped" | "error"
  duration?: number
  message?: string
}

type TestOutput = {
  framework: string
  command: string
  total: number
  passed: number
  failed: number
  skipped: number
  errors: number
  duration: number
  results: TestResult[]
  output: string
  retryAttempt?: number
}

function parseJest(output: string): TestResult[] {
  const results: TestResult[] = []
  const passRegex = /\s+✓\s+(.+)/g
  const failRegex = /\s+✕\s+(.+)/g
  let match

  while ((match = passRegex.exec(output)) !== null) {
    results.push({ name: match[1].trim(), status: "passed" })
  }
  while ((match = failRegex.exec(output)) !== null) {
    results.push({ name: match[1].trim(), status: "failed" })
  }
  return results
}

function parseVitest(output: string): TestResult[] {
  const results: TestResult[] = []
  const passRegex = /\s+✓\s+(.+)/g
  const failRegex = /\s+(?:✕|×)\s+(.+)/g
  let match

  while ((match = passRegex.exec(output)) !== null) {
    results.push({ name: match[1].trim(), status: "passed" })
  }
  while ((match = failRegex.exec(output)) !== null) {
    results.push({ name: match[1].trim(), status: "failed" })
  }
  return results
}

function parsePytest(output: string): TestResult[] {
  const results: TestResult[] = []
  const passRegex = /(\S+)\s+PASSED/g
  const failRegex = /(\S+)\s+FAILED/g
  const skipRegex = /(\S+)\s+SKIPPED/g
  let match

  while ((match = passRegex.exec(output)) !== null) {
    results.push({ name: match[1], status: "passed" })
  }
  while ((match = failRegex.exec(output)) !== null) {
    results.push({ name: match[1], status: "failed" })
  }
  while ((match = skipRegex.exec(output)) !== null) {
    results.push({ name: match[1], status: "skipped" })
  }
  return results
}

function parseGoTest(output: string): TestResult[] {
  const results: TestResult[] = []
  const passRegex = /---\s+PASS:\s+(\S+)/g
  const failRegex = /---\s+FAIL:\s+(\S+)/g
  const skipRegex = /---\s+SKIP:\s+(\S+)/g
  let match

  while ((match = passRegex.exec(output)) !== null) {
    results.push({ name: match[1], status: "passed" })
  }
  while ((match = failRegex.exec(output)) !== null) {
    results.push({ name: match[1], status: "failed" })
  }
  while ((match = skipRegex.exec(output)) !== null) {
    results.push({ name: match[1], status: "skipped" })
  }
  return results
}

function detectFramework(cwd: string): { command: string; framework: string } | null {
  const fs = require("fs")
  const path = require("path")

  if (fs.existsSync(path.join(cwd, "jest.config.js")) || fs.existsSync(path.join(cwd, "jest.config.ts")) || fs.existsSync(path.join(cwd, "jest.config.mjs"))) {
    return { command: "npx jest --no-cache", framework: "jest" }
  }
  if (fs.existsSync(path.join(cwd, "vitest.config.ts")) || fs.existsSync(path.join(cwd, "vitest.config.js"))) {
    return { command: "npx vitest run", framework: "vitest" }
  }
  if (fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "setup.py"))) {
    return { command: "python -m pytest -v", framework: "pytest" }
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return { command: "go test ./... -v", framework: "go-test" }
  }
  const pkg = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8")) } catch { return null }
  })()
  if (pkg?.scripts?.test) {
    return { command: pkg.scripts.test, framework: "npm-test" }
  }
  return null
}

function parseResults(output: string, framework: string): TestResult[] {
  switch (framework) {
    case "jest": return parseJest(output)
    case "vitest": return parseVitest(output)
    case "pytest": return parsePytest(output)
    case "go-test": return parseGoTest(output)
    default: return []
  }
}

export const TestRunnerTool = Tool.define(
  "test_runner",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    return {
      description:
        "Run test suites with structured result parsing and automatic framework detection. " +
        "Supports Jest, Vitest, pytest, Go test, and any npm test command. " +
        "Returns structured test results with pass/fail/skip counts. " +
        "Includes retry support for flaky tests and optional test filtering.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cwd = Instance.worktree
          const effectiveCommand = params.command ?? detectFramework(cwd)?.command
          const framework = params.command ? "custom" : (detectFramework(cwd)?.framework ?? "unknown")

          if (!effectiveCommand) {
            return {
              title: "Test Runner: no framework detected",
              output: [
                "Could not detect a test framework automatically.",
                "Please provide a test command explicitly, e.g.:",
                '  test_runner({ command: "npm test" })',
                '  test_runner({ command: "pytest -v" })',
              ].join("\n"),
              metadata: { framework: "none", total: 0, passed: 0, failed: 0, skipped: 0 },
            }
          }

          const fullCommand = params.filter
            ? `${effectiveCommand} ${params.filter}`
            : effectiveCommand

          const maxRetries = params.retry ?? 0
          let lastOutput = ""
          let lastResults: TestResult[] = []

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const proc = ChildProcess.make(fullCommand, [], {
              shell: true,
              cwd,
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

            const exitCode = yield* handle.exitCode.pipe(
              Effect.timeout(`${(params.timeout ?? 300000) + 5000} millis`),
              Effect.catch(() => Effect.succeed(null as number | null)),
            )

            lastOutput = chunks.join("")
            lastResults = parseResults(lastOutput, framework)

            const allPassed = lastResults.length > 0
              ? lastResults.every((r) => r.status === "passed" || r.status === "skipped")
              : exitCode === 0

            if (allPassed || attempt >= maxRetries) break

            log.info(`Test run ${attempt + 1} had failures, retrying...`, {
              failed: lastResults.filter((r) => r.status === "failed").length,
            })
          }

          const passed = lastResults.filter((r) => r.status === "passed").length
          const failed = lastResults.filter((r) => r.status === "failed").length
          const skipped = lastResults.filter((r) => r.status === "skipped").length
          const errored = lastResults.filter((r) => r.status === "error").length
          const total = lastResults.length || 0

          const failedTests = lastResults.filter((r) => r.status === "failed")
          const summaryLines: string[] = [
            `Test Results (${framework}):`,
            `  Command: ${fullCommand}`,
            `  Total:   ${total}`,
            `  Passed:  ${passed}`,
            `  Failed:  ${failed}`,
            `  Skipped: ${skipped}`,
          ]

          if (maxRetries > 0) {
            summaryLines.push(`  Retries: ${maxRetries}`)
          }

          if (failedTests.length > 0 && failedTests.length <= 20) {
            summaryLines.push("", "Failed Tests:")
            for (const test of failedTests) {
              summaryLines.push(`  ✕ ${test.name}`)
            }
          }

          if (failed > 0) {
            summaryLines.push("", "Fix the failing tests before proceeding.")
          }

          const testOutput: TestOutput = {
            framework,
            command: fullCommand,
            total,
            passed,
            failed,
            skipped,
            errors: errored,
            duration: 0,
            results: lastResults,
            output: lastOutput.slice(-10000),
            retryAttempt: maxRetries,
          }

          return {
            title: failed > 0
              ? `Tests: ${failed} failed, ${passed} passed`
              : `Tests: ${passed} passed`,
            output: summaryLines.join("\n"),
            metadata: testOutput,
          }
        }).pipe(Effect.orDie),
    }
  }),
)