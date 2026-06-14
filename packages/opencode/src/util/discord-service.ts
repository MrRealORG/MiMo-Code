/**
 * Discord Integration - Bot Service
 * Handles connection to Discord via WebSocket
 * and message sync with MiMo-Code
 */

import { WebSocket } from 'ws'
import { EventEmitter } from 'events'
import { Log } from './log'
import * as fs from 'fs/promises'
import * as path from 'path'

const log = Log.create({ service: 'discord' })

const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'

export interface DiscordConfig {
  token: string
  userId?: string
  guildId?: string
  channelId?: string
}

export interface DiscordMessage {
  id: string
  content: string
  author: { id: string; username: string; discriminator: string }
  channelId: string
  guildId?: string
  timestamp: string
}

export class DiscordService extends EventEmitter {
  private ws: WebSocket | null = null
  private config: DiscordConfig | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5

  async connect(token?: string) {
    if (token) {
      this.config = { token }
      await this.saveConfig()
    }

    if (!this.config?.token) {
      throw new Error('No Discord token provided. Run /discord setup first.')
    }

    log.info('Connecting to Discord Gateway...')
    this.ws = new WebSocket(DISCORD_GATEWAY)
    this.setupWebSocket()
  }

  private setupWebSocket() {
    if (!this.ws) return

    this.ws.on('open', () => {
      log.info('WebSocket connected to Discord Gateway')
      this.reconnectAttempts = 0
    })

    this.ws.on('message', (data) => {
      const payload = JSON.parse(data.toString())
      this.handleGatewayEvent(payload)
    })

    this.ws.on('close', () => {
      log.warn('WebSocket disconnected')
      this.cleanup()
      this.attemptReconnect()
    })

    this.ws.on('error', (err) => {
      log.error('WebSocket error', { error: err.message })
    })
  }

  private handleGatewayEvent(payload: any) {
    const { op, d, s, t } = payload

    if (s !== null) this.seq = s

    switch (op) {
      case 10: // HELLO
        this.startHeartbeat(d.heartbeat_interval)
        this.identify()
        break

      case 11: // HEARTBEAT ACK
        log.debug('Heartbeat acknowledged')
        break

      case 0: // DISPATCH
        this.handleDispatch(t, d)
        break
    }
  }

  private startHeartbeat(interval: number) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }))
      }
    }, interval)
  }

  private identify() {
    if (!this.ws || !this.config) return

    const identifyPayload = {
      op: 2,
      d: {
        token: this.config.token,
        intents: 513, // GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT
        properties: {
          $os: process.platform,
          $browser: 'MiMo-Code',
          $device: 'MiMo-Code'
        }
      }
    }

    this.ws.send(JSON.stringify(identifyPayload))
    log.info('Sent identify payload')
  }

  private handleDispatch(event: string, data: any) {
    switch (event) {
      case 'READY':
        this.sessionId = data.session_id
        log.info('Discord connection ready', { user: data.user.username })
        this.emit('ready', data.user)
        break

      case 'MESSAGE_CREATE':
        this.handleMessage(data)
        break
    }
  }

  private handleMessage(msg: DiscordMessage) {
    // Only process messages from configured channels/DMs
    if (this.config?.channelId && msg.channelId !== this.config.channelId) return
    if (this.config?.userId && msg.author.id === this.config.userId) return // Ignore own messages

    log.info('Received message', { from: msg.author.username, content: msg.content.substring(0, 50) })
    this.emit('message', msg)
  }

  async sendMessage(channelId: string, content: string) {
    if (!this.config?.token) throw new Error('Not connected to Discord')

    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.config.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content })
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`)
    }

    const msg = await response.json()
    log.info('Sent message', { channelId, content: content.substring(0, 50) })
    return msg
  }

  private cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private async attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnect attempts reached')
      this.emit('disconnected')
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    
    log.info('Attempting reconnect', { attempt: this.reconnectAttempts, delay })
    
    await new Promise(resolve => setTimeout(resolve, delay))
    await this.connect()
  }

  async setup(userId?: string, guildId?: string, channelId?: string) {
    if (!this.config) {
      const config = await this.loadConfig()
      this.config = config || {}
    }

    if (userId) this.config.userId = userId
    if (guildId) this.config.guildId = guildId
    if (channelId) this.config.channelId = channelId

    await this.saveConfig()
    log.info('Discord setup complete', { userId, guildId, channelId })
  }

  private async saveConfig() {
    const configPath = path.join(process.env.HOME || '~', '.mimocode', 'discord.json')
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(this.config, null, 2))
  }

  private async loadConfig(): Promise<DiscordConfig | null> {
    try {
      const configPath = path.join(process.env.HOME || '~', '.mimocode', 'discord.json')
      const data = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  disconnect() {
    this.cleanup()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    log.info('Disconnected from Discord')
    this.emit('disconnected')
  }
}

// Singleton instance
export const discordService = new DiscordService()

// ========== ADVANCED FEATURES ==========

/**
 * Execute terminal commands from Discord
 * Usage: /sudo <command>
 */
async handleSudoCommand(message: DiscordMessage): Promise<string> {
  const args = message.content.split(' ').slice(1)
  if (args.length === 0) {
    return '❌ Usage: /sudo <command>\nExample: /sudo ls -la'
  }

  const cmd = args[0]
  const cmdArgs = args.slice(1)

  try {
    const { spawn } = require('child_process')
    const result = await new Promise<string>((resolve) => {
      const proc = spawn(cmd, cmdArgs, {
        shell: true,
        cwd: process.cwd()
      })
      
      let stdout = ''
      let stderr = ''
      
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      
      proc.on('close', (code: number) => {
        if (code === 0) {
          resolve(stdout || '✅ Command executed successfully')
        } else {
          resolve(`❌ Exit code ${code}\n${stderr || stdout}`)
        }
      })
      
      proc.on('error', (err: Error) => {
        resolve(`❌ Error: ${err.message}`)
      })
      
      // 30s timeout
      setTimeout(() => {
        proc.kill()
        resolve('⏱️ Command timed out (30s)')
      }, 30000)
    })
    
    // Truncate to Discord's 2000 char limit
    return result.length > 1900 
      ? result.substring(0, 1900) + '\n... (truncated)'
      : result
  } catch (error) {
    return `❌ Failed to execute: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * File browser - List files from Discord
 * Usage: /files [path]
 */
