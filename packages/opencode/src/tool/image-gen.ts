import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { Log } from "../util"

const log = Log.create({ service: "image-gen-tool" })

const SIZE_PRESETS = {
  "1024x1024": { width: 1024, height: 1024 },
  "768x1344": { width: 768, height: 1344 },
  "864x1152": { width: 864, height: 1152 },
  "1344x768": { width: 1344, height: 768 },
  "1152x864": { width: 1152, height: 864 },
  "1440x720": { width: 1440, height: 720 },
  "720x1440": { width: 720, height: 1440 },
  "512x512": { width: 512, height: 512 },
} as const

type SizeKey = keyof typeof SIZE_PRESETS

const Parameters = z.object({
  prompt: z
    .string()
    .describe("A detailed text description of the image to generate"),
  output: z
    .string()
    .describe("The file path where the generated image will be saved (e.g., ./assets/logo.png)"),
  size: z
    .enum(Object.keys(SIZE_PRESETS) as [SizeKey, ...SizeKey[]])
    .optional()
    .default("1024x1024")
    .describe("Image size preset. Default is 1024x1024."),
  style: z
    .enum(["natural", "vivid"])
    .optional()
    .default("natural")
    .describe("Image style: 'natural' for realistic, 'vivid' for more vibrant/artistic"),
})

function generateSvgPlaceholder(
  prompt: string,
  width: number,
  height: number,
): string {
  const lines = prompt.split(" ").slice(0, 8).join(" ")
  const truncated = lines.length > 40 ? lines.slice(0, 40) + "..." : lines
  const fontSize = Math.min(Math.floor(width / 20), 24)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <defs>`,
    `    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />`,
    `      <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect width="${width}" height="${height}" fill="url(#bg)" rx="12"/>`,
    `  <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="#e94560" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="bold">IMAGE</text>`,
    `  <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" dy="${fontSize + 8}" fill="#a7a3d8" font-family="system-ui, sans-serif" font-size="${Math.floor(fontSize * 0.5)}">${truncated.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`,
    `  <text x="50%" y="90%" dominant-baseline="middle" text-anchor="middle" fill="#666" font-family="system-ui, sans-serif" font-size="${Math.floor(fontSize * 0.4)}">Set IMAGE_GEN_API_KEY and IMAGE_GEN_API_URL for real generation</text>`,
    `</svg>`,
  ].join("\n")
}

export const ImageGenTool = Tool.define(
  "image_gen",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Generate an image from a text description and save it to a file. " +
        "Supports multiple sizes (512x512 to 1440x720) and styles (natural/vivid). " +
        "Requires IMAGE_GEN_API_KEY and IMAGE_GEN_API_URL environment variables for real image generation. " +
        "If not configured, generates an SVG placeholder.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const outputPath = path.isAbsolute(params.output)
            ? params.output
            : path.join(SessionCwd.get(ctx.sessionID), params.output)

          const dimensions = SIZE_PRESETS[params.size]
          const apiKey = process.env.IMAGE_GEN_API_KEY
          const apiUrl = process.env.IMAGE_GEN_API_URL
          const model = process.env.IMAGE_GEN_MODEL || "dall-e-3"

          if (!apiKey || !apiUrl) {
            log.info("No IMAGE_GEN_API_KEY/URL configured, generating SVG placeholder")
            const svg = generateSvgPlaceholder(params.prompt, dimensions.width, dimensions.height)
            yield* fs.writeWithDirs(outputPath, svg)

            const relativePath = path.relative(Instance.worktree, outputPath)
            return {
              title: `Generated placeholder: ${relativePath}`,
              output: [
                `Generated SVG placeholder image.`,
                `Path: ${outputPath}`,
                `Size: ${dimensions.width}x${dimensions.height}`,
                `Prompt: ${params.prompt}`,
                ``,
                `Note: Set IMAGE_GEN_API_KEY and IMAGE_GEN_API_URL environment variables for real AI image generation.`,
              ].join("\n"),
              metadata: {
                filepath: outputPath,
                width: dimensions.width,
                height: dimensions.height,
                style: params.style,
                placeholder: true,
              },
            }
          }

          try {
            const response = yield* Effect.promise(async () => {
              const res = await fetch(apiUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model,
                  prompt: params.prompt,
                  n: 1,
                  size: params.size,
                  style: params.style,
                  response_format: "b64_json",
                }),
              })

              if (!res.ok) {
                const errorText = await res.text()
                throw new Error(`Image generation API error (${res.status}): ${errorText}`)
              }

              return res.json()
            })

            const b64Data = response.data?.[0]?.b64_json
            if (!b64Data) {
              throw new Error("No image data returned from API")
            }

            const buffer = Buffer.from(b64Data, "base64")
            yield* fs.writeWithDirs(outputPath, buffer)

            const relativePath = path.relative(Instance.worktree, outputPath)
            return {
              title: `Generated image: ${relativePath}`,
              output: [
                `Successfully generated image.`,
                `Path: ${outputPath}`,
                `Size: ${dimensions.width}x${dimensions.height}`,
                `Style: ${params.style}`,
                `Model: ${model}`,
                `Prompt: ${params.prompt}`,
              ].join("\n"),
              metadata: {
                filepath: outputPath,
                width: dimensions.width,
                height: dimensions.height,
                style: params.style,
                model,
                placeholder: false,
              },
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            log.warn("Image generation failed, falling back to SVG placeholder", { error: msg })
            const svg = generateSvgPlaceholder(params.prompt, dimensions.width, dimensions.height)
            yield* fs.writeWithDirs(outputPath, svg)

            return {
              title: `Generated placeholder (API error): ${path.relative(Instance.worktree, outputPath)}`,
              output: [
                `Image generation API failed, generated SVG placeholder instead.`,
                `Error: ${msg}`,
                `Path: ${outputPath}`,
                `Size: ${dimensions.width}x${dimensions.height}`,
              ].join("\n"),
              metadata: {
                filepath: outputPath,
                width: dimensions.width,
                height: dimensions.height,
                placeholder: true,
                error: msg,
              },
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)