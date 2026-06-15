import path from "path"
import { Global } from "@/global"
import { Filesystem, Log } from "@/util"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { appendFile, writeFile } from "fs/promises"
import type { PromptInfo } from "./history"

const log = Log.create({ service: "prompt-stash" })

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

const MAX_STASH_ENTRIES = 50

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const stashPath = path.join(Global.Path.state, "prompt-stash.jsonl")
    onMount(async () => {
      const text = await Filesystem.readText(stashPath).catch(() => "")
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((line): line is StashEntry => line !== null)
        .slice(-MAX_STASH_ENTRIES)

      setStore("entries", lines)

      // Rewrite file with only valid entries to self-heal corruption
      if (lines.length > 0) {
        const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
        writeFile(stashPath, content).catch((err) =>
          log.error("failed to rewrite stash file on init", { path: stashPath, err }),
        )
      }
    })

    const [store, setStore] = createStore({
      entries: [] as StashEntry[],
    })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (trimmed) {
          const content = store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n"
          writeFile(stashPath, content).catch((err) =>
            log.error("failed to write trimmed stash file", { path: stashPath, err }),
          )
          return
        }

        appendFile(stashPath, JSON.stringify(stash) + "\n").catch((err) =>
          log.error("failed to append stash entry", { path: stashPath, err }),
        )
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(
          produce((draft) => {
            draft.entries.pop()
          }),
        )
        const content =
          store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : ""
        writeFile(stashPath, content).catch((err) =>
          log.error("failed to write stash file after pop", { path: stashPath, err }),
        )
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(
          produce((draft) => {
            draft.entries.splice(index, 1)
          }),
        )
        const content =
          store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : ""
        writeFile(stashPath, content).catch((err) =>
          log.error("failed to write stash file after remove", { path: stashPath, err }),
        )
      },
    }
  },
})
