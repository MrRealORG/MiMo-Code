import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { assertWriteAllowed } from "./external-directory"
import fs from "node:fs/promises"
import os from "node:os"

const Parameters = z.object({
  filePath: z.string().describe("The path to the file or directory to delete (absolute or relative)"),
  reason: z
    .string()
    .describe("Brief explanation of why this file/directory needs to be deleted"),
  recursive: z
    .boolean()
    .describe("Set to true to delete directories and their contents recursively")
    .optional()
    .default(false),
})

export const DeleteTool = Tool.define(
  "delete",
  Effect.gen(function* () {
    const fsService = yield* AppFileSystem.Service
    const bus = yield* Bus.Service

    return {
      description: `Delete a file or directory from the filesystem. ALWAYS use this tool instead of bash 'rm' commands.

Before any deletion, a confirmation dialog is shown to the user displaying:
- File/directory name
- Full path/location
- File size and type
- Deletion reason

The deletion ONLY proceeds after the user explicitly confirms via the GUI.

IMPORTANT: Never use bash 'rm' or 'rmdir' commands. Always use this delete tool for any file or directory removal.`,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(SessionCwd.get(ctx.sessionID), params.filePath)

          const normalizedPath =
            process.platform === "win32" ? AppFileSystem.normalizePath(filepath) : filepath
          const relativePath = path.relative(Instance.worktree, normalizedPath)

          // Check write permissions
          yield* assertWriteAllowed(ctx, normalizedPath, {
            kind: (yield* fsService.isDir(normalizedPath)) ? "directory" : "file",
          })

          // Gather file information for the confirmation dialog
          let fileInfo: {
            name: string
            path: string
            relativePath: string
            type: string
            size: string
          }

          try {
            const stat = yield* Effect.promise(() => fs.stat(normalizedPath))
            const isDir = stat.isDirectory()

            let sizeStr = ""
            if (isDir) {
              // Calculate directory size
              const dirSize = yield* Effect.promise(async () => {
                let totalSize = 0
                async function walk(dirPath: string): Promise<number> {
                  let size = 0
                  const entries = await fs.readdir(dirPath, { withFileTypes: true })
                  for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name)
                    if (entry.isDirectory()) {
                      size += await walk(fullPath)
                    } else {
                      try {
                        const entryStat = await fs.stat(fullPath)
                        size += entryStat.size
                      } catch {
                        // skip files we can't stat
                      }
                    }
                  }
                  return size
                }
                return walk(normalizedPath)
              })
              sizeStr = formatBytes(dirSize)
              fileInfo = {
                name: path.basename(normalizedPath),
                path: normalizedPath,
                relativePath,
                type: "Directory",
                size: sizeStr,
              }
            } else {
              sizeStr = formatBytes(stat.size)
              fileInfo = {
                name: path.basename(normalizedPath),
                path: normalizedPath,
                relativePath,
                type: stat.isFile() ? "File" : stat.isSymbolicLink() ? "Symlink" : "Unknown",
                size: sizeStr,
              }
            }
          } catch {
            fileInfo = {
              name: path.basename(normalizedPath),
              path: normalizedPath,
              relativePath,
              type: "Unknown",
              size: "N/A",
            }
          }

          // Ask for deletion confirmation — this triggers the GUI confirmation dialog
          yield* ctx.ask({
            permission: "delete",
            patterns: [relativePath],
            always: [],
            metadata: {
              filepath: normalizedPath,
              relativePath,
              fileName: fileInfo.name,
              fileType: fileInfo.type,
              fileSize: fileInfo.size,
              reason: params.reason,
              recursive: params.recursive,
              deletionInfo: {
                name: fileInfo.name,
                path: normalizedPath,
                relativePath,
                type: fileInfo.type,
                size: fileInfo.size,
                reason: params.reason,
              },
            },
          })

          // Perform the actual deletion
          yield* Effect.promise(async () => {
            if (params.recursive) {
              await fs.rm(normalizedPath, { recursive: true, force: true })
            } else {
              await fs.unlink(normalizedPath)
            }
          })

          // Notify watchers
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: normalizedPath,
            event: "unlink",
          })

          const output = [
            `Deleted ${fileInfo.type.toLowerCase()}: ${relativePath}`,
            `  Name: ${fileInfo.name}`,
            `  Path: ${normalizedPath}`,
            `  Size: ${fileInfo.size}`,
            `  Reason: ${params.reason}`,
          ].join("\n")

          return {
            title: `Delete ${fileInfo.name}`,
            metadata: {
              filepath: normalizedPath,
              relativePath,
              fileName: fileInfo.name,
              fileType: fileInfo.type,
              fileSize: fileInfo.size,
              reason: params.reason,
              deleted: true,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}