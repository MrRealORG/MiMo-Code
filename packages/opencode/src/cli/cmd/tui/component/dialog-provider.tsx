import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useLanguage } from "@tui/context/language"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@mimo-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { useToast, type ToastContext } from "../ui/toast"
import { isConsoleManagedProvider } from "@tui/util/provider-origin"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

type TFunc = (key: string, params?: Record<string, any>) => string

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const { t } = useLanguage()
  const options = createMemo(() => {
    const list = pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, provider.id)
        const connected = sync.data.provider_next.connected.includes(provider.id)

        const descLookup: Record<string, string> = {
          opencode: t("tui.provider.recommended"),
          anthropic: t("tui.provider.api_key_desc"),
          openai: t("tui.provider.openai_desc"),
          "opencode-go": t("tui.provider.go_desc"),
        }

        return {
          title: provider.name,
          value: provider.id,
          description: descLookup[provider.id],
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.id in PROVIDER_PRIORITY ? t("tui.provider.category_popular") : t("tui.provider.category_other"),
          gutter: connected ? <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = sync.data.provider_auth[provider.id] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title={t("tui.provider.select_auth_method")}
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID: provider.id,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                    t={t}
                  />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                    t={t}
                  />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={provider.id} title={method.label} metadata={metadata} t={t} />
              ))
            }
          },
        }
      }),
    )
    return [
      ...list,
      {
        title: t("tui.provider.custom"),
        value: "__custom__",
        description: undefined,
        footer: undefined,
        category: t("tui.provider.category_other"),
        gutter: undefined,
        async onSelect() {
          await runCustomProviderWizard({ dialog, sdk, sync, toast, t })
        },
      },
    ]
  })
  return options
}

export function DialogProvider() {
  const { t } = useLanguage()
  const options = createDialogProviderOptions()
  return <DialogSelect title={t("tui.provider.title")} options={options()} />
}

export async function runCustomProviderWizard(opts: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ToastContext
  t: TFunc
}) {
  const { dialog, sdk, sync, toast, t } = opts

  function step(n: number, total: number, title: string, placeholder?: string, value?: string) {
    return DialogPrompt.show(dialog, `${title} (${n}/${total})`, { placeholder, value })
  }

  const providerIDRaw = await step(1, 6, t("tui.provider.wizard.provider_id"), t("tui.provider.wizard.provider_id_placeholder"))
  if (providerIDRaw === null) return
  const providerID = providerIDRaw.trim()
  if (!providerID) return

  const nameRaw = await step(2, 6, t("tui.provider.wizard.display_name"), t("tui.provider.wizard.display_name_placeholder"), providerID)
  if (nameRaw === null) return
  const name = nameRaw.trim() || providerID

  const baseURLRaw = await step(3, 6, t("tui.provider.wizard.base_url"), t("tui.provider.wizard.base_url_placeholder"))
  if (baseURLRaw === null) return
  const baseURL = baseURLRaw.trim()
  if (!baseURL) return

  const apiKeyRaw = await step(4, 6, t("tui.provider.wizard.api_key"), t("tui.provider.wizard.api_key_placeholder"))
  if (apiKeyRaw === null) return
  const apiKey = apiKeyRaw.trim()
  if (!apiKey) return

  const modelIDRaw = await step(5, 6, t("tui.provider.wizard.first_model_id"), t("tui.provider.wizard.first_model_id_placeholder"))
  if (modelIDRaw === null) return
  const modelID = modelIDRaw.trim()
  if (!modelID) return

  const modelNameRaw = await step(6, 6, t("tui.provider.wizard.first_model_name"), t("tui.provider.wizard.first_model_name_placeholder"), modelID)
  if (modelNameRaw === null) return
  const modelName = modelNameRaw.trim() || modelID

  const envKey = `${providerID.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`
  const patch = {
    provider: {
      [providerID]: {
        name,
        npm: "@ai-sdk/openai-compatible",
        env: [envKey],
        options: {
          baseURL,
          setCacheKey: true,
        },
        models: {
          [modelID]: {
            name: modelName,
          },
        },
      },
    },
  } as const

  const updateRes = await sdk.client.global.config.update({ config: patch as any })
  if (updateRes.error) {
    toast.show({ variant: "error", message: JSON.stringify(updateRes.error) })
    return
  }

  const authRes = await sdk.client.auth.set({
    providerID,
    auth: { type: "api", key: apiKey },
  })
  if (authRes.error) {
    toast.show({ variant: "error", message: JSON.stringify(authRes.error) })
    return
  }

  await sdk.client.instance.dispose()
  await sync.bootstrap()
  dialog.replace(() => <DialogModel providerID={providerID} />)
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
  t: TFunc
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const t = props.t

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: t("tui.provider.copied"), variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>{t("tui.provider.waiting_auth")}</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>{t("tui.provider.copy_key")}</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
  t: TFunc
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)
  const t = props.t

  return (
    <DialogPrompt
      title={props.title}
      placeholder={t("tui.provider.auth_code_placeholder")}
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>{t("tui.provider.invalid_code")}</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
  t: TFunc
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const t = props.t

  return (
    <DialogPrompt
      title={props.title}
      placeholder={t("tui.provider.api_key_input_placeholder")}
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                {t("tui.provider.zen_desc")}
              </text>
              <text fg={theme.text}>
                {t("tui.provider.zen_action", { url: "https://opencode.ai/zen" })}
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                {t("tui.provider.go_subscribe_desc")}
              </text>
              <text fg={theme.text}>
                {t("tui.provider.go_subscribe_action", { url: "https://opencode.ai/zen" })}
              </text>
            </box>
          ),
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}