import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { Log } from "../util"

const log = Log.create({ service: "perf-analyze-tool" })

const Parameters = z.object({
  action: z.enum([
    "analyze",
    "find_hotspots",
    "check_patterns",
  ]).describe(
    "Performance analysis action. " +
    "'analyze' — full performance audit of files: hot loops, N+1 queries, memory leaks, inefficient patterns. " +
    "'find_hotspots' — identifies the most performance-critical code sections (deep nesting, heavy computation). " +
    "'check_patterns' — scans for known anti-patterns: sync I/O in async, blocking calls, unnecessary re-renders, etc.",
  ),
  files: z
    .array(z.string())
    .optional()
    .describe("Files to analyze. If not provided, analyzes recently changed files."),
})

type PerfIssue = {
  severity: "critical" | "warning" | "info"
  file: string
  line: number | null
  category: string
  pattern: string
  message: string
  suggestion: string
  estimatedImpact: "high" | "medium" | "low"
}

// Performance anti-patterns
const PERF_PATTERNS: {
  regex: RegExp
  severity: PerfIssue["severity"]
  category: string
  pattern: string
  message: string
  suggestion: string
  estimatedImpact: PerfIssue["estimatedImpact"]
}[] = [
  // N+1 query patterns
  {
    regex: /(?:for|forEach|map)\s*\([^)]*\)\s*\{[^}]*(?:await\s+|(?:query|find|fetch|select|execute)\s*\()/s,
    severity: "critical",
    category: "n-plus-1",
    pattern: "N+1 Query/Request",
    message: "Async operation (query/fetch) inside a loop — classic N+1 problem. Each iteration makes a separate request.",
    suggestion: "Batch the operations: collect all IDs/keys, make one bulk query, then process results. Use JOIN, WHERE IN, or Promise.all.",
    estimatedImpact: "high",
  },
  // Synchronous operations in async context
  {
    regex: /(?:async\s+\w+\s*\([^)]*\)\s*=>\s*\{|async\s+function\s+\w+\s*\([^)]*\)\s*\{)[^}]*\b(?:readFileSync|writeFileSync|execSync|spawnSync)\s*\(/s,
    severity: "warning",
    category: "sync-in-async",
    pattern: "Sync I/O in Async",
    message: "Synchronous file/system call inside async function — blocks the event loop.",
    suggestion: "Use the async counterparts: readFile, writeFile, exec, spawn. Or use worker threads for CPU-bound work.",
    estimatedImpact: "high",
  },
  // Unbounded array operations
  {
    regex: /\.filter\s*\([^)]*\)\s*\.map\s*\([^)]*\)\s*\.filter\s*\(/g,
    severity: "warning",
    category: "chained-iterations",
    pattern: "Chained Array Iterations",
    message: "Multiple chained .filter().map().filter() creates intermediate arrays — O(n) per operation.",
    suggestion: "Combine into a single .reduce() or use a for loop to avoid allocating intermediate arrays.",
    estimatedImpact: "medium",
  },
  // Spread in loops
  {
    regex: /(?:for|while|map|forEach)\s*\([^)]*\)\s*\{[^}]*\[\s*\.\.\.(?:\w+|[^,]+),/s,
    severity: "warning",
    category: "spread-in-loop",
    pattern: "Array Spread in Loop",
    message: "Array spread operator [...] inside a loop creates a new array copy each iteration — O(n^2) total.",
    suggestion: "Use .push() or .concat() outside the loop, or build the array differently.",
    estimatedImpact: "high",
  },
  // JSON.parse/stringify in hot paths
  {
    regex: /JSON\.(parse|stringify)\s*\(/g,
    severity: "info",
    category: "json-serialize",
    pattern: "JSON Serialization",
    message: "JSON.parse/stringify can be slow for large objects. Detected in code — verify it's not in a hot path.",
    suggestion: "For repeated serialization, consider using a faster library (e.g., msgpackr) or caching the result.",
    estimatedImpact: "medium",
  },
  // Regex without cache
  {
    regex: /new\s+RegExp\s*\([^)]+\)\s*[;,}\n]/g,
    severity: "info",
    category: "regex-creation",
    pattern: "Dynamic RegExp Creation",
    message: "RegExp created with 'new' — if called repeatedly, regex compilation overhead adds up.",
    suggestion: "Move regex creation outside the loop/function. Use a regex literal if the pattern is static.",
    estimatedImpact: "low",
  },
  // Large object allocations in loops
  {
    regex: /(?:for|while|map|forEach)\s*\([^)]*\)\s*\{[^}]*return\s*\{[^}]{50,}/s,
    severity: "info",
    category: "large-allocation",
    pattern: "Large Object in Loop",
    message: "Large object literal created inside a loop — consider if object pooling or reuse is possible.",
    suggestion: "If objects are similar, consider reusing and mutating, or use a factory function.",
    estimatedImpact: "low",
  },
  // Unnecessary await
  {
    regex: /return\s+await\s+/g,
    severity: "info",
    category: "unnecessary-await",
    pattern: "Return Await",
    message: "'return await' is unnecessary in most cases — adds one extra microtask tick.",
    suggestion: "Use 'return' directly unless inside a try/catch where you need to catch the rejection.",
    estimatedImpact: "low",
  },
  // Promise.all opportunities
  {
    regex: /await\s+\w+\s*\([^)]*\)\s*;\s*\n\s*await\s+\w+\s*\([^)]*\)\s*;\s*\n\s*await\s+\w+\s*\([^)]*\)/gs,
    severity: "warning",
    category: "sequential-async",
    pattern: "Sequential Async Calls",
    message: "Multiple consecutive await calls — these could run in parallel with Promise.all().",
    suggestion: "Wrap independent async calls in Promise.all([...]) to execute them concurrently.",
    estimatedImpact: "high",
  },
  // Substring/split in hot paths
  {
    regex: /(?:for|while|map|filter|reduce|forEach)\s*\([^)]*\)\s*\{[^}]*\.\.(split|substring|substr|slice)\s*\(/s,
    severity: "info",
    category: "string-ops-in-loop",
    pattern: "String Ops in Loop",
    message: "String operations (split/substring/slice) inside a loop can be expensive for large data.",
    suggestion: "Consider caching results, using indexes, or processing strings outside the loop.",
    estimatedImpact: "medium",
  },
  // Missing debounce/throttle on event handlers
  {
    regex: /\.(?:addEventListener|on\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\w*)\s*\{[^}]*(?:fetch|axios|XMLHttpRequest|request)/s,
    severity: "warning",
    category: "missing-debounce",
    pattern: "Missing Debounce/Throttle",
    message: "Network request in event handler without debounce/throttle — rapid firing will flood the server.",
    suggestion: "Wrap the handler with debounce (for input) or throttle (for scroll/resize) from lodash or a utility.",
    estimatedImpact: "medium",
  },
  // Memory leak patterns
  {
    regex: /setInterval\s*\([^)]+\)\s*(?![^;]*clearInterval)/gs,
    severity: "warning",
    category: "memory-leak",
    pattern: "Uncleared Interval",
    message: "setInterval without corresponding clearInterval — potential memory leak if the component doesn't clean up.",
    suggestion: "Store the interval ID and call clearInterval in cleanup/unmount/destroy.",
    estimatedImpact: "medium",
  },
  {
    regex: /addEventListener\s*\([^)]+\)\s*(?![^;]*removeEventListener)/gs,
    severity: "warning",
    category: "memory-leak",
    pattern: "Uncleared Event Listener",
    message: "addEventListener without removeEventListener — potential memory leak.",
    suggestion: "Remove event listeners in cleanup/unmount. Consider using AbortController.",
    estimatedImpact: "medium",
  },
  {
    regex: /new\s+Map\s*\(\s*\)\s*;\s*\n(?!.*\.clear\(\))[\s\S]{0,200}(?:for|while|push|set)/s,
    severity: "info",
    category: "memory-leak",
    pattern: "Growing Map/Set",
    message: "Map/Set that only grows without bounds — potential memory leak for long-running processes.",
    suggestion: "Implement cleanup/eviction (LRU, TTL), or clear when no longer needed.",
    estimatedImpact: "medium",
  },
  // Unoptimized React patterns
  {
    regex: /(?:const|let)\s+\[\s*\w+\s*,\s*set\w+\s*\]\s*=\s*useState\s*\(/g,
    severity: "info",
    category: "react-state",
    pattern: "Multiple useState",
    message: "Multiple useState calls — consider useReducer for related state to avoid unnecessary re-renders.",
    suggestion: "Group related state into a single useReducer, or use a single state object.",
    estimatedImpact: "medium",
  },
  {
    regex: /<\w+\s+[^>]*onChange=\{[^}]*\}\s*[^>]*>\s*{[^}]*\.map\s*\(/s,
    severity: "warning",
    category: "react-rerender",
    pattern: "Inline Handler with Map",
    message: "Inline function handler on parent element with .map() children — causes all children to re-render.",
    suggestion: "Use React.memo on child components, or memoize the handler with useCallback.",
    estimatedImpact: "medium",
  },
  // Database query patterns
  {
    regex: /(?:SELECT|find|query)\s*\*\s*(?:FROM|[\(])/gi,
    severity: "warning",
    category: "select-star",
    pattern: "SELECT *",
    message: "SELECT * fetches all columns — wasteful if only a few are needed.",
    suggestion: "Specify only the columns you need. Reduces data transfer and memory usage.",
    estimatedImpact: "medium",
  },
  {
    regex: /(?:\.find\w*\s*\(\s*\{[^}]*\}\s*\)|\.findOne\w*\s*\(\s*\{[^}]*\}\s*\)).*(?:\.\s*find\w*\s*\(\s*\{)/s,
    severity: "warning",
    category: "n-plus-1-db",
    pattern: "Sequential DB Queries",
    message: "Multiple sequential database queries — could be a N+1 query problem.",
    suggestion: "Use JOIN, population, or include to fetch related data in fewer queries.",
    estimatedImpact: "high",
  },
  // Caching opportunities
  {
    regex: /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{[^}]*(?:fetch|axios|request|query)\s*\([^)]*\)[^}]*\n\s*\}/s,
    severity: "info",
    category: "no-cache",
    pattern: "No Caching",
    message: "Function makes a network/DB call without any caching — called repeatedly, this is wasteful.",
    suggestion: "Add memoization, caching layer, or use SWR/React Query for data fetching.",
    estimatedImpact: "medium",
  },
]

