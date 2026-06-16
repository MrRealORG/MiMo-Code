import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useLanguage } from "@tui/context/language"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const { t } = useLanguage()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: item.native ? t("tui.agent.native") : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title={t("tui.agent.title")}
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}