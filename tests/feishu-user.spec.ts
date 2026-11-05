import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveFeishuUser } from '../src/deployment.ts'
import { Commands, assertLarkUserRead } from '../src/infra/commands.ts'
import { workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { FeishuUserConfigSchema, FeishuUserMessageSchema, feishuUserKind, feishuUserTrigger, pollFeishuUser } from '../src/sources/feishu-user.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-user-')) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })
const user = { cli: process.execPath, appId: 'cli_personal', brand: 'feishu' as const, openId: 'ou_operator', name: 'Operator' }
const identity = { appId: user.appId, brand: 'feishu', identity: 'user', available: true, onBehalfOf: { openId: user.openId, userName: 'Operator' } }
const config = () => FeishuUserConfigSchema.parse({ cli: user.cli, account: user.openId })
const deployment = () => testDeployment({ stateDir: dir, feishuUser: user, feishu: undefined })
const commands = () => new Commands(deployment, {}, new AbortController().signal)
const started = '2026-11-05T00:00:00.000Z'
const message = FeishuUserMessageSchema.parse({ message_id: 'om_notice', chat_id: 'oc_team', chat_type: 'group', chat_name: 'Team',
  content: '@_user_1 please review this', msg_type: 'text', create_time: '2026-11-05T00:00:10.000Z',
  sender: { id: 'ou_colleague', sender_type: 'user', name: 'Colleague' }, mentions: [{ id: user.openId, key: '@_user_1', name: 'Operator' }] })
function host() {
  const state = new Map<string, unknown>(), received: Trigger[] = []
  const c = commands()
  const ctx = { deployment: deployment(), commands: c, config: () => config(),
    state: { get: (k: string) => state.get(k), set: (k: string, value: unknown) => value === undefined ? state.delete(k) : state.set(k, value) },
    receive: (t: Trigger) => { received.push(t) }, threads: { describe: vi.fn() }, report: vi.fn() } as unknown as SourceContext
  return { ctx, state, received, commands: c }
}

it('resolves the existing personal identity without a bot profile or copying credentials', async () => {
  const probe = vi.fn(async () => JSON.stringify(identity))
  expect(await resolveFeishuUser(testMachine({ stateDir: dir }), { cli: process.execPath, account: user.openId }, probe)).toMatchObject(user)
  expect(probe.mock.calls).toHaveLength(1)
  expect(await resolveFeishuUser(testMachine(), {}, probe)).toBeUndefined()
  await expect(resolveFeishuUser(testMachine(), { cli: process.execPath, account: 'ou_other' }, probe)).rejects.toMatchObject({ code: 'feishuUserFailed', place: 'feishu-user' })
  await expect(resolveFeishuUser(testMachine(), { cli: process.execPath, account: user.openId }, async () => JSON.stringify({ ...identity, identity: 'bot' }))).rejects.toMatchObject({ code: 'feishuUserFailed' })
})

it('keeps personal notifications separate from bot events and does not grant task authority to a mention or DM', () => {
  const trigger = feishuUserTrigger(message, user)!
  expect(trigger.source).toBe('feishu-user')
  expect(trigger.addressed).toBeUndefined()
  expect(trigger.meta).toMatchObject({ owner: user.openId, mentioned: true, direct: false, notification: true })
  expect(trigger.text).toContain('@Operator')
  const settings = SettingsSchema.parse({ sources: { 'feishu-user': { enabled: true, config: config() } } })
  const registry = new SourceRegistry(() => settings);registry.register(feishuUserKind)
  expect(settingsPolicy(settings, registry).gate(trigger, { key: 'feishu-user:test', ref: trigger.threads[0]!, createdAt: started, subscriptions: [], correlated: [], pending: [], meta: {} }, [])).toMatchObject({ admissible: false })
  expect(feishuUserTrigger({ ...message, chat_type: 'p2p' }, user)?.addressed).toBeUndefined()
  expect(feishuUserTrigger(message, { ...user, openId: 'ou_other' })?.id).not.toBe(trigger.id)
})

