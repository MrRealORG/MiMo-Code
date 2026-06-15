import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { useLanguage } from "@tui/context/language"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-goal"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const { t } = useLanguage()
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))
  // The latest verdict (keyed by the most recently judged turn) drives the
  // status line; per-turn reasons live inline on the message stream.
  const latest = createMemo(() => {
    const g = goal()
    if (!g?.lastMessageID) return undefined
    return g.verdicts[g.lastMessageID]
  })

  // Show whenever there is an active goal, or a verdict survives from a goal
  // that just cleared (so the ✓/⊘ result lingers briefly).
  const show = createMemo(() => Boolean(goal()?.condition || latest()))

  const status = createMemo(() => {
    const v = latest()
    if (!v) return undefined
    if (v.error) return { dot: theme().textMuted, label: t("tui.sidebar.goal_error_stopped") }
    if (v.ok) return { dot: theme().success, label: t("tui.sidebar.goal_met") }
    if (v.impossible) return { dot: theme().error, label: t("tui.sidebar.goal_impossible") }
    return { dot: theme().warning, label: t("tui.sidebar.goal_not_met", { round: v.attempt }) }
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
                {t("tui.sidebar.judge")}: {s().label}
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
    // Just below LSP (300) so the goal status sits beneath the LSP block.
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
