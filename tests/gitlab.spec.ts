import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { resolveGitlabDeployment } from '../src/deployment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { GitlabConfigSchema, GitlabItemSchema, GitlabNoteSchema, gitlabContext, gitlabKind, gitlabTrigger, pollGitlab, sendGitlab } from '../src/sources/gitlab.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { Outbox, type OutboxHost } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitlab-source-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })
const gitlab = { cli: '/bin/false', host: 'gitlab.example', project: 312, repository: 'product/team/requirements', login: 'jared',
  noreply: '104-jared@users.noreply.gitlab.example', replyMode: 'draft' as const }
const config = () => GitlabConfigSchema.parse({ host: gitlab.host, repository: gitlab.repository, cli: gitlab.cli, replyMode: 'draft', acceptOwnMentions: true })
const deployment = () => testDeployment({ stateDir: dir, github: { cli: '', login: '', noreply: '' }, gitlab })
const commands = () => new Commands(deployment, {}, new AbortController().signal)
const at = '2026-11-04T12:00:00.000Z'
const item = GitlabItemSchema.parse({ iid: 42, title: 'Fix typo', description: '@jared fix this typo', author: { username: 'alice' },
  created_at: at, updated_at: at, state: 'opened', web_url: 'https://gitlab.example/product/team/requirements/-/issues/42' })
const note = GitlabNoteSchema.parse({ id: 9, body: '@jared please investigate', author: { username: 'jared' }, created_at: at, updated_at: at })
const ref = { ...gitlab, kind: 'issue' as const, iid: item.iid, url: item.web_url }
const message: OutboundMessage = { id: 'draft-1', kind: 'reply', text: '我会先检查这条需求。', channel: gitlabTrigger(ref, item, note, 'jared', true)!.channel! }

it('keeps issue and MR numbers distinct, uses allowed native actor IDs, and matches complete usernames', () => {
  const issue = gitlabTrigger(ref, item, note, 'jared', true)!
  const mr = gitlabTrigger({ ...ref, kind: 'mr' }, item, note, 'jared', true)!
  expect(issue).toMatchObject({ actor: { source: 'gitlab', id: 'jared' }, addressed: 'mention', human: true })
  expect(issue.threads).not.toEqual(mr.threads)
  expect(gitlabTrigger(ref, item, { ...note, body: '@jared.more fix', author: { username: 'alice' } }, 'jared')?.addressed).toBeUndefined()
  expect(gitlabTrigger(ref, item, { ...note, author: { username: 'ci_bot', bot: true } }, 'jared')?.human).toBe(false)
})

it('accepts own mentions only when enabled and never ingests marked replies or system notes', () => {
  expect(gitlabTrigger(ref, item, note, 'jared')).toBeUndefined()
  expect(gitlabTrigger(ref, item, note, 'jared', true)).toBeDefined()
  expect(gitlabTrigger(ref, item, { ...note, body: '@jared response\n<!-- dsh-superagent:receipt -->' }, 'jared', true)).toBeUndefined()
  expect(gitlabTrigger(ref, item, { ...note, system: true }, 'jared', true)).toBeUndefined()
  expect(gitlabTrigger(ref, item, { ...note, body: 'no request' }, 'jared', true)).toBeUndefined()
})

it('rejects scope and reply destinations after switching host or project', () => {
  const c = config()
  expect(gitlabKind.scope!({ meta: { ...ref } }, c)).toMatchObject({ listened: true })
  expect(gitlabKind.scope!({ meta: { ...ref, host: 'other.example' } }, c)).toMatchObject({ listened: false })
  expect(gitlabKind.channel!.allowed!({ ...message.channel.address, repository: 'other/project' }, c)).toBe(false)
})

it('resolves the existing glab account and project without requiring GitHub or Developer access in draft mode', async () => {
  const probe = vi.fn(async (args: string[]) => args.at(-1) === 'user'
    ? JSON.stringify({ id: 104, username: 'jared' })
    : JSON.stringify({ id: 312, path_with_namespace: gitlab.repository, permissions: { group_access: { access_level: 20 } } }))
  const resolved = await resolveGitlabDeployment(testMachine({ stateDir: dir }), { ...config(), cli: process.execPath }, probe)
  expect(resolved).toMatchObject({ gitlab: { host: gitlab.host, project: 312, login: 'jared', replyMode: 'draft' }, github: { cli: '' } })
  expect(probe.mock.calls[1]?.[0].at(-1)).toContain('product%2Fteam%2Frequirements')
  await expect(resolveGitlabDeployment(testMachine({ stateDir: dir }), { ...config(), cli: process.execPath, replyMode: 'send' }, probe)).rejects.toMatchObject({ code: 'gitlabAccessFailed' })
})

it('refuses draft-mode API mutations and paths escaping the configured project before starting a process', async () => {
  const c = commands(), run = vi.spyOn(c, 'run').mockResolvedValue('[]')
  for (const path of ['../user', '%2e%2e/user', '/user', 'https://other.example/api']) {
    await expect(c.gitlab(z.unknown(), path)).rejects.toThrow('restricted')
  }
  await expect(c.gitlab(z.unknown(), 'issues/42/notes', '--method', 'POST', '-f', 'body=x')).rejects.toThrow('draft mode')
  await expect(c.gitlab(z.unknown(), 'issues', '-f', 'body=x')).rejects.toThrow('draft mode')
  expect(run).not.toHaveBeenCalled()
  await c.gitlab(z.array(z.unknown()), 'issues', '--method', 'GET')
  expect(run).toHaveBeenCalledWith('/bin/false', ['api', '--hostname', gitlab.host, 'projects/312/issues', '--method', 'GET'])
})

