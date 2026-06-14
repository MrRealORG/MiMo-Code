import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Log } from "../util"
import { Instance } from "../project/instance"

const log = Log.create({ service: "git-ops-tool" })

const Parameters = z.object({
  action: z.enum([
    "status",
    "diff",
    "log",
    "branch",
    "commit",
    "stash",
    "restore",
  ]).describe("Git operation to perform"),
  message: z
    .string()
    .optional()
    .describe("Commit message (required for 'commit' action)"),
  branch: z
    .string()
    .optional()
    .describe("Branch name (required for 'branch' action, optional for 'log'/'diff')"),
  files: z
    .array(z.string())
    .optional()
    .describe("Specific files to include in commit/diff (default: all)"),
  count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe("Number of log entries to show (for 'log' action)"),
  stashMessage: z
    .string()
    .optional()
    .describe("Message for the stash entry"),
  staged: z
    .boolean()
    .optional()
    .default(false)
    .describe("For 'diff': show only staged changes. For 'commit': only commit staged files."),
})

export const GitOpsTool = Tool.define(
  "git_ops",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const runGit = Effect.fnUntraced(
      function* (args: string[], cwd?: string) {
        const proc = ChildProcess.make("git", args, {
          cwd: cwd ?? Instance.worktree,
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
        return { output: chunks.join(""), exitCode: code }
      },
    )

    return {
      description:
        "Structured git operations for version control. " +
        "Actions: 'status' (working tree status), 'diff' (show changes), 'log' (commit history), " +
        "'branch' (create/switch branches), 'commit' (stage and commit), 'stash' (save/restore work), 'restore' (discard changes). " +
        "Prefer this over raw bash for git operations — it provides structured output and safer defaults.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cwd = Instance.worktree

          switch (params.action) {
            case "status": {
              const { output } = yield* runGit(["status", "--short", "--branch"])
              const branch = yield* runGit(["branch", "--show-current"])
              const currentBranch = branch.output.trim() || "detached"

              const lines = output.trim().split("\n").filter(Boolean)
              const staged = lines.filter((l) => l.startsWith("M ") || l.startsWith("A ") || l.startsWith("D ")).length
              const modified = lines.filter((l) => l[1] === "M" || l[1] === "m").length
              const untracked = lines.filter((l) => l.startsWith("??") || l.startsWith("A ")).length

              return {
                title: `Git: ${currentBranch}`,
                output: [
                  `Branch: ${currentBranch}`,
                  `Staged: ${staged} | Modified: ${modified} | Untracked: ${untracked}`,
                  "",
                  output || "  (clean working tree)",
                ].join("\n"),
                metadata: { action: "status", branch: currentBranch, staged, modified, untracked },
              }
            }

            case "diff": {
              const args = params.staged
                ? ["diff", "--cached", "--stat"]
                : ["diff", "--stat"]
              if (params.files?.length) {
                args.push("--", ...params.files)
              }
              const { output: stat } = yield* runGit(args)

              const detailArgs = params.staged
                ? ["diff", "--cached"]
                : ["diff"]
              if (params.files?.length) {
                detailArgs.push("--", ...params.files)
              }
              const { output: detail } = yield* runGit(detailArgs)

              return {
                title: "Git: diff",
                output: [stat || "No changes.", "", detail].join("\n"),
                metadata: { action: "diff", staged: params.staged, files: params.files },
              }
            }

            case "log": {
              const args = [
                "log",
                `-${params.count}`,
                "--pretty=format:%h %s (%cr) <%an>",
              ]
              if (params.branch) {
                args.push(params.branch)
              }
              const { output } = yield* runGit(args)
              const lines = output.trim().split("\n").filter(Boolean)

              return {
                title: `Git: log (${lines.length} commits)`,
                output: lines.join("\n") || "No commits found.",
                metadata: { action: "log", count: lines.length, branch: params.branch },
              }
            }

            case "branch": {
              if (!params.branch) {
                const { output } = yield* runGit(["branch", "--list", "-v", "--no-abbrev"])
                const { output: current } = yield* runGit(["branch", "--show-current"])
                return {
                  title: `Git: branches (${current.trim()})`,
                  output: output || "No branches found.",
                  metadata: { action: "branch", current: current.trim() },
                }
              }

              yield* runGit(["checkout", "-b", params.branch])
              return {
                title: `Git: branch ${params.branch}`,
                output: [
                  `Created and switched to branch: ${params.branch}`,
                  `Previous branch state is preserved. Use 'git_ops' with action 'branch' to switch back.`,
                ].join("\n"),
                metadata: { action: "branch", created: params.branch },
              }
            }

            case "commit": {
              if (!params.message) {
                return {
                  title: "Git: commit failed",
                  output: "Commit requires a 'message' parameter.",
                  metadata: { action: "commit", error: "missing_message" },
                }
              }

              const addArgs = ["add"]
              if (params.files?.length) {
                addArgs.push("--", ...params.files)
              } else if (!params.staged) {
                addArgs.push("-A")
              }
              yield* runGit(addArgs)

              const { output: diffStat } = yield* runGit(["diff", "--cached", "--stat"])
              const { exitCode } = yield* runGit(["commit", "-m", params.message])

              if (exitCode !== 0) {
                return {
                  title: "Git: commit failed",
                  output: "Commit failed. Check if there are any changes to commit.",
                  metadata: { action: "commit", error: "commit_failed" },
                }
              }

              const { output: hash } = yield* runGit(["rev-parse", "--short", "HEAD"])
              return {
                title: `Git: committed ${hash.trim()}`,
                output: [
                  `Committed: ${hash.trim()}`,
                  `Message: ${params.message}`,
                  "",
                  diffStat || "  (no diff stat available)",
                ].join("\n"),
                metadata: { action: "commit", hash: hash.trim(), message: params.message },
              }
            }

            case "stash": {
              const { output: currentBranch } = yield* runGit(["branch", "--show-current"])
              const stashArgs = params.stashMessage
                ? ["stash", "push", "-m", params.stashMessage]
                : ["stash", "push"]
              const { exitCode } = yield* runGit(stashArgs)

              if (exitCode !== 0) {
                return {
                  title: "Git: stash (nothing to stash)",
                  output: "No changes to stash. Working tree is clean.",
                  metadata: { action: "stash", stashed: false },
                }
              }

              return {
                title: `Git: stashed on ${currentBranch.trim()}`,
                output: [
                  `Changes stashed successfully.`,
                  ...(params.stashMessage ? [`Message: ${params.stashMessage}`] : []),
                  `Use git_ops with action 'stash' to list or restore stashed changes.`,
                ].join("\n"),
                metadata: { action: "stash", stashed: true, message: params.stashMessage },
              }
            }

            case "restore": {
              const restoreArgs = ["restore"]
              if (params.staged) {
                restoreArgs.push("--staged")
              }
              if (params.files?.length) {
                restoreArgs.push("--", ...params.files)
              } else {
                restoreArgs.push(".")
              }
              yield* runGit(restoreArgs)

              return {
                title: "Git: restored",
                output: params.files?.length
                  ? `Restored ${params.files.length} file(s) to their last committed state.`
                  : "Restored all files to their last committed state.",
                metadata: { action: "restore", files: params.files, staged: params.staged },
              }
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)