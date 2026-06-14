import type { CommandModule, Argv } from "yargs"

type WithDoubleDash<T> = T & { "--"?: string[] }

/**
 * Creates a lazy command module that defers the actual module import
 * until yargs matches and executes the command. This significantly reduces
 * startup time by avoiding eager loading of heavy command dependencies
 * (tools, providers, app-runtime, etc.) for commands that are not being run.
 *
 * Only the `command` string and `describe` string are loaded eagerly so that
 * `--help` output remains complete without importing the full command module.
 */
export function lazyCommand<T = {}, U = {}>(
  command: string,
  describe: string,
  importFn: () => Promise<{ [key: string]: unknown }>,
  exportName: string,
): CommandModule<T, WithDoubleDash<U>> {
  let resolved: CommandModule<T, WithDoubleDash<U>> | undefined
  let resolvePromise: Promise<CommandModule<T, WithDoubleDash<U>>> | undefined

  function resolve(): Promise<CommandModule<T, WithDoubleDash<U>>> {
    if (resolved) return Promise.resolve(resolved)
    if (!resolvePromise) {
      resolvePromise = importFn().then((mod) => {
        resolved = mod[exportName] as CommandModule<T, WithDoubleDash<U>>
        return resolved
      })
    }
    return resolvePromise
  }

  return {
    command,
    describe,
    builder: ((argv: Argv<T>) => resolve().then((mod) => {
      if (typeof mod.builder === "function") return mod.builder(argv)
      return argv
    })) as CommandModule<T, WithDoubleDash<U>>["builder"],
    handler: ((argv: any) => resolve().then((mod) => {
      if (typeof mod.handler === "function") return mod.handler(argv)
    })) as CommandModule<T, WithDoubleDash<U>>["handler"],
  }
}