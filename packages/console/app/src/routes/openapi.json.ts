export async function GET() {
  const response = await fetch(
    "https://raw.githubusercontent.com/XiaomiMiMo/MiMo-Code/refs/heads/main/packages/sdk/openapi.json",
  )
  const json = await response.json()
  return json
}
