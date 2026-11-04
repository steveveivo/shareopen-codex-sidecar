/**
 * ShareOpen Connector SDK — unified transport abstraction.
 *
 * A Connector wraps one of three transports (WS / REST / ACP) behind a single
 * language-agnostic interface.  Connectors (Claude Code, Codex, Manus, Coze,
 * WorkBuddy, or any custom agent platform) only interact with this interface —
 * they never touch the underlying transport directly.
 *
 * @module
 */

import { WsTransport } from './transports/ws.js'
import { RestTransport } from './transports/rest.js'
import { AcpTransport } from './transports/acp.js'

/**
 * @typedef {Object} ConnectorConfig
 * @property {'ws'|'rest'|'acp'} transport
 * @property {string} host            // e.g. 'http://localhost:3021' or 'https://shareopen.com'
 * @property {string} [token]        // WS transport: agent token
 * @property {string} [connectorId]  // REST/ACP: registered connector id ('con_...')
 * @property {string} [hmacKey]      // REST transport: HMAC key (from registration)
 * @property {string} [acpEndpoint]  // ACP transport: base ACP URL (default `${host}/acp`)
 * @property {number} [heartbeatMs]  // WS: client-side ping interval (default 25000)
 * @property {boolean} [autoReconnect] // WS: auto-reconnect on close (default true)
 */

export class ShareOpenConnector {
  /**
   * @param {ConnectorConfig} config
   */
  constructor(config) {
    this.config = config
    this._events = new Map() // eventName -> Set<handler>

    switch (config.transport) {
      case 'ws':
        this.transport = new WsTransport(config)
        break
      case 'rest':
        this.transport = new RestTransport(config)
        break
      case 'acp':
        this.transport = new AcpTransport(config)
        break
      default:
        throw new Error(`Unknown transport: ${config.transport}`)
    }

    // Wire transport-level events into the unified on() API.
    this.transport.on('open', () => this._emit('open'))
    this.transport.on('close', (code) => this._emit('close', code))
    this.transport.on('message', (frame) => this._dispatch(frame))
    this.transport.on('error', (err) => this._emit('error', err))
  }

  /** @returns {Promise<void>} */
  async connect() {
    if (this.transport.connect) await this.transport.connect()
    // REST/ACP transports are stateless per-call; "connect" is a no-op for them.
  }

  /** @returns {Promise<void>} */
  async disconnect() {
    if (this.transport.disconnect) await this.transport.disconnect()
    this.transport.removeAllListeners?.()
  }

  /**
   * Send a chat message to a conversation.
   * @param {string} conversationId
   * @param {string} text
   * @param {object} [opts]
   * @param {Array}  [opts.attachments]
   * @param {string} [opts.messageId]
   * @returns {Promise<void>}
   */
  async send(conversationId, text, opts = {}) {
    return this.transport.sendChat({
      conversation_id: conversationId,
      content: text,
      attachments: opts.attachments,
      message_id: opts.messageId,
    })
  }

  /**
   * Stream a reply: iterate an async generator of chunks, send each as a
   * `stream_chunk` frame, then send a final `agent_message` with full text.
   * @param {string} conversationId
   * @param {AsyncIterable<string>} chunks
   * @param {object} [opts]
   * @param {string} [opts.messageId]
   * @returns {Promise<void>}
   */
  async stream(conversationId, chunks, opts = {}) {
    const messageId = opts.messageId || `msg_local_${Date.now()}`
    let full = ''
    for await (const chunk of chunks) {
      full += chunk
      await this.transport.sendStreamChunk({
        conversation_id: conversationId,
        content: chunk,
        message_id: messageId,
        is_final: false,
      })
    }
    // Final frame carries the complete text so the backend can persist once.
    await this.transport.sendChat({
      conversation_id: conversationId,
      content: full,
      message_id: messageId,
      is_final: true,
    })
  }

  /**
   * Typing indicator.
   * @param {string} conversationId
   * @param {boolean} [on=true]
   */
  async typing(conversationId, on = true) {
    await this.transport.sendTyping({ conversation_id: conversationId, on })
  }

  /**
   * Register a slash-command menu entry (in the user's "/" command menu).
   * @param {string} name
   * @param {string} description
   * @param {Array} [parameters]
   */
  async registerCommand(name, description, parameters = []) {
    await this.transport.sendCommandRegister({
      command: { name, description, parameters },
    })
  }

