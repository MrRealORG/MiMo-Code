import { createMemo, createResource, createSignal, Show, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useToast, type ToastContext } from "../ui/toast"
import { useKeyboard } from "@opentui/solid"
import { Spinner } from "./spinner"
import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { filter, sortBy } from "remeda"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

type OpenRouterModel = {
  id: string
  name: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
  }
}

type OpenRouterResponse = {
  data: OpenRouterModel[]
}

type PricingFilter = "all" | "free" | "paid"

function isFreeModel(model: OpenRouterModel): boolean {
  const promptPrice = parseFloat(model.pricing?.prompt ?? "1")
  const completionPrice = parseFloat(model.pricing?.completion ?? "1")
  return promptPrice === 0 && completionPrice === 0
}

function formatContextLength(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)}M`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)}K`
  return String(bytes)
}

function formatPrice(pricePerToken: string): string {
  const price = parseFloat(pricePerToken)
  if (price === 0) return "Free"
  const perMillion = price * 1_000_000
  if (perMillion < 0.01) return "<$0.01/M"
  return `$${perMillion.toFixed(2)}/M tok`
}

export function DialogBrowseOpenRouter() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const [filterMode, setFilterMode] = createSignal<PricingFilter>("all")
  const [query, setQuery] = createSignal("")

  const [resource] = createResource(async (): Promise<OpenRouterModel[]> => {
    try {
      const res = await globalThis.fetch(OPENROUTER_MODELS_URL, {
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return []
      const json: OpenRouterResponse = await res.json()
      return json.data ?? []
    } catch {
      return []
    }
  })

  const allModels = createMemo(() => {
    const raw = resource()
    if (!raw) return []
    return sortBy(raw, (m) => m.name)
  })

  const filteredModels = createMemo(() => {
    let items = allModels()
    const mode = filterMode()
    if (mode === "free") items = filter(items, isFreeModel)
    if (mode === "paid") items = filter(items, (m) => !isFreeModel(m))

    const q = query().trim().toLowerCase()
    if (q) {
      items = filter(items, (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    }
    return items
  })

  const totalCount = createMemo(() => allModels().length)
  const freeCount = createMemo(() => allModels().filter(isFreeModel).length)
  const paidCount = createMemo(() => allModels().filter((m) => !isFreeModel(m)).length)

  const filterLabel = createMemo(() => {
    const mode = filterMode()
    if (mode === "free") return `[Free: ${freeCount()}]`
    if (mode === "paid") return `[Paid: ${paidCount()}]`
    return `[All: ${totalCount()}]`
  })

  useKeyboard((evt) => {
    if (evt.name === "1") {
      evt.preventDefault()
      evt.stopPropagation()
      setFilterMode("all")
    }
    if (evt.name === "2") {
      evt.preventDefault()
      evt.stopPropagation()
      setFilterMode("free")
    }
    if (evt.name === "3") {
      evt.preventDefault()
      evt.stopPropagation()
      setFilterMode("paid")
    }
  })

  const options = createMemo((): DialogSelectOption<{ modelID: string; name: string }>[] => {
    return filteredModels().map((model) => {
      const free = isFreeModel(model)
      const promptPrice = formatPrice(model.pricing?.prompt ?? "0")
      const completionPrice = formatPrice(model.pricing?.completion ?? "0")
      const context = formatContextLength(model.context_length)

      return {
        title: model.name,
        value: { modelID: model.id, name: model.name },
        description: `${context} ctx`,
        footer: free ? "Free" : `${promptPrice} / ${completionPrice}`,
        category: free ? "Free models" : "Paid models",
        async onSelect() {
          const patch = {
            provider: {
              openrouter: {
                models: {
                  [model.id]: {
                    name: model.name,
                  },
                },
              },
            },
          }
          const updateRes = await sdk.client.global.config.update({ config: patch as any })
          if (updateRes.error) {
            toast.show({ variant: "error", message: String(updateRes.error) })
            return
          }
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          toast.show({ variant: "success", message: `Enabled: ${model.name}` })
          dialog.clear()
        },
      }
    })
  })

  const loading = createMemo(() => resource.loading)

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <Show
      when={!loading()}
      fallback={
        <box paddingLeft={4} paddingRight={4} paddingTop={4} gap={1}>
          <Spinner color={theme.textMuted}>Fetching models from OpenRouter...</Spinner>
        </box>
      }
    >
      <Show
        when={allModels().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={2} gap={1}>
            <text fg={theme.textMuted}>Failed to fetch models from OpenRouter.</text>
            <text fg={theme.textMuted}>Check your internet connection and try again.</text>
          </box>
        }
      >
        <box gap={1} paddingBottom={1}>
          <box paddingLeft={4} paddingRight={4}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Browse OpenRouter Models {filterLabel()}
              </text>
              <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
                esc
              </text>
            </box>
            <box paddingTop={1} gap={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                Filters:
              </text>
              <text fg={filterMode() === "all" ? theme.primary : theme.textMuted}>
                1:All
              </text>
              <text fg={filterMode() === "free" ? theme.primary : theme.textMuted}>
                2:Free
              </text>
              <text fg={filterMode() === "paid" ? theme.primary : theme.textMuted}>
                3:Paid
              </text>
            </box>
          </box>
          <DialogSelect
            title=""
            options={options()}
            placeholder="Search models..."
            flat={true}
            skipFilter={false}
            onFilter={setQuery}
          />
          <box paddingLeft={4} paddingRight={1} gap={1}>
            <text fg={theme.textMuted}>
              Select a model to enable it. Press 1/2/3 to filter.
            </text>
          </box>
        </box>
      </Show>
    </Show>
  )
}