it('stores actual outbox content as a local draft and never replays it when sending is enabled', async () => {
  let settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: config() } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(gitlabKind)
  const store = new Store(join(dir, 'drafts.sqlite'))
  const callbacks = new Map<string, (payload: unknown, id: string) => Promise<void>>()
  const c = commands(), run = vi.spyOn(c, 'run')
  const host = { store, sources, commands: c, paused: () => false,
    effects: { handle: (name: string, cb: (payload: unknown, id: string) => Promise<void>) => { callbacks.set(name, cb) }, enqueue: vi.fn(), cancel: vi.fn(), idle: async () => {} } } as unknown as OutboxHost
  try {
    const outbox = new Outbox(host)
    outbox.send(message)
    await callbacks.get('reply')!({}, message.id)
    expect(outbox.status(message.id)).toBe('draft')
    expect(store.read.draftReplies()[0]?.text).toBe(message.text)
    settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: { ...config(), replyMode: 'send' } } } })
    await callbacks.get('reply')!({}, message.id)
    expect(run).not.toHaveBeenCalled()
    expect(outbox.status(message.id)).toBe('draft')
  } finally { store.close() }
})

it('makes reply sends idempotent and refuses direct sends while draft mode is active', async () => {
  const c = commands(), run = vi.spyOn(c, 'run')
  await expect(sendGitlab({ commands: c }, message)).rejects.toThrow('draft mode')
  expect(run).not.toHaveBeenCalled()
  const send = new Commands(() => ({ ...deployment(), gitlab: { ...gitlab, replyMode: 'send' } }), {}, new AbortController().signal)
  const api = vi.spyOn(send, 'gitlab').mockResolvedValue([{ ...note, body: 'already sent\n<!-- dsh-superagent:draft-1 -->' }])
  expect(await sendGitlab({ commands: send }, message)).toBe('sent')
  expect(api).toHaveBeenCalledTimes(1)
})

it('returns bounded original thread context and rejects cross-project context', async () => {
  const c = commands()
  const api = vi.spyOn(c, 'gitlab').mockImplementation(async (_schema, path) => path.includes('/notes') ? [note] : item)
  const trigger = gitlabTrigger(ref, item, note, 'jared', true)!
  const read = await gitlabContext(c, trigger, 'thread')
  expect(read.messages.map(m => m.id)).toEqual(['body', '9'])
  expect(api.mock.calls[1]?.[1]).toContain('per_page=50&page=1')
  await expect(gitlabContext(c, { ...trigger, meta: { ...trigger.meta, project: 999 } }, 'thread')).rejects.toThrow('outside')
})

it('starts polling at activation and retains the cursor on failed reads', async () => {
  const state = new Map<string, unknown>(), received: Trigger[] = []
  const c = commands(), api = vi.spyOn(c, 'gitlab')
  const ctx = { deployment: deployment(), commands: c, config: () => config(), state: { get: (k: string) => state.get(k), set: (k: string, value: unknown) => state.set(k, value) },
    receive: (t: Trigger) => { received.push(t) }, report: vi.fn(), threads: { describe: vi.fn() }, tickets: { open: () => [], threadClosed: vi.fn() } } as unknown as SourceContext
  await pollGitlab(ctx)
  expect(api).not.toHaveBeenCalled()
  const first = [...state.values()][0]
  api.mockRejectedValueOnce(new Error('temporary network outage'))
  await expect(pollGitlab(ctx)).rejects.toThrow('network outage')
  expect([...state.values()][0]).toBe(first)
  expect(received).toEqual([])
})

it('reads changed issue/MR notes, with retry-safe stable trigger IDs and no historical backfill', async () => {
  const state = new Map<string, unknown>([['gitlab-cursor:gitlab.example:312', '2026-11-04T11:59:00.000Z']])
  const received: Trigger[] = [], c = commands()
  vi.spyOn(c, 'gitlab').mockImplementation(async (_schema, path) => path.startsWith('merge_requests?') ? [] : path.includes('/notes') ? [note] : [item])
  const ctx = { deployment: deployment(), commands: c, config: () => config(), state: { get: (k: string) => state.get(k), set: (k: string, value: unknown) => state.set(k, value) },
    receive: (t: Trigger) => { received.push(t) }, report: vi.fn(), threads: { describe: vi.fn() }, tickets: { open: () => [], threadClosed: vi.fn() } } as unknown as SourceContext
  await pollGitlab(ctx)
  expect(received).toHaveLength(2)
  expect(received[1]?.actor.id).toBe('jared')
})

it('blocks worker glab writes and git push while preserving scoped GET reads and host binding', async () => {
  const cli = join(dir, 'fake-glab')
  writeFileSync(cli, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n'); chmodSync(cli, 0o755)
  await writeEnvironment({ ...deployment(), gitlab: { ...gitlab, cli } }, [])
  const shim = join(workerBin(dir), 'glab')
  expect((await exec(shim, ['api', 'projects/312/issues', '--method', 'GET'])).stdout).toContain('gitlab.example')
  for (const args of [['api', 'projects/312/issues', '-X', 'POST'], ['api', 'projects/312/issues', '--method=POST'],
    ['api', 'projects/999/issues'], ['api', 'projects/312/../999/issues'], ['api', 'projects/312/issues', '--hostname', 'evil.example'],
    ['issue', 'comment', '42', '-m', 'test'], ['config', 'get', 'token']]) {
    await expect(exec(shim, args)).rejects.toThrow()
  }
  await expect(exec(join(workerBin(dir), 'git'), ['push', 'origin', 'HEAD'])).rejects.toThrow('no push')
  await expect(exec(join(workerBin(dir), 'git'), ['-c', 'alias.upload=push', 'upload'])).rejects.toThrow()
  const vars = agentVariables(dir)
  expect(vars).not.toHaveProperty('GITLAB_TOKEN', expect.any(String))
})
