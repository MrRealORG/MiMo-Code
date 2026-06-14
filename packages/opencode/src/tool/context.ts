import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { Log } from "../util"

const log = Log.create({ service: "context-tool" })

const Parameters = z.object({
  action: z.enum([
    "gather",
    "trace_imports",
    "find_dependents",
    "find_tests",
    "file_context",
  ]).describe(
    "Context gathering action. " +
    "'gather' — comprehensive context: imports, dependents, related tests, config, types for a file. " +
    "'trace_imports' — recursively trace all imports of a file (the full dependency tree). " +
    "'find_dependents' — find all files that import/use the given file. " +
    "'find_tests' — find all test files related to the given source file(s). " +
    "'file_context' — get a complete context snapshot: file stats, exports, imports, dependencies, related docs.",
  ),
  files: z
    .array(z.string())
    .describe("File path(s) to analyze context for"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(2)
    .describe("How deep to trace imports/dependents (1=direct only, 2=one level deeper, etc.)"),
  includeTests: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to include related test files in the context"),
})

type ImportInfo = {
  from: string
  imports: string[]
  external: string[]
  internal: string[]
}

type FileContext = {
  path: string
  size: number
  lines: number
  language: string
  exports: string[]
  imports: { module: string; items: string[]; isExternal: boolean }[]
  hasDefaultExport: boolean
  hasTypes: boolean
  hasTests: boolean
  testFiles: string[]
}

function getLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript (React)", ".js": "JavaScript",
    ".jsx": "JavaScript (React)", ".py": "Python", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".rb": "Ruby", ".php": "PHP",
    ".c": "C", ".cpp": "C++", ".cs": "C#", ".swift": "Swift",
    ".kt": "Kotlin", ".vue": "Vue", ".svelte": "Svelte",
  }
  return map[ext] || "Unknown"
}

function parseExports(content: string): { names: string[]; hasDefault: boolean; hasTypes: boolean } {
  const names: string[] = []
  let hasDefault = false
  let hasTypes = false

  // Named exports: export function/class/const/type/interface/enum
  const namedExportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g
  let match
  while ((match = namedExportRegex.exec(content)) !== null) {
    if (content.substring(0, match.index + match[0].length).includes("export default")) {
      hasDefault = true
    }
    names.push(match[1])
  }

  // export default
  if (/export\s+default\s/.test(content)) hasDefault = true

  // Types/interfaces
  if (/\b(?:type|interface|enum)\s+\w+/.test(content)) hasTypes = true

  // export { ... }
  const namedBlockRegex = /export\s*\{([^}]+)\}/g
  while ((match = namedBlockRegex.exec(content)) !== null) {
    const items = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
    names.push(...items)
  }

  return { names, hasDefault, hasTypes }
}

function parseImports(content: string): { module: string; items: string[]; isExternal: boolean }[] {
  const imports: { module: string; items: string[]; isExternal: boolean }[] = []

  // ES imports: import { a, b } from 'module'
  const esImportRegex = /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = esImportRegex.exec(content)) !== null) {
    const items = match[1]
      ? match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : match[2] ? [match[2]] : []
    const mod = match[3]
    imports.push({ module: mod, items, isExternal: !mod.startsWith(".") && !mod.startsWith("/") })
  }

  // Dynamic imports: import('module')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    const mod = match[1]
    imports.push({ module: mod, items: [], isExternal: !mod.startsWith(".") && !mod.startsWith("/") })
  }

  // require()
  const requireRegex = /(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = requireRegex.exec(content)) !== null) {
    const mod = match[1]
    imports.push({ module: mod, items: [], isExternal: !mod.startsWith(".") && !mod.startsWith("/") })
  }

  // Python imports
  const pyImportRegex = /^(?:from\s+(\S+)\s+import\s+(.+)|import\s+(.+))$/gm
  while ((match = pyImportRegex.exec(content)) !== null) {
    if (match[1]) {
      const items = match[2].split(",").map((s) => s.trim()).filter(Boolean)
      imports.push({ module: match[1], items, isExternal: !match[1].startsWith(".") })
    } else if (match[3]) {
      const mods = match[3].split(",").map((s) => s.trim())
      for (const mod of mods) imports.push({ module: mod, items: [], isExternal: true })
    }
  }

  return imports
}