async handleFilesCommand(message: DiscordMessage): Promise<string> {
  const pathArg = message.content.split(' ').slice(1).join(' ') || '.'
  
  try {
    const fullPath = path.resolve(process.cwd(), pathArg)
    const stats = await fs.stat(fullPath)
    
    if (stats.isDirectory()) {
      const items = await fs.readdir(fullPath)
      const formatted = items.map(item => {
        const itemPath = path.join(fullPath, item)
        const isDir = fs.statSync(itemPath).isDirectory()
        return isDir ? `📁 ${item}/` : `📄 ${item}`
      }).join('\n')
      
      return `📂 ${pathArg}:\n${formatted || '(empty)'}`
    } else {
      const size = stats.size
      const ext = path.extname(fullPath)
      return `📄 ${pathArg}\nSize: ${this.formatBytes(size)}\nExt: ${ext || 'N/A'}`
    }
  } catch (error) {
    return `❌ Path not found: ${pathArg}`
  }
}

/**
 * Read file from Discord
 * Usage: /read <file>
 */
async handleReadCommand(message: DiscordMessage): Promise<string> {
  const filePath = message.content.split(' ').slice(1).join(' ')
  
  if (!filePath) {
    return '❌ Usage: /read <file>'
  }
  
  try {
    const fullPath = path.resolve(process.cwd(), filePath)
    const content = await fs.readFile(fullPath, 'utf-8')
    
    const lines = content.split('\n')
    const maxLines = 50
    const truncated = lines.length > maxLines
    const displayContent = truncated 
      ? lines.slice(0, maxLines).join('\n') + '\n... (truncated)'
      : content
    
    return `📄 ${filePath}:\n\`\`\`\n${displayContent}\n\`\`\``
  } catch (error) {
    return `❌ Cannot read file: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * System status
 * Usage: /status
 */
async handleStatusCommand(): Promise<string> {
  const memUsage = process.memoryUsage()
  const uptime = process.uptime()
  
  return `📊 **MiMo-Code Status**

**Uptime:** ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m
**Memory:** ${this.formatBytes(memUsage.heapUsed)} / ${this.formatBytes(memUsage.heapTotal)}
**Node.js:** ${process.version}
**Platform:** ${process.platform}
**PID:** ${process.pid}
**CWD:** \`${process.cwd()}\``
}

/**
 * Quick notes
 * Usage: /note add|list|remove
 */
async handleNoteCommand(message: DiscordMessage): Promise<string> {
  const args = message.content.split(' ')
  const subcommand = args[1]
  const notePath = path.join(process.cwd(), '.mimocode', 'discord-notes.json')
  
  try {
    let notes: string[] = []
    try {
      notes = JSON.parse(await fs.readFile(notePath, 'utf-8'))
    } catch {
      notes = []
    }
    
    switch (subcommand) {
      case 'add': {
        const noteText = args.slice(2).join(' ')
        if (!noteText) return '❌ Usage: /note add <text>'
        notes.push(`[${new Date().toISOString()}] ${noteText}`)
        await fs.writeFile(notePath, JSON.stringify(notes, null, 2))
        return `✅ Note added (${notes.length} total)`
      }
      
      case 'list': {
        if (notes.length === 0) return ' 📝 No notes yet'
        return `📝 **Notes (${notes.length}):**\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
      }
      
      case 'remove': {
        const index = parseInt(args[2]) - 1
        if (isNaN(index) || index < 0 || index >= notes.length) {
          return '❌ Invalid note number'
        }
        notes.splice(index, 1)
        await fs.writeFile(notePath, JSON.stringify(notes, null, 2))
        return `✅ Note removed (${notes.length} remaining)`
      }
      
      default:
        return '❌ Usage: /note add|list|remove'
    }
  } catch (error) {
    return `❌ Note error: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Help command
 * Usage: /help
 */
async handleHelpCommand(): Promise<string> {
  return `🤖 **MiMo-Code Discord Bot**

**Commands:**
\`/sudo <cmd>\` - Execute terminal command
\`/files [path]\` - Browse files
\`/read <file>\` - Read file content
\`/status\` - System status
\`/note add|list|remove\` - Quick notes
\`/help\` - This message

**Examples:**
\`/sudo npm test\`
\`/files src\`
\`/read README.md\`
\`/note add Remember to push\``
}

// Helper
private formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * Route incoming Discord message to appropriate handler
 */
async routeMessage(message: DiscordMessage): Promise<string | null> {
  // Only handle messages starting with /
  if (!message.content.startsWith('/')) return null
  
  const command = message.content.split(' ')[0].toLowerCase()
  
  switch (command) {
    case '/sudo':
      return this.handleSudoCommand(message)
    case '/files':
    case '/ls':
      return this.handleFilesCommand(message)
    case '/read':
    case '/cat':
      return this.handleReadCommand(message)
    case '/status':
    case '/sys':
      return this.handleStatusCommand()
    case '/note':
    case '/notes':
      return this.handleNoteCommand(message)
    case '/help':
    case '/?':
      return this.handleHelpCommand()
    default:
      return null
  }
}
