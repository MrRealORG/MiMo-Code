import { createContext, useContext, type ParentProps, Show, For } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import z from "zod"
import { type TuiEvent } from "../event"
import { useLanguage } from "@tui/context/language"

export type ToastOptions = z.infer<typeof TuiEvent.ToastShow.properties>

const MAX_TOASTS = 3

interface ToastEntry extends ToastOptions {
  id: number
}

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <For each={toast.toasts()}>
      {(entry, index) => {
        const height = entry.title
          ? (entry.message.length > 40 ? 4 : 3)
          : (entry.message.length > 40 ? 3 : 2)
        return (
          <box
            position="absolute"
            zIndex={4000}
            justifyContent="center"
            alignItems="flex-start"
            top={2 + index() * (height + 1)}
            right={2}
            maxWidth={Math.min(60, dimensions().width - 6)}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.backgroundPanel}
            borderColor={theme[entry.variant]}
            border={["left", "right"]}
            customBorderChars={SplitBorder.customBorderChars}
          >
            <Show when={entry.title}>
              <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
                {entry.title}
              </text>
            </Show>
            <text fg={theme.text} wrapMode="word" width="100%">
              {entry.message}
            </text>
          </box>
        )
      }}
    </For>
  )
}

let nextToastId = 0

function init() {
  const [store, setStore] = createStore({
    toasts: [] as ToastEntry[],
  })
  const t = useLanguage().t

  const timeoutHandles = new Map<number, NodeJS.Timeout>()

  function removeToast(id: number) {
    const handle = timeoutHandles.get(id)
    if (handle) {
      clearTimeout(handle)
      timeoutHandles.delete(id)
    }
    setStore(produce((draft: { toasts: ToastEntry[] }) => {
      const idx = draft.toasts.findIndex(t => t.id === id)
      if (idx !== -1) draft.toasts.splice(idx, 1)
    }))
  }

  const toast = {
    show(options: ToastOptions) {
      const { duration = 5000, ...toastOpts } = options
      const id = nextToastId++
      const entry: ToastEntry = { ...toastOpts, id }

      // Evict oldest toasts if at capacity
      const current = store.toasts
      while (current.length >= MAX_TOASTS) {
        const removed = current.shift()!
        const handle = timeoutHandles.get(removed.id)
        if (handle) {
          clearTimeout(handle)
          timeoutHandles.delete(removed.id)
        }
      }
      current.push(entry)
      setStore("toasts", [...current])

      timeoutHandles.set(id, setTimeout(() => {
        removeToast(id)
      }, duration).unref())
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
    get toasts() {
      return store.toasts
    },
    get currentToast(): ToastOptions | null {
      return store.toasts[store.toasts.length - 1] ?? null
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
