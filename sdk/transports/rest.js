/**
 * REST transport — webhook-based connector (cloud agents: Manus / Coze / generic).
 *
 * Outbound (connector → ShareOpen):
 *   POST {host}/api/connectors/:id/inbound
 *   Headers: X-Signature: hmac-sha256=<hex>, X-Timestamp, X-Nonce
 *   hex = HMAC_SHA256(hmacKey, `${ts}:${nonce}:${rawBody}`)
 *
 * Inbound (ShareOpen → connector) is NOT implemented client-side in v1:
 *   ShareOpen routes user messages to the agent platform via its own outbound
 *   delivery (P1). This transport exposes the *connector's* responsibility —
 *   pushing platform events back into ShareOpen over the signed webhook.
 */

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'

export class RestTransport extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this._proto = 'so-connector-1'
  }

  /**
   * Compute the HMAC signature for a raw request body.
   * @param {string|Buffer} rawBody
   * @returns {{ signature: string, timestamp: string, nonce: string }}
   */
  sign(rawBody) {
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(12).toString('hex')
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
    const key = this.config.hmacKey || ''
    const signature = crypto.createHmac('sha256', key).update(`${ts}:${nonce}:${body}`).digest('hex')
    return { signature, timestamp: ts, nonce }
  }

  /**
   * Push one inbound frame to ShareOpen (signed webhook).
   * @param {object} frame  // see PROTOCOL.md §3.3
   * @returns {Promise<object>}  // parsed JSON response
   */
  async pushInbound(frame) {
    const connectorId = this.config.connectorId
    if (!connectorId) throw new Error('REST transport requires connectorId')

    const body = JSON.stringify({ ...frame, proto: this._proto })
    const { signature, timestamp, nonce } = this.sign(body)
    const url = `${this.config.host}/api/connectors/${connectorId}/inbound`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': `hmac-sha256=${signature}`,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
      },
      body,
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    if (!res.ok) {
      const err = new Error(`inbound ${res.status}: ${text.slice(0, 200)}`)
      err.status = res.status
      err.body = json
      this.emit('error', err)
      throw err
    }
    return json
  }

  // ---- outbound frame builders (used by ShareOpenConnector) ----
  // For REST, "send" means: the agent platform produced a chat event; push it
  // back into ShareOpen so the user sees it.

  async sendChat(frame) {
    return this.pushInbound({
      frame: 'chat',
      event_id: frame.event_id || `evt_${crypto.randomUUID()}`,
      conversation_id: frame.conversation_id,
      receiver_id: frame.receiver_id,
      receiver_type: frame.receiver_type || 'human',
      text: frame.content,
      ...(frame.attachments ? { attachment: frame.attachments[0] } : {}),
    })
  }

  async sendStreamChunk(frame) {
    // REST has no streaming channel in v1 — coalesce and push the final frame.
    if (!frame.is_final) return
    return this.pushInbound({
      frame: 'stream_final',
      event_id: frame.message_id,
      conversation_id: frame.conversation_id,
      text: frame.content,
    })
  }

  async sendTyping() {
    return this.pushInbound({ frame: 'typing', event_id: `evt_typing_${Date.now()}` })
  }

  async sendCommandRegister() {
    // Command menus are a WS/ACP feature; no-op over REST in v1.
  }

  // REST is stateless — connect/disconnect are no-ops (shareop connector may
  // still call them for symmetry).
  async connect() { this.emit('open') }
  async disconnect() { this.emit('close', 1000) }
}
