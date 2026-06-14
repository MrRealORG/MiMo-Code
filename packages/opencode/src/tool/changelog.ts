import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Instance } from "../project/instance"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Log } from "../util"

const log = Log.create({ service: "changelog-tool" })

const Parameters = z.object({
  action: z.enum([
    "generate",
    "latest",
  ]).describe(
    "Changelog action. " +
    "'generate' — generates a full CHANGELOG.md from git history with conventional commit parsing. " +
    "'latest' — shows only the changes since the last tagged release.",
  ),
  output: z
    .string()
    .optional()
    .describe("Output file path (default: 'CHANGELOG.md' in worktree root). Only used with 'generate' action."),
  tagPrefix: z
    .string()
    .optional()
    .default("v")
    .describe("Git tag prefix (default: 'v'). Used to detect release tags."),
})

interface CommitInfo {
  hash: string
  shortHash: string
  type: string
  scope: string | null
  description: string
  body: string
  date: string
  author: string
  breaking: boolean
}

const CONVENTIONAL_COMMIT_REGEX = /^(\w+)(?:\(([^)]+)\))?!?:\s+(.+)$/

function parseConventionalCommit(message: string): { type: string; scope: string | null; description: string; breaking: boolean } {
  const match = message.match(CONVENTIONAL_COMMIT_REGEX)
  if (!match) {
    return { type: "other", scope: null, description: message.split("\n")[0], breaking: false }
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    description: match[3],
    breaking: message.includes("BREAKING CHANGE") || message.includes("BREAKING-CHANGE") || message.endsWith("!"),
  }
}

const COMMIT_TYPE_LABELS: Record<string, { label: string; emoji: string }> = {
  feat: { label: "Features", emoji: "✨" },
  fix: { label: "Bug Fixes", emoji: "🐛" },
  perf: { label: "Performance", emoji: "⚡" },
  refactor: { label: "Refactoring", emoji: "🔧" },
  docs: { label: "Documentation", emoji: "📝" },
  test: { label: "Tests", emoji: "✅" },
  build: { label: "Build System", emoji: "📦" },
  ci: { label: "CI/CD", emoji: "👷" },
  chore: { label: "Chores", emoji: "🏗️" },
  style: { label: "Styles", emoji: "💄" },
  revert: { label: "Reverts", emoji: "⏪" },
  other: { label: "Other", emoji: "📌" },
}

