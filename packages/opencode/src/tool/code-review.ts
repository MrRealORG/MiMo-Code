import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { Log } from "../util"

const log = Log.create({ service: "code-review-tool" })

const Parameters = z.object({
  action: z.enum([
    "review_files",
    "find_bugs",
    "analyze_complexity",
    "check_security",
    "full_audit",
  ]).describe(
    "Review action to perform. " +
    "'review_files' — review specific files for bugs, style issues, and improvements. " +
    "'find_bugs' — focused bug detection: null refs, type mismatches, unhandled errors, race conditions. " +
    "'analyze_complexity' — cyclomatic complexity and code smell detection. " +
    "'check_security' — security audit: injection, hardcoded secrets, unsafe patterns. " +
    "'full_audit' — comprehensive review combining all checks above.",
  ),
  files: z
    .array(z.string())
    .optional()
    .describe("List of file paths to review. If not provided, reviews all recently changed files (from git diff)."),
  focus: z
    .string()
    .optional()
    .describe("Focus area for the review (e.g., 'error handling', 'performance', 'type safety', 'memory leaks'). Only used with 'review_files' action."),
})

type ReviewIssue = {
  severity: "critical" | "warning" | "info" | "suggestion"
  file: string
  line: number | null
  category: string
  message: string
  fix?: string
}

type BugPattern = {
  regex: RegExp
  severity: ReviewIssue["severity"]
  category: string
  message: string
  fix?: string
}

