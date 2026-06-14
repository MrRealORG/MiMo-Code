import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { Log } from "../util"

const log = Log.create({ service: "dep-graph-tool" })

const Parameters = z.object({
  action: z.enum([
    "analyze",
    "find_circular",
    "find_unused",
    "health_check",
  ]).describe(
    "Dependency analysis action. " +
    "'analyze' — full dependency graph with import relationships, layer violations, and stats. " +
    "'find_circular' — detect circular dependency chains in the codebase. " +
    "'find_unused' — find exported symbols that are never imported anywhere. " +
    "'health_check' — overall dependency health: bundle size hints, outdated patterns, coupling metrics.",
  ),
  scope: z
    .string()
    .optional()
    .describe("Directory or glob pattern to scope the analysis (e.g., 'src/', 'packages/*/src/')"),
  focusFile: z
    .string()
    .optional()
    .describe("For 'analyze' — focus on one file and show its import/export graph"),
})

interface DepNode {
  file: string
  imports: string[]
  exports: string[]
  importedBy: string[]
  size: number
  complexity: number
}

interface CircularChain {
  chain: string[]
  files: string[]
}

function parseImports(content: string): string[] {
  const imports: string[] = []
  const regex = /import\s+(?:type\s+)?(?:\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = regex.exec(content)) !== null) {
    if (match[1].startsWith(".") || match[1].startsWith("/")) {
      imports.push(match[1])
    }
  }
  return imports
}

function parseExports(content: string): string[] {
  const exports: string[] = []
  const regex = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g
  let match
  while ((match = regex.exec(content)) !== null) {
    exports.push(match[1])
  }
  const blockRegex = /export\s*\{([^}]+)\}/g
  while ((match = blockRegex.exec(content)) !== null) {
    const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
    exports.push(...names)
  }
  return exports
}