export const ChangelogTool = Tool.define(
  "changelog",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    return {
      description:
        "Auto-generate professional changelogs from git history. " +
        "Parses conventional commits (feat, fix, perf, refactor, etc.) and organizes them by type and scope. " +
        "'generate' — creates a full CHANGELOG.md with all releases, organized by version tags. " +
        "'latest' — shows changes since the last tagged release. " +
        "Groups commits by type (Features, Bug Fixes, Performance, etc.) with emoji indicators.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cwd = Instance.worktree

          const runGit = async (args: string[], timeoutMs: number = 15000): Promise<string> => {
            const proc = yield* spawner.spawn(
              { command: "git", args, options: { cwd, shell: false } },
            )
            const chunks: string[] = []
            yield* Effect.forkScoped(
              Effect.async<void>((resume) => {
                const handler = (chunk: string) => { chunks.push(chunk) }
                proc.stdout.subscribe(handler)
                proc.stderr.subscribe(handler)
                proc.exitCode.then(() => {
                  proc.stdout.unsubscribe(handler)
                  proc.stderr.unsubscribe(handler)
                  resume(Effect.void)
                })
              }),
            )
            yield* proc.exitCode.pipe(
              Effect.timeout(`${timeoutMs} millis`),
              Effect.catch(() => Effect.succeed(null)),
            )
            return chunks.join("").trim()
          }

          // Get all tags
          const tagsOutput = yield* runGit(["tag", "--sort=-creatordate"])
          const tags = tagsOutput ? tagsOutput.split("\n").filter(Boolean) : []
          const prefix = params.tagPrefix ?? "v"
          const releaseTags = tags.filter((t) => t.startsWith(prefix))

          // Determine range
          let rangeFrom: string | null = null
          let rangeTo = "HEAD"
          let latestTag: string | null = null

          if (params.action === "latest" && releaseTags.length > 0) {
            rangeFrom = releaseTags[0]
            latestTag = releaseTags[0]
          }

          // Get commits
          const logArgs = ["log", "--no-merges", `--format=%H%n%h%n%ai%n%an%n%s%n%b%n---COMMIT---`]
          if (rangeFrom) {
            logArgs.splice(2, 0, `${rangeFrom}..${rangeTo}`)
          }

          const logOutput = yield* runGit(logArgs, 30000)
          if (!logOutput) {
            return {
              title: "Changelog: no commits found",
              output: "No commits found in the specified range.",
              metadata: { action: params.action, commits: 0 },
            }
          }

          // Parse commits
          const commits: CommitInfo[] = []
          const commitBlocks = logOutput.split("---COMMIT---").filter(Boolean)

          for (const block of commitBlocks) {
            const lines = block.trim().split("\n")
            if (lines.length < 4) continue

            const hash = lines[0].trim()
            const shortHash = lines[1].trim()
            const date = lines[2].trim().split(" ")[0]
            const author = lines[3].trim()
            const subject = lines[4].trim()
            const body = lines.slice(5).join("\n").trim()

            const parsed = parseConventionalCommit(subject)
            commits.push({
              hash,
              shortHash,
              type: parsed.type,
              scope: parsed.scope,
              description: parsed.description,
              body,
              date,
              author,
              breaking: parsed.breaking,
            })
          }

          if (commits.length === 0) {
            return {
              title: "Changelog: no conventional commits",
              output: "No conventional commits found. Use format: type(scope): description",
              metadata: { action: params.action, commits: 0 },
            }
          }

          // Group commits by type
          const grouped: Record<string, CommitInfo[]> = {}
          for (const commit of commits) {
            if (!grouped[commit.type]) grouped[commit.type] = []
            grouped[commit.type].push(commit)
          }

          // Generate changelog content
          const lines: string[] = []

          if (params.action === "latest") {
            lines.push(`## Changes since ${latestTag}`)
            lines.push(``)
          } else {
            lines.push(`# Changelog`)
            lines.push(``)
            lines.push(`All notable changes to this project will be documented in this file.`)
            lines.push(``)
          }

          lines.push(`**${commits.length} commit(s)** by ${new Set(commits.map((c) => c.author)).size} contributor(s)`)
          lines.push(``)

          // Breaking changes first
          const breakingCommits = commits.filter((c) => c.breaking)
          if (breakingCommits.length > 0) {
            lines.push(`### BREAKING CHANGES`)
            lines.push(``)
            for (const commit of breakingCommits) {
              lines.push(`- ${commit.description} (${commit.shortHash})`)
            }
            lines.push(``)
          }

          // Group by type in order
          const typeOrder = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "style", "revert", "other"]
          for (const type of typeOrder) {
            const typeCommits = grouped[type]
            if (!typeCommits || typeCommits.length === 0) continue

            const label = COMMIT_TYPE_LABELS[type] || COMMIT_TYPE_LABELS.other
            lines.push(`### ${label.emoji} ${label.label}`)
            lines.push(``)

            // Sub-group by scope if multiple scopes
            const scopes = new Map<string, CommitInfo[]>()
            const noScope: CommitInfo[] = []
            for (const commit of typeCommits) {
              if (commit.scope) {
                if (!scopes.has(commit.scope)) scopes.set(commit.scope, [])
                scopes.get(commit.scope)!.push(commit)
              } else {
                noScope.push(commit)
              }
            }

            if (scopes.size > 1) {
              for (const [scope, scopeCommits] of scopes) {
                lines.push(`**${scope}:**`)
                for (const commit of scopeCommits) {
                  lines.push(`- ${commit.description} (${commit.shortHash})`)
                }
                lines.push(``)
              }
            }

            for (const commit of noScope) {
              lines.push(`- ${commit.description} (${commit.shortHash})`)
            }

            lines.push(``)
          }

          // Contributors
          const contributors = [...new Set(commits.map((c) => c.author))]
          if (contributors.length > 0) {
            lines.push(`### Contributors`)
            lines.push(``)
            for (const contributor of contributors) {
              lines.push(`- ${contributor}`)
            }
          }

          const changelogContent = lines.join("\n")

          // Write file if generate action
          if (params.action === "generate") {
            const { AppFileSystem } = yield* Effect.promise(() => import("@mimo-ai/shared/filesystem"))
            const fs = yield* AppFileSystem.Service
            const outputPath = params.output
              ? path.isAbsolute(params.output) ? params.output : path.join(cwd, params.output)
              : path.join(cwd, "CHANGELOG.md")

            yield* fs.writeFileString(outputPath, changelogContent)

            return {
              title: `Changelog: ${commits.length} commits → CHANGELOG.md`,
              output: [
                `Generated changelog with ${commits.length} commits.`,
                `Output: ${path.relative(cwd, outputPath)}`,
                `Types: ${Object.keys(grouped).map((t) => `${t}(${grouped[t].length})`).join(", ")}`,
                `Contributors: ${contributors.length}`,
                ...(breakingCommits.length > 0 ? [`Breaking changes: ${breakingCommits.length}`] : []),
              ].join("\n"),
              metadata: {
                action: "generate",
                commits: commits.length,
                types: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
                contributors: contributors.length,
                breaking: breakingCommits.length,
                outputPath: path.relative(cwd, outputPath),
              },
            }
          }

          // For 'latest', just return the content
          return {
            title: `Changelog: ${commits.length} commits since ${latestTag}`,
            output: changelogContent,
            metadata: {
              action: "latest",
              since: latestTag,
              commits: commits.length,
              types: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)