function findTestFile(filePath: string): string[] {
  const ext = path.extname(filePath)
  const base = filePath.replace(ext, "")
  const patterns = [
    `${base}.test${ext}`, `${base}.spec${ext}`,
    `${base}.test.tsx`, `${base}.spec.tsx`,
    `${base}.test.js`, `${base}.spec.js`,
    `${base}_test${ext}`, `${base}_spec${ext}`,
    `test/${path.basename(base)}.test${ext}`,
    `tests/${path.basename(base)}.test${ext}`,
    `__tests__/${path.basename(base)}${ext}`,
    `__tests__/${path.basename(base)}.test${ext}`,
  ]
  return patterns
}

function findSourceFile(testPath: string): string[] {
  const ext = path.extname(testPath)
  const base = testPath
    .replace(ext, "")
    .replace(/\.test$/, "")
    .replace(/\.spec$/, "")
    .replace(/_test$/, "")
    .replace(/_spec$/, "")
  return [`${base}${ext}`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`]
}

export const ContextTool = Tool.define(
  "context",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Intelligent codebase context gathering — the key advantage over other AI coding tools. " +
        "Before writing any code, use this to understand the FULL picture: " +
        "'gather' — gets imports, dependents, related tests, config files, type definitions for given files. " +
        "'trace_imports' — recursively traces the full import/dependency tree to depth N. " +
        "'find_dependents' — finds every file that imports the given file (who uses this). " +
        "'find_tests' — finds all test files related to given source files. " +
        "'file_context' — complete snapshot of a file: stats, exports, imports, deps, related docs. " +
        "Use 'gather' before making changes to understand impact. Use 'find_dependents' before refactoring. " +
        "Use 'trace_imports' to understand the dependency chain.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const worktree = Instance.worktree

          const resolveFile = (filePath: string): string => {
            const target = path.isAbsolute(filePath) ? filePath : path.join(SessionCwd.get(ctx.sessionID), filePath)
            return path.resolve(target)
          }

          const toRelative = (filePath: string): string => path.relative(worktree, filePath)

          const readIfExists = async (filePath: string): Promise<string | null> => {
            try {
              const exists = yield* fs.existsSafe(filePath)
              if (!exists) return null
              return yield* fs.readFileString(filePath)
            } catch {
              return null
            }
          }

          const scanDir = (dir: string, pattern: string): string[] => {
            try {
              const { Glob } = require("@mimo-ai/shared/util/glob")
              return Glob.scanSync(pattern, { cwd: dir, absolute: true, dot: false })
            } catch {
              return []
            }
          }

          switch (params.action) {
            case "gather": {
              // Comprehensive context gathering for multiple files
              const allContexts: FileContext[] = []
              const allDependents: Map<string, string[]> = new Map()
              const allTestFiles: Set<string> = new Set()

              for (const filePath of params.files) {
                const resolved = resolveFile(filePath)
                const relPath = toRelative(resolved)
                const content = yield* readIfExists(resolved)
                if (!content) continue

                const ext = path.extname(resolved)
                const { names, hasDefault, hasTypes } = parseExports(content)
                const imports = parseImports(content)
                const lines = content.split("\n")

                const testPatterns = findTestFile(resolved)
                let hasTests = false
                const foundTests: string[] = []
                for (const tp of testPatterns) {
                  const testExists = yield* fs.existsSafe(tp)
                  if (testExists) {
                    hasTests = true
                    foundTests.push(toRelative(tp))
                    allTestFiles.add(tp)
                  }
                }

                allContexts.push({
                  path: relPath,
                  size: Buffer.byteLength(content, "utf-8"),
                  lines: lines.length,
                  language: getLanguage(ext),
                  exports: names,
                  imports,
                  hasDefaultExport: hasDefault,
                  hasTypes,
                  hasTests,
                  testFiles: foundTests,
                })

                // Find dependents: search for files importing this file
                if (params.depth >= 1) {
                  const fileBasename = path.basename(resolved, ext)
                  const dir = path.dirname(resolved)
                  const parentDir = path.dirname(dir)

                  // Search for import patterns
                  const candidates = scanDir(worktree, "**/*.{ts,tsx,js,jsx}")
                  for (const candidate of candidates) {
                    if (candidate === resolved) continue
                    try {
                      const candidateContent = yield* fs.readFileString(candidate)
                      const importPatterns = [
                        `from '${relPath}'`, `from "${relPath}"`,
                        `from './${path.basename(resolved)}'`, `from "./${path.basename(resolved)}"`,
                        `from '../${path.basename(dir)}/${path.basename(resolved)}'`,
                        `require('${relPath}')`, `require("${relPath}")`,
                      ]
                      const isDependent = importPatterns.some((p) => candidateContent.includes(p))
                      if (isDependent) {
                        if (!allDependents.has(relPath)) allDependents.set(relPath, [])
                        allDependents.get(relPath)!.push(toRelative(candidate))
                      }
                    } catch { /* skip */ }
                  }
                }
              }

              // Find related config files
              const configFiles: string[] = []
              const configPatterns = [
                "tsconfig*.json", "package.json", ".eslintrc*", ".prettierrc*",
                "jest.config.*", "vitest.config.*", "pyproject.toml", "go.mod",
                "Cargo.toml", ".env.example", "docker-compose*.yml",
              ]
              for (const pattern of configPatterns) {
                const found = scanDir(worktree, pattern)
                for (const f of found) configFiles.push(toRelative(f))
              }

              const lines: string[] = []
              lines.push("=== CONTEXT GATHERING REPORT ===")
              lines.push(`Files analyzed: ${params.files.length}`)
              lines.push(`Depth: ${params.depth}`)
              lines.push("")

              for (const ctx of allContexts) {
                lines.push(`--- ${ctx.path} ---`)
                lines.push(`  Language: ${ctx.language} | Lines: ${ctx.lines} | Size: ${ctx.size} bytes`)
                lines.push(`  Exports: ${ctx.exports.length > 0 ? ctx.exports.join(", ") : "(none)"}${ctx.hasDefaultExport ? " + default" : ""}`)
                lines.push(`  Types: ${ctx.hasTypes ? "Yes" : "No"}`)
                lines.push(`  Imports: ${ctx.imports.length} (${ctx.imports.filter((i) => i.isExternal).length} external, ${ctx.imports.filter((i) => !i.isExternal).length} internal)`)
                if (ctx.imports.length > 0) {
                  for (const imp of ctx.imports) {
                    const items = imp.items.length > 0 ? ` {${imp.items.join(", ")}}` : ""
                    lines.push(`    ${imp.isExternal ? "[ext]" : "[int]"} from '${imp.module}'${items}`)
                  }
                }
                lines.push(`  Tests: ${ctx.hasTests ? ctx.testFiles.join(", ") : "No test files found"}`)
                const deps = allDependents.get(ctx.path)
                if (deps && deps.length > 0) {
                  lines.push(`  Used by (${deps.length}): ${deps.slice(0, 10).join(", ")}${deps.length > 10 ? "..." : ""}`)
                }
                lines.push("")
              }

              if (configFiles.length > 0) {
                lines.push("--- PROJECT CONFIG ---")
                for (const cf of configFiles.slice(0, 15)) {
                  lines.push(`  ${cf}`)
                }
                lines.push("")
              }

              if (allTestFiles.size > 0) {
                lines.push("--- RELATED TEST FILES ---")
                for (const tf of allTestFiles) {
                  lines.push(`  ${toRelative(tf)}`)
                }
              }

              return {
                title: `Context: ${params.files.length} file(s) analyzed`,
                output: lines.join("\n"),
                metadata: {
                  action: "gather",
                  files: params.files.length,
                  contexts: allContexts,
                  dependents: Object.fromEntries(allDependents),
                  testFiles: [...allTestFiles].map((f) => toRelative(f)),
                  configFiles,
                },
              }
            }

            case "trace_imports": {
              // Recursively trace imports to a given depth
              const visited = new Set<string>()
              const importTree: { file: string; imports: { module: string; resolved?: string }[] }[] = []

              const traceFile = async (filePath: string, currentDepth: number): Promise<void> => {
                const resolved = path.isAbsolute(filePath) ? filePath : resolveFile(filePath)
                const key = toRelative(resolved)
                if (visited.has(key) || currentDepth > params.depth!) return
                visited.add(key)

                const content = yield* readIfExists(resolved)
                if (!content) return

                const imports = parseImports(content)
                const entry: { file: string; imports: { module: string; resolved?: string }[] } = {
                  file: key,
                  imports: [],
                }

                for (const imp of imports) {
                  if (imp.isExternal) {
                    entry.imports.push({ module: imp.module })
                  } else {
                    // Resolve relative import
                    let resolvedImport: string | undefined
                    try {
                      const dir = path.dirname(resolved)
                      const modPath = imp.module.endsWith(".ts") || imp.module.endsWith(".js")
                        ? imp.module
                        : `${imp.module}.ts`
                      const full = path.resolve(dir, modPath)
                      const exists = yield* fs.existsSafe(full)
                      if (exists) {
                        resolvedImport = toRelative(full)
                        entry.imports.push({ module: imp.module, resolved: resolvedImport })
                        if (currentDepth < params.depth!) {
                          yield* traceFile(full, currentDepth + 1)
                        }
                      } else {
                        entry.imports.push({ module: imp.module })
                      }
                    } catch {
                      entry.imports.push({ module: imp.module })
                    }
                  }
                }

                importTree.push(entry)
              }

              for (const filePath of params.files) {
                yield* traceFile(resolveFile(filePath), 1)
              }

              const lines: string[] = []
              lines.push("=== IMPORT DEPENDENCY TREE ===")
              lines.push(`Root: ${params.files.join(", ")}`)
              lines.push(`Depth: ${params.depth} | Files traced: ${importTree.length}`)
              lines.push("")

              for (const entry of importTree) {
                lines.push(`${entry.file}`)
                for (const imp of entry.imports) {
                  if (imp.resolved) {
                    lines.push(`  ├── ${imp.module} → ${imp.resolved}`)
                  } else {
                    lines.push(`  ├── ${imp.module} [external]`)
                  }
                }
              }

              // Summary
              const externalDeps = new Set<string>()
              const internalDeps = new Set<string>()
              for (const entry of importTree) {
                for (const imp of entry.imports) {
                  if (imp.resolved) internalDeps.add(imp.resolved)
                  else externalDeps.add(imp.module)
                }
              }

              lines.push("")
              lines.push(`Summary: ${internalDeps.size} internal, ${externalDeps.size} external dependencies`)

              return {
                title: `Import Tree: ${importTree.length} files traced`,
                output: lines.join("\n"),
                metadata: {
                  action: "trace_imports",
                  depth: params.depth,
                  filesTraced: importTree.length,
                  externalDeps: [...externalDeps],
                  internalDeps: [...internalDeps],
                },
              }
            }

            case "find_dependents": {
              // Find all files that import the given files
              const sourceFiles = params.files.map((f) => toRelative(resolveFile(f)))
              const dependents: Record<string, string[]> = {}

              for (const src of sourceFiles) {
                dependents[src] = []
              }

              const allSourceFiles = scanDir(worktree, "**/*.{ts,tsx,js,jsx,mjs,cjs}")
              const srcBasename = path.basename(resolveFile(params.files[0]))

              for (const candidate of allSourceFiles) {
                try {
                  const content = yield* fs.readFileString(candidate)
                  const relCandidate = toRelative(candidate)

                  for (const src of sourceFiles) {
                    const srcBasename2 = path.basename(src)
                    const srcDir = path.dirname(src)
                    const patterns = [
                      `from '${src}'`, `from "${src}"`,
                      `from './${srcBasename2}'`, `from "./${srcBasename2}"`,
                      `require('${src}')`, `require("${src}")`,
                    ]
                    // Also try parent dir imports
                    const parentDir = path.dirname(srcDir)
                    if (parentDir !== srcDir) {
                      patterns.push(`from '../${path.basename(srcDir)}/${srcBasename2}'`)
                    }

                    if (patterns.some((p) => content.includes(p))) {
                      if (!dependents[src]) dependents[src] = []
                      dependents[src].push(relCandidate)
                    }
                  }
                } catch { /* skip */ }
              }

              const lines: string[] = []
              lines.push("=== DEPENDENT FILES ===")
              let totalDependents = 0

              for (const [src, deps] of Object.entries(dependents)) {
                lines.push(`\n${src} is used by ${deps.length} file(s):`)
                if (deps.length === 0) {
                  lines.push("  (no dependents found — consider removing if unused)")
                } else {
                  for (const dep of deps) {
                    lines.push(`  ← ${dep}`)
                  }
                }
                totalDependents += deps.length
              }

              lines.push(`\nTotal dependents: ${totalDependents}`)

              return {
                title: `Dependents: ${totalDependents} file(s) found`,
                output: lines.join("\n"),
                metadata: {
                  action: "find_dependents",
                  dependents,
                  total: totalDependents,
                },
              }
            }

            case "find_tests": {
              const testFiles: string[] = []
              const sourceToTests: Record<string, string[]> = {}

              for (const filePath of params.files) {
                const resolved = resolveFile(filePath)
                const relPath = toRelative(resolved)
                sourceToTests[relPath] = []

                const patterns = findTestFile(resolved)
                for (const tp of patterns) {
                  const exists = yield* fs.existsSafe(tp)
                  if (exists) {
                    const rel = toRelative(tp)
                    testFiles.push(rel)
                    sourceToTests[relPath].push(rel)
                  }
                }

                // Also search for test files that import this file
                const allTestCandidates = scanDir(worktree, "**/*.{test,spec}.{ts,tsx,js,jsx}")
                for (const candidate of allTestCandidates) {
                  try {
                    const content = yield* fs.readFileString(candidate)
                    if (content.includes(relPath) || content.includes(path.basename(resolved, path.extname(resolved)))) {
                      const rel = toRelative(candidate)
                      if (!sourceToTests[relPath].includes(rel)) {
                        sourceToTests[relPath].push(rel)
                        if (!testFiles.includes(rel)) testFiles.push(rel)
                      }
                    }
                  } catch { /* skip */ }
                }
              }

              const lines: string[] = []
              lines.push("=== TEST FILE DISCOVERY ===")
              for (const [src, tests] of Object.entries(sourceToTests)) {
                lines.push(`\n${src}:`)
                if (tests.length === 0) {
                  lines.push("  No test files found — consider writing tests!")
                } else {
                  for (const t of tests) {
                    lines.push(`  ✓ ${t}`)
                  }
                }
              }

              return {
                title: `Tests: ${testFiles.length} found`,
                output: lines.join("\n"),
                metadata: {
                  action: "find_tests",
                  testFiles,
                  sourceToTests,
                },
              }
            }

            case "file_context": {
              // Complete context snapshot
              const lines: string[] = []
              lines.push("=== FILE CONTEXT SNAPSHOT ===")

              for (const filePath of params.files) {
                const resolved = resolveFile(filePath)
                const relPath = toRelative(resolved)
                const content = yield* readIfExists(resolved)

                if (!content) {
                  lines.push(`\n${relPath}: FILE NOT FOUND`)
                  continue
                }

                const ext = path.extname(resolved)
                const { names, hasDefault, hasTypes } = parseExports(content)
                const imports = parseImports(content)
                const fileLines = content.split("\n")

                lines.push(`\n═══ ${relPath} ═══`)
                lines.push(`  Type: ${getLanguage(ext)}`)
                lines.push(`  Size: ${Buffer.byteLength(content, "utf-8")} bytes | ${fileLines.length} lines`)
                lines.push(`  Has types: ${hasTypes ? "Yes" : "No"}`)
                lines.push("")
                lines.push("  EXPORTS:")
                if (names.length === 0 && !hasDefault) {
                  lines.push("    (none)")
                } else {
                  for (const name of names) lines.push(`    ${name}`)
                  if (hasDefault) lines.push(`    (default export)`)
                }
                lines.push("")
                lines.push("  IMPORTS:")
                if (imports.length === 0) {
                  lines.push("    (none)")
                } else {
                  const external = imports.filter((i) => i.isExternal)
                  const internal = imports.filter((i) => !i.isExternal)
                  if (external.length > 0) {
                    lines.push("    External:")
                    for (const imp of external) {
                      const items = imp.items.length > 0 ? ` — {${imp.items.join(", ")}}` : ""
                      lines.push(`      ${imp.module}${items}`)
                    }
                  }
                  if (internal.length > 0) {
                    lines.push("    Internal:")
                    for (const imp of internal) {
                      const items = imp.items.length > 0 ? ` — {${imp.items.join(", ")}}` : ""
                      lines.push(`      ${imp.module}${items}`)
                    }
                  }
                }

                // Check for related files
                const dir = path.dirname(resolved)
                const base = path.basename(resolved, ext)
                const siblings = scanDir(dir, `${base}.*`)
                if (siblings.length > 1) {
                  lines.push("")
                  lines.push("  RELATED FILES (same name, different ext):")
                  for (const sib of siblings) {
                    if (sib !== resolved) lines.push(`    ${toRelative(sib)}`)
                  }
                }
              }

              return {
                title: `File Context: ${params.files.length} file(s)`,
                output: lines.join("\n"),
                metadata: {
                  action: "file_context",
                  files: params.files.length,
                },
              }
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)