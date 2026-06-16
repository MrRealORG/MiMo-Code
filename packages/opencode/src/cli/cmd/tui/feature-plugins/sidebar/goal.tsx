import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useLanguage } from "@tui/context/language"

const id = "internal:sidebar-goal"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const t = useLanguage().t
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))
  const latest = createMemo(() => {
    const g = goal()
    if (!g?.lastMessageID) return undefined
    return g.verdicts[g.lastMessageID]
  })

  const show = createMemo(() => Boolean(goal()?.condition || latest()))

  const status = createMemo(() => {
    const v = latest()
    if (!v) return undefined
    if (v.error) return { dot: theme().textMuted, label: t("tui.sidebar.goal.error_stopped") }
    if (v.ok) return { dot: theme().success, label: t("tui.sidebar.goal.met") }
    if (v.impossible) return { dot: theme().error, label: t("tui.sidebar.goal.impossible") }
    return { dot: theme().warning, label: t("tui.sidebar.goal.not_met", { round: v.attempt }) }
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>{t("tui.sidebar.goal")}</b>
          </text>
        </box>
        <Show when={goal()?.condition}>
          {(condition) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme().primary}>
                •
              </text>
              <text fg={theme().textMuted} wrapMode="word">
                {condition()}
              </text>
            </box>
          )}
        </Show>
        <Show when={status()}>
          {(s) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={s().dot}>
                •
              </text>
              <text fg={theme().textMuted} wrapMode="word">
                {t("tui.sidebar.goal.judge")}{s().label}
              </text>
            </box>
          )}
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin