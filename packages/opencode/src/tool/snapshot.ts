import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Snapshot } from "../snapshot"

const lastCheckpoint = new Map<string, string>()

const Parameters = z.object({
  action: z
    .enum(["checkpoint", "status"])
    .describe(
      "Action to perform: 'checkpoint' saves current file state as a version point (user can /undo to revert). 'status' shows what files have been modified since the last checkpoint.",
    ),
  label: z
    .string()
    .optional()
    .describe("Optional label for the checkpoint (only used with 'checkpoint' action)"),
})

export const SnapshotTool = Tool.define(
  "snapshot",
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service

    return {
      description:
        "Create file version checkpoints and view change status. " +
        "Use 'checkpoint' to save the current state of all files — the user can then use /undo in the terminal to revert to this point. " +
        "Use 'status' to see which files have changed since the last checkpoint. " +
        "The system automatically tracks file changes for /undo, but explicit checkpoints give users better undo granularity.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sessionID = ctx.sessionID as string

          switch (params.action) {
            case "checkpoint": {
              const hash = yield* snapshot.track()
              if (!hash) {
                return {
                  title: "Snapshot: no changes",
                  output:
                    "No file changes to snapshot. Make some changes first, then create a checkpoint.",
                  metadata: { action: "checkpoint", hash: undefined },
                }
              }

              lastCheckpoint.set(sessionID, hash)

              yield* ctx.metadata({
                title: params.label
                  ? `Checkpoint: ${params.label}`
                  : `Checkpoint: ${hash.slice(0, 7)}`,
              })

              return {
                title: params.label
                  ? `Checkpoint: ${params.label}`
                  : `Checkpoint: ${hash.slice(0, 7)}`,
                output: [
                  `Snapshot checkpoint created successfully.`,
                  `Hash: ${hash.slice(0, 12)}`,
                  ...(params.label ? [`Label: ${params.label}`] : []),
                  "",
                  `The user can now use /undo in the terminal to revert to this point.`,
                ].join("\n"),
                metadata: {
                  action: "checkpoint",
                  hash,
                  label: params.label,
                },
              }
            }

            case "status": {
              const prevHash = lastCheckpoint.get(sessionID)
              const currentHash = yield* snapshot.track()

              if (!currentHash) {
                return {
                  title: "Snapshot: no changes",
                  output: "No file changes detected since the last checkpoint.",
                  metadata: { action: "status", files: [] },
                }
              }

              if (prevHash && prevHash !== currentHash) {
                const diffs = yield* snapshot.diffFull(prevHash, currentHash)
                if (!diffs.length) {
                  return {
                    title: "Snapshot status: no changes",
                    output: "Files are unchanged since the last checkpoint.",
                    metadata: { action: "status", files: [] },
                  }
                }

                const lines = diffs.map((d) => {
                  const icon =
                    d.status === "added" ? "+" : d.status === "deleted" ? "-" : "~"
                  return `  [${icon}] ${d.file} (${d.status}, +${d.additions}/-${d.deletions})`
                })

                return {
                  title: `Changes since checkpoint: ${diffs.length} files`,
                  output: [
                    `Files changed since checkpoint ${prevHash.slice(0, 7)}:`,
                    ...lines,
                    "",
                    `Use /undo to revert all these changes.`,
                  ].join("\n"),
                  metadata: {
                    action: "status",
                    fromHash: prevHash,
                    toHash: currentHash,
                    files: diffs.map((d) => d.file),
                  },
                }
              }

              const patch = yield* snapshot.patch(currentHash)
              const fileList = patch.files.map((f) => `  - ${f}`).join("\n")

              return {
                title: `Tracked changes: ${patch.files.length} files`,
                output: [
                  `Files currently tracked by snapshot:`,
                  fileList || "  (none)",
                  "",
                  `Tip: Create a checkpoint first, then use 'status' again to see incremental changes.`,
                ].join("\n"),
                metadata: {
                  action: "status",
                  files: patch.files,
                },
              }
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)