it('ignores own messages, recalled messages and system notifications without treating bot senders as human', () => {
  expect(feishuUserTrigger({ ...message, sender: { ...message.sender, id: user.openId } }, user)).toBeUndefined()
  expect(feishuUserTrigger({ ...message, deleted: true }, user)).toBeUndefined()
  expect(feishuUserTrigger({ ...message, msg_type: 'system' }, user)).toBeUndefined()
  expect(feishuUserTrigger({ ...message, sender: { id: 'cli_bot', sender_type: 'app' } }, user)?.human).toBe(false)
})

it('receives only the configured account’s enabled personal notification scopes', () => {
  const scope = feishuUserKind.scope!
  expect(scope({ meta: { owner: user.openId, mentioned: true } }, config())).toEqual({ listened: true, observed: false })
  expect(scope({ meta: { owner: 'ou_other', mentioned: true } }, config())).toMatchObject({ listened: false })
  expect(scope({ meta: { owner: user.openId, direct: false, mentioned: false } }, config())).toMatchObject({ listened: false })
  expect(scope({ meta: { owner: user.openId, direct: true } }, { ...config(), directMessages: false })).toMatchObject({ listened: false })
})

it('permits only IM read shortcuts and rejects sends, identity changes, raw APIs and file download flags', () => {
  expect(() => assertLarkUserRead(['im', '+messages-search', '--is-at-me', '--page-size', '20', '--no-reactions'])).not.toThrow()
  for (const args of [['im', '+messages-reply'], ['im', '+messages-send'], ['api', 'POST', '/open-apis/im/v1/messages'],
    ['auth', 'login'], ['im', '+messages-search', '--as', 'bot'], ['im', '+messages-mget', '--download-resources'],
    ['im', '+messages-search', '--profile', 'other'], ['im', '+messages-search', '--jq', '.'], ['im', '+messages-search', '--query', '--as']]) {
    expect(() => assertLarkUserRead(args)).toThrow('read-only')
  }
})

it('forces user identity and refuses account drift, bot output and ok:false responses', async () => {
  const c = commands(), run = vi.spyOn(c, 'run')
  run.mockResolvedValueOnce(JSON.stringify(identity)).mockResolvedValueOnce(JSON.stringify({ ok: true, identity: 'user', data: { messages: [] } }))
  expect(await c.larkUser(['im', '+messages-search', '--is-at-me'])).toEqual({ messages: [] })
  expect(run.mock.calls[1]?.[1]).toEqual(['im', '+messages-search', '--is-at-me', '--as', 'user', '--format', 'json'])
  run.mockClear();run.mockResolvedValueOnce(JSON.stringify({ ...identity, onBehalfOf: { openId: 'ou_other' } }))
  await expect(c.larkUser(['im', '+chat-list'])).rejects.toThrow('account changed')
  expect(run).toHaveBeenCalledTimes(1)
  for (const response of [{ ok: true, identity: 'bot', data: {} }, { ok: false, identity: 'user', error: { message: 'permission denied' } }]) {
    run.mockResolvedValueOnce(JSON.stringify(identity)).mockResolvedValueOnce(JSON.stringify(response))
    await expect(c.larkUser(['im', '+chat-list'])).rejects.toThrow()
  }
  run.mockClear()
  await expect(c.larkUser(['im', '+messages-send'])).rejects.toThrow('read-only')
  expect(run).not.toHaveBeenCalled()
})

it('saves all personal replies as local drafts without ever calling the sending channel', async () => {
  const settings = SettingsSchema.parse({ sources: { 'feishu-user': { enabled: true, config: config() } } })
  const registry = new SourceRegistry(() => settings);registry.register(feishuUserKind)
  const c = commands(), run = vi.spyOn(c, 'run')
  const trigger = feishuUserTrigger(message, user)!
  expect(await registry.send({ id: 'preview', kind: 'reply', text: 'A local proposed reply', channel: trigger.channel! }, c)).toBe('draft')
  expect(run).not.toHaveBeenCalled()
  await expect(feishuUserKind.channel!.send({ commands: c }, { id: 'direct', kind: 'reply', text: 'No send', channel: trigger.channel! })).rejects.toThrow('sending is disabled')
})

