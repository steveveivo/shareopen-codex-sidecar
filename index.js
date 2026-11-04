#!/usr/bin/env node
/**
 * ShareOpen x Codex CLI — local WS sidecar (P2).
 *
 * Codex CLI is a LOCAL agent: the ShareOpen cloud can't reach it.  The
 * sidecar runs on the user's machine and bridges:
 *
 *   ShareOpen  <—WS—>  sidecar  <—headless—>  `codex exec`
 *
 * Inbound (user → ShareOpen → codex):
 *   User message arrives on the WS.  The sidecar spawns
 *   `codex exec <prompt>` (or `codex exec --json` for structured output)
 *   and pushes the result back into the ShareOpen conversation.
 *
 * Outbound (codex → ShareOpen → user, hook-supplemented):
 *   Codex's `notify` config key (agent-turn-complete, payload as argv) and
 *   the newer lifecycle hooks (UserPromptSubmit / Stop / PermissionRequest)
 *   call into the sidecar via:
 *
 *     node index.js hook --agent-id <id> --event <event> [--notify-json '<json>']
 *
 *   The sidecar forwards the turn result / approval request into ShareOpen
 *   as an `agent_message`.
 *
 * Known limitation (documented in README): Codex's external `notify` hook
 * only fires on `agent-turn-complete` (v0.120); `approval-requested` has
 * no external hook path — the sidecar surfaces it as a text confirmation
 * instead of a blocking approval flow.
 *
 * Usage:
 *   node index.js serve --agent-id <id> --token <so_live_...> [--shareopen <url> --codex-bin <path> --codex-home <dir>]
 *   node index.js hook  --agent-id <id> --token <so_live_...> --event <agent-turn-complete|permission-request> [--notify-json '<json>']
 */

import { ShareOpenConnector } from './sdk/index.js'
import { handleCommand, registerBuiltins } from './builtin-commands.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const cmd = process.argv[2]
const args = parseArgs(process.argv.slice(3))

const agentId = args['agent-id'] || process.env.CODEX_AGENT_ID || ''
const soToken = args.token || process.env.SO_AGENT_TOKEN || ''
const shareopen = args.shareopen || process.env.SHAREOPEN_URL || 'http://localhost:3021'
const codexBin = args['codex-bin'] || process.env.CODEX_BIN || 'codex'
const codexHome = args['codex-home'] || process.env.CODEX_HOME || ''
const workdir = args['workdir'] || process.cwd()
// ── 多租户隔离 (P3: 出租场景) ─────────────────────────────────────
// owner-id: 该 agent 的 owner (user_id)。侧车启动方知道, 填进来。
// 每个入站消息的 user_id === owner-id → owner 租户; 否则 → subscriber 租户。
// 租户各自一个 codexHome 目录: owner 用默认/指定, subscriber 用租户目录,
// 记忆库/线程历史/shell 快照天然按租户隔离, 互不污染。
const ownerId = args['owner-id'] || process.env.CODEX_OWNER_ID || ''
// 租户 home 基目录: owner 未指定 --codex-home 时用默认 (~/.codex),
// 订阅者基目录默认 ~/.codex-tenants/
const tenantHomeBase = args['tenant-home'] || process.env.CODEX_TENANT_HOME
  || join(process.env.HOME || '', '.codex-tenants')
// 公共只读共享目录 (codex-so): 订阅者沙箱内可 cat/读, 不可写。
// owner 本人 full 权限本就可达, 此参数只影响订阅者。
const sharedRoDir = args['shared-ro'] || process.env.CODEX_SHARED_RO || ''
// 订阅者是否开沙箱 (默认开, 配了 owner-id 即出租场景; 单租户自用可 --no-sandbox 关)
const sandboxOn = args['no-sandbox'] ? false : true

// ── serve mode: WS sidecar ─────────────────────────────────────────────

