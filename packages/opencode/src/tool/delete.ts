import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { Bus } from "../bus"

const Parameters = z.object({
  filePath: z.string().describe("The path to the file or directory to delete"),
  reason: z
    .string()
    .describe("Explanation of why this file/directory needs to be deleted"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set to true to delete directories and their contents recursively"),
})

export const DeleteTool = Tool.define(
  "delete",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service

    return {
      description:
        "Delete a file or directory from the filesystem. " +
        "You MUST inform the user about what you are deleting and why BEFORE calling this tool — " +
        "use the question tool or mention it in your response text. " +
        "The permission system will automatically ask for user confirmation. " +
        "All changes are tracked by the snapshot system, so users can /undo to revert.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const target = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(SessionCwd.get(ctx.sessionID), params.filePath)

          const resolved = path.resolve(target)
          const stat = yield* fs.stat(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))

          if (!stat) {
            return {
              title: `Delete: ${path.relative(Instance.worktree, resolved)}`,
              output: `Path does not exist: ${resolved}`,
              metadata: { deleted: false, reason: "not_found" },
            }
          }

          const isDir = stat.type === "Directory"
          const relativePath = path.relative(Instance.worktree, resolved)
          const size =
            typeof stat.size === "bigint" ? Number(stat.size) : (stat.size as number)

          yield* ctx.ask({
            permission: "delete",
            patterns: [relativePath],
            always: ["*"],
            metadata: {
              filepath: resolved,
              relativePath,
              type: isDir ? "directory" : "file",
              size,
              reason: params.reason,
              recursive: params.recursive,
            },
          })

          yield* fs.remove(resolved)

          yield* bus.publish(FileWatcher.Event.Updated, {
            file: resolved,
            event: "unlink",
          })

          return {
            title: `Deleted: ${relativePath}`,
            output: [
              `Successfully deleted ${isDir ? "directory" : "file"}: ${relativePath}`,
              `Type: ${isDir ? "directory" : "file"}`,
              `Size: ${isDir ? "(directory)" : `${size} bytes`}`,
              `Reason: ${params.reason}`,
              "",
              `Note: You can use /undo in the terminal to revert this deletion.`,
            ].join("\n"),
            metadata: {
              deleted: true,
              filepath: resolved,
              relativePath,
              type: isDir ? "directory" : "file",
              size,
              reason: params.reason,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)