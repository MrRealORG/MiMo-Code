/**
 * Discord Command - CLI entry point for /discord
 */

import { startDiscordTUI } from './util/discord-tui'
import { discordService } from './util/discord-service'
import { Log } from './util/log'

const log = Log.create({ service: 'discord-cli' })

export async function handleDiscordCommand(args: string[]) {
  const subcommand = args[0]?.toLowerCase()

  switch (subcommand) {
    case 'setup':
      const token = args[1]
      if (!token) {
        console.error('Usage: /discord setup <token>')
        return
      }
      await discordService.connect(token)
      console.log('✅ Discord configured successfully!')
      break

    case 'channel':
      const channelId = args[1]
      if (!channelId) {
        console.error('Usage: /discord channel <id>')
        return
      }
      await discordService.setup(undefined, undefined, channelId)
      console.log(`✅ Channel set to ${channelId}`)
      break

    case 'guild':
      const guildId = args[1]
      if (!guildId) {
        console.error('Usage: /discord guild <id>')
        return
      }
      await discordService.setup(undefined, guildId)
      console.log(`✅ Guild set to ${guildId}`)
      break

    case 'status':
      const config = await discordService['loadConfig']()
      console.log('\n📊 Discord Status:')
      console.log(`  Token: ${config?.token ? '✅ Configured' : '❌ Not set'}`)
      console.log(`  User ID: ${config?.userId || 'Not set'}`)
      console.log(`  Guild ID: ${config?.guildId || 'Not set'}`)
      console.log(`  Channel ID: ${config?.channelId || 'Not set'}`)
      break

    case 'public':
      // Enable public mode - no user filtering
      await discordService.setup()
      console.log('✅ Public mode enabled - bot will respond to all channels')
      break

    case 'disconnect':
      discordService.disconnect()
      console.log('👋 Disconnected from Discord')
      break

    case 'help':
      console.log(`
🎮 Discord Commands:
  /discord              - Launch interactive TUI
  /discord setup <tok>  - Configure bot token
  /discord channel <id> - Select channel
  /discord guild <id>   - Set guild/server
  /discord status       - Show status
  /discord public       - Enable public mode
  /discord disconnect   - Disconnect
      `)
      break

    default:
      // Launch TUI
      await startDiscordTUI()
  }
}

// Auto-start if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  handleDiscordCommand(process.argv.slice(2)).catch(console.error)
}
