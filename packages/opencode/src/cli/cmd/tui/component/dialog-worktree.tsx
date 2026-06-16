import { createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { useToast } from "../ui/toast"
import { useLanguage } from "@tui/context/language"
import path from "path"
import * as Log from "@/util/log"

const CREATE_SENTINEL = "__create_worktree__"

const log = Log.create({ service: "tui.worktree" })

export function DialogWorktree() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const toast = useToast()
  const { t } = useLanguage()
  const [worktrees, setWorktrees] = createSignal<string[]>()
  const [busy, setBusy] = createSignal<string>()

  onMount(async () => {
    dialog.setSize("medium")
    const result = await sdk.client.worktree.list().catch((err: any) => {
      log.warn("Failed to list worktrees", { error: err })
      return undefined
    })
    setWorktrees(result?.data ?? [])
  })

  const options = createMemo(() => {
    const b = busy()
    if (b) {
      return [{ title: b, value: "__busy__" }]
    }

    const list = worktrees()
    if (!list) {
      return [{ title: t("tui.worktree.loading"), value: "__loading__" }]
    }

    const items = list.map((dir) => ({
      title: path.basename(dir),
      value: dir,
      description: dir,
    }))

    return [
      ...items,
      {
        title: t("tui.worktree.create_new"),
        value: CREATE_SENTINEL,
        description: undefined as string | undefined,
      },
    ]
  })

  async function switchTo(directory: string) {
    setBusy(t("tui.worktree.switching"))
    await sdk.client.instance.dispose().catch(() => {})
    sdk.switchDirectory(directory)
    await sync.bootstrap()
    route.navigate({ type: "home" })
    dialog.clear()
    toast.show({ message: t("tui.worktree.switched", { name: path.basename(directory) }), variant: "success" })
  }

  async function create() {
    setBusy(t("tui.worktree.creating"))
    const result = await sdk.client.worktree.create().catch((err: any) => {
      log.warn("Failed to create worktree", { error: err })
      return undefined
    })
    if (!result?.data) {
      toast.show({ message: t("tui.worktree.create_failed"), variant: "error" })
      setBusy(undefined)
      return
    }
    await switchTo(result.data.directory)
  }

  return (
    <DialogSelect
      title={t("tui.worktree.title")}
      options={options()}
      skipFilter={true}
      onSelect={(option) => {
        if (option.value === "__busy__" || option.value === "__loading__") return
        if (option.value === CREATE_SENTINEL) {
          void create()
          return
        }
        void switchTo(option.value)
      }}
    />
  )
}