it('initializes both cursors at activation, then reads scoped new messages and paginates without backfilling history', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(started) })
  const h = host(), read = vi.spyOn(h.commands, 'larkUser')
  await pollFeishuUser(h.ctx)
  expect(h.state.size).toBe(2);expect(read).not.toHaveBeenCalled()
  vi.setSystemTime(Date.parse(started) + 70_000)
  read.mockImplementation(async args => args.includes('p2p') ? { messages: [], has_more: false }
    : args.includes('--page-token') ? { messages: [{ ...message, message_id: 'om_second' }], has_more: false }
    : { messages: [message], has_more: true, page_token: 'next' })
  await pollFeishuUser(h.ctx)
  expect(h.received).toHaveLength(2)
  expect(read.mock.calls[0]?.[0]).toContain('--is-at-me')
  expect(read.mock.calls[1]?.[0]).toContain('next')
  expect(h.received[0]?.meta.senderName).toBe('Colleague')
  expect([...h.state.values()]).toEqual([expect.objectContaining({ since: '2026-11-05T00:01:10.000Z' }), expect.anything()])
})

it('retains a failed stream’s cursor, advances successful streams and detects repeated pagination tokens', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(started) })
  const h = host();await pollFeishuUser(h.ctx)
  const original = [...h.state.values()][0]
  vi.setSystemTime(Date.parse(started) + 70_000)
  vi.spyOn(h.commands, 'larkUser').mockImplementation(async args => args.includes('p2p') ? { messages: [], has_more: false }
    : { messages: [], has_more: true, page_token: 'same' })
  await expect(pollFeishuUser(h.ctx)).rejects.toThrow('pagination is incomplete')
  expect([...h.state.values()][0]).toEqual(original)
  expect([...h.state.values()][1]).toMatchObject({ since: '2026-11-05T00:01:10.000Z' })
})

it('rejects out-of-scope, preactivation and own records even if a search returns them', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(started) })
  const h = host();await pollFeishuUser(h.ctx)
  vi.setSystemTime(Date.parse(started) + 70_000)
  vi.spyOn(h.commands, 'larkUser').mockResolvedValue({ has_more: false, messages: [
    { ...message, mentions: [] }, { ...message, create_time: '2026-11-04T23:59:00.000Z' },
    { ...message, sender: { ...message.sender, id: user.openId } },
  ] })
  await pollFeishuUser(h.ctx)
  expect(h.received).toEqual([])
})

it('enforces the read-only worker wrapper and keeps the bot CLI distinct', async () => {
  const cli = join(dir, 'fake-lark')
  writeFileSync(cli, `#!/bin/sh\nif [ "$1" = whoami ]; then printf '%s' '${JSON.stringify(identity)}'; else printf '%s\\n' "$@"; fi\n`);chmodSync(cli, 0o755)
  await writeEnvironment({ ...deployment(), feishuUser: { ...user, cli } }, [])
  const shim = join(workerBin(dir), 'lark-user-cli')
  const result = await exec(shim, ['im', '+messages-search', '--is-at-me'])
  expect(result.stdout).toContain('--as\nuser')
  for (const args of [['im', '+messages-send'], ['im', '+messages-search', '--as', 'bot'], ['auth', 'login'], ['api', 'POST', '/messages']]) {
    await expect(exec(shim, args)).rejects.toThrow('read-only')
  }
  await expect(exec(join(workerBin(dir), 'lark-cli'), ['im', '+chat-list'])).rejects.toThrow('no Feishu bot')
})


it('does not drop a new message when the CLI formats its creation time only to the minute', async () => {
  const activation = Date.parse(started) + 30_000
  vi.useFakeTimers({ toFake: ['Date'], now: activation })
  const h = host();await pollFeishuUser(h.ctx)
  vi.setSystemTime(activation + 70_000)
  const date = new Date(Date.parse(started))
  const localMinute = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
  vi.spyOn(h.commands, 'larkUser').mockImplementation(async args => ({ messages: args.includes('group') ? [{ ...message, create_time: localMinute }] : [], has_more: false }))
  await pollFeishuUser(h.ctx)
  expect(h.received).toHaveLength(1)
})
