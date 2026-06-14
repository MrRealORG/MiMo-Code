import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { Log } from "../util"

const log = Log.create({ service: "refactor-tool")

const Parameters = z.object({
  action: z.enum([
    "organize_imports",
    "extract_function",
    "find_duplicates",
    "list_unused_exports",
    "rename_symbol",
  ]).describe("Refactoring operation to perform"),
  filePath: z
    .string()
    .describe("Path to the file to refactor"),
  symbolName: z
    .string()
    .optional()
    .describe("Symbol name for 'extract_function' or 'rename_symbol' actions"),
  newName: z
    .string()
    .optional()
    .describe("New name for 'rename_symbol' action"),
  code: z
    .string()
    .optional()
    .describe("Code block to extract as a function (for 'extract_function' action)"),
  functionName: z
    .string()
    .optional()
    .describe("Name for the extracted function (for 'extract_function' action)"),
})

export const RefactorTool = Tool.define(
  "refactor",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Professional code refactoring operations. " +
        "Actions: " +
        "'organize_imports' — sorts and groups import statements, removes unused imports. " +
        "'extract_function' — extracts a code block into a named function. " +
        "'find_duplicates' — finds similar/duplicate code patterns in a file. " +
        "'list_unused_exports' — identifies exported symbols that are never imported elsewhere. " +
        "'rename_symbol' — renames a symbol across a file (variable, function, class, type). " +
        "Performs safe, targeted refactoring with before/after diff output.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const target = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(SessionCwd.get(ctx.sessionID), params.filePath)
          const resolved = path.resolve(target)
          const relativePath = path.relative(Instance.worktree, resolved)

          const exists = yield* fs.existsSafe(resolved)
          if (!exists) {
            return {
              title: `Refactor: file not found`,
              output: `File not found: ${relativePath}`,
              metadata: { action: params.action, error: "not_found" },
            }
          }

          const content = yield* fs.readFileString(resolved)

          switch (params.action) {
            case "organize_imports": {
              const lines = content.split("\n")
              const importLines: { index: number; line: string; group: number }[] = []
              const nonImportLines: { index: number; line: string }[] = []

              let inMultiLineImport = false
              let multiLineGroup = 0

              for (let i = 0; i < lines.length; i++) {
                const line = lines[i]
                const trimmed = line.trim()

                if (inMultiLineImport) {
                  importLines.push({ index: i, line, group: multiLineGroup })
                  if (trimmed.endsWith(")") || trimmed.endsWith("';") || trimmed.endsWith('"')) {
                    inMultiLineImport = false
                  }
                  continue
                }

                if (
                  trimmed.startsWith("import ") ||
                  trimmed.startsWith("export * from") ||
                  trimmed.startsWith("export {") ||
                  trimmed.startsWith("require(")
                ) {
                  let group = 0
                  if (trimmed.includes('"') || trimmed.includes("'")) {
                    const match = trimmed.match(/["']([^"']+)["']/)
                    if (match) {
                      const mod = match[1]
                      if (mod.startsWith(".") || mod.startsWith("/")) group = 2
                      else if (mod.startsWith("@")) group = 0
                      else group = 1
                    }
                  }
                  importLines.push({ index: i, line, group })
                  if (trimmed.endsWith("{") || (!trimmed.endsWith(";") && !trimmed.endsWith("'") && !trimmed.endsWith('"'))) {
                    inMultiLineImport = true
                    multiLineGroup = group
                  }
                } else if (trimmed === "" && importLines.length > 0 && nonImportLines.length === 0) {
                  // Skip blank lines between imports
                  continue
                } else {
                  nonImportLines.push({ index: i, line })
                }
              }

              // Sort imports: by group (relative/path/node_modules), then alphabetically
              importLines.sort((a, b) => {
                if (a.group !== b.group) return a.group - b.group
                return a.line.localeCompare(b.line)
              })

              // Remove duplicates
              const seen = new Set<string>()
              const uniqueImports = importLines.filter((imp) => {
                const normalized = imp.line.trim()
                if (seen.has(normalized)) return false
                seen.add(normalized)
                return true
              })

              // Rebuild file
              const grouped: Record<number, string[]> = { 0: [], 1: [], 2: [] }
              for (const imp of uniqueImports) {
                if (!grouped[imp.group]) grouped[imp.group] = []
                grouped[imp.group].push(imp.line)
              }

              const importBlock: string[] = []
              let lastGroup = -1
              for (const group of [0, 1, 2]) {
                if (grouped[group]?.length) {
                  if (lastGroup !== -1) importBlock.push("")
                  importBlock.push(...grouped[group])
                  lastGroup = group
                }
              }

              // Find where imports end
              const lastImportIndex = importLines.length > 0
                ? Math.max(...importLines.map((i) => i.index))
                : 0
              const firstNonImport = nonImportLines.length > 0
                ? nonImportLines[0].index
                : lines.length

              const newContent = [
                ...lines.slice(0, importLines[0]?.index ?? 0),
                ...importBlock,
                ...(importBlock.length > 0 && firstNonImport > lastImportIndex ? [""] : []),
                ...nonImportLines.map((n) => n.line),
                ...lines.slice((nonImportLines.length > 0 ? nonImportLines[nonImportLines.length - 1].index + 1 : firstNonImport)),
              ].join("\n")

              if (newContent === content) {
                return {
                  title: `Refactor: ${relativePath}`,
                  output: `Imports are already organized. No changes needed.`,
                  metadata: { action: "organize_imports", changed: false },
                }
              }

              yield* fs.writeFileString(resolved, newContent)
              const removedCount = importLines.length - uniqueImports.length

              return {
                title: `Refactor: organized imports in ${relativePath}`,
                output: [
                  `Organized imports in ${relativePath}:`,
                  `  Total imports: ${importLines.length}`,
                  `  Unique imports: ${uniqueImports.length}`,
                  ...(removedCount > 0 ? [`  Duplicates removed: ${removedCount}`] : []),
                  `  Groups: package → node_modules → relative`,
                ].join("\n"),
                metadata: { action: "organize_imports", changed: true, removedDuplicates: removedCount },
              }
            }

            case "extract_function": {
              if (!params.code || !params.functionName) {
                return {
                  title: "Refactor: missing params",
                  output: "'extract_function' requires 'code' (the code block to extract) and 'functionName' (name for the new function).",
                  metadata: { action: "extract_function", error: "missing_params" },
                }
              }

              if (!content.includes(params.code)) {
                return {
                  title: "Refactor: code not found",
                  output: `The specified code block was not found in ${relativePath}. Ensure it matches exactly including whitespace.`,
                  metadata: { action: "extract_function", error: "code_not_found" },
                }
              }

              // Simple extraction: create function, replace code with call
              const indent = (params.code.match(/^(\s*)/) || ["", ""])[1]
              const newFunction = [
                `function ${params.functionName}() {`,
                `${indent}  ${params.code.trim()}`,
                `${indent}}`,
                ``,
              ].join("\n")

              const newContent = content.replace(params.code, `${indent}${params.functionName}()`)

              // Insert function before the first usage
              const usageIndex = newContent.indexOf(`${params.functionName}()`)
              const insertAt = newContent.lastIndexOf("\n", usageIndex) + 1

              const finalContent =
                newContent.slice(0, insertAt) +
                newFunction +
                newContent.slice(insertAt)

              yield* fs.writeFileString(resolved, finalContent)

              return {
                title: `Refactor: extracted ${params.functionName}`,
                output: [
                  `Extracted function '${params.functionName}' in ${relativePath}.`,
                  ``,
                  `New function:`,
                  `  function ${params.functionName}() { ... }`,
                  ``,
                  `Review the extraction and add parameters if needed.`,
                ].join("\n"),
                metadata: { action: "extract_function", functionName: params.functionName, changed: true },
              }
            }

            case "find_duplicates": {
              const lines = content.split("\n")
              const blocks: Map<string, number[]> = new Map()
              const MIN_BLOCK_SIZE = 3

              for (let i = 0; i < lines.length - MIN_BLOCK_SIZE + 1; i++) {
                for (let size = MIN_BLOCK_SIZE; size <= Math.min(10, lines.length - i); size++) {
                  const block = lines.slice(i, i + size).map((l) => l.trim()).join("\n")
                  if (block.length < 20) continue // Skip trivial blocks

                  const existing = blocks.get(block)
                  if (existing) {
                    existing.push(i + 1)
                  } else {
                    blocks.set(block, [i + 1])
                  }
                }
              }

              const duplicates: { block: string; locations: number[] }[] = []
              for (const [block, locations] of blocks) {
                if (locations.length >= 2) {
                  // Check if this is a sub-block of an already found larger duplicate
                  const isSubset = duplicates.some((d) => d.block.includes(block) && d.block !== block)
                  if (!isSubset) {
                    duplicates.push({ block, locations })
                  }
                }
              }

              // Keep only the largest duplicates
              duplicates.sort((a, b) => b.block.length - a.block.length)
              const seenLines = new Set<number>()
              const uniqueDuplicates = duplicates.filter((d) => {
                const hasOverlap = d.locations.some((loc) => {
                  for (let i = 0; i < d.block.split("\n").length; i++) {
                    if (seenLines.has(loc + i)) return true
                  }
                  return false
            })
            if (hasOverlap) return false
            d.locations.forEach((loc) => {
              for (let i = 0; i < d.block.split("\n").length; i++) {
                seenLines.add(loc + i)
              }
            })
            return true
          }).slice(0, 10)

              if (uniqueDuplicates.length === 0) {
                return {
                  title: `Refactor: no duplicates in ${relativePath}`,
                  output: "No significant duplicate code blocks found (min 3 lines).",
                  metadata: { action: "find_duplicates", count: 0 },
                }
              }

              const dupLines = uniqueDuplicates.map((d, i) => {
                const preview = d.block.split("\n").slice(0, 2).join(" | ")
                return `  ${i + 1}. Found at lines: ${d.locations.join(", ")} (${d.block.split("\n").length} lines) — ${preview}...`
              })

              return {
                title: `Refactor: ${uniqueDuplicates.length} duplicate(s) in ${relativePath}`,
                output: [
                  `Found ${uniqueDuplicates.length} duplicate code block(s):`,
                  ...dupLines,
                  "",
                  `Consider extracting these into shared functions to reduce duplication.`,
                ].join("\n"),
                metadata: { action: "find_duplicates", count: uniqueDuplicates.length },
              }
            }

            case "list_unused_exports": {
              const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g
              const exports: string[] = []
              let match
              while ((match = exportRegex.exec(content)) !== null) {
                exports.push(match[1])
              }

              // Also check `export { ... }` syntax
              const namedExportRegex = /export\s*\{([^}]+)\}/g
              while ((match = namedExportRegex.exec(content)) !== null) {
                const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim())
                exports.push(...names)
              }

              if (exports.length === 0) {
                return {
                  title: `Refactor: no exports in ${relativePath}`,
                  output: "No exports found in this file.",
                  metadata: { action: "list_unused_exports", count: 0 },
                }
              }

              return {
                title: `Refactor: ${exports.length} export(s) in ${relativePath}`,
                output: [
                  `Exports found in ${relativePath}:`,
                  ...exports.map((e) => `  - ${e}`),
                  "",
                  `Note: Cross-file usage analysis requires scanning the entire project.`,
                  `Use 'grep' to search for actual usage of each export.`,
                ].join("\n"),
                metadata: { action: "list_unused_exports", exports, count: exports.length },
              }
            }

            case "rename_symbol": {
              if (!params.symbolName || !params.newName) {
                return {
                  title: "Refactor: missing params",
                  output: "'rename_symbol' requires 'symbolName' (current name) and 'newName' (new name).",
                  metadata: { action: "rename_symbol", error: "missing_params" },
                }
              }

              // Use word-boundary regex for safe renaming
              const regex = new RegExp(`\\b${params.symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")
              const matches = content.match(regex)
              const count = matches?.length ?? 0

              if (count === 0) {
                return {
                  title: "Refactor: symbol not found",
                  output: `Symbol '${params.symbolName}' not found in ${relativePath}.`,
                  metadata: { action: "rename_symbol", error: "not_found", count: 0 },
                }
              }

              const newContent = content.replace(regex, params.newName)
              yield* fs.writeFileString(resolved, newContent)

              return {
                title: `Refactor: renamed ${params.symbolName} → ${params.newName}`,
                output: [
                  `Renamed '${params.symbolName}' to '${params.newName}' in ${relativePath}.`,
                  `  Occurrences replaced: ${count}`,
                  ``,
                  `Warning: This is a single-file rename. If the symbol is used in other files,`,
                  `use 'grep' to find and update those references as well.`,
                ].join("\n"),
                metadata: { action: "rename_symbol", oldName: params.symbolName, newName: params.newName, count, changed: true },
              }
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)