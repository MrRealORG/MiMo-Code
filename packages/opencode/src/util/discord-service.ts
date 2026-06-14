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
