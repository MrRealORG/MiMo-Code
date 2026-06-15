import { Flag } from "@/flag/flag"
import { Hono } from "hono"
import { proxy } from "hono/proxy"
import { getMimeType } from "hono/utils/mime"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { Log } from "@/util"

const embeddedUIPromise = Flag.MIMOCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts")
      .then((module) => module.default as Record<string, string>)
      .catch((err) => {
        Log.create({ service: "server" }).warn("Embedded web UI not available, will proxy to app.opencode.ai", { error: String(err) })
        return null
      })

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    const embeddedWebUI = await embeddedUIPromise
    const path = c.req.path

    if (embeddedWebUI) {
      const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
      if (!match) return c.json({ error: "Not Found" }, 404)

      if (await fs.exists(match)) {
        const mime = getMimeType(match) ?? "text/plain"
        c.header("Content-Type", mime)
        if (mime.startsWith("text/html")) {
          c.header("Content-Security-Policy", DEFAULT_CSP)
        }
        return c.body(new Uint8Array(await fs.readFile(match)))
      } else {
        return c.json({ error: "Not Found" }, 404)
      }
    } else {
      try {
        const response = await proxy(`https://app.opencode.ai${path}`, {
          raw: c.req.raw,
          headers: {
            ...Object.fromEntries(c.req.raw.headers.entries()),
            host: "app.opencode.ai",
          },
        })
        // If the proxy returns a non-2xx status, serve a local error page
        // instead of forwarding potentially confusing upstream responses.
        if (!response.ok && path === "/") {
          return c.html(
            `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MiMo Code</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#666;text-align:center">
<div><h2>Web UI is not available</h2>
<p>The embedded web UI bundle is missing and the remote UI at app.opencode.ai returned an error (${response.status}).</p>
<p>Please build with the embedded UI or check your network connection.</p>
</div></body></html>`,
            503,
          )
        }
        const match = response.headers.get("content-type")?.includes("text/html")
          ? (await response.clone().text()).match(
              /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
            )
          : undefined
        const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
        response.headers.set("Content-Security-Policy", csp(hash))
        return response
      } catch (err) {
        return c.html(
          `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MiMo Code</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#666;text-align:center">
<div><h2>Web UI is not available</h2>
<p>Failed to reach the remote UI at app.opencode.ai.</p>
<p>Please build with the embedded UI or check your network connection.</p>
</div></body></html>`,
          503,
        )
      }
    }
  })