async function serve() {
  // Token alone identifies the agent (the backend resolves it via
  // /ws/agent?token=…); --agent-id is an optional log label only.
  if (!soToken) {
    fail('serve requires --token (or SO_AGENT_TOKEN env; token identifies the agent)')
  }

  const sdk = new ShareOpenConnector({
    transport: 'ws',
    host: shareopen,
    token: soToken,
    autoReconnect: true,  // serve mode: reconnect on WS drop, else half-open process silently stops replying
  })

  await sdk.connect()
  console.log(`[codex-sidecar] WS connected → ${shareopen} (agent ${agentId})`)

  // / command menu: register built-in slash commands + handle invocations.
  registerBuiltins(sdk, {
    agentName: 'Codex',
    binLabel: 'Codex CLI',
    workdir,
    describeSelf: async () => {
      try {
        const { execFile } = await import('node:child_process')
        const v = await new Promise((res) => execFile(codexBin, ['--version'], (e, so) => res(so || '')))
        return `codex ${String(v).trim().split('\n')[0]}`
      } catch { return '未知' }
    },
  })
  sdk.on('command', (inv) => handleCommand(inv, sdk, {
    agentName: 'Codex', binLabel: 'Codex CLI', workdir,
  }))

  sdk.on('message', async (msg) => {
    const { conversation_id: convId, text, user_id: senderId } = msg
    const media = msg.media || null
    const group = msg.group || null   // [P0 2026-11-03] 群信封块
    if (!text && !media) return

    // 多租户隔离: 按发送者 user_id 解析该租户专属 codexHome + 会话 workdir
    const tenant = resolveTenant(senderId)
    const convWorkdir = join(workdir, 'convs', convId)
    mkdirSync(convWorkdir, { recursive: true })

    // Download media attachments to local temp files for the CLI to read.
    let mediaDir = null
    let localAttachments = []
    if (media) {
      const staged = await stageAttachments(media, convWorkdir)
      localAttachments = staged.paths
      mediaDir = staged.dir
    }

    const prompt = buildPrompt(text, localAttachments, group)
    console.log(
      `[codex-sidecar] msg ${convId} tenant=${tenant.tenantId} owner=${tenant.isOwner}: ` +
      `${prompt.slice(0, 60)}…`
    )

    await sdk.typing(convId, true)
    const result = await runCodexHeadless(prompt, convWorkdir, tenant.home, {
      isOwner: tenant.isOwner,
      sandbox: sandboxOn,
      sharedRo: sharedRoDir,
    })
    await sdk.typing(convId, false)
    if (mediaDir) { try { await rm(mediaDir, { recursive: true, force: true }) } catch {} }

    if (result.error) {
      await sdk.send(convId, `[codex error] ${result.error}`)
    } else {
      const reply = result.text || '(no output)'
      const { clean, attachments } = extractOutboundAttachments(reply, tenant.home)
      await sdk.send(convId, clean, attachments.length ? { attachments } : {})
    }
  })

  sdk.on('close', (code) => {
    console.warn(`[codex-sidecar] WS closed (${code}); auto-reconnect in 5s`)
  })

  process.on('SIGINT', async () => {
    console.log('\n[codex-sidecar] shutting down…')
    await sdk.disconnect()
    process.exit(0)
  })
}

/**
 * Run `codex exec <prompt>` headlessly and capture the final answer.
 * `codex exec --json` emits JSONL events; we collect the last `turn_complete`
 * or fall back to plain-text stdout.
 */
function runCodexHeadless(prompt, cwd, codexHome, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (codexHome) env.CODEX_HOME = codexHome

    // Plain exec (no --json) gives the final assistant message on stdout
    // which is the simplest reliable contract; --json is opt-in.
    const useJson = !!args['json-output']
    // stdio[0] 必须 ignore：默认继承父进程 stdin 会让 codex exec 进入
    // "读 stdin 交互模式"（stderr 打 "Reading additional input from stdin..."），
    // 侧车收不到结果、一直挂到 5min 超时。
    // Codex trusts dirs under ~/.codex or a git repo. Sidecar workdirs are
    // plain /tmp or user dirs that aren't git repos → codex exec refuses
    // ("Not inside a trusted directory"). --skip-git-repo-check bypasses the
    // trust gate for headless exec.
    //
    // 沙箱 (多租户 P3): opts.isOwner / opts.sharedRo
    //  - owner 租户: danger-full-access (主人完全权限, 现状体验)
    //  - 订阅者: workspace-write (只能写自己的会话 workdir, 公共目录 ro)
    // 公共只读目录 (--shared-ro / codex-so) 用 --add-dir 追加为沙箱内可访问。
    // 注意: 0.159.2 里 -c sandbox_permissions=[...] 被忽略("is ignored"),
    // 实际放行目录只能用 --add-dir (writable 额外目录, 顺带可读)。
    const baseArgs = ['exec', '--skip-git-repo-check', ...(useJson ? ['--json'] : [])]
    const sandboxArgs = []
    if (opts.isOwner) {
      sandboxArgs.push('-s', 'danger-full-access')
    } else if (opts.sandbox !== false) {
      // 订阅者: 可写=会话 workdir (cwd 自动进白名单), 公共目录 --add-dir
      sandboxArgs.push('-s', 'workspace-write')
      if (opts.sharedRo) sandboxArgs.push('--add-dir', opts.sharedRo)
    }
    const proc = spawn(codexBin, [...baseArgs, ...sandboxArgs, prompt], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ error: stderr.slice(0, 500) || `codex exited ${code}` })
      }
      if (useJson) {
        // JSONL: last line with type=turn_complete carries the answer.
        const lines = stdout.trim().split('\n').filter(Boolean)
        let text = stdout
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const ev = JSON.parse(lines[i])
            if (ev.type === 'turn_complete' || ev.type === 'agent_message') {
              text = ev.message || ev.content || ev.text || text
              break
            }
          } catch { /* skip non-JSON lines */ }
        }
        resolve({ text })
      } else {
        resolve({ text: stdout })
      }
    })

    proc.on('error', (e) => resolve({ error: e.message }))
    setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        resolve({ error: 'codex timed out after 5min' })
      }
    }, 5 * 60 * 1000)
  })
}

