import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { Log } from "./util"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "./installation/version"
import { NamedError } from "@mimo-ai/shared/util/error"
import { FormatError } from "./cli/error"
import { Filesystem } from "./util"
import { lazyCommand } from "./cli/cmd/lazy-command"
import { EOL } from "os"
import path from "path"
import { Global } from "./global"
import { JsonMigration } from "./storage"
import { Database } from "./storage"
// ClaudeImport is loaded lazily inside the middleware to avoid pulling in
// session-parsing dependencies on every startup (only runs once per install).
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "./util/mimo-process"

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("mimo ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("mimo")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.MIMOCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.MIMOCODE = "1"
    process.env.MIMOCODE_PID = String(process.pid)

    Log.Default.info("mimocode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const marker = path.join(Global.Path.data, "mimocode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }

    // Idempotently import Claude Code sessions into SQLite. Runs once per process
    // tree (the env guard is inherited by spawned children) and is best-effort:
    // a failure here must never block command startup.
    if (!process.env.MIMOCODE_DISABLE_CLAUDE_IMPORT && !process.env.MIMOCODE_CLAUDE_IMPORTED) {
      process.env.MIMOCODE_CLAUDE_IMPORTED = "1"
      try {
        const { ClaudeImport } = await import("./session/claude-import")
        await ClaudeImport.run()
      } catch (e) {
        Log.Default.warn("claude-import failed", { e: errorMessage(e) })
      }
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  // Lazy-load all command modules to reduce startup time (#520).
  // Only the command name and description are resolved eagerly for --help;
  // the full module (tools, providers, app-runtime, etc.) is imported only
  // when yargs actually matches and executes the command.
  .command(lazyCommand("acp", "Agent Client Protocol", () => import("./cli/cmd/acp"), "AcpCommand"))
  .command(lazyCommand("mcp", "Manage MCP servers", () => import("./cli/cmd/mcp"), "McpCommand"))
  .command(lazyCommand("tui-thread", "TUI thread management", () => import("./cli/cmd/tui/thread"), "TuiThreadCommand"))
  .command(lazyCommand("attach", "Attach to a running TUI session", () => import("./cli/cmd/tui/attach"), "AttachCommand"))
  .command(lazyCommand("run", "Run a one-shot coding task", () => import("./cli/cmd/run"), "RunCommand"))
  .command(lazyCommand("generate", "Generate code from a prompt", () => import("./cli/cmd/generate"), "GenerateCommand"))
  .command(lazyCommand("debug", "Debugging and troubleshooting tools", () => import("./cli/cmd/debug"), "DebugCommand"))
  .command(lazyCommand("account", "Manage accounts", () => import("./cli/cmd/account"), "ConsoleCommand"))
  .command(lazyCommand("providers", "Manage providers", () => import("./cli/cmd/providers"), "ProvidersCommand"))
  .command(lazyCommand("agent", "Manage agents", () => import("./cli/cmd/agent"), "AgentCommand"))
  .command(lazyCommand("upgrade", "Upgrade mimo to the latest version", () => import("./cli/cmd/upgrade"), "UpgradeCommand"))
  .command(lazyCommand("uninstall", "Uninstall mimo", () => import("./cli/cmd/uninstall"), "UninstallCommand"))
  .command(lazyCommand("serve", "Start the MiMo Code server", () => import("./cli/cmd/serve"), "ServeCommand"))
  .command(lazyCommand("web", "Start the web UI", () => import("./cli/cmd/web"), "WebCommand"))
  .command(lazyCommand("models", "List and search available models", () => import("./cli/cmd/models"), "ModelsCommand"))
  .command(lazyCommand("stats", "Show session statistics", () => import("./cli/cmd/stats"), "StatsCommand"))
  .command(lazyCommand("export", "Export sessions", () => import("./cli/cmd/export"), "ExportCommand"))
  .command(lazyCommand("import", "Import sessions", () => import("./cli/cmd/import"), "ImportCommand"))
  .command(lazyCommand("github", "GitHub integration", () => import("./cli/cmd/github"), "GithubCommand"))
  .command(lazyCommand("pr", "Pull request management", () => import("./cli/cmd/pr"), "PrCommand"))
  .command(lazyCommand("session", "Manage sessions", () => import("./cli/cmd/session"), "SessionCommand"))
  .command(lazyCommand("plugin", "Manage plugins", () => import("./cli/cmd/plug"), "PluginCommand"))
  .command(lazyCommand("db", "Database management", () => import("./cli/cmd/db"), "DbCommand"))
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
