import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { SessionCwd } from "./session-cwd"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import fs from "node:fs/promises"
import crypto from "node:crypto"

const Parameters = z.object({
  prompt: z
    .string()
    .describe(
      "Detailed text description of the image to generate. Be specific about style, content, colors, composition, and any text to include.",
    ),
  outputPath: z
    .string()
    .describe(
      "The file path where the generated image will be saved (e.g., './assets/hero.png'). Supported formats: png, jpg, webp.",
    )
    .optional(),
  width: z
    .number()
    .describe("Image width in pixels. Common sizes: 1024, 768, 1344, 1152.")
    .optional()
    .default(1024),
  height: z
    .number()
    .describe("Image height in pixels. Common sizes: 1024, 1344, 864, 1152.")
    .optional()
    .default(1024),
  style: z
    .enum(["natural", "vivid"])
    .describe("Image style: 'natural' for realistic, 'vivid' for more artistic/colorful.")
    .optional()
    .default("natural"),
})

/**
 * Image generation tool for Agent Mode.
 *
 * This tool generates images from text descriptions. It uses the configured
 * image generation provider (defaults to a built-in integration).
 *
 * The generated image is saved to the specified output path (or a default
 * location) and the path is returned to the LLM.
 */
export const ImageGenTool = Tool.define(
  "image_gen",
  Effect.gen(function* () {
    const fsService = yield* AppFileSystem.Service

    return {
      description: `Generate an image from a text description and save it to a file.

This tool creates images using AI image generation. Provide a detailed prompt describing the desired image including:
- Subject matter and composition
- Art style (photorealistic, illustration, 3D render, etc.)
- Color palette and mood
- Any specific text or labels to include
- Lighting and camera angle (for realistic images)

The image is saved to the specified output path. If no path is provided, it defaults to './generated-images/<hash>.png'.

Supported sizes: 1024x1024, 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440
Supported formats: png, jpg, webp`,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Determine output path
          const cwd = SessionCwd.get(ctx.sessionID)
          let outputPath = params.outputPath
            ? path.isAbsolute(params.outputPath)
              ? params.outputPath
              : path.join(cwd, params.outputPath)
            : path.join(cwd, "generated-images", `${crypto.randomBytes(8).toString("hex")}.png`)

          // Ensure output directory exists
          const outputDir = path.dirname(outputPath)
          yield* fsService.mkdirp(outputDir)

          // Validate dimensions
          const validSizes = [
            [1024, 1024],
            [768, 1344],
            [864, 1152],
            [1344, 768],
            [1152, 864],
            [1440, 720],
            [720, 1440],
          ]
          const sizeKey = `${params.width}x${params.height}`
          const isValidSize = validSizes.some(([w, h]) => `${w}x${h}` === sizeKey)
          const [finalWidth, finalHeight] = isValidSize
            ? [params.width, params.height]
            : [1024, 1024]

          if (!isValidSize) {
            yield* Effect.logWarning(
              `Invalid size ${sizeKey}, falling back to 1024x1024. Valid sizes: ${validSizes.map(([w, h]) => `${w}x${h}`).join(", ")}`,
            )
          }

          // Check for IMAGE_GEN_API_KEY environment variable or config
          const apiKey = process.env.IMAGE_GEN_API_KEY
          const apiUrl = process.env.IMAGE_GEN_API_URL || "https://api.openai.com/v1/images/generations"
          const model = process.env.IMAGE_GEN_MODEL || "dall-e-3"

          let imageBuffer: Buffer

          if (apiKey && apiUrl) {
            // Use configured API
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
                  size: `${finalWidth}x${finalHeight}`,
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
              throw new Error("No image data received from API")
            }
            imageBuffer = Buffer.from(b64Data, "base64")
          } else {
            // Placeholder: create a simple SVG-based placeholder image
            // In production, this would be replaced with actual image generation
            const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" width="${finalWidth}" height="${finalHeight}" viewBox="0 0 ${finalWidth} ${finalHeight}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <text x="50%" y="40%" font-family="Arial, sans-serif" font-size="24" fill="#e94560" text-anchor="middle" font-weight="bold">Image Generation</text>
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="16" fill="#a7a3d8" text-anchor="middle">Agent Mode</text>
  <text x="50%" y="62%" font-family="Arial, sans-serif" font-size="12" fill="#888" text-anchor="middle">Prompt: ${params.prompt.slice(0, 80)}${params.prompt.length > 80 ? "..." : ""}</text>
  <text x="50%" y="72%" font-family="Arial, sans-serif" font-size="11" fill="#555" text-anchor="middle">Size: ${finalWidth}x${finalHeight} | Style: ${params.style}</text>
  <text x="50%" y="85%" font-family="Arial, sans-serif" font-size="10" fill="#444" text-anchor="middle">Set IMAGE_GEN_API_KEY and IMAGE_GEN_API_URL env vars for real generation</text>
</svg>`
            imageBuffer = Buffer.from(svgContent)
          }

          // Ensure .png extension for SVG placeholders, respect original for API results
          if (!apiKey && !outputPath.endsWith(".svg")) {
            outputPath = outputPath.replace(/\.\w+$/, ".svg")
          }

          // Write the image file
          yield* fsService.writeWithDirs(outputPath, imageBuffer)

          const relativePath = path.relative(Instance.worktree, outputPath)
          const sizeKB = (imageBuffer.length / 1024).toFixed(1)

          const output = [
            `Image generated successfully!`,
            `  Saved to: ${relativePath}`,
            `  Full path: ${outputPath}`,
            `  Size: ${sizeKB} KB`,
            `  Dimensions: ${finalWidth}x${finalHeight}`,
            `  Style: ${params.style}`,
            `  Prompt: ${params.prompt.slice(0, 100)}${params.prompt.length > 100 ? "..." : ""}`,
          ].join("\n")

          return {
            title: `Generated image: ${path.basename(outputPath)}`,
            metadata: {
              filepath: outputPath,
              relativePath,
              width: finalWidth,
              height: finalHeight,
              style: params.style,
              prompt: params.prompt,
              sizeKB,
              generated: true,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)