// Common bug patterns across languages
const BUG_PATTERNS: BugPattern[] = [
  // Null/undefined issues
  { regex: /\.(\w+)\s*\(/s, severity: "warning", category: "null-safety", message: "Possible null reference — ensure the object is not null/undefined before accessing property" },
  { regex: /(?:if|while|&&|\|\|)\s*\([^)]*==\s*null[^)]*\)\s*[^;{}]*\.\w+\(/s, severity: "warning", category: "null-safety", message: "Accessing property after null check without else/return — could be null if check fails" },

  // Error handling
  { regex: /catch\s*\([^)]*\)\s*\{\s*\}/s, severity: "warning", category: "error-handling", message: "Empty catch block — errors are silently swallowed", fix: "Add logging or re-throw the error" },
  { regex: /\.then\([^)]*\)(?!\s*\.catch)/s, severity: "warning", category: "error-handling", message: "Promise chain without .catch() — unhandled rejection risk", fix: "Add .catch() handler or wrap in try/catch" },
  { regex: /new\s+Promise\s*\(\s*\(\s*(?:resolve|reject)\s*(?:,\s*(?:resolve|reject)\s*)?\)\s*=>\s*\{/s, severity: "info", category: "error-handling", message: "Consider using async/await instead of explicit Promise constructor" },

  // Type safety
  { regex: /as\s+any\b/g, severity: "warning", category: "type-safety", message: "'as any' bypasses type checking — use a proper type or unknown with type guard", fix: "Replace with proper type assertion or type guard" },
  { regex: /@ts-ignore|@ts-nocheck/g, severity: "warning", category: "type-safety", message: "TypeScript error suppression — fix the underlying type error instead" },

  // Security
  { regex: /(?:password|secret|api[_-]?key|token|auth)\s*[:=]\s*["'][^"']{3,}["']/gi, severity: "critical", category: "security", message: "Possible hardcoded secret/credential — use environment variables", fix: "Move to .env file and use process.env" },
  { regex: /eval\s*\(/g, severity: "critical", category: "security", message: "eval() is a security risk — use safer alternatives", fix: "Use JSON.parse, Function constructor, or template literals" },
  { regex: /innerHTML\s*=/g, severity: "warning", category: "security", message: "Direct innerHTML assignment — XSS risk if value is user-provided", fix: "Use textContent or a sanitization library" },
  { regex: /document\.write\s*\(/g, severity: "warning", category: "security", message: "document.write() is unsafe and deprecated", fix: "Use DOM manipulation methods instead" },
  { regex: /dangerouslySetInnerHTML/g, severity: "info", category: "security", message: "React dangerouslySetInnerHTML — ensure value is sanitized" },

  // Resource leaks
  { regex: /addEventListener\s*\([^)]+\)\s*(?![^;]*removeEventListener)/s, severity: "info", category: "resource-leak", message: "Event listener added without corresponding removeEventListener — potential memory leak" },
  { regex: /setInterval\s*\(/g, severity: "info", category: "resource-leak", message: "setInterval found — ensure it is cleared with clearInterval when done" },
  { regex: /new\s+WebSocket\s*\(/g, severity: "info", category: "resource-leak", message: "WebSocket created — ensure it is closed on cleanup" },

  // Async issues
  { regex: /await\s+await\s+/g, severity: "warning", category: "async", message: "Double await — unnecessary, remove the inner await" },
  { regex: /for\s*\([^)]*\)\s*\{[^}]*await\s+/s, severity: "warning", category: "async", message: "Sequential awaits in loop — consider Promise.all() for parallelism if operations are independent" },
  { regex: /async\s+\w+\s*\([^)]*\)\s*\{[^}]*return\s+(?!\w)[^}]*\}/s, severity: "info", category: "async", message: "Async function without await — unnecessary async keyword" },

  // Common mistakes
  { regex: /if\s*\([^)]*=\s*[^=][^)]*\)/g, severity: "critical", category: "bug", message: "Assignment in if condition — did you mean === (comparison)?" },
  { regex: /==(?!=)/g, severity: "info", category: "bug", message: "Loose equality (==) — use strict equality (===) instead", fix: "Replace == with === (and != with !==)" },
  { regex: /console\.(log|debug|info|warn|error)\s*\([^)]*\)\s*;?\s*\n\s*console\.(log|debug|info|warn|error)/g, severity: "info", category: "cleanup", message: "Multiple console.log statements — consider removing debug logging for production" },
  { regex: /TODO|FIXME|HACK|XXX/g, severity: "info", category: "cleanup", message: "TODO/FIXME/HACK comment found — resolve before shipping" },

  // Performance
  { regex: /document\.querySelector\s*\([^)]*\)\s*(?![^;]*querySelector)/s, severity: "info", category: "performance", message: "Repeated querySelector calls — cache the element reference" },
  { regex: /\.\s*forEach\s*\(\s*\w\s*=>\s*\{[^}]*\.push\s*\(/s, severity: "info", category: "performance", message: "Array.push inside forEach — consider using .map() or .filter() instead" },
]

// Security-focused patterns
const SECURITY_PATTERNS: BugPattern[] = [
  { regex: /(?:password|passwd|pwd|secret|api[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"']+["']/gi, severity: "critical", category: "hardcoded-secret", message: "Hardcoded secret detected — move to environment variable or secret manager" },
  { regex: /eval\s*\(/g, severity: "critical", category: "code-injection", message: "eval() allows arbitrary code execution" },
  { regex: /new\s+Function\s*\(/g, severity: "critical", category: "code-injection", message: "Function constructor allows arbitrary code execution" },
  { regex: /innerHTML\s*=\s*(?![^;]*sanitize)/g, severity: "warning", category: "xss", message: "Unsanitized innerHTML assignment — XSS vulnerability" },
  { regex: /document\.write\s*\(/g, severity: "warning", category: "xss", message: "document.write can lead to XSS" },
  { regex: /req\.(?:query|body|params)\.\w+(?!\s*(?:\?|\.))/g, severity: "warning", category: "input-validation", message: "User input used without validation — sanitize and validate all user inputs" },
  { regex: /SELECT\s+.*\+.*FROM/gi, severity: "critical", category: "sql-injection", message: "String concatenation in SQL query — use parameterized queries" },
  { regex: /curl\s+.*\$\{/g, severity: "warning", category: "command-injection", message: "Variable in shell command — use proper escaping or safe APIs" },
  { regex: /child_process\.(?:exec|spawn)\s*\(/g, severity: "warning", category: "command-injection", message: "Child process execution — ensure input is sanitized" },
  { regex: /fs\.(?:readFile|writeFile|unlink|access)\s*\([^),]*(?:req\.|params\.|query\.|body\.)/g, severity: "warning", category: "path-traversal", message: "User input in file system path — path traversal risk" },
  { regex: /cors\(\s*\{\s*origin:\s*["']\*["']/gi, severity: "warning", category: "cors", message: "Wildcard CORS origin — restrict to specific domains in production" },
  { regex: /Access-Control-Allow-Origin:\s*\*/g, severity: "warning", category: "cors", message: "Wildcard CORS header — restrict in production" },
  { regex: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/g, severity: "info", category: "transport", message: "Non-HTTPS URL detected — use HTTPS for production" },
  { regex: /skipLibCheck\s*:\s*true/g, severity: "info", category: "dependencies", message: "skipLibCheck is true — type errors in dependencies may go unnoticed" },
]

function getComplexityIndicators(content: string, filePath: string): ReviewIssue[] {
  const issues: ReviewIssue[] = []
  const lines = content.split("\n")

  // Check function lengths
  const functionRegex = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/g
  let match
  const functions: { name: string; startLine: number; endLine: number }[] = []

  while ((match = functionRegex.exec(content)) !== null) {
    const name = match[1] || match[2]
    const startPos = match.index
    const startLine = content.substring(0, startPos).split("\n").length

    // Find the function body (simple heuristic)
    let braceCount = 0
    let endPos = startPos
    let foundOpenBrace = false
    for (let i = startPos; i < content.length; i++) {
      if (content[i] === "{") { braceCount++; foundOpenBrace = true }
      if (content[i] === "}") { braceCount-- }
      if (foundOpenBrace && braceCount === 0) { endPos = i; break }
    }
    const endLine = content.substring(0, endPos).split("\n").length
    functions.push({ name: name || "anonymous", startLine, endLine })
  }

  // Flag long functions (>50 lines)
  for (const fn of functions) {
    const length = fn.endLine - fn.startLine
    if (length > 80) {
      issues.push({
        severity: "warning",
        file: filePath,
        line: fn.startLine,
        category: "complexity",
        message: `Function '${fn.name}' is ${length} lines long — consider breaking into smaller functions (target: <50 lines)`,
        fix: "Extract logical blocks into helper functions",
      })
    } else if (length > 50) {
      issues.push({
        severity: "info",
        file: filePath,
        line: fn.startLine,
        category: "complexity",
        message: `Function '${fn.name}' is ${length} lines — consider splitting if logic is complex`,
      })
    }
  }

  // Check nesting depth
  let maxNesting = 0
  let currentNesting = 0
  for (const line of lines) {
    const opens = (line.match(/\b(?:if|for|while|switch|try|catch)\b/g) || []).length
    const closes = (line.match(/\b(?:}\s*else|}\s*catch|}\s*finally)\b/g) || []).length
    currentNesting += opens - closes
    if (currentNesting < 0) currentNesting = 0
    maxNesting = Math.max(maxNesting, currentNesting)
  }

  if (maxNesting > 4) {
    issues.push({
      severity: "warning",
      file: filePath,
      line: null,
      category: "complexity",
      message: `Deep nesting detected (depth: ${maxNesting}) — consider early returns, guard clauses, or extracting functions`,
      fix: "Use early returns / guard clauses to reduce nesting",
    })
  }

  // Check file length
  if (lines.length > 500) {
    issues.push({
      severity: "info",
      file: filePath,
      line: null,
      category: "complexity",
      message: `File is ${lines.length} lines — consider splitting into modules (target: <300 lines)`,
    })
  }

  // Check for too many parameters in functions
  const paramRegex = /(?:function\s+\w+|(?:const|let)\s+\w+\s*=\s*(?:async\s+)?)\(([^)]*)\)/g
  while ((match = paramRegex.exec(content)) !== null) {
    const params = match[1].split(",").filter((p) => p.trim().length > 0)
    if (params.length > 5) {
      const lineNum = content.substring(0, match.index).split("\n").length
      issues.push({
        severity: "info",
        file: filePath,
        line: lineNum,
        category: "complexity",
        message: `Function has ${params.length} parameters — consider using an options object`,
        fix: "Group related parameters into a config/options object",
      })
    }
  }

  // Check for code smells
  const codeSmells: { pattern: RegExp; message: string; severity: ReviewIssue["severity"] }[] = [
    { pattern: /if\s*\([^)]*\)\s*\{\s*return\s+true\s*;\s*\}\s*else\s*\{\s*return\s+false\s*;\s*\}/s, message: "Unnecessary if/else returning boolean — return the condition directly", severity: "info" },
    { pattern: /if\s*\(\s*condition\s*\)\s*\{\s*\w+\s*=\s*true\s*;\s*\}\s*else\s*\{\s*\w+\s*=\s*false\s*;\s*\}/s, message: "Boolean assignment via if/else — assign condition directly", severity: "info" },
    { pattern: /typeof\s+\w+\s*===?\s*["']undefined["']\s*&&\s*\w+\s*!==\s*null/g, message: "Redundant null check with typeof undefined — use `!= null` for both null and undefined", severity: "info" },
  ]

  for (const smell of codeSmells) {
    if (smell.pattern.test(content)) {
      issues.push({
        severity: smell.severity,
        file: filePath,
        line: null,
        category: "code-smell",
        message: smell.message,
      })
    }
  }

  return issues
}

function runPatternAnalysis(content: string, filePath: string, patterns: BugPattern[]): ReviewIssue[] {
  const issues: ReviewIssue[] = []
  const lines = content.split("\n")

  for (const pattern of patterns) {
    // Reset regex state
    pattern.regex.lastIndex = 0
    let match
    while ((match = pattern.regex.exec(content)) !== null) {
      // Calculate line number from match position
      const lineNum = content.substring(0, match.index).split("\n").length
      const lineContent = lines[lineNum - 1]?.trim() || ""

      // Skip comment lines
      if (lineContent.startsWith("//") || lineContent.startsWith("*") || lineContent.startsWith("/*")) continue

      issues.push({
        severity: pattern.severity,
        file: filePath,
        line: lineNum,
        category: pattern.category,
        message: pattern.message,
        fix: pattern.fix,
      })
    }
  }

  // Deduplicate: same line, same category
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.file}:${issue.line}:${issue.category}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function formatReport(issues: ReviewIssue[], action: string): string {
  if (issues.length === 0) {
    return "No issues found. Code looks clean!"
  }

  const critical = issues.filter((i) => i.severity === "critical")
  const warnings = issues.filter((i) => i.severity === "warning")
  const infos = issues.filter((i) => i.severity === "info")
  const suggestions = issues.filter((i) => i.severity === "suggestion")

  const lines: string[] = []

  lines.push(`Code Review Report (${action})`)
  lines.push(`${"=".repeat(50)}`)
  lines.push(`  Critical:   ${critical.length}`)
  lines.push(`  Warnings:   ${warnings.length}`)
  lines.push(`  Info:       ${infos.length}`)
  lines.push(`  Suggestions:${suggestions.length}`)
  lines.push("")

  if (critical.length > 0) {
    lines.push("CRITICAL ISSUES (must fix):")
    for (const issue of critical) {
      lines.push(`  [${issue.severity.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""} — [${issue.category}]`)
      lines.push(`    ${issue.message}`)
      if (issue.fix) lines.push(`    Fix: ${issue.fix}`)
      lines.push("")
    }
  }

  if (warnings.length > 0) {
    lines.push("WARNINGS (should fix):")
    for (const issue of warnings) {
      lines.push(`  [${issue.severity.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""} — [${issue.category}]`)
      lines.push(`    ${issue.message}`)
      if (issue.fix) lines.push(`    Fix: ${issue.fix}`)
      lines.push("")
    }
  }

  if (infos.length > 0) {
    lines.push("INFO:")
    for (const issue of infos) {
      lines.push(`  [${issue.severity.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""} — [${issue.category}]`)
      lines.push(`    ${issue.message}`)
      lines.push("")
    }
  }

  if (suggestions.length > 0) {
    lines.push("SUGGESTIONS:")
    for (const issue of suggestions) {
      lines.push(`  [${issue.severity.toUpperCase()}] ${issue.file}${issue.line ? `:${issue.line}` : ""} — [${issue.category}]`)
      lines.push(`    ${issue.message}`)
      lines.push("")
    }
  }

  if (critical.length > 0) {
    lines.push(`${"=".repeat(50)}`)
    lines.push(`ACTION REQUIRED: Fix ${critical.length} critical issue(s) before proceeding.`)
  }

  return lines.join("\n")
}

export const CodeReviewTool = Tool.define(
  "code_review",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Professional code review and bug analysis tool. Performs static analysis to find bugs, " +
        "security vulnerabilities, code smells, and complexity issues. " +
        "Actions: " +
        "'review_files' — general review with optional focus area. " +
        "'find_bugs' — focused bug detection (null refs, type errors, unhandled errors, race conditions). " +
        "'analyze_complexity' — cyclomatic complexity, function length, nesting depth analysis. " +
        "'check_security' — security audit (injection, XSS, hardcoded secrets, path traversal). " +
        "'full_audit' — comprehensive review combining all checks. " +
        "Returns structured report with severity levels, categories, and fix suggestions.",
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
            } catch {
              log.info("Could not get git diff, code review requires explicit file paths")
            }
          }

          if (targetFiles.length === 0) {
            return {
              title: "Code Review: no files to review",
              output: [
                "No files specified and no uncommitted changes detected.",
                "Provide file paths to review, e.g.:",
                "  code_review({ action: 'find_bugs', files: ['src/index.ts', 'src/utils.ts'] })",
              ].join("\n"),
              metadata: { action: params.action, files_reviewed: 0 },
            }
          }

          // Resolve file paths and read content
          const fileContents: { path: string; content: string; relPath: string }[] = []
          for (const filePath of targetFiles) {
            const target = path.isAbsolute(filePath)
              ? filePath
              : path.join(SessionCwd.get(ctx.sessionID), filePath)
            const resolved = path.resolve(target)
            const relPath = path.relative(worktree, resolved)

            const exists = yield* fs.existsSafe(resolved)
            if (!exists) continue

            // Skip binary files
            const ext = path.extname(resolved).toLowerCase()
            const textExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt", ".scala", ".vue", ".svelte"]
            if (!textExtensions.includes(ext)) continue

            const content = yield* fs.readFileString(resolved)
            fileContents.push({ path: resolved, content, relPath })
          }

          if (fileContents.length === 0) {
            return {
              title: "Code Review: no reviewable files",
              output: "No supported source files found to review. Supported: .ts, .tsx, .js, .jsx, .py, .go, .rs, .java, .c, .cpp, .vue, .svelte, and more.",
              metadata: { action: params.action, files_reviewed: 0 },
            }
          }

          const allIssues: ReviewIssue[] = []

          for (const file of fileContents) {
            switch (params.action) {
              case "find_bugs":
              case "full_audit":
                allIssues.push(...runPatternAnalysis(file.content, file.relPath, BUG_PATTERNS))
                if (params.action === "find_bugs") break

              case "check_security":
              case "full_audit":
                allIssues.push(...runPatternAnalysis(file.content, file.relPath, SECURITY_PATTERNS))
                if (params.action === "check_security") break

              case "analyze_complexity":
              case "full_audit":
                allIssues.push(...getComplexityIndicators(file.content, file.relPath))
                if (params.action === "analyze_complexity") break

              case "review_files":
              default:
                // General review: run bug patterns + complexity
                allIssues.push(...runPatternAnalysis(file.content, file.relPath, BUG_PATTERNS))
                allIssues.push(...getComplexityIndicators(file.content, file.relPath))
                break
            }
          }

          // Sort by severity
          const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2, suggestion: 3 }
          allIssues.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4))

          const report = formatReport(allIssues, params.action)
          const criticalCount = allIssues.filter((i) => i.severity === "critical").length
          const warningCount = allIssues.filter((i) => i.severity === "warning").length

          return {
            title: criticalCount > 0
              ? `Code Review: ${criticalCount} critical, ${warningCount} warnings`
              : warningCount > 0
                ? `Code Review: ${warningCount} warnings found`
                : `Code Review: ${allIssues.length} issues (all info)`,
            output: report,
            metadata: {
              action: params.action,
              files_reviewed: fileContents.length,
              total_issues: allIssues.length,
              critical: criticalCount,
              warnings: warningCount,
              info: allIssues.filter((i) => i.severity === "info").length,
              issues: allIssues.map((i) => ({
                severity: i.severity,
                file: i.file,
                line: i.line,
                category: i.category,
                message: i.message,
              })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)