function analyzeHotspots(content: string, filePath: string): PerfIssue[] {
  const issues: PerfIssue[] = []
  const lines = content.split("\n")

  // Deep nesting (indicator of complex logic)
  let maxDepth = 0
  let currentDepth = 0
  let hotLine = 0
  for (let i = 0; i < lines.length; i++) {
    const opens = (lines[i].match(/\b(?:if|for|while|switch|try|catch|async)\b/g) || []).length
    const closes = (lines[i].match(/\}/g) || []).length
    currentDepth += opens - closes
    if (currentDepth < 0) currentDepth = 0
    if (currentDepth > maxDepth) {
      maxDepth = currentDepth
      hotLine = i + 1
    }
  }
  if (maxDepth > 4) {
    issues.push({
      severity: "warning",
      file: filePath,
      line: hotLine,
      category: "complexity-hotspot",
      pattern: "Deep Nesting Hotspot",
      message: `Code nesting reaches depth ${maxDepth} — this is a performance and readability hotspot. Deep nesting often indicates complex logic that could be slow.`,
      suggestion: "Use early returns, guard clauses, or extract nested blocks into separate functions.",
      estimatedImpact: "medium",
    })
  }

  // Long functions
  const funcMatches = [...content.matchAll(/(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)/g)]
  for (const match of funcMatches) {
    const name = match[1] || match[2]
    const startPos = match.index!
    const startLine = content.substring(0, startPos).split("\n").length

    let braceCount = 0
    let endPos = startPos
    let foundOpen = false
    for (let i = startPos; i < content.length; i++) {
      if (content[i] === "{") { braceCount++; foundOpen = true }
      if (content[i] === "}") { braceCount-- }
      if (foundOpen && braceCount === 0) { endPos = i; break }
    }
    const endLine = content.substring(0, endPos).split("\n").length
    const funcLength = endLine - startLine

    if (funcLength > 100) {
      issues.push({
        severity: "warning",
        file: filePath,
        line: startLine,
        category: "long-function",
        pattern: "Long Function Hotspot",
        message: `Function '${name}' is ${funcLength} lines long — likely a performance and maintainability hotspot.`,
        suggestion: "Break into smaller, focused functions. Long functions often contain hidden performance issues.",
        estimatedImpact: "medium",
      })
    }
  }

  // Loops with heavy operations
  const loopMatches = [...content.matchAll(/(?:for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\(|\.filter\s*\(|\.reduce\s*\()/g)]
  for (const match of loopMatches) {
    const loopStart = match.index!
    const loopEnd = Math.min(loopStart + 2000, content.length)
    const loopBody = content.substring(loopStart, loopEnd)
    const lineNum = content.substring(0, loopStart).split("\n").length

    // Check for heavy operations inside loops
    const heavyOps: string[] = []
    if (/JSON\.(parse|stringify)/.test(loopBody)) heavyOps.push("JSON serialization")
    if (/new\s+RegExp/.test(loopBody)) heavyOps.push("RegExp creation")
    if (/\[\s*\.\.\./.test(loopBody)) heavyOps.push("array spread")
    if (/(?:await\s+|(?:query|find|fetch|select)\s*\()/.test(loopBody)) heavyOps.push("async/DB operation")
    if (/Object\.(assign|keys|values|entries)/.test(loopBody)) heavyOps.push("Object operation")

    if (heavyOps.length >= 2) {
      issues.push({
        severity: "warning",
        file: filePath,
        line: lineNum,
        category: "heavy-loop",
        pattern: "Heavy Loop",
        message: `Loop contains multiple heavy operations: ${heavyOps.join(", ")}`,
        suggestion: "Consider moving heavy operations outside the loop, caching results, or using a different algorithm.",
        estimatedImpact: "high",
      })
    }
  }

  return issues
}

function formatPerfReport(issues: PerfIssue[], action: string): string {
  if (issues.length === 0) {
    return "No performance issues detected. Code looks optimized!"
  }

  const critical = issues.filter((i) => i.severity === "critical")
  const warnings = issues.filter((i) => i.severity === "warning")
  const infos = issues.filter((i) => i.severity === "info")
  const highImpact = issues.filter((i) => i.estimatedImpact === "high")

  const lines: string[] = []
  lines.push(`Performance Analysis Report (${action})`)
  lines.push(`${"=".repeat(55)}`)
  lines.push(`  Critical:     ${critical.length}`)
  lines.push(`  Warnings:     ${warnings.length}`)
  lines.push(`  Info:         ${infos.length}`)
  lines.push(`  High Impact:  ${highImpact.length}`)
  lines.push("")

  if (critical.length > 0) {
    lines.push("CRITICAL (fix immediately — major performance impact):")
    for (const issue of critical) {
      lines.push(`  [${issue.estimatedImpact.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""}`)
      lines.push(`    Pattern: ${issue.pattern} [${issue.category}]`)
      lines.push(`    ${issue.message}`)
      lines.push(`    Suggestion: ${issue.suggestion}`)
      lines.push("")
    }
  }

  if (warnings.length > 0) {
    lines.push("WARNINGS (should fix — noticeable impact):")
    for (const issue of warnings) {
      lines.push(`  [${issue.estimatedImpact.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""}`)
      lines.push(`    Pattern: ${issue.pattern} [${issue.category}]`)
      lines.push(`    ${issue.message}`)
      lines.push(`    Suggestion: ${issue.suggestion}`)
      lines.push("")
    }
  }

  if (infos.length > 0) {
    lines.push("OPTIMIZATION OPPORTUNITIES:")
    for (const issue of infos) {
      lines.push(`  [${issue.estimatedImpact.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""}`)
      lines.push(`    ${issue.pattern}: ${issue.message}`)
      lines.push("")
    }
  }

  if (highImpact.length > 0) {
    lines.push(`${"=".repeat(55)}`)
    lines.push(`PRIORITY: Fix ${highImpact.length} high-impact issue(s) first for maximum performance gain.`)
  }

  return lines.join("\n")
}

export const PerfAnalyzeTool = Tool.define(
  "perf_analyze",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Professional performance analysis tool — finds bottlenecks and anti-patterns that Claude Code misses. " +
        "'analyze' — full performance audit: N+1 queries, sync I/O in async, memory leaks, inefficient loops, caching opportunities. " +
        "'find_hotspots' — identifies the most performance-critical code sections based on complexity and operation density. " +
        "'check_patterns' — scans for 18+ known anti-patterns with specific fix suggestions and impact estimates. " +
        "Each issue includes severity, estimated impact (high/medium/low), and a concrete fix suggestion.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const worktree = Instance.worktree
          let targetFiles = params.files ?? []

          // If no files specified, get changed files from git
          if (targetFiles.length === 0) {
            try {
              const { ChildProcessSpawner } = yield* Effect.promise(() =>
                import("effect/unstable/process/ChildProcessSpawner"),
              )
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
              const proc = yield* spawner.spawn(
                { command: "git", args: ["diff", "--name-only", "HEAD"], options: { cwd: worktree, shell: false } },
              )
              const chunks: string[] = []
              yield* Effect.forkScoped(
                Effect.async<void>((resume) => {
                  const handler = (chunk: string) => { chunks.push(chunk) }
                  proc.stdout.subscribe(handler)
                  proc.exitCode.then(() => {
                    proc.stdout.unsubscribe(handler)
                    resume(Effect.void)
                  })
                }),
              )
              yield* proc.exitCode.pipe(Effect.timeout("10 seconds"), Effect.catch(() => Effect.succeed(null)))
              const output = chunks.join("").trim()
              targetFiles = output.split("\n").filter((f) => f.length > 0)
            } catch { /* skip */ }
          }

          if (targetFiles.length === 0) {
            return {
              title: "Perf Analyze: no files",
              output: "No files specified and no uncommitted changes. Provide file paths.",
              metadata: { action: params.action, files: 0 },
            }
          }

          const allIssues: PerfIssue[] = []

          for (const filePath of targetFiles) {
            const target = path.isAbsolute(filePath) ? filePath : path.join(SessionCwd.get(ctx.sessionID), filePath)
            const resolved = path.resolve(target)
            const relPath = path.relative(worktree, resolved)
            const ext = path.extname(resolved).toLowerCase()

            const textExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".vue", ".svelte"]
            if (!textExtensions.includes(ext)) continue

            const exists = yield* fs.existsSafe(resolved)
            if (!exists) continue

            const content = yield* fs.readFileString(resolved)

            switch (params.action) {
              case "find_hotspots":
                allIssues.push(...analyzeHotspots(content, relPath))
                break

              case "check_patterns":
              case "analyze":
              default: {
                // Run pattern matching
                for (const pattern of PERF_PATTERNS) {
                  pattern.regex.lastIndex = 0
                  let match
                  while ((match = pattern.regex.exec(content)) !== null) {
                    const lineNum = content.substring(0, match.index).split("\n").length
                    const lineContent = content.split("\n")[lineNum - 1]?.trim() || ""
                    if (lineContent.startsWith("//") || lineContent.startsWith("*")) continue

                    allIssues.push({
                      severity: pattern.severity,
                      file: relPath,
                      line: lineNum,
                      category: pattern.category,
                      pattern: pattern.pattern,
                      message: pattern.message,
                      suggestion: pattern.suggestion,
                      estimatedImpact: pattern.estimatedImpact,
                    })
                  }
                }

                if (params.action === "analyze") {
                  allIssues.push(...analyzeHotspots(content, relPath))
                }
                break
              }
            }
          }

          // Deduplicate
          const seen = new Set<string>()
          const uniqueIssues = allIssues.filter((issue) => {
            const key = `${issue.file}:${issue.line}:${issue.category}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

          // Sort: critical first, then by impact
          const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
          const impactOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
          uniqueIssues.sort((a, b) => {
            const sd = severityOrder[a.severity] - severityOrder[b.severity]
            if (sd !== 0) return sd
            return impactOrder[a.estimatedImpact] - impactOrder[b.estimatedImpact]
          })

          const report = formatPerfReport(uniqueIssues, params.action)

          return {
            title: uniqueIssues.some((i) => i.severity === "critical")
              ? `Perf: ${uniqueIssues.filter((i) => i.severity === "critical").length} critical issue(s)`
              : uniqueIssues.some((i) => i.estimatedImpact === "high")
                ? `Perf: ${uniqueIssues.filter((i) => i.estimatedImpact === "high").length} high-impact issue(s)`
                : `Perf: ${uniqueIssues.length} issue(s)`,
            output: report,
            metadata: {
              action: params.action,
              filesAnalyzed: targetFiles.length,
              totalIssues: uniqueIssues.length,
              critical: uniqueIssues.filter((i) => i.severity === "critical").length,
              warnings: uniqueIssues.filter((i) => i.severity === "warning").length,
              highImpact: uniqueIssues.filter((i) => i.estimatedImpact === "high").length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)