/**
 * Build the prompt for `codex exec`, folding in local attachment paths so the
 * model can inspect them (cat, base64, or direct file read) in the sandbox.
 */
function buildPrompt(text, localAttachments, group = null) {
  const parts = []
  // 置顶: 出站附件约定 — 直接告知"写一行文本即可，无需任何工具"
  // codex 误认为需要平台提供 /send_media 工具才会拒绝；必须前置+措辞明确
  parts.push(
    '[ShareOpen attachment protocol — IMPORTANT, read before answering]\n' +
    'To send a file or image to the user: write the literal text MEDIA:<absolute_path> ' +
    'on its own line anywhere in your reply. That is all. No /send_media tool, no upload API, ' +
    'no platform feature — the ShareOpen sidecar reads MEDIA lines from your plain-text reply ' +
    'and converts them into file attachments automatically. Just save the file to your working ' +
    'directory, then write MEDIA:/absolute/path/to/file in your reply.\n' +
    'Rules: max 3MB per file, max 5 files per reply. Use absolute paths for local files or ' +
    'https URLs for public files. Do NOT describe MEDIA lines in your prose — just write them. ' +
    'If you create an image, document, or code file the user should receive, ALWAYS attach it ' +
    'with a MEDIA line. You are not limited to text-only replies.'
  )
  // [P0 2026-11-03] 群上下文: 置顶渲染"我是谁(角色) / 群成员 / 最近发言 / 谁@了我".
  // 单聊 group=null → 零成本.
  if (group && group.members && group.members.length) {
    const roleLine = group.self_role ? `\n[你在本群的角色: ${group.self_role}]` : ''
    const members = group.members
      .filter(m => m && m.name)
      .map(m => `- ${m.name} (${m.type === 'agent' ? 'agent' : 'human'}${m.role ? `, 角色: ${m.role}` : ''})`)
      .join('\n')
    const recent = (group.recent || [])
      .filter(r => r && r.text && r.text.trim())
      .slice(-10)
      .map(r => `[${r.type === 'agent' ? 'agent' : 'user'} ${r.from}]: ${(r.text || '').slice(0, 300)}`)
      .join('\n')
    const mentioned = (group.mentions || []).filter(m => m && m.name).map(m => m.name)
    const mentionNote = mentioned.length ? `\n[本条消息 @了你: ${mentioned.join(', ')}]` : ''
    parts.push(
      `[Group context — 你在一个 ShareOpen 群聊里]${roleLine}\n` +
      `群成员:\n${members}\n` +
      (recent ? `最近发言:\n${recent}\n` : '') +
      mentionNote
    )
  }
  if (text) parts.push(text)
  if (localAttachments.length) {
    const lines = localAttachments.map(a =>
      `- ${a.path} (source name: ${a.name}${a.type ? `, type: ${a.type}` : ''})`
    )
    parts.push(
      `\n[Attached files — use cat or base64 to inspect them before answering]\n${lines.join('\n')}`
    )
    if (!text) parts.push('Please analyze the attached file(s).')
  }
  return parts.join('\n')
}

