import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { useLanguage } from "@tui/context/language"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"

const id = "internal:sidebar-mcp"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const { t } = useLanguage()
  const list = createMemo(() => props.api.state.mcp())
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const dot = (status: string) => {
    if (status === "connected") return theme().success
    if (status === "failed") return theme().error
    if (status === "pending") return theme().warning
    if (status === "disabled") return theme().textMuted
    if (status === "needs_auth") return theme().warning
    if (status === "needs_client_registration") return theme().error
    return theme().textMuted
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>{t("tui.sidebar.mcp")}</b>
            <Show when={!open()}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({on()} {t("tui.sidebar.active")}{bad() > 0 ? `, ${bad()} ${t("tui.sidebar.errors", { count: bad() })}` : ""})
              </span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: dot(item.status),
                  }}
                >
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {item.name}{" "}
                  <span style={{ fg: theme().textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>{t("tui.sidebar.connected")}</Match>
                      <Match when={item.status === "failed"}>
                        <i>{item.error}</i>
                      </Match>
                      <Match when={(item.status as string) === "pending"}>{t("tui.sidebar.pending_approval")}</Match>
                      <Match when={item.status === "disabled"}>{t("tui.sidebar.disabled")}</Match>
                      <Match when={item.status === "needs_auth"}>{t("tui.sidebar.needs_auth")}</Match>
                      <Match when={item.status === "needs_client_registration"}>{t("tui.sidebar.needs_client_id")}</Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
