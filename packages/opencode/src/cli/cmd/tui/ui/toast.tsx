import { createContext, useContext, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import z from "zod"
import { type TuiEvent } from "../event"
import { useLanguage } from "@tui/context/language"

export type ToastOptions = z.infer<typeof TuiEvent.ToastShow.properties>

/** After this many identical messages, further occurrences are suppressed for the session. */
const MAX_TOAST_REPEATS = 3
/** Minimum ms between showings of the same message. */
const MIN_TOAST_INTERVAL_MS = 30_000

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          zIndex={4000}
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          borderColor={theme[current().variant]}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <Show when={current().title}>
            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
              {current().title}
            </text>
          </Show>
          <text fg={theme.text} wrapMode="word" width="100%">
            {current().message}
          </text>
        </box>
      )}
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
  })
  const t = useLanguage().t

  let timeoutHandle: NodeJS.Timeout | null = null

  // Deduplication state: message key → { count, lastShown }
  const seen = new Map<string, { count: number; lastShown: number }>()

  function shouldSuppress(message: string): boolean {
    const now = Date.now()
    const entry = seen.get(message)
    if (!entry) return false
    // Already shown MAX times — suppress for the rest of the session
    if (entry.count >= MAX_TOAST_REPEATS) return true
    // Shown recently — suppress until interval elapses
    if (now - entry.lastShown < MIN_TOAST_INTERVAL_MS) return true
    return false
  }

  function recordShown(message: string) {
    const now = Date.now()
    const entry = seen.get(message)
    if (entry) {
      entry.count++
      entry.lastShown = now
    } else {
      seen.set(message, { count: 1, lastShown: now })
    }
  }

  const toast = {
    show(options: ToastOptions) {
      const { duration = 5000, ...currentToast } = options
      if (shouldSuppress(currentToast.message)) return
      recordShown(currentToast.message)
      setStore("currentToast", currentToast)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
      }, duration).unref()
    },
    error: (err: any) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: t("tui.toast.unknown_error"),
      })
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}