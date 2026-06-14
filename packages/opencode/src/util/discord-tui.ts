/**
 * Discord TUI - Terminal User Interface for Discord Integration
 * Provides a beautiful terminal interface for Discord chat
 */

import * as readline from 'readline'
import { discordService, DiscordMessage } from './discord-service'
import { Log } from './log'
import chalk from 'chalk'

const log = Log.create({ service: 'discord-tui' })

interface Message {
  id: string
  author: string
  content: string
  timestamp: string
  isOwn: boolean
}

export class DiscordTUI {
  private rl: readline.Interface | null = null
  private messages: Message[] = []
  private isConnected = false
  private currentChannel: string | null = null
  private statusLine = 'Disconnected'
  private inputBuffer = ''

  async start() {
    console.log(chalk.cyan.bold('\n╔═══════════════════════════════════════════╗'))
    console.log(chalk.cyan.bold('║       🎮 MiMo-Code Discord Chat          ║'))
    console.log(chalk.cyan.bold('╚═══════════════════════════════════════════╝\n'))

    // Check for existing config
    const config = await discordService['loadConfig']()
    
    if (!config?.token) {
      await this.showSetup()
      return
    }

    await this.connect(config.token)
  }

  private async showSetup() {
    console.log(chalk.yellow('First-time setup required!\n'))
    console.log(chalk.dim('To get your Discord token:'))
    console.log(chalk.dim('1. Go to Discord Developer Portal (https://discord.com/developers/applications)'))
    console.log(chalk.dim('2. Create a new application'))
    console.log(chalk.dim('3. Go to "Bot" section and create a bot'))
    console.log(chalk.dim('4. Copy the bot token\n'))

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    const token = await this.question(chalk.green('Enter your Discord bot token: '))
    
    if (token.trim()) {
      console.log(chalk.yellow('\n⏳ Saving configuration...'))
      await discordService.connect(token)
    } else {
      console.log(chalk.red('❌ Token cannot be empty'))
      this.rl.close()
    }
  }

  private async connect(token: string) {
    console.log(chalk.yellow('\n🔌 Connecting to Discord...'))
    this.statusLine = 'Connecting...'

    try {
      await discordService.connect(token)
    } catch (error: any) {
      console.log(chalk.red(`\n❌ Failed to connect: ${error.message}`))
      return
    }

    discordService.on('ready', (user) => {
      this.isConnected = true
      this.statusLine = `Connected as ${user.username}`
      console.log(chalk.green(`\n✅ Connected as ${chalk.bold(user.username)}\n`))
      this.startChatInterface()
    })

    discordService.on('message', (msg: DiscordMessage) => {
      this.addMessage({
        id: msg.id,
        author: msg.author.username,
        content: msg.content,
        timestamp: new Date(msg.timestamp).toLocaleTimeString(),
        isOwn: false
      })
    })

    discordService.on('disconnected', () => {
      this.isConnected = false
      this.statusLine = 'Disconnected'
      this.render()
    })
  }

  private startChatInterface() {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })
    }

    this.render()
    this.rl.on('line', async (input) => {
      await this.handleInput(input)
    })
  }

  private async handleInput(input: string) {
    const trimmed = input.trim()

    if (trimmed.startsWith('/')) {
      await this.handleCommand(trimmed)
      return
    }

    if (!this.currentChannel) {
      this.addMessage({
        id: Date.now().toString(),
        author: 'System',
        content: 'Use /channel <id> to select a channel first',
        timestamp: new Date().toLocaleTimeString(),
        isOwn: false
      })
      this.render()
      return
    }

    if (trimmed && this.isConnected) {
      try {
        await discordService.sendMessage(this.currentChannel, trimmed)
        this.addMessage({
          id: Date.now().toString(),
          author: 'You',
          content: trimmed,
          timestamp: new Date().toLocaleTimeString(),
          isOwn: true
        })
      } catch (error: any) {
        this.addMessage({
          id: Date.now().toString(),
          author: 'Error',
          content: error.message,
          timestamp: new Date().toLocaleTimeString(),
          isOwn: false
        })
      }
    }

    this.render()
  }

  private async handleCommand(cmd: string) {
    const parts = cmd.split(' ')
    const command = parts[0].toLowerCase()

    switch (command) {
      case '/setup':
        await this.showSetup()
        break

      case '/channel':
        this.currentChannel = parts[1] || null
        this.statusLine = this.currentChannel 
          ? `Channel: ${this.currentChannel}` 
          : 'Connected (no channel selected)'
        this.addMessage({
          id: Date.now().toString(),
          author: 'System',
          content: this.currentChannel 
            ? `Switched to channel ${this.currentChannel}` 
            : 'Cleared channel selection',
          timestamp: new Date().toLocaleTimeString(),
          isOwn: false
        })
        break

      case '/guild':
        const guildId = parts[1]
        await discordService.setup(undefined, guildId)
        this.addMessage({
          id: Date.now().toString(),
          author: 'System',
          content: `Set guild to ${guildId}`,
          timestamp: new Date().toLocaleTimeString(),
          isOwn: false
        })
        break

      case '/clear':
        this.messages = []
        break

      case '/exit':
      case '/quit':
        console.log(chalk.yellow('\n👋 Goodbye!\n'))
        discordService.disconnect()
        this.rl?.close()
        process.exit(0)

      case '/help':
        this.showHelp()
        break

      default:
        this.addMessage({
          id: Date.now().toString(),
          author: 'System',
          content: `Unknown command: ${command}. Type /help for available commands.`,
          timestamp: new Date().toLocaleTimeString(),
          isOwn: false
        })
    }

    this.render()
  }

  private showHelp() {
    const helpLines = [
      'Available commands:',
      '  /setup <token>     - Setup Discord with bot token',
      '  /channel <id>      - Select channel to chat in',
      '  /guild <id>        - Set guild/server ID',
      '  /public            - Enable public mode for servers',
      '  /clear             - Clear message history',
      '  /help              - Show this help',
      '  /exit              - Exit Discord TUI'
    ]

    helpLines.forEach(line => {
      this.addMessage({
        id: Date.now().toString() + Math.random(),
        author: 'Help',
        content: line,
        timestamp: new Date().toLocaleTimeString(),
        isOwn: false
      })
    })
  }

  private addMessage(msg: Message) {
    this.messages.push(msg)
    if (this.messages.length > 100) {
      this.messages.shift()
    }
  }

  private render() {
    // Clear screen
    console.clear()
    
    // Header
    console.log(chalk.cyan.bold('╔═══════════════════════════════════════════╗'))
    console.log(chalk.cyan.bold('║       🎮 MiMo-Code Discord Chat          ║'))
    console.log(chalk.cyan.bold('╚═══════════════════════════════════════════╝\n'))
    
    // Status
    console.log(chalk.dim(`Status: ${this.statusLine}\n`))
    console.log(chalk.dim('─'.repeat(45)))

    // Messages
    const recentMessages = this.messages.slice(-15)
    recentMessages.forEach(msg => {
      const time = chalk.dim(`[${msg.timestamp}]`)
      const author = msg.isOwn ? chalk.green(msg.author) : chalk.blue(msg.author)
      console.log(`${time} ${chalk.bold(author)}: ${msg.content}`)
    })

    // Footer
    console.log(chalk.dim('\n' + '─'.repeat(45)))
    console.log(chalk.dim('Type a message or /help for commands\n'))
  }

  private question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl!.question(prompt, resolve)
    })
  }
}

// CLI entry point
export async function startDiscordTUI() {
  const tui = new DiscordTUI()
  await tui.start()
}