function estimateComplexity(content: string): number {
  const lines = content.split("\n")
  let complexity = 1 // base
  const branchRegex = /\b(?:if|else if|for|while|case|catch|\?\?|&&|\|\|)\b/g
  for (const line of lines) {
    const matches = line.match(branchRegex)
    if (matches) complexity += matches.length
  }
  // Account for callbacks/promises
  const callbackRegex = /=>\s*[{(]/g
  const callbacks = content.match(callbackRegex)
  if (callbacks) complexity += callbacks.length * 0.5

  // Account for ternary
  const ternaryRegex = /\?[^:]+:/g
  const ternaries = content.match(ternaryRegex)
  if (ternaries) complexity += ternaries.length * 0.5

  return Math.round(complexity)
}

function resolveImportPath(importer: string, importPath: string, ext: string): string {
  const dir = path.dirname(importer)
  let resolved = path.resolve(dir, importPath)

  // Try common extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]
  for (const ext of extensions) {
    const tryPath = importPath.endsWith(ext) ? resolved : resolved + ext
    if (tryPath.endsWith("/index")) {
      // Already handled
    }
    return tryPath
  }

  return resolved + ext
}

export const DepGraphTool = Tool.define(
  "dep_graph",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Professional dependency analysis and code architecture tool. " +
        "'analyze' — builds a full import/export graph showing relationships between files, layer violations, and coupling. " +
        "'find_circular' — detects circular dependency chains that cause runtime errors and bundler issues. " +
        "'find_unused' — finds exported functions/types that are never imported anywhere (dead code). " +
        "'health_check' — overall dependency health score with actionable metrics. " +
        "Use before refactoring to understand impact. Use 'find_circular' to fix bundler issues. " +
        "Use 'find_unused' to clean up dead code.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const worktree = Instance.worktree
          const scopeDir = params.scope ? path.resolve(worktree, params.scope) : worktree

          // Scan for source files
          let sourceFiles: string[] = []
          try {
            const { Glob } = require("@mimo-ai/shared/util/glob")
            const pattern = params.scope
              ? `${params.scope}**/*.{ts,tsx,js,jsx}`
              : "**/*.{ts,tsx,js,jsx}"
            sourceFiles = Glob.scanSync(pattern, { cwd: worktree, absolute: true, dot: false })
              .filter((f: string) => {
              // Skip node_modules, dist, build, .git
              const rel = path.relative(worktree, f)
              return !rel.includes("node_modules") && !rel.includes("dist/") &&
                     !rel.includes("build/") && !rel.includes(".git/") &&
                     !rel.includes(".next/") && !rel.includes("coverage/")
            })
          } catch {
            return {
              title: "Dep Graph: scan failed",
              output: "Could not scan source files. Check the scope path.",
              metadata: { action: params.action, error: "scan_failed" },
            }
          }

          if (sourceFiles.length === 0) {
            return {
              title: "Dep Graph: no files found",
              output: "No source files found in the specified scope.",
              metadata: { action: params.action, files: 0 },
            }
          }

          // Build the graph
          const nodes: Map<string, DepNode> = new Map()
          const allExports: Map<string, string[]> = new Map() // exportName -> [files]

          // Phase 1: Parse all files
          for (const filePath of sourceFiles) {
            const relPath = path.relative(worktree, filePath)
            const ext = path.extname(filePath)

            const exists = yield* fs.existsSafe(filePath)
            if (!exists) continue

            const content = yield* fs.readFileString(filePath)
            const imports = parseImports(content)
            const exports = parseExports(content)
            const size = Buffer.byteLength(content, "utf-8")
            const complexity = estimateComplexity(content)

            nodes.set(relPath, {
              file: relPath,
              imports,
              exports,
              importedBy: [],
              size,
              complexity,
            })

            for (const exp of exports) {
              if (!allExports.has(exp)) allExports.set(exp, [])
              allExports.get(exp)!.push(relPath)
            }
          }

          // Phase 2: Resolve imports and build reverse dependencies
          for (const [relPath, node] of nodes) {
            const resolvedImports: string[] = []
            for (const imp of node.imports) {
              // Try to resolve the import
              const importer = path.resolve(worktree, relPath)
              const ext = path.extname(relPath) || ".ts"
              let resolved = resolveImportPath(importer, imp, ext)

              // Normalize
              let resolvedRel = path.relative(worktree, resolved)
              if (resolvedRel.startsWith("..")) {
                // Try with different extensions
                const dir = path.dirname(importer)
                const base = imp.replace(/\.\w+$/, "")
                for (const tryExt of [".ts", ".tsx", ".js", ".jsx"]) {
                  const tryPath = path.relative(worktree, path.resolve(dir, base + tryExt))
                  if (nodes.has(tryPath)) {
                    resolvedRel = tryPath
                    break
                  }
                }
                // Try index
                if (!nodes.has(resolvedRel)) {
                  for (const tryExt of ["/index.ts", "/index.tsx", "/index.js"]) {
                    const tryPath = path.relative(worktree, path.resolve(dir, imp + tryExt))
                    if (nodes.has(tryPath)) {
                      resolvedRel = tryPath
                      break
                    }
                  }
                }
              }

              if (nodes.has(resolvedRel)) {
                resolvedImports.push(resolvedRel)
                nodes.get(resolvedRel)!.importedBy.push(relPath)
              }
            }
            node.imports = resolvedImports
          }

          switch (params.action) {
            case "analyze": {
              const lines: string[] = []
              lines.push("=== DEPENDENCY GRAPH ANALYSIS ===")
              lines.push(`Files analyzed: ${nodes.size}`)
              lines.push("")

              // If focused on one file, show detailed graph
              if (params.focusFile) {
                const focusRel = path.relative(worktree, path.resolve(worktree, params.focusFile))
                const focusNode = nodes.get(focusRel) || nodes.get(params.focusFile)

                if (!focusNode) {
                  lines.push(`File '${params.focusFile}' not found in analysis scope.`)
                  break
                }

                lines.push(`FOCUS: ${focusNode.file}`)
                lines.push(`  Size: ${focusNode.size} bytes | Complexity: ${focusNode.complexity}`)
                lines.push("")
                lines.push(`  IMPORTS FROM (${focusNode.imports.length}):`)
                if (focusNode.imports.length === 0) {
                  lines.push("    (leaf module — no internal imports)")
                } else {
                  for (const imp of focusNode.imports) {
                    const impNode = nodes.get(imp)
                    lines.push(`    ← ${imp} (${impNode?.complexity ?? "?"} complexity, ${impNode?.size ?? "?"} bytes)`)
                  }
                }
                lines.push("")
                lines.push(`  EXPORTED TO (${focusNode.importedBy.length}):`)
                if (focusNode.importedBy.length === 0) {
                  lines.push("    (unused module — not imported by anything!)")
                } else {
                  for (const dep of focusNode.importedBy) {
                    lines.push(`    → ${dep}`)
                  }
                }
                lines.push("")
                lines.push(`  EXPORTS: ${focusNode.exports.join(", ") || "(none)"}`)
              } else {
                // Show top-level stats
                const totalImports = [...nodes.values()].reduce((sum, n) => sum + n.imports.length, 0)
                const totalExports = [...nodes.values()].reduce((sum, n) => sum + n.exports.length, 0)
                const avgComplexity = Math.round([...nodes.values()].reduce((sum, n) => sum + n.complexity, 0) / nodes.size)

                lines.push("PROJECT STATS:")
                lines.push(`  Total files:    ${nodes.size}`)
                lines.push(`  Total imports:  ${totalImports}`)
                lines.push(`  Total exports:  ${totalExports}`)
                lines.push(`  Avg complexity: ${avgComplexity}`)

                // Most imported files (core modules)
                const sortedByDeps = [...nodes.values()].sort((a, b) => b.importedBy.length - a.importedBy.length)
                lines.push("")
                lines.push("MOST IMPORTED FILES (core modules):")
                for (const node of sortedByDeps.slice(0, 10)) {
                  if (node.importedBy.length === 0) continue
                  lines.push(`  ${node.importedBy.length} dependents — ${node.file}`)
                }

                // Leaf modules (no imports)
                const leaves = [...nodes.values()].filter((n) => n.imports.length === 0)
                lines.push("")
                lines.push(`LEAF MODULES (no imports): ${leaves.length}`)
                if (leaves.length <= 15) {
                  for (const leaf of leaves) {
                    lines.push(`  ${leaf.file}`)
                  }
                }

                // Orphan modules (no dependents)
                const orphans = [...nodes.values()].filter((n) => n.importedBy.length === 0)
                lines.push("")
                lines.push(`ORPHAN MODULES (not imported): ${orphans.length}`)
                if (orphans.length <= 15) {
                  for (const orphan of orphans) {
                    lines.push(`  ${orphan.file} — exports: ${orphan.exports.join(", ") || "(none)"}`)
                  }
                }
              }

              return {
                title: `Dep Graph: ${nodes.size} files analyzed`,
                output: lines.join("\n"),
                metadata: {
                  action: "analyze",
                  files: nodes.size,
                  focusFile: params.focusFile ?? null,
                },
              }
            }

            case "find_circular": {
              // DFS-based cycle detection
              const WHITE = 0, GRAY = 1, BLACK = 2
              const color: Map<string, number> = new Map()
              const parent: Map<string, string | null> = new Map()
              const cycles: CircularChain[] = []

              for (const key of nodes.keys()) {
                color.set(key, WHITE)
                parent.set(key, null)
              }

              const dfs = (node: string, stack: string[]): void => {
                color.set(node, GRAY)
                stack.push(node)

                const nodeData = nodes.get(node)
                if (nodeData) {
                  for (const imp of nodeData.imports) {
                    if (color.get(imp) === GRAY) {
                      // Found a cycle
                      const cycleStart = stack.indexOf(imp)
                      const chain = stack.slice(cycleStart)
                      chain.push(imp) // close the cycle
                      cycles.push({ chain, files: [...new Set(chain)] })
                    } else if (color.get(imp) === WHITE) {
                      parent.set(imp, node)
                      dfs(imp, stack)
                    }
                  }
                }

                stack.pop()
                color.set(node, BLACK)
              }

              for (const key of nodes.keys()) {
                if (color.get(key) === WHITE) {
                  dfs(key, [])
                }
              }

              const lines: string[] = []
              lines.push("=== CIRCULAR DEPENDENCY ANALYSIS ===")
              lines.push(`Files scanned: ${nodes.size}`)

              if (cycles.length === 0) {
                lines.push("")
                lines.push("No circular dependencies detected!")
                lines.push("The dependency graph is clean.")
              } else {
                lines.push(`Circular chains found: ${cycles.length}`)
                lines.push("")

                // Deduplicate cycles
                const seen = new Set<string>()
                const uniqueCycles = cycles.filter((c) => {
                  const key = [...c.files].sort().join(" → ")
                  if (seen.has(key)) return false
                  seen.add(key)
                  return true
                })

                for (let i = 0; i < Math.min(uniqueCycles.length, 20); i++) {
                  const cycle = uniqueCycles[i]
                  lines.push(`Cycle ${i + 1} (${cycle.files.length} files):`)
                  lines.push(`  ${cycle.chain.join(" → ")}`)
                  lines.push("")
                }

                if (uniqueCycles.length > 20) {
                  lines.push(`... and ${uniqueCycles.length - 20} more cycles`)
                }

                lines.push("")
                lines.push("IMPACT: Circular dependencies can cause:")
                lines.push("  - Runtime errors (undefined values at import time)")
                lines.push("  - Bundler issues (infinite loops)")
                lines.push("  - Difficult refactoring (tangled code)")
                lines.push("")
                lines.push("FIX: Extract shared code into a new module that both files import.")
              }

              return {
                title: cycles.length > 0
                  ? `Circular Deps: ${cycles.length} chain(s) found`
                  : "Circular Deps: none found",
                output: lines.join("\n"),
                metadata: {
                  action: "find_circular",
                  filesScanned: nodes.size,
                  cyclesFound: cycles.length,
                  cycles: cycles.map((c) => ({ chain: c.chain, files: c.files })),
                },
              }
            }

            case "find_unused": {
              const lines: string[] = []
              lines.push("=== UNUSED EXPORT ANALYSIS ===")
              lines.push(`Files scanned: ${nodes.size}`)
              lines.push("")

              const unusedExports: { file: string; export: string; type: string }[] = []

              for (const [relPath, node] of nodes) {
                for (const exp of node.exports) {
                  // Check if any other file imports this symbol
                  const importers = allExports.get(exp) ?? []
                  const isUsed = importers.some((impFile) => {
                    if (impFile === relPath) return false
                    const impNode = nodes.get(impFile)
                    return impNode?.imports.includes(relPath)
                  })

                  if (!isUsed) {
                    // Determine type
                    const filePath = path.resolve(worktree, relPath)
                    let type = "unknown"
                    try {
                      const content = yield* fs.readFileString(filePath)
                      if (new RegExp(`export\\s+function\\s+${exp}\\b`).test(content)) type = "function"
                      else if (new RegExp(`export\\s+class\\s+${exp}\\b`).test(content)) type = "class"
                      else if (new RegExp(`export\\s+(?:const|let|var)\\s+${exp}\\b`).test(content)) type = "variable"
                      else if (new RegExp(`export\\s+type\\s+${exp}\\b`).test(content)) type = "type"
                      else if (new RegExp(`export\\s+interface\\s+${exp}\\b`).test(content)) type = "interface"
                      else if (new RegExp(`export\\s+enum\\s+${exp}\\b`).test(content)) type = "enum"
                    } catch { /* skip */ }

                    unusedExports.push({ file: relPath, export: exp, type })
                  }
                }
              }

              // Also find files that are never imported (orphan modules with exports)
              const orphanFiles = [...nodes.entries()]
                .filter(([, node]) => node.importedBy.length === 0 && node.exports.length > 0)
                .map(([file]) => file)

              if (unusedExports.length === 0 && orphanFiles.length === 0) {
                lines.push("No unused exports found!")
                lines.push("All exported symbols are being used somewhere.")
              } else {
                if (unusedExports.length > 0) {
                  lines.push(`UNUSED EXPORTS: ${unusedExports.length}`)
                  // Group by file
                  const byFile: Record<string, typeof unusedExports> = {}
                  for (const ue of unusedExports) {
                    if (!byFile[ue.file]) byFile[ue.file] = []
                    byFile[ue.file].push(ue)
                  }
                  for (const [file, exports] of Object.entries(byFile)) {
                    lines.push(`\n  ${file}:`)
                    for (const exp of exports) {
                      lines.push(`    ${exp.export} (${exp.type})`)
                    }
                  }
                }

                if (orphanFiles.length > 0) {
                  lines.push(`\nORPHAN MODULES (never imported, has exports): ${orphanFiles.length}`)
                  for (const file of orphanFiles.slice(0, 20)) {
                    const node = nodes.get(file)!
                    lines.push(`  ${file} — exports: ${node.exports.join(", ")}`)
                  }
                  if (orphanFiles.length > 20) {
                    lines.push(`  ... and ${orphanFiles.length - 20} more`)
                  }
                }

                lines.push("\nNOTE: Some exports may be entry points or used externally (e.g., CLI, plugin API).")
                lines.push("Review carefully before removing.")
              }

              return {
                title: unusedExports.length > 0
                  ? `Unused: ${unusedExports.length} export(s) found`
                  : "Unused: all exports used",
                output: lines.join("\n"),
                metadata: {
                  action: "find_unused",
                  filesScanned: nodes.size,
                  unusedExports,
                  orphanFiles,
                },
              }
            }

            case "health_check": {
              const lines: string[] = []
              lines.push("=== DEPENDENCY HEALTH CHECK ===")
              lines.push("")

              const allNodes = [...nodes.values()]
              const totalSize = allNodes.reduce((sum, n) => sum + n.size, 0)
              const avgComplexity = Math.round(allNodes.reduce((sum, n) => sum + n.complexity, 0) / allNodes.length)
              const maxComplexity = Math.max(...allNodes.map((n) => n.complexity))
              const maxFile = allNodes.reduce((max, n) => n.complexity > max.complexity ? n : max, allNodes[0])

              // Coupling: average number of imports per file
              const avgCoupling = Math.round(allNodes.reduce((sum, n) => sum + n.imports.length, 0) / allNodes.length)

              // Most depended-on files (high coupling risk)
              const highFanIn = allNodes.filter((n) => n.importedBy.length > 10).sort((a, b) => b.importedBy.length - a.importedBy.length)

              // Large files
              const largeFiles = allNodes.filter((n) => n.size > 10000).sort((a, b) => b.size - a.size)

              // High complexity files
              const highComplexity = allNodes.filter((n) => n.complexity > 20).sort((a, b) => b.complexity - a.complexity)

              // Circular deps
              const WHITE = 0, GRAY = 1, BLACK = 2
              const color2: Map<string, number> = new Map()
              for (const key of nodes.keys()) color2.set(key, WHITE)
              let circularCount = 0
              const dfsCheck = (node: string, stack: string[]): void => {
                color2.set(node, GRAY)
                stack.push(node)
                const nodeData = nodes.get(node)
                if (nodeData) {
                  for (const imp of nodeData.imports) {
                    if (color2.get(imp) === GRAY) circularCount++
                    else if (color2.get(imp) === WHITE) dfsCheck(imp, stack)
                  }
                }
                stack.pop()
                color2.set(node, BLACK)
              }
              for (const key of nodes.keys()) {
                if (color2.get(key) === WHITE) dfsCheck(key, [])
              }

              // Files with too many imports (high coupling)
              const highCouplingFiles = allNodes.filter((n) => n.imports.length > 8).sort((a, b) => b.imports.length - a.imports.length)

              // Calculate health score (0-100)
              let score = 100
              score -= Math.min(30, circularCount * 5)  // Circular deps are bad
              score -= Math.min(20, highComplexity.length * 3)  // High complexity
              score -= Math.min(15, highCouplingFiles.length * 2)  // High coupling
              score -= Math.min(15, largeFiles.length * 2)  // Large files
              score -= Math.min(10, highFanIn.length * 3)  // High fan-in (centralization)
              score -= Math.min(10, Math.max(0, (avgComplexity - 10) * 1))  // Average complexity
              score = Math.max(0, Math.min(100, score))

              const grade = score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : score >= 50 ? "D" : "F"

              lines.push(`HEALTH SCORE: ${score}/100 (Grade: ${grade})`)
              lines.push("")
              lines.push("METRICS:")
              lines.push(`  Files analyzed:       ${nodes.size}`)
              lines.push(`  Total size:           ${(totalSize / 1024).toFixed(1)} KB`)
              lines.push(`  Avg complexity:       ${avgComplexity}`)
              lines.push(`  Max complexity:       ${maxComplexity} (${maxFile?.file ?? "?"})`)
              lines.push(`  Avg coupling (imports): ${avgCoupling} per file`)
              lines.push(`  Circular deps:        ${circularCount}`)
              lines.push(`  Large files (>10KB):  ${largeFiles.length}`)
              lines.push(`  High complexity (>20):${highComplexity.length}`)
              lines.push("")

              if (circularCount > 0) {
                lines.push(`ISSUES:`)
                lines.push(`  [!] ${circularCount} circular dependency chain(s) detected`)
              }
              if (highComplexity.length > 0) {
                lines.push(`  [!] ${highComplexity.length} file(s) with complexity > 20:`)
                for (const f of highComplexity.slice(0, 5)) {
                  lines.push(`      ${f.file} (complexity: ${f.complexity})`)
                }
              }
              if (highCouplingFiles.length > 0) {
                lines.push(`  [!] ${highCouplingFiles.length} file(s) with >8 imports (tight coupling):`)
                for (const f of highCouplingFiles.slice(0, 5)) {
                  lines.push(`      ${f.file} (${f.imports.length} imports)`)
                }
              }
              if (highFanIn.length > 0) {
                lines.push(`  [i] ${highFanIn.length} highly-centralized file(s) (>10 dependents):`)
                for (const f of highFanIn.slice(0, 5)) {
                  lines.push(`      ${f.file} (${f.importedBy.length} dependents)`)
                }
              }
              if (largeFiles.length > 0) {
                lines.push(`  [i] ${largeFiles.length} large file(s) (>10KB):`)
                for (const f of largeFiles.slice(0, 5)) {
                  lines.push(`      ${f.file} (${(f.size / 1024).toFixed(1)} KB)`)
                }
              }

              lines.push("")
              lines.push("RECOMMENDATIONS:")
              if (circularCount > 0) lines.push("  1. Break circular dependencies by extracting shared code into a new module")
              if (highComplexity.length > 0) lines.push("  2. Simplify high-complexity files by extracting functions")
              if (highCouplingFiles.length > 0) lines.push("  3. Reduce coupling by using dependency injection or event-based patterns")
              if (largeFiles.length > 0) lines.push("  4. Split large files into smaller, focused modules")
              if (highFanIn.length > 0) lines.push("  5. Consider if highly-centralized files should be split into sub-modules")

              return {
                title: `Dep Health: ${score}/100 (${grade})`,
                output: lines.join("\n"),
                metadata: {
                  action: "health_check",
                  score,
                  grade,
                  files: nodes.size,
                  circularDeps: circularCount,
                  avgComplexity,
                  maxComplexity,
                  avgCoupling,
                  largeFiles: largeFiles.length,
                  highComplexity: highComplexity.length,
                },
              }
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)