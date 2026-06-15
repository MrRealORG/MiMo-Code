import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useTheme } from "../context/theme"
import { Keybind } from "@/util"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "../context/language"
import * as Log from "@/util/log"

const log = Log.Default.clone().tag("service", "tui-mcp")

function Status(props: { enabled: boolean; loading: boolean; t: (key: string) => string }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>{props.t("tui.dialog.mcp.loading")}</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>{props.t("tui.dialog.mcp.enabled")}</span>
  }
  return <span style={{ fg: theme.textMuted }}>{props.t("tui.dialog.mcp.disabled")}</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const { t } = useLanguage()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const options = createMemo(() => {
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: status.status === "failed" ? t("tui.dialog.mcp.failed") : status.status,
        footer: <Status enabled={local.mcp.isEnabled(name)} loading={loadingMcp === name} t={t} />,
        category: undefined,
      })),
    )
  })

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("space")[0],
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== null) return

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
          } else {
            log.error("Failed to refresh MCP status: no data returned")
          }
        } catch (error) {
          log.error("Failed to toggle MCP", { name: option.value, error })
        } finally {
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title={t("tui.dialog.mcp.title")}
      options={options()}
      keybind={keybinds()}
      onSelect={(_option) => {
        // Don't close on select, only on escape
      }}
    />
  )
}