/**
 * Download media attachments into a per-message staging dir inside the
 * project dir so the CLI's file tools can read them (CLIs can't fetch
 * remote URLs).  Files land in `.so-media/<uuid>/`; caller cleans up.
 */
async function stageAttachments(media, workdir) {
  const dir = join(workdir, '.so-media', randomUUID().slice(0, 12))
  mkdirSync(dir, { recursive: true })
  const out = []
  const items = Array.isArray(media) ? media : [media]
  for (const att of items) {
    const url = att?.url || att?.media_url
    if (!url) continue
    const fname = (att.file_name || url.split('/').pop() || 'attachment').replace(/[^\w.\-]/g, '_')
    const localPath = join(dir, fname)
    try {
      const res = await fetch(url)
      if (!res.ok) { console.warn(`[codex-sidecar] media download ${res.status}: ${url.slice(0, 80)}`); continue }
      writeFileSync(localPath, Buffer.from(await res.arrayBuffer()))
      out.push({ path: localPath, name: fname, type: att.type || att.media_type || '' })
      console.log(`[codex-sidecar] media staged: ${localPath}`)
    } catch (e) {
      console.warn(`[codex-sidecar] media download failed: ${e.message}`)
    }
  }
  return { paths: out, dir }
}

// ── hook mode: receive a Codex notify / lifecycle event ───────────────

async function hook() {
  if (!agentId || !soToken) {
    fail('hook requires --agent-id and --token')
  }
  const event = args.event || 'agent-turn-complete'
  let payload = {}
  if (args['notify-json']) {
    try { payload = JSON.parse(args['notify-json']) } catch { payload = { raw: String(args['notify-json']) } }
  }

  const sdk = new ShareOpenConnector({ transport: 'ws', host: shareopen, token: soToken, autoReconnect: false })
  await sdk.connect()

  const convId = payload.conversation_id || process.env.SHAREOPEN_CONVERSATION_ID || agentId
  const content = describeCodexEvent(event, payload)

  if (content) {
    await sdk.send(convId, content, { messageId: `msg_codex_hook_${randomUUID().slice(0, 8)}` })
  }
  await sdk.disconnect()
  process.exit(0)
}

function describeCodexEvent(event, p) {
  switch (event) {
    case 'agent-turn-complete':
      return p['last-assistant-message'] || p.message
        ? `[codex] turn complete: ${String(p['last-assistant-message'] || p.message).slice(0, 500)}`
        : '[codex] turn complete'
    case 'permission-request':
    case 'approval-requested':
      // Codex external hooks don't expose approval-requested (open issue
      // #11808). Surface it as a text confirmation — the user approves in
      // the terminal, not in ShareOpen.
      return `[codex] ⚠️ Codex 请求权限（终端内确认，ShareOpen 无外部审批通道）：${(p.command || p.reason || 'tool call').toString().slice(0, 300)}`
    default:
      return null
  }
}

// ── MEDIA: outbound attachment extraction (≤3MB, same protocol as openclaw) ─
// Codex is told (in buildPrompt) to end its reply with MEDIA:/abs/path tags
// when it produces files for the user.  The sidecar extracts them, base64-
// inlines local files ≤ 3MB, and sends via sdk.send(..., { attachments }).
// Files > 3MB are skipped with a warning — WS frame size budget (34MB b64
// for a 25MB file is a memory spike on the prod api).

