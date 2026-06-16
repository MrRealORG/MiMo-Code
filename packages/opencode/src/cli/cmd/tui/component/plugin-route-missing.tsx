import { useTheme } from "../context/theme"
import { useLanguage } from "@tui/context/language"

export function PluginRouteMissing(props: { id: string; onHome: () => void }) {
  const { theme } = useTheme()
  const { t } = useLanguage()

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
      <text fg={theme.warning}>{t("tui.plugin_route_missing.unknown", { id: props.id })}</text>
      <box onMouseUp={props.onHome} backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text}>{t("tui.plugin_route_missing.go_home")}</text>
      </box>
    </box>
  )
}
