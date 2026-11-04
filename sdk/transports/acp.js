/**
 * ACP transport — Agent Client Protocol (JSON-RPC over SSE).
 *
 * Modeled on WorkBuddy's official /api/v1/acp:
 *   1. POST {endpoint}/connect        → { connectionId, sessionToken }
 *   2. GET  {endpoint}/events         → SSE stream (notifications)
 *   3. POST {endpoint}/ (JSON-RPC)    → newSession / prompt / cancelRun
 *
 * SSE stream events map to stream_chunk / stream_final frames on the unified
 * connector interface.  On disconnect, reconnect with a fresh /connect and
 * re-issue the last known prompt (idempotency via event ids).
 */

import { EventEmitter } from 'node:events'

export class AcpTransport extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.endpoint = config.acpEndpoint || `${config.host}/acp`
    this.sessionToken = null
    this.connectionId = null
    this._sse = null
    this._rpcId = 0
    this._pending = new Map() // rpcId -> { resolve, reject }
    this._proto = 'so-connector-1'
  }

  async connect() {
    const res = await fetch(`${this.endpoint}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: this.config.agentId,
        token: this.config.token, // optional platform-level auth
      }),
    })
    if (!res.ok) throw new Error(`acp connect ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    this.sessionToken = data.sessionToken || data.token
    this.connectionId = data.connectionId
    this._openSse()
    this.emit('open')
  }

  _openSse() {
    // SSE via fetch stream (no EventSource in Node; browser could use native).
    const url = `${this.endpoint}/events?token=${encodeURIComponent(this.sessionToken)}`
    fetch(url, { headers: { Accept: 'text/event-stream' } })
      .then(async (res) => {
        if (!res.ok) { this.emit('error', new Error(`acp sse ${res.status}`)); return }
        this._sse = res.body
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            this._onSseEvent(raw)
          }
        }
      })
      .catch((e) => this.emit('error', e))
  }

  _onSseEvent(raw) {
    // SSE: "event: name\ndata: {...}\n\n"
    const lines = raw.split('\n')
    let event = 'message'
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return
    let payload
    try { payload = JSON.parse(data) } catch { payload = { raw: data } }
    this._dispatchSse(event, payload)
  }

  _dispatchSse(event, payload) {
    switch (event) {
      case 'stream_chunk':
      case 'streamChunk':
        this.emit('message', { type: 'stream_chunk', content: payload.delta ?? payload.content, message_id: payload.messageId, is_final: false })
        break
      case 'stream_final':
      case 'message':
        this.emit('message', { type: 'agent_message', content: payload.content ?? payload.text, conversation_id: payload.conversationId, message_id: payload.messageId, is_final: true })
        break
      case 'error':
        this.emit('error', new Error(payload.message || 'acp error'))
        break
      default:
        this.emit('message', { type: event, ...payload })
    }
  }

  /**
   * Send a JSON-RPC request over POST.
   * @param {string} method   // 'newSession' | 'prompt' | 'cancelRun'
   * @param {object} params
   */
  async rpc(method, params) {
    const id = ++this._rpcId
    const body = JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: { ...params, proto: this._proto },
    })
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.sessionToken}`,
      },
      body,
    })
    if (!res.ok) throw new Error(`acp rpc ${method} ${res.status}`)
    return res.json()
  }

  // ---- outbound frame builders ----

  async sendChat(frame) {
    return this.rpc('prompt', {
      conversationId: frame.conversation_id,
      content: frame.content,
      messageId: frame.message_id,
    })
  }

  async sendStreamChunk(frame) {
    // ACP streams are server-driven (SSE); a "chunk" from our side maps to a
    // prompt turn.  In v1, only the final frame is meaningful.
    if (frame.is_final) return this.sendChat(frame)
  }

  async sendTyping() {
    // No typing frame in ACP v1.
  }

  async sendCommandRegister() {
    // No slash menus over ACP v1.
  }

  async newSession(params = {}) {
    return this.rpc('newSession', params)
  }

  async cancelRun(params = {}) {
    return this.rpc('cancelRun', params)
  }

  async disconnect() {
    try { await this.rpc('disconnect', {}) } catch {}
    if (this._sse) { try { this._sse.cancel?.() } catch {} this._sse = null }
    this.sessionToken = null
    this.emit('close', 1000)
  }
}