const OUT_ATTACH_MAX = 3 * 1024 * 1024
const OUT_MAX_FILES = 5
// Keep in sync with backend/lib/agent-attachments.js EXT_TO_DIR (classify())
// so the stored media_type lands in the right bucket.  Backend default for
// unknown exts is 'files' (application/octet-stream) — fine for archives.
const MIME_OUT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.js': 'text/javascript', '.ts': 'text/typescript',
  '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css',
  '.sh': 'text/x-shellscript',
  '.zip': 'application/zip', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.tgz': 'application/gzip',
}
const MEDIA_RE = /MEDIA:\s*([^\s`"']+)(?=$|[\s`"']|[,;:)\]（）〈〉《》：，。；！？、【】])/g

function extractOutboundAttachments(text, workdir) {
  if (!text || !text.includes('MEDIA:')) return { clean: text, attachments: [] }
  const out = []
  let clean = text
  for (const m of text.matchAll(MEDIA_RE)) {
    if (out.length >= OUT_MAX_FILES) break
    const raw = m[1]
    // URL form: pass through (backend fetches server-side; MAX_SIZE applies)
    if (/^https?:\/\//i.test(raw)) {
      const bare = raw.split('?')[0]
      const ext = extname(bare).toLowerCase()
      out.push({
        source: 'url',
        file_id: `url_${out.length}`,
        url: raw,
        name: bare.split('/').pop()?.replace(/[^\w.-]/g, '_') || 'attachment',
        mime: MIME_OUT[ext] || 'application/octet-stream',
      })
      clean = clean.replace(m[0], '')
      continue
    }
    // Local file form: base64-inline
    let abs = raw
    if (abs.startsWith('~')) abs = join(process.env.HOME || '', abs.slice(1))
    else if (!abs.startsWith('/')) abs = join(workdir, abs)
    let stat
    try { stat = statSync(abs) } catch { clean = clean.replace(m[0], ''); continue }
    if (!stat.isFile()) { clean = clean.replace(m[0], ''); continue }
    if (stat.size > OUT_ATTACH_MAX) {
      console.warn(`[codex-sidecar] attachment skipped (>3MB): ${abs}`)
      clean = clean.replace(m[0], '')
      continue
    }
    const ext = extname(abs).toLowerCase()
    out.push({
      source: 'file',
      file_id: `b64_${out.length}`,
      name: abs.split('/').pop() || 'attachment',
      mime: MIME_OUT[ext] || 'application/octet-stream',
      size: stat.size,
      data_b64: readFileSync(abs).toString('base64'),
    })
    clean = clean.replace(m[0], '')
  }
  return { clean: clean.replace(/MEDIA:/g, '').replace(/\n{3,}/g, '\n\n').trim(), attachments: out }
}

/**
 * 多租户 codexHome 解析 (出租场景隔离)。
 * - owner (user_id === ownerId): 用启动方指定的 --codex-home (codexHome 变量),
 *   没指定则沿用 Codex 默认 (~/.codex, CLI 自己兜底, 传空串即默认行为)。
 * - subscriber (其余 user_id): 每人一个独立目录 tenantHomeBase/<user_id>/,
 *   Codex 的记忆/线程/shell 快照落在这里, 物理隔离, 互不可见。
 * 订阅者"禁记忆写" = 写到的是自己租户目录而非 owner 目录, 而非真的禁写;
 * 这符合"每人独立记忆"语义, 同时绝不污染 owner。
 * 未提供 --owner-id 时退化为旧行为 (全体共享 codexHome), 兼容现有单租户部署。
 */
function resolveTenant(userId) {
  // 未配置 owner-id → 不隔离 (向后兼容), 所有人走同一 home
  if (!ownerId) {
    return {
      tenantId: userId || 'default',
      isOwner: false,
      home: codexHome, // 原样: '' 表示走 Codex 默认 ~/.codex
    }
  }
  if (userId && userId === ownerId) {
    return { tenantId: 'owner', isOwner: true, home: codexHome }
  }
  // 订阅者: 独立租户目录 (mkdir 时 lazy, 避免无消息租户占目录)
  const safeId = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_')
  const home = join(tenantHomeBase, safeId)
  mkdirSync(home, { recursive: true })
  return { tenantId: safeId, isOwner: false, home }
}

// ── shared ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    }
  }
  return out
}

function fail(msg) {
  console.error(`[codex-sidecar] ${msg}`)
  process.exit(1)
}

switch (cmd) {
  case 'serve':
    serve().catch((e) => fail(e.message))
    break
  case 'hook':
    hook().catch((e) => fail(e.message))
    break
  default:
    console.log('Usage:')
    console.log('  node index.js serve --agent-id <id> --token <so_live_...> [--shareopen <url> --codex-bin <path> --codex-home <dir> --json-output]')
    console.log('  node index.js hook  --agent-id <id> --token <so_live_...> --event <agent-turn-complete|permission-request> [--notify-json \'{"last-assistant-message":"..."}\']')
    console.log('')
    console.log('  Codex notify config (~/.codex/config.toml, top-level key):')
    console.log('    notify = ["/usr/bin/env", "node", "<this>/index.js", "hook", "--agent-id", "<id>", "--token", "<so>", "--event", "agent-turn-complete"]')
}
