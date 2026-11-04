#!/usr/bin/env node
/**
 * ShareOpen built-in slash commands — shared by local-CLI sidecars
 * (claude-code / codex / workbuddy).
 *
 * Self-contained: register once after WS connect (backend upserts on
 * reconnect), handle `command_invocation` frames via
 * connector.on('command', ...) and reply with connector.commandResult().
 *
 * Usage:
 *   import { BUILTIN_COMMANDS, handleCommand, registerBuiltins } from './builtin-commands.js'
 *
 *   // after sdk.connect():
 *   registerBuiltins(sdk, { agentName: 'Claude Code' })
 *
 *   // once at startup:
 *   sdk.on('command', async (inv) => handleCommand(inv, sdk, ctx))
 *
 * ctx = { workdir, binLabel, runHeadless, describeSelf }
 *   binLabel     'Claude Code CLI' | 'Codex CLI' | 'CodeBuddy CLI'
 *   runHeadless  async (prompt, cwd) => { text } | { error }
 *   describeSelf async () => string  (version + model + status summary)
 */

export const BUILTIN_COMMANDS = [
  { name: 'help', description: '查看可用命令 / Show available commands', category: 'general', aliases: ['h', '命令', 'cmds'] },
  { name: 'status', description: '侧车与 CLI 状态 / Sidecar & CLI status', category: 'session', aliases: ['st', '状态'] },
  { name: 'model', description: '当前模型 / CLI 版本 / Current model / CLI version', category: 'model', aliases: ['模型'] },
  { name: 'usage', description: '用量说明 / Usage & /menu help', category: 'general', aliases: ['u'] },
]

// i18n: sidecars run on the user machine and have no i18n runtime, so the
// backend injects the invoking user's locale into the command_invocation
// frame (ws-server.js handleCommandInvocation). Default = 'zh' (legacy).
function helpText(locale, name, binLabel) {
  if (locale === 'en') return `👋 Built-in / command menu for ${name} (${binLabel} sidecar):\n\n/help — this help\n/status — sidecar & CLI status\n/model — current model / CLI version\n/usage — usage notes\n\nType / in the chat box to open the menu; commands with parameters show a form.`
  return `👋 ${name} 内置 / 命令菜单（${binLabel} 侧车）：\n\n/help — 本帮助\n/status — 侧车与 CLI 状态\n/model — 当前模型 / CLI 版本\n/usage — 用量说明\n\n直接在输入框打 / 调出菜单，参数型命令会弹表单。`
}

function usageText(locale) {
  if (locale === 'en') return `Usage:\n1. Type / at the start of the chat box to open the command menu (↑↓ select, Enter run, Tab complete)\n2. Parameterless commands (like /status) run on select\n3. All commands in this sidecar are parameterless and read-only — they never modify your files\n\nTip: for normal chat just send a message, no / needed.`
  return `用法：\n1. 输入框开头打 / 弹出命令菜单（↑↓ 选择，Enter 执行，Tab 补全）\n2. 无参命令（如 /status）选中即执行\n3. 本侧车命令均为无参只读命令，不会改你的文件\n\n提示：普通聊天直接发消息即可，无需 /。`
}

export async function handleCommand(inv, sdk, ctx) {
  const { invocation_id: invId, command: name, args, locale } = inv
  const locale_ = String(locale || 'zh')
  const en = locale_ === 'en'
  const cmd = String(name || '').toLowerCase()
  const reply = async (status, text) => {
    try { await sdk.commandResult(invId, { status, ...(text ? { result: text } : {}) }) }
    catch (e) { console.warn(`[so-commands] reply failed: ${e.message}`) }
  }

  try {
    switch (cmd) {
      case 'help': case 'h':
        return reply('completed', helpText(locale_, ctx.agentName, ctx.binLabel))
      case 'usage': case 'u':
        return reply('completed', usageText(locale_))
      case 'status': case 'st': case '状态': {
        const uptime = Math.round(process.uptime())
        const lines = en
          ? [`✅ Sidecar online (up ${fmtDur(uptime)})`, `CLI: ${ctx.binLabel}`]
          : [`✅ 侧车在线（已运行 ${fmtDur(uptime)}）`, `CLI: ${ctx.binLabel}`]
        if (ctx.describeSelf) {
          const self = await ctx.describeSelf()
          if (self) lines.push(en ? `Self-check: ${String(self).slice(0, 200)}` : `自检: ${String(self).slice(0, 200)}`)
        }
        lines.push(en ? `Workdir: ${ctx.workdir}` : `工作目录: ${ctx.workdir}`)
        return reply('completed', lines.join('\n'))
      }
      case 'model': case '模型': {
        let out = en ? `Model / version info (${ctx.binLabel}):` : `模型/版本信息（${ctx.binLabel}）:`
        if (ctx.describeSelf) {
          const self = await ctx.describeSelf()
          out = self ? String(self).slice(0, 300) : (en ? 'unknown' : '未知')
        }
        return reply('completed', out)
      }
      case 'new':
      case 'clear':
        return reply('completed', en
          ? `(${ctx.binLabel} sidecar keeps context per conversation — no /new needed; just keep sending messages.)`
          : `（${ctx.binLabel} 侧车会按会话保留上下文，无需 /new；直接继续发消息即可。）`)
      case 'stop':
        return reply('completed', en ? '(No task is currently running.)' : '（当前没有正在执行的任务。）')
      default:
        return reply('failed', en
          ? `Unknown command /${cmd} — try /help`
          : `未知命令 /${cmd}，试试 /help`)
    }
  } catch (e) {
    return reply('failed', en ? `Command failed: ${e.message}` : `命令执行失败: ${e.message}`)
  }
}

export async function registerBuiltins(sdk, ctx) {
  try {
    for (const c of BUILTIN_COMMANDS) {
      await sdk.registerCommands([c])
    }
    console.log(`[so-commands] registered ${BUILTIN_COMMANDS.length} built-in commands`)
  } catch (e) {
    console.warn(`[so-commands] register failed (non-fatal): ${e.message}`)
  }
}

function fmtDur(sec) {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`
}
