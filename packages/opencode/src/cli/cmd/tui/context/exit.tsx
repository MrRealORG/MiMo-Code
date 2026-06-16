import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { win32FlushInputBuffer } from "../win32"
type Exit = ((reason?: unknown) => Promise<void>) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onBeforeExit?: () => Promise<void>; onExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    let message: string | undefined
    let task: Promise<void> | undefined
    const store = {
      set: (value?: string) => {
        const prev = message
        message = value
        return () => {
          message = prev
        }
      },
      clear: () => {
        message = undefined
      },
      get: () => message,
    }
    const exit: Exit = Object.assign(
      (reason?: unknown) => {
        if (task) return task
        task = (async () => {
          await input.onBeforeExit?.()
          // Reset window title before destroying renderer
          renderer.setTerminalTitle("")
          renderer.destroy()
          // SGR reset + show cursor + disable mouse tracking + OSC color resets.
          // Mouse tracking disable must be sent BEFORE renderer.destroy() or
          // after — but always before process exit — to prevent the terminal
          // from staying in mouse mode on abnormal exit (SIGTERM, killed by
          // another process). Without this, every mouse movement emits
          // garbage escape sequences like [555;row;colM (#838).
          // The sequences below disable all common mouse tracking modes:
          //   ?1000  basic tracking (BTN_EVENT / X10)
          //   ?1002  button-event tracking
          //   ?1003  any-event tracking
          //   ?1006  SGR extended coordinate mode
          //   ?1015  URXVT extended coordinate mode
          //   ?1005  UTF-8 extended coordinate mode
          process.stdout.write(
            "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" +
              "\x1b[0m\x1b[?25h\x1b]110\x07\x1b]111\x07\x1b]112\x07",
          )
          win32FlushInputBuffer()
          if (reason) {
            const formatted = FormatError(reason) ?? FormatUnknownError(reason)
            if (formatted) {
              process.stderr.write(formatted + "\n")
            }
          }
          const text = store.get()
          if (text) process.stdout.write(text + "\n")
          await input.onExit?.()
        })()
        return task
      },
      {
        message: store,
      },
    )
    process.on("SIGHUP", () => exit())
    // Synchronous exit hook — runs even when the process is killed by a
    // signal that prevents the async exit() from completing (e.g. SIGTERM
    // from an external process). Ensures mouse tracking and terminal state
    // are always cleaned up.
    const TERMINAL_CLEANUP =
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" +
      "\x1b[0m\x1b[?25h\x1b]110\x07\x1b]111\x07\x1b]112\x07"
    process.on("exit", () => {
      try {
        process.stdout.write(TERMINAL_CLEANUP)
      } catch {}
    })
    return exit
  },
})
