/** GitLab project Source: scoped polling, policy, thread context and idempotent replies. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ContextPart, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  acceptOwnMentions: z.boolean().default(false),
  observeIssues: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const User = z.looseObject({ username: z.string(), bot: z.boolean().optional() })
export const GitlabItemSchema = z.looseObject({
  iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(), author: User,
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }),
  web_url: z.string().url(), state: z.string(), source_branch: z.string().optional(),
})
export const GitlabNoteSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string(), author: User, system: z.boolean().default(false),
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }),
  position: z.looseObject({ new_path: z.string().optional(), new_line: z.number().nullish() }).nullish(),
})
type Item = z.infer<typeof GitlabItemSchema>
type Note = z.infer<typeof GitlabNoteSchema>
export type GitlabRef = { host: string; project: number; repository: string; kind: 'issue' | 'mr'; iid: number; url: string }
const resource = (ref: GitlabRef) => `${ref.kind === 'issue' ? 'issues' : 'merge_requests'}/${ref.iid}`
const threadId = (ref: GitlabRef) => `${ref.host}:${ref.project}:${ref.kind}:${ref.iid}`
export const gitlabMention = (text: string, login: string): boolean => !!login &&
  new RegExp(`(?:^|[^a-zA-Z0-9_.@-])@${escapeRegExp(login)}(?![a-zA-Z0-9_.-])`, 'i').test(text)
const marker = '<!-- dsh-superagent:'
/** Normalize an issue/MR body or a human note; shared-account mode still discards every marked agent reply. */
export function gitlabTrigger(ref: GitlabRef, item: Item, note: Note | undefined, login: string, own = false): Trigger | undefined {
  const author = note?.author ?? item.author
  const text = note ? note.body : `${item.title}\n\n${item.description ?? ''}`
  const addressed = gitlabMention(text, login)
  if (note?.system || text.includes(marker) || (sameName(author.username, login) && !(own && addressed))) return undefined
  const at = note?.created_at ?? item.created_at
  const url = `${ref.url}${note ? `#note_${note.id}` : ''}`
  return { id: key('gitlab', threadId(ref), note ? `note:${note.id}` : 'body'), source: 'gitlab',
    threads: [{ source: 'gitlab', id: threadId(ref) }], actor: { source: 'gitlab', id: author.username },
    human: author.bot !== true, at, text, ...(addressed ? { addressed: 'mention' as const } : {}), url,
    channel: { source: 'gitlab', thread: `gitlab:${threadId(ref)}`, address: {
      host: ref.host, repository: ref.repository, project: String(ref.project), kind: ref.kind, iid: String(ref.iid), url,
    } }, meta: { ...ref, noteId: note?.id, title: item.title } }
}
/** Read a complete, validated page sequence using glab's JSON pagination mode. */
export async function gitlabList<T>(commands: Commands, schema: z.ZodType<T>, path: string): Promise<T[]> {
  return commands.gitlab(z.array(schema), `${path}${path.includes('?') ? '&' : '?'}per_page=100`, '--paginate', '--method', 'GET')
}
/** Send once using a hidden receipt marker; a 404 stays retryable because private-project access may recover. */
export async function sendGitlab({ commands }: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const target = commands.deployment.gitlab
  const address = message.channel.address
  if (!target || address.host !== target.host || address.repository !== target.repository || address.project !== String(target.project)) throw new Error('GitLab reply target is outside the configured project')
  if (target.replyMode === 'draft') throw new Error('GitLab is in draft mode')
  if (!['issue', 'mr'].includes(address.kind ?? '') || !/^[1-9][0-9]*$/.test(address.iid ?? '')) throw new Error('Invalid GitLab reply target')
  const path = `${address.kind === 'issue' ? 'issues' : 'merge_requests'}/${address.iid}/notes`
  const receipt = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = await gitlabList(commands, GitlabNoteSchema, path)
    if (notes.some(note => sameName(note.author.username, target.login) && note.body.includes(receipt))) return 'sent'
    await commands.gitlab(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${receipt}`)
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
function refOf(trigger: Trigger): GitlabRef {
  const { host, project, repository, kind, iid, url } = trigger.meta
  if (typeof host !== 'string' || typeof repository !== 'string' || typeof project !== 'number' ||
    (kind !== 'issue' && kind !== 'mr') || typeof iid !== 'number' || typeof url !== 'string') throw new Error('Invalid GitLab thread')
  return { host, project, repository, kind, iid, url }
}
/** Bounded context: the root and one page of notes, with numeric continuation cursors. */
export async function gitlabContext(commands: Commands, trigger: Trigger, part: string, cursor?: string): Promise<ContextPart> {
  const ref = refOf(trigger)
  const target = commands.deployment.gitlab
  if (!target || ref.host !== target.host || ref.project !== target.project) throw new Error('GitLab context is outside the configured project')
  const root = await commands.gitlab(GitlabItemSchema, resource(ref))
  const rootMessage = { id: 'body', from: root.author.username, at: root.created_at, text: `${root.title}\n\n${root.description ?? ''}`, url: root.web_url }
  if (part === 'root' || part === 'parent') return { messages: [rootMessage], body: { messages: [rootMessage] } }
  if (cursor && !/^[1-9][0-9]*$/.test(cursor)) throw new Error('Invalid GitLab context cursor')
  const page = Number(cursor ?? 1)
  const notes = await commands.gitlab(z.array(GitlabNoteSchema), `${resource(ref)}/notes?sort=asc&order_by=created_at&per_page=50&page=${page}`)
  const messages = [...page === 1 ? [rootMessage] : [], ...notes.filter(note => !note.system).map(note => ({
    id: String(note.id), from: note.author.username, at: note.created_at, text: note.body,
    ...note.author.bot ? { bot: true as const } : {}, url: `${root.web_url}#note_${note.id}`,
    ...note.position?.new_path ? { path: note.position.new_path, ...note.position.new_line ? { line: note.position.new_line } : {} } : {},
  }))]
  return { messages, body: { messages }, ...notes.length === 50 ? { next: String(page + 1) } : {} }
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '监听一个 GitLab 项目的 Issue、MR 与评论；默认只在本地预览回复。', en: 'Receives project issues, merge requests and notes; replies stay local by default.' },
  schema: GitlabConfigSchema, health: ['gitlab'],
  facts: deployment => deployment?.gitlab ? { cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` } } : {},
  fields: [
    { key: 'host', type: 'text', label: { zh: 'GitLab 地址', en: 'GitLab host' } },
    { key: 'repository', type: 'text', label: { zh: '监听的项目', en: 'Project path' } },
    { key: 'cli', type: 'text', label: { zh: 'GitLab CLI', en: 'GitLab CLI' } },
    { key: 'replyMode', type: 'select', label: { zh: '回复模式', en: 'Reply mode' }, options: [
      { value: 'draft', label: { zh: '仅本地预览，不发送', en: 'Local drafts only' } },
      { value: 'send', label: { zh: '向 GitLab 发送', en: 'Send to GitLab' } },
    ], hint: { zh: '预览不会在以后自动发送；预览模式也禁止执行器通过 glab 写入或 git push。', en: 'Drafts never send automatically later. Draft mode also blocks worker glab writes and git push.' } },
    { key: 'acceptOwnMentions', type: 'switch', label: { zh: '接收当前账号自己发出的 @ 请求', en: 'Receive the signed-in account’s own @ requests' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '观察新 Issue 和 MR', en: 'Observe new issues and merge requests' } },
    { key: 'observeComments', type: 'switch', label: { zh: '观察没有 @ 的评论', en: 'Observe unaddressed notes' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  scope: ({ meta }, config) => meta.host === config.host && sameName(String(meta.repository), config.repository)
    ? { listened: true, observed: meta.noteId ? config.observeComments : config.observeIssues, row: meta.noteId ? 'comments' : 'issues' }
    : { listened: false, reason: 'outside_gitlab_project' },
  draftReplies: config => config.replyMode === 'draft',
  channel: { allowed: (address, config) => address.host === config.host && sameName(address.repository ?? '', config.repository),
    send: sendGitlab, link: address => ({ url: address.url ?? '', label: { zh: `GitLab ${address.kind === 'mr' ? '!' : '#'}${address.iid}`, en: `GitLab ${address.kind === 'mr' ? '!' : '#'}${address.iid}` } }) },
  threadContext: { messageId: trigger => trigger.meta.noteId ? String(trigger.meta.noteId) : 'body',
    read: (commands, trigger, part, cursor) => gitlabContext(commands, trigger, part, cursor) },
  find: query => ({ threads: [], terms: [query] }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    explicit: { zh: '名单中的账号在 Issue、MR 或评论里明确 @ 当前账号。', en: 'An allowed account mentions the signed-in account in an issue, MR or note.' },
    rows: stored => ['issues', 'comments'].map(id => ({ id, label: id === 'issues' ? { zh: '新 Issue / MR', en: 'New issue / MR' } : { zh: '评论', en: 'Notes' },
      note: { zh: '仅名单内 @ 可明确接单', en: 'Explicit work requires an allowed mention' },
      cells: { listedUnaddressed: !!stored[id === 'issues' ? 'observeIssues' : 'observeComments'], unlistedAddressed: true, unlistedUnaddressed: false } })),
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 主机', en: 'GitLab host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: '监听的项目路径', en: 'Watched GitLab project path' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: 'glab 已登录的账号', en: 'The account used by glab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPLY_MODE', description: { zh: 'draft 时只生成本地回复，禁止远程写入', en: 'draft means local replies only; no remote writes' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '提交邮箱', en: 'Commit email' } },
    ],
    values: ({ deployment }) => ({ DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '',
      DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.gitlab?.repository ?? '', DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '',
      DSH_SUPERAGENT_GITLAB_REPLY_MODE: deployment.gitlab?.replyMode ?? 'draft', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.noreply ?? '' }),
  },
}
/** Poll changes since activation; a failed round leaves its cursor untouched and intake is idempotent. */
export async function pollGitlab(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const config = ctx.config<GitlabConfig>('gitlab')
  const target = ctx.deployment.gitlab
  if (!config || !target) return
  const cursorKey = KV.gitlab.cursor(`${target.host}:${target.project}`)
  const before = ctx.state.get(cursorKey)
  const started = new Date().toISOString()
  if (!before) { ctx.state.set(cursorKey, started); ctx.report('gitlab', { state: 'ready', detail: '' }); return }
  const commands = ctx.commands.withSignal(signal)
  for (const kind of ['issue', 'mr'] as const) {
    const list = kind === 'issue' ? 'issues' : 'merge_requests'
    const items = await gitlabList(commands, GitlabItemSchema, `${list}?state=all&scope=all&order_by=updated_at&sort=asc&updated_after=${encodeURIComponent(before)}`)
    for (const item of items) {
      signal?.throwIfAborted()
      if (!ctx.config('gitlab')) return
      const ref = { host: target.host, project: target.project, repository: target.repository, kind, iid: item.iid, url: item.web_url }
      if (Date.parse(item.created_at) >= Date.parse(before)) {
        const trigger = gitlabTrigger(ref, item, undefined, target.login, config.acceptOwnMentions)
        if (trigger) await ctx.receive(trigger)
      }
      const notes = await gitlabList(commands, GitlabNoteSchema, `${resource(ref)}/notes?sort=asc&order_by=created_at`)
      for (const note of notes) {
        if (Date.parse(note.created_at) < Date.parse(before)) continue
        const trigger = gitlabTrigger(ref, item, note, target.login, config.acceptOwnMentions)
        if (trigger) await ctx.receive(trigger)
      }
      const thread = `gitlab:${threadId(ref)}`
      ctx.threads.describe(thread, { label: `${kind === 'issue' ? '#' : '!'}${item.iid} ${item.title}`, url: item.web_url })
      if (kind === 'mr') {
        const followed = { source: 'gitlab', id: threadId(ref) }
        for (const ticket of ctx.tickets.open()) {
          if (ticket.execution?.name && item.source_branch?.split('/').at(-1) === ticket.execution.name && sameName(item.author.username, target.login)) {
            ctx.tickets.bindThread(ticket.id, followed, true)
          }
        }
        if (item.state === 'merged' || item.state === 'closed') ctx.tickets.threadClosed(followed, item.state, item.updated_at)
      }
    }
  }
  ctx.state.set(cursorKey, new Date(Date.parse(started) - 5000).toISOString())
  ctx.report('gitlab', { state: 'ready', detail: '' })
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = (async () => {
      await source.ready
      if (!source.configured()) { source.report('gitlab', health('paused', 'setupPending')); return }
      let failures = 0
      while (!controller.signal.aborted) {
        try {
          if (source.config('gitlab')) await pollGitlab(source, controller.signal)
          else source.report('gitlab', health('paused', 'sourceOff'))
          failures = 0
        } catch (error) {
          if (++failures >= 3 && !controller.signal.aborted) source.report('gitlab', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
        await pause((source.config<GitlabConfig>('gitlab')?.pollSeconds ?? 60) * 1000, controller.signal)
      }
    })().catch(error => { if (!controller.signal.aborted) source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
