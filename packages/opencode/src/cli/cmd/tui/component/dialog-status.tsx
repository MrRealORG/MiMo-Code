import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import { useLanguage } from "../context/language"

export type DialogStatusProps = {}

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const { t } = useLanguage()

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const mcpCount = createMemo(() => Object.keys(sync.data.mcp).length)
  const lspCount = createMemo(() => sync.data.lsp.length)
  const formatterCount = createMemo(() => enabledFormatters().length)
  const pluginCount = createMemo(() => plugins().length)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("tui.dialog.status.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={mcpCount() > 0} fallback={<text fg={theme.text}>{t("tui.dialog.status.no_mcp")}</text>}>
        <box>
          <text fg={theme.text}>{t("tui.dialog.status.mcp_count", { count: mcpCount() })}</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: theme.success,
                        failed: theme.error,
                        pending: theme.warning,
                        disabled: theme.textMuted,
                        needs_auth: theme.warning,
                        needs_client_registration: theme.error,
                      } as Record<string, typeof theme.success>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>{t("tui.dialog.status.mcp.connected")}</Match>
                      <Match when={item.status === "failed"}>{(item as { error?: string }).error}</Match>
                      <Match when={(item.status as string) === "pending"}>{t("tui.dialog.status.mcp.pending")}</Match>
                      <Match when={item.status === "disabled"}>{t("tui.dialog.status.mcp.disabled")}</Match>
                      <Match when={(item.status as string) === "needs_auth"}>
                        {t("tui.dialog.status.mcp.needs_auth", { key })}
                      </Match>
                      <Match when={(item.status as string) === "needs_client_registration"}>
                        {(item as { error?: string }).error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {lspCount() > 0 && (
        <box>
          <text fg={theme.text}>{t("tui.dialog.status.lsp_count", { count: lspCount() })}</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.success,
                      error: theme.error,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={formatterCount() > 0} fallback={<text fg={theme.text}>{t("tui.dialog.status.no_formatters")}</text>}>
        <box>
          <text fg={theme.text}>{t("tui.dialog.status.formatters_count", { count: formatterCount() })}</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={pluginCount() > 0} fallback={<text fg={theme.text}>{t("tui.dialog.status.no_plugins")}</text>}>
        <box>
          <text fg={theme.text}>{t("tui.dialog.status.plugins_count", { count: pluginCount() })}</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}