  /**
   * Bulk-register slash commands (full metadata: category, aliases,
   * permission_level, cooldown_ms) in one call.
   * @param {Array<{name:string, description?:string, category?:string,
   *   parameters?:Array, aliases?:string[], permission_level?:string,
   *   cooldown_ms?:number}>} commands
   */
  async registerCommands(commands) {
    for (const c of commands || []) {
      await this.transport.sendCommandRegister({
        command: {
          name: c.name,
          description: c.description || '',
          category: c.category || 'general',
          parameters: c.parameters || [],
          aliases: c.aliases || [],
          permission_level: c.permission_level || 'user',
          cooldown_ms: c.cooldown_ms || 0,
        },
      })
    }
  }

  /**
   * Reply to a command_invocation: { invocation_id, status, result|error }.
   * The backend persists result as a `command_result` message and pushes it
   * to the user's open chats.
   * @param {string} invocationId
   * @param {object} response  { status:'completed'|'failed', result?:string, error?:string }
   */
  async commandResult(invocationId, response) {
    await this.transport._sendRaw({
      type: 'command_response',
      invocation_id: invocationId,
      response,
    })
  }

  /**
   * Subscribe to an inbound event.
   * @param {'message'|'reaction'|'component'|'command'|'open'|'close'|'error'|string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, new Set())
    this._events.get(event).add(handler)
    return this
  }

  off(event, handler) {
    this._events.get(event)?.delete(handler)
    return this
  }

  _emit(event, payload) {
    for (const h of this._events.get(event) || []) {
      try { h(payload) } catch (e) { console.error('[connector] handler error:', e) }
    }
  }

  /** Map a transport frame to a unified event + handler. */
  _dispatch(frame) {
    const t = frame.type || frame.frame
    switch (t) {
      case 'user_message':
      case 'text_message':
      case 'message':
        // 'message' is the /ws/agent outbound push frame from the backend:
        // { type:'message', data:{ conversation_id, message, user_id,
        // message_id, media? } } — normalize its nested shape into the same
        // unified payload as user_message/text_message so local sidecar
        // connectors (claude-code / codex / workbuddy / hermes_ws / openclaw)
        // all receive 'message' events.
        {
          const d = t === 'message' ? frame.data || {} : frame
          this._emit('message', {
            conversation_id: d.conversation_id ?? frame.conversation_id,
            user_id: d.user_id ?? frame.user_id,
            message_id: d.message_id ?? frame.message_id,
            text: d.message ?? d.content ?? frame.content ?? frame.text ?? '',
            transcribed: d.transcribed === true,
            attachments: frame.attachments,
            media: d.media,
            // [P0 2026-11-03] 群信封 group 块 + L2 envelope: 后端在群聊 WS 帧上
            // 挂了 data.group (buildGroupPayload: members/recent/mentions/media/self_role)
            // 和 data.envelope (buildGroupEnvelope)。此前被丢弃, 所有 sidecar 收不到
            // 群角色感知。穿透后, 群聊时 msg.group 非空, 单聊为 undefined (零成本)。
            group: d.group ?? frame.group,
            envelope: d.envelope ?? frame.envelope,
          })
        }
        break
      case 'reaction_added':
      case 'reaction_removed':
        this._emit('reaction', {
          kind: t,
          message_id: frame.message_id,
          conversation_id: frame.conversation_id,
          emoji: frame.emoji,
          reacter_id: frame.reacter_id,
          catchup: frame.catchup,
        })
        break
      case 'component_callback':
        this._emit('component', {
          invocation_id: frame.invocation_id,
          component: frame.component,
          payload: frame.payload,
        })
        break
      case 'command_invocation':
        this._emit('command', {
          invocation_id: frame.invocation_id,
          command: frame.command_name,
          args: frame.args,
          locale: frame.locale || 'zh',
          conversation_id: frame.conversation_id,
          user_id: frame.user_id,
        })
        break
      case 'pong':
        // Heartbeat ack — no public event, but useful for metrics.
        break
      default:
        this._emit('unknown', frame)
    }
  }
}

export { WsTransport, RestTransport, AcpTransport }
