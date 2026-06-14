import { Button } from "@mimo-ai/ui/button"
import { Dialog } from "@mimo-ai/ui/dialog"
import { Icon } from "@mimo-ai/ui/icon"
import { IconButton } from "@mimo-ai/ui/icon-button"
import { Spinner } from "@mimo-ai/ui/spinner"
import { Switch } from "@mimo-ai/ui/switch"
import { Tag } from "@mimo-ai/ui/tag"
import { TextField } from "@mimo-ai/ui/text-field"
import { Tooltip } from "@mimo-ai/ui/tooltip"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"

type OpenRouterModel = {
  id: string
  name: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
    image?: string
  }
  top_provider?: { max_completion_tokens?: number }
  supported_parameters?: string[]
}

type OpenRouterResponse = {
  data: OpenRouterModel[]
}

type PricingFilter = "all" | "free" | "paid"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

function isFree(model: OpenRouterModel): boolean {
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
  if (price === 0) return "$0"
  const perMillion = price * 1_000_000
  if (perMillion < 0.01) return "<$0.01/M"
  return `$${perMillion.toFixed(2)}/M`
}

export const DialogBrowseOpenRouter: Component = () => {
  const language = useLanguage()
  const models = useModels()

  const [filter, setFilter] = createSignal<PricingFilter>("all")
  const [search, setSearch] = createSignal("")

  const [error, setError] = createSignal<string | undefined>()

  const [resource, { refetch }] = createResource(async () => {
    setError(undefined)
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: OpenRouterResponse = await res.json()
      return json.data ?? []
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      return []
    }
  })

  const allModels = createMemo(() => {
    const raw = resource() ?? []
    return raw.sort((a, b) => a.name.localeCompare(b.name))
  })

  const filteredModels = createMemo(() => {
    let items = allModels()
    const f = filter()
    if (f === "free") items = items.filter(isFree)
    if (f === "paid") items = items.filter((m) => !isFree(m))
    const q = search().toLowerCase().trim()
    if (q) {
      items = items.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q),
      )
    }
    return items
  })

  const totalCount = createMemo(() => allModels().length)
  const freeCount = createMemo(() => allModels().filter(isFree).length)
  const paidCount = createMemo(() => allModels().filter((m) => !isFree(m)).length)

  const isEnabled = (modelId: string) => {
    return models.visible({ providerID: "openrouter", modelID: modelId })
  }

  const handleToggle = (modelId: string, checked: boolean) => {
    models.setVisibility({ providerID: "openrouter", modelID: modelId }, checked)
  }

  const handleEnableAllVisible = () => {
    filteredModels().forEach((m) => {
      if (!isEnabled(m.id)) {
        handleToggle(m.id, true)
      }
    })
  }

  const handleDisableAllVisible = () => {
    filteredModels().forEach((m) => {
      if (isEnabled(m.id)) {
        handleToggle(m.id, false)
      }
    })
  }

  const filters: { key: PricingFilter; labelKey: string; count: () => number }[] = [
    { key: "all", labelKey: "openrouter.filter.all", count: totalCount },
    { key: "free", labelKey: "openrouter.filter.free", count: freeCount },
    { key: "paid", labelKey: "openrouter.filter.paid", count: paidCount },
  ]

  const loading = createMemo(() => resource.loading)

  return (
    <Dialog
      title={language.t("openrouter.browse.title")}
      description={language.t("openrouter.browse.description")}
      action={
        <div class="flex items-center gap-1">
          <Tooltip placement="top" value={language.t("openrouter.action.enableAll")}>
            <IconButton
              icon="eye"
              variant="ghost"
              iconSize="normal"
              class="size-6"
              aria-label={language.t("openrouter.action.enableAll")}
              onClick={handleEnableAllVisible}
            />
          </Tooltip>
          <Tooltip placement="top" value={language.t("openrouter.action.disableAll")}>
            <IconButton
              icon="eye-slash"
              variant="ghost"
              iconSize="normal"
              class="size-6"
              aria-label={language.t("openrouter.action.disableAll")}
              onClick={handleDisableAllVisible}
            />
          </Tooltip>
        </div>
      }
    >
      <div class="flex flex-col gap-3">
        {/* Search */}
        <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
          <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
          <TextField
            variant="ghost"
            type="text"
            value={search()}
            onChange={setSearch}
            placeholder={language.t("openrouter.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
          />
          <Show when={search()}>
            <IconButton icon="circle-x" variant="ghost" onClick={() => setSearch("")} />
          </Show>
        </div>

        {/* Filter tabs */}
        <div class="flex items-center gap-1">
          <For each={filters}>
            {(f) => (
              <Button
                size="small"
                variant={filter() === f.key ? "secondary" : "ghost"}
                onClick={() => setFilter(f.key)}
                class="text-13-regular"
              >
                {language.t(f.labelKey)}
                <span class="ml-1 text-12-regular opacity-60">{f.count()}</span>
              </Button>
            )}
          </For>
        </div>

        {/* Model list */}
        <div class="h-[400px] overflow-y-auto no-scrollbar rounded-lg border border-border-weak-base">
          <Show
            when={!loading()}
            fallback={
              <div class="flex items-center justify-center py-16 gap-2">
                <Spinner />
                <span class="text-14-regular text-text-weak">
                  {language.t("openrouter.loading")}
                </span>
              </div>
            }
          >
            <Show
              when={!error()}
              fallback={
                <div class="flex flex-col items-center justify-center py-16 text-center gap-3">
                  <span class="text-14-regular text-text-weak">
                    {language.t("openrouter.empty.fetchError")}
                  </span>
                  <Show when={error()}>
                    <span class="text-12-regular text-text-weak">{error()}</span>
                  </Show>
                  <Button size="small" variant="secondary" onClick={() => refetch()}>
                    {language.t("openrouter.action.retry")}
                  </Button>
                </div>
              }
            >
              <Show
                when={filteredModels().length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center py-16 text-center">
                    <span class="text-14-regular text-text-weak">
                      {search() || filter() !== "all"
                        ? language.t("openrouter.empty.filtered")
                        : language.t("openrouter.empty.noModels")}
                    </span>
                    <Show when={search()}>
                      <span class="text-14-regular text-text-strong mt-1">&quot;{search()}&quot;</span>
                    </Show>
                  </div>
                }
            >
              <For each={filteredModels()}>
                {(model) => (
                  <div class="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-border-weak-base last:border-none hover:bg-surface-base transition-colors">
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-13-regular text-text-strong truncate">{model.name}</span>
                        <Show when={isFree(model)}>
                          <Tag>{language.t("model.tag.free")}</Tag>
                        </Show>
                      </div>
                      <div class="text-12-regular text-text-weak truncate font-mono" style={{ opacity: 0.7 }}>
                        {model.id}
                      </div>
                      <div class="flex items-center gap-3 text-12-regular text-text-weak">
                        <span class="truncate">
                          {formatContextLength(model.context_length)} {language.t("openrouter.model.context")}
                        </span>
                        <span>
                          {language.t("openrouter.model.prompt")}: {formatPrice(model.pricing?.prompt ?? "0")}
                        </span>
                        <span>
                          {language.t("openrouter.model.completion")}: {formatPrice(model.pricing?.completion ?? "0")}
                        </span>
                      </div>
                    </div>
                    <div class="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={isEnabled(model.id)}
                        onChange={(checked) => handleToggle(model.id, checked)}
                        hideLabel
                      >
                        {model.name}
                      </Switch>
                    </div>
                  </div>
                )}
              </For>
            </Show>
            </Show>
          </Show>
        </div>

        {/* Footer info */}
        <div class="text-12-regular text-text-weak px-1">
          {language.t("openrouter.footer", { count: filteredModels().length, total: totalCount() })}
        </div>
      </div>
    </Dialog>
  )
}