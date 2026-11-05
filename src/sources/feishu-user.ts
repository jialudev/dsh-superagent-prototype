/** Personal Feishu notifications via the existing user CLI: polling intake and local drafts only. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { FeishuUserSchema, type FeishuUser } from '../deployment.ts'
import { withMentionNames, feishuTime } from './feishu-trigger.ts'
import { feishuChatLink } from './feishu-channel.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import type { SourceKind, Localized } from './kind.ts'

export const FeishuUserConfigSchema = FeishuUserSchema.extend({
  mentions: z.boolean().default(true), directMessages: z.boolean().default(true),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
}).strict()
export type FeishuUserConfig = z.infer<typeof FeishuUserConfigSchema>
export const FeishuUserMessageSchema = z.looseObject({
  message_id: z.string().regex(/^om_[A-Za-z0-9_-]+$/), chat_id: z.string().regex(/^oc_[A-Za-z0-9]+$/),
  chat_type: z.enum(['p2p', 'group']), chat_name: z.string().optional(),
  content: z.string().default(''), msg_type: z.string(), create_time: z.string(), deleted: z.boolean().default(false),
  sender: z.looseObject({ id: z.string().min(1), name: z.string().optional(), sender_type: z.string() }),
  mentions: z.array(z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  message_app_link: z.string().url().refine(value => value.startsWith('https://')).optional(),
  root_id: z.string().optional(), thread_id: z.string().optional(), parent_id: z.string().optional(),
})
type Message = z.infer<typeof FeishuUserMessageSchema>
const PageSchema = z.looseObject({ messages: z.array(FeishuUserMessageSchema), has_more: z.boolean(), page_token: z.string().optional() })
const streams = ['mentions', 'direct'] as const
/** Notifications addressed to the person carry context, never an implicit mandate to the Agent. */
export function feishuUserTrigger(message: Message, user: FeishuUser): Trigger | undefined {
  if (message.deleted || message.sender.id === user.openId || message.msg_type === 'system') return undefined
  const direct = message.chat_type === 'p2p'
  const mentioned = message.mentions.some(mention => mention.id === user.openId)
  const thread = `${user.appId}:${user.openId}:${message.chat_id}:${message.root_id ?? message.thread_id ?? message.message_id}`
  const url = message.message_app_link ?? feishuChatLink(user.brand, message.chat_id)
  return { id: key('feishu-user', user.appId, user.openId, message.message_id), source: 'feishu-user',
    threads: [{ source: 'feishu-user', id: thread }], actor: { source: 'feishu-user', id: message.sender.id },
    human: message.sender.sender_type === 'user', at: feishuTime(message.create_time),
    text: withMentionNames(message.content, message.mentions), url,
    channel: { source: 'feishu-user', thread: `feishu-user:${user.appId}:${user.openId}:${message.chat_id}`, address: {
      owner: user.openId, chatId: message.chat_id, messageId: message.message_id, direct: String(direct), mentioned: String(mentioned), url,
    } }, meta: { owner: user.openId, appId: user.appId, chatId: message.chat_id, messageId: message.message_id,
      chatName: message.chat_name ?? '', senderName: message.sender.name ?? '', direct, mentioned, notification: true,
      ...message.thread_id ? { threadId: message.thread_id } : {}, ...message.parent_id ? { parentId: message.parent_id } : {} } }
}
export const feishuUserKind: SourceKind<FeishuUserConfig> = {
  kind: 'feishu-user', title: { zh: '个人飞书通知', en: 'Personal Feishu notifications' },
  description: { zh: '用现有个人账号每分钟只读检查 @你和私聊新消息，显示在消息页；通知不会自动发起任务，回复仅保存在本地。',
    en: 'Polls personal mentions and direct messages through the existing user CLI. Notifications are context, not task authority; replies are local drafts only.' },
  schema: FeishuUserConfigSchema, health: ['feishu-user'],
  fields: [
    { key: 'cli', type: 'text', label: { zh: '个人账号的飞书 CLI', en: 'Personal Feishu CLI' } },
    { key: 'account', type: 'text', label: { zh: '个人账号 open_id', en: 'User open_id' },
      hint: { zh: '必须与 CLI 当前的用户身份相符；保留原登录配置，不复制凭据。', en: 'Must match the CLI user identity; existing credentials are reused.' } },
    { key: 'mentions', type: 'switch', label: { zh: '接收群里的 @我', en: 'Receive group mentions' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊新消息', en: 'Receive direct messages' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  facts: (deployment): Record<string, Localized | string> => deployment?.feishuUser ? { cli: { zh: `当前用户 ${deployment.feishuUser.name || deployment.feishuUser.openId} · 仅本地预览`,
    en: `Current user ${deployment.feishuUser.name || deployment.feishuUser.openId} · local drafts only` } } : {},
  draftReplies: () => true,
  scope: ({ meta }, config) => meta.owner === config.account && (meta.direct === true ? config.directMessages : config.mentions && meta.mentioned === true)
    ? { listened: true, observed: false } : { listened: false, reason: 'personal_notification_out_of_scope' },
  channel: {
    allowed: (address, config) => address.owner === config.account && (address.direct === 'true' ? config.directMessages : config.mentions && address.mentioned === 'true'),
    send: async () => { throw new Error('Personal Feishu notifications are local drafts only; sending is disabled') },
    link: address => ({ url: address.url ?? '', label: { zh: '飞书原消息', en: 'Original Feishu message' } }),
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FEISHU_USER', description: { zh: '只读通知使用的个人账号', en: 'Personal account for read-only notifications' } },
      { key: 'DSH_SUPERAGENT_FEISHU_USER_CLI', description: { zh: '只读个人飞书 CLI 包装器；不能发送或更改身份', en: 'Read-only personal Feishu CLI wrapper; no sends or identity changes' } },
    ],
    values: ({ deployment }) => ({ DSH_SUPERAGENT_FEISHU_USER: deployment.feishuUser?.openId ?? '',
      DSH_SUPERAGENT_FEISHU_USER_CLI: deployment.feishuUser ? 'lark-user-cli' : '' }),
  },
}
/** Poll both streams independently; paged reads and intake must all succeed before a stream's cursor advances. */
export async function pollFeishuUser(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const config = ctx.config<FeishuUserConfig>('feishu-user')
  const user = ctx.deployment.feishuUser
  if (!config) return
  if (!user || user.openId !== config.account) throw new Error('Configure and verify the personal Feishu CLI account before receiving notifications')
  const commands = ctx.commands.withSignal(signal)
  const ended = new Date().toISOString()
  const errors: string[] = []
  for (const stream of streams) {
    const cursor = KV.feishuUser.cursor(`${user.appId}:${user.openId}:${stream}`)
    const before = ctx.state.get(cursor)
    if (!(stream === 'mentions' ? config.mentions : config.directMessages)) { ctx.state.set(cursor, undefined); continue }
    if (!before) { ctx.state.set(cursor, { activated: ended, since: ended }); continue }
    try {
      // Search indexing may lag; replay the last two minutes and deduplicate by stable source-message ID.
      const since = new Date(Math.max(Date.parse(before.activated), Date.parse(before.since) - 120_000)).toISOString()
      const args = ['im', '+messages-search', '--chat-type', stream === 'direct' ? 'p2p' : 'group',
        ...stream === 'mentions' ? ['--is-at-me'] : [], '--start', since, '--end', ended, '--page-size', '50', '--no-reactions']
      let token: string | undefined
      const seen = new Set<string>()
      for (let page = 0; ; page++) {
        signal?.throwIfAborted()
        const read = PageSchema.parse(await commands.larkUser([...args, ...token ? ['--page-token', token] : []]))
        for (const message of read.messages) {
          signal?.throwIfAborted()
          if (!ctx.config('feishu-user')) return
          const trigger = feishuUserTrigger(message, user)
          // The CLI renders some create_time values to local minute precision; the server's precise search window remains authoritative.
          const resolution = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(message.create_time) ? 59_999 : 0
          if (!trigger || Date.parse(trigger.at) + resolution < Date.parse(before.activated) || Date.parse(trigger.at) > Date.parse(ended)) continue
          if ((stream === 'direct' && message.chat_type !== 'p2p') || (stream === 'mentions' && (message.chat_type !== 'group' || !trigger.meta.mentioned))) continue
          await ctx.receive(trigger)
          ctx.threads.describe(`feishu-user:${trigger.threads[0]!.id}`, { url: trigger.url, facts: {
            chat: { value: message.chat_name || (message.chat_type === 'p2p' ? '私聊' : message.chat_id) },
          } })
        }
        if (!read.has_more) break
        if (!read.page_token || seen.has(read.page_token) || page >= 39) throw new Error('Personal Feishu search pagination is incomplete; cursor retained')
        seen.add(read.page_token); token = read.page_token
      }
      ctx.state.set(cursor, { ...before, since: ended })
    } catch (error) { if (signal?.aborted) throw error; errors.push(`${stream}: ${String(error)}`) }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  ctx.report('feishu-user', { state: 'ready', detail: 'Polling personal mentions and direct messages; local drafts only', at: ended })
}
export const name = 'dsh-superagent-feishu-user'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(feishuUserKind), 'feishu-user: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, feishuUserKind)
    const controller = new AbortController()
    const running = (async () => {
      await source.ready
      if (!source.configured()) { source.report('feishu-user', health('paused', 'setupPending')); return }
      let failures = 0
      while (!controller.signal.aborted) {
        try {
          if (source.config('feishu-user')) await pollFeishuUser(source, controller.signal)
          else source.report('feishu-user', health('paused', 'sourceOff'))
          failures = 0
        } catch (error) {
          if (!controller.signal.aborted && ++failures >= 3) source.report('feishu-user', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
        await pause((source.config<FeishuUserConfig>('feishu-user')?.pollSeconds ?? 60) * 1000, controller.signal)
      }
    })().catch(error => { if (!controller.signal.aborted) source.report('feishu-user', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
