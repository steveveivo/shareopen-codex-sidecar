/**
 * WS transport — connects to ShareOpen's /ws/agent endpoint.
 *
 * Protocol (aligned with backend/ws-server.js + hermes adapter):
 *   - Auth:   URL query `?token=<agent_token>`
 *   - Inbound (server → client): frames with `type` field
 *        user_message / text_message / reaction_added / reaction_removed /
 *        component_callback / command_invocation / ping / agent_status
 *   - Outbound (client → server): frames with `type` field
 *        agent_message / stream_chunk / agent_typing / command_register /
 *        component_create / ping / pong
 *   - Heartbeat: server pings every 30s; client replies {type:'pong'}.
 *     Client may also proactively ping every `heartbeatMs`.
 */

import { EventEmitter } from 'node:events'

let WebSocketImpl = null
async function loadWebSocket() {
  if (WebSocketImpl) return WebSocketImpl
  try {
    const mod = await import('ws')
    WebSocketImpl = mod.WebSocket || mod.default
  } catch {
    // Browser / undici fallback (global WebSocket exists in modern runtimes).
    WebSocketImpl = globalThis.WebSocket
  }
  if (!WebSocketImpl) throw new Error('WebSocket implementation not available')
  return WebSocketImpl
}

export class WsTransport extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.ws = null
    this.closedByUser = false
    this._heartbeatTimer = null
    this._reconnectTimer = null
    this._proto = 'so-connector-1'
  }

  get url() {
    const base = (this.config.host || 'http://localhost:3021').replace(/^http/, 'ws')
    const token = encodeURIComponent(this.config.token || '')
    // [027] 设备指纹: 宿主透传 device query 参数 (壳生成, 后端落 agent_devices 表),
    // 管理连接页据此区分同一 agent 在不同设备上的在线标志。
    const device = this.config.device
      ? `&device=${encodeURIComponent(JSON.stringify(this.config.device))}`
      : ''
    return `${base}/ws/agent?token=${token}&proto=${this._proto}${device}`
  }

  async connect() {
    await loadWebSocket()
    this.closedByUser = false
    await this._open()
  }

  _open() {
    return new Promise((resolve, reject) => {
      const WS = WebSocketImpl
      this.ws = new WS(this.url)
      let settled = false
      const settle = () => { if (!settled) { settled = true; resolve() } }

      const onOpen = () => { this._startHeartbeat(); this.emit('open'); settle() }
      const onMsg = (data) => this._onMessage(data)
      const onClose = (code) => {
        this._stopHeartbeat()
        this.emit('close', code)
        if (!this.closedByUser && this.config.autoReconnect !== false) {
          const delay = this.config.reconnectDelayMs || 5000
          this._reconnectTimer = setTimeout(() => this._open().catch(reject), delay)
        }
      }

      // Register EXACTLY ONE handler set. Newer `ws` versions implement BOTH
      // the EventEmitter API (.on) AND the browser EventTarget API
      // (addEventListener) — registering both fires every event TWICE, which
      // made sidecars process each user message twice (double spawns, double
      // replies; verified in real WorkBuddy e2e 2026-09-30).
      if (typeof this.ws.on === 'function') {
        this.ws.on('open', onOpen)
        this.ws.on('message', onMsg)
        this.ws.on('close', onClose)
        this.ws.on('error', (err) => this.emit('error', err))
      } else if (this.ws.addEventListener) {
        this.ws.addEventListener('open', onOpen)
        this.ws.addEventListener('message', (e) => this._onMessage(e.data))
        this.ws.addEventListener('close', (e) => onClose(e.code))
        this.ws.addEventListener('error', (e) => this.emit('error', e.error || e))
      }
    })
  }

  _onMessage(data) {
    let frame
    try {
      frame = typeof data === 'string' ? JSON.parse(data) : JSON.parse(new TextDecoder().decode(data))
    } catch {
      return
    }
    // Heartbeat reply.
    if (frame.type === 'ping') {
      this._sendRaw({ type: 'pong' })
      return
    }
    this.emit('message', frame)
  }

  _startHeartbeat() {
    const ms = this.config.heartbeatMs || 25000
    this._heartbeatTimer = setInterval(() => {
      if (this._isOpen()) this._sendRaw({ type: 'ping' })
    }, ms)
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer)
    clearTimeout(this._reconnectTimer)
    this._heartbeatTimer = null
  }

  _isOpen() {
    return this.ws && (this.ws.readyState === 1 || this.ws.readyState === 'open')
  }

  _sendRaw(obj) {
    if (!this._isOpen()) return false
    this.ws.send(JSON.stringify({ ...obj, proto: this._proto }))
    return true
  }

  // ---- outbound frame builders (used by ShareOpenConnector) ----

  sendChat(frame) {
    return this._sendRaw({
      type: 'agent_message',
      conversation_id: frame.conversation_id,
      content: frame.content,
      ...(frame.attachments ? { attachments: frame.attachments } : {}),
      ...(frame.message_id ? { message_id: frame.message_id } : {}),
      ...(frame.is_final ? { is_final: true } : {}),
    })
  }

  sendStreamChunk(frame) {
    return this._sendRaw({
      type: 'stream_chunk',
      conversation_id: frame.conversation_id,
      content: frame.content,
      message_id: frame.message_id,
      ...(frame.is_final ? { is_final: true } : {}),
    })
  }

  sendTyping(frame) {
    return this._sendRaw({
      type: 'agent_typing',
      conversation_id: frame.conversation_id,
      ...(frame.on === false ? { on: false } : {}),
    })
  }

  sendCommandRegister(frame) {
    return this._sendRaw({ type: 'command_register', command: frame.command })
  }

  async disconnect() {
    this.closedByUser = true
    this._stopHeartbeat()
    if (this.ws) {
      return new Promise((resolve) => {
        const ws = this.ws
        this.ws = null
        const done = () => { this._stopHeartbeat(); resolve() }
        // The `ws` library emits 'close' on its own EventEmitter; resolve once.
        if (ws.on) {
          ws.on('close', done)
          try { ws.close() } catch { done() }
        } else {
          try { ws.close() } catch {}
          setTimeout(done, 100)
        }
      })
    }
    return
  }
}
