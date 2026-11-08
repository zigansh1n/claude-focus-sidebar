import { expect, mock, test } from 'claude-code/testing'
import { ARCHIVE, COMMAND, HOT, SCRATCH, VERSION, WAITING, WORKING, dayOf, newer, plan, projectOf, restamp, stampOf, type Session } from '../hooks/register'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-23T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const REPOS = new Set(['/Users/u/web-app/.git', '/Users/u/api-server/.git', '/Users/u/old/.git'])
const exists = async (p: string) => REPOS.has(p)

type Section = { id: string; kind: string; name: string; group_by?: string }

/** A sidebar and session list held in memory, answering the mod's MCP calls. */
const fakeApp = (sessions: Session[], userSections: Section[] = []) => {
  const sections: Section[] = [
    { id: 'pinned', kind: 'pinned', name: '' },
    ...userSections,
    { id: 'sessions', kind: 'sessions', name: '' },
  ]
  let n = 0
  const calls: string[] = []
  // Sections the mod asked the session list about, one by one.
  const listed: string[] = []
  // Ways the real app could part from what the mod assumes.
  const quirks = { renameIgnored: false, listCap: 0, listRefused: false }
  // Sessions shown under a section named after another project, after each call.
  const misfiled: string[] = []
  const filed = new Set<string>()
  const answer = (tool: string, args: Record<string, unknown>): string => {
    const text = reply(tool, args)
    for (const s of sessions) {
      if (!s.isArchived && s.group === null && filed.has(s.sessionId)) misfiled.push(`${tool}: ${s.sessionId} dropped to Recents`)
      if (s.group) filed.add(s.sessionId)
      const name = sections.find(x => x.id === s.group?.id)?.name?.replace(/\u200b+$/, '')
      const own = s.cwd.includes('/scratch-workspaces/') ? SCRATCH : s.cwd.split('/')[3]
      if (!s.isArchived && name && name !== 'Study' && name.replace(`${HOT} `, '') !== own) misfiled.push(`${tool}: ${s.sessionId} in ${name}`)
    }
    return text
  }
  const reply = (tool: string, args: Record<string, unknown>): string => {
    calls.push(tool)
    if (tool === 'list_sessions') {
      if (quirks.listRefused) throw new Error('refused: PreToolUse hook error: Session state unavailable; cannot verify tool permissions.')
      if (args.include_archived) throw new Error('result exceeds maximum allowed tokens')
      if (args.group) listed.push(String(args.group))
      // Like the real tool: newest first, cut to `limit`, narrowed to one section by `group`.
      const live = sessions
        .slice(1)
        .filter(s => !s.isArchived && (!args.group || s.group?.id === args.group))
        .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
        .slice(0, Number(args.limit ?? 20))
      if (quirks.listCap && live.length > quirks.listCap) throw new Error('result (51,035 characters across 1,288 lines) exceeds maximum allowed tokens')
      return JSON.stringify(live)
    }
    if (tool === 'get_session') {
      const one = args.session_id === 'self' ? sessions[0] : sessions.find(s => s.sessionId === args.session_id)!
      const detail = { ...one, createdAt: '2026-10-23T07:30:00Z' }
      return JSON.stringify(one.sessionId.startsWith('routine') ? { ...detail, scheduledTaskId: 'daily' } : detail)
    }
    if (tool === 'list_sections') {
      return JSON.stringify(sections.map(x => ({ ...x, session_count: sessions.filter(s => !s.isArchived && s.group?.id === x.id).length })))
    }
    if (tool === 'create_section') {
      // The app hands back the section already holding that name instead of making a second one.
      const same = sections.find(s => s.kind === 'manual' && s.name === args.name)
      if (same) return JSON.stringify(same)
      const s = { id: `cg-${++n}`, kind: 'manual', name: String(args.name) }
      sections.splice(sections.length - 1, 0, s)
      return JSON.stringify(s)
    }
    if (tool === 'rename_section') {
      if (quirks.renameIgnored) return 'Renamed.'
      sections.find(s => s.id === args.section_id)!.name = String(args.name)
      return 'Renamed.'
    }
    if (tool === 'delete_section') {
      sections.splice(sections.findIndex(s => s.id === args.section_id), 1)
      for (const s of sessions) if (s.group?.id === args.section_id) s.group = null
      return 'Deleted.'
    }
    if (tool === 'set_view') {
      sections.find(s => s.id === args.section_id)!.group_by = String(args.group_by)
      return '{}'
    }
    if (tool === 'set_session_title') {
      sessions.find(s => s.sessionId === args.session_id)!.title = String(args.title)
      return 'Renamed.'
    }
    if (tool === 'unarchive_session') {
      sessions.find(s => s.sessionId === args.session_id)!.isArchived = false
      return 'Restored.'
    }
    if (tool === 'archive_session') {
      if (String(args.session_id).startsWith('stuck')) throw new Error('needs your input')
      sessions.find(s => s.sessionId === args.session_id)!.isArchived = true
      return 'Archived.'
    }
    if (tool === 'move_sessions') {
      if ((args.session_ids as string[]).some(id => id.startsWith('routine'))) throw new Error('is a routine run')
      const section = sections.find(s => s.id === args.section_id)!
      for (const s of sessions) if ((args.session_ids as string[]).includes(s.sessionId)) s.group = { id: section.id, name: section.name }
      return 'Moved.'
    }
    throw new Error(`unexpected ${tool}`)
  }
  const manual = () => sections.filter(s => s.kind === 'manual').map(s => s.name)
  const groupOf = (id: string) => sessions.find(s => s.sessionId === id)!.group?.name ?? null
  const viewOf = (name: string) => sections.find(s => s.name === name)?.group_by
  const titleOf = (id: string) => sessions.find(s => s.sessionId === id)!.title
  const isHidden = (id: string) => sessions.find(s => s.sessionId === id)!.isArchived === true
  return { answer, manual, groupOf, isHidden, viewOf, titleOf, calls, listed, sessions, misfiled, quirks }
}

const FIRST_RUN_MS = 5_000
const PERIOD_MS = 5 * 60_000
const SETTLE_MS = 300

/** Starts a desktop session over the fake app with the mod loaded, and lets its first sync run. */
const start = async ($: any, on: any, app: ReturnType<typeof fakeApp>, data: Record<string, unknown> = {}, rival = false, seed: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map(Object.entries(data))
  const copy = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  on('store.get', (_: unknown, e: any) => ({ value: copy(store.get(e.key)) }))
  on('store.set', (_: unknown, e: any) => {
    store.set(e.key, copy(e.value))
    // Another session's copy takes the lock right after this one wrote its mark.
    if (rival && e.key === 'lock') store.set('lock', { owner: 'rival', until: NOW + DAY })
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('mcp.call', (_: unknown, e: any) => {
    try {
      return { value: { isError: false, content: [{ type: 'text', text: app.answer(e.tool, e.args) }] } }
    } catch (err) {
      return { value: { isError: true, content: [{ type: 'text', text: String(err) }] } }
    }
  })
  const files = new Map<string, string>(Object.entries(seed))
  on('fs.exists', (_: unknown, e: any) => ({ value: REPOS.has(e.path) || files.has(e.path) }))
  on('fs.read', (_: unknown, e: any) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_: unknown, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: COMMAND } }))
  await $.session.start({ cwd: '/Users/u/web-app', surface: 'desktop', isInteractive: true })
  // Each sync waits SETTLE_MS on its lock before it starts: every step lets that wait pass too.
  const advance = async (ms: number) => {
    await clock.advance(ms)
    await clock.advance(SETTLE_MS)
  }
  await advance(FIRST_RUN_MS)
  const log = () => (files.get('/Users/u/.claude/focus-sidebar.log') ?? '').split('\n').filter(Boolean)
  return { advance, store, log, file: (p: string) => files.get(p) }
}

const s = (id: string, cwd: string, days: number, extra: Partial<Session> = {}): Session => ({
  sessionId: id,
  cwd,
  lastActivityAt: ago(days),
  group: null,
  ...extra,
})

test('projectOf files repos, subfolders, worktrees and scratch', async () => {
  expect(await projectOf('/Users/u/web-app', exists)).toBe('web-app')
  expect(await projectOf('/Users/u/web-app/src/api', exists)).toBe('web-app')
  expect(await projectOf('/Users/u/web-app/.claude/worktrees/fix-1', exists)).toBe('web-app')
  expect(await projectOf('/Users/u/notes', exists)).toBe('notes')
  expect(await projectOf('/Users/u/Library/Application Support/Claude/scratch-workspaces/a/b', exists)).toBe(SCRATCH)
})

test('plan hides folders left out of a working day, whole folders only', async () => {
  const rows = [
    { ...s('a', '', 0), project: 'web-app' },
    { ...s('b', '', 5), project: 'web-app' },
    { ...s('c', '', 0.5), project: 'api-server' },
    { ...s('d', '', 2), project: 'old' },
    { ...s('e', '', 3), project: 'pinned-one', pinned: true },
    { ...s('f', '', 3), project: 'running', isRunning: true },
  ]
  const { slots, hide } = plan(rows, new Set(), NOW, new Set(), new Set(), [dayOf(NOW - DAY)])
  expect(slots.map(x => x.name)).toEqual([`${HOT} web-app`, 'api-server', 'running'])
  expect(slots[0].sessionIds).toEqual(['a', 'b'])
  expect(hide).toEqual(['d'])
})

test('each no-folder session is judged on its own', async () => {
  const rows = [
    { ...s('fresh', '/s/1', 0.2), project: SCRATCH },
    { ...s('stale', '/s/2', 3), project: SCRATCH },
  ]
  const { slots, hide } = plan(rows, new Set(), NOW, new Set(), new Set(), [dayOf(NOW - DAY)])
  expect(slots).toEqual([{ name: SCRATCH, sessionIds: ['fresh'], groupBy: 'none' }])
  expect(hide).toEqual(['stale'])
})

test('a frequently used project outranks one touched once a bit later', async () => {
  const rows = [
    { ...s('a', '', 0.4), project: 'daily' },
    { ...s('b', '', 0.5), project: 'daily' },
    { ...s('c', '', 0.6), project: 'daily' },
    { ...s('d', '', 0.2), project: 'once' },
  ]
  expect(plan(rows, new Set(), NOW).slots.map(x => x.name)).toEqual(['daily', 'once'])
})

test('sync files sessions, then re-ranks by renaming slots in place', async ($, on) => {
  const app = fakeApp(
    [
      s('self', '/Users/u/web-app', 0),
      s('k2', '/Users/u/web-app/src', 0.1),
      s('an', '/Users/u/api-server', 2),
      s('scr', '/Users/u/Library/Application Support/Claude/scratch-workspaces/x/y', 0.5),
      s('old', '/Users/u/old', 15),
      s('pin', '/Users/u/api-server', 0, { pinned: true }),
      s('mine', '/Users/u/api-server', 0, { group: { id: 'cg-user', name: 'Study' } }),
      s('nested', '/Users/u/web-app', 0, { startedBy: 'self' }),
      s('orphan-fork', '/Users/u/web-app', 0, { startedBy: 'gone' }),
    ],
    [{ id: 'cg-user', kind: 'manual', name: 'Study' }],
  )
  const clock = await start($, on, app)

  expect(app.manual()).toEqual(['Study', `${HOT} web-app`, `${HOT} api-server`, SCRATCH])
  expect(app.groupOf('self')).toBe(`${HOT} web-app`)
  expect(app.groupOf('k2')).toBe(`${HOT} web-app`)
  expect(app.isHidden('old')).toBe(true)
  expect(app.groupOf('pin')).toBe(null)
  expect(app.groupOf('mine')).toBe('Study')
  expect(app.groupOf('nested')).toBe(null)
  expect(app.groupOf('orphan-fork')).toBe(`${HOT} web-app`)

  // api-server is the one worked in last: on the next tick it climbs to the top slot. A swap parks one
  // folder in a section of its own name for a moment; none is left behind.
  const later = new Date(NOW + 3 * 60_000).toISOString()
  for (const id of ['an', 'pin', 'mine']) app.sessions.find(x => x.sessionId === id)!.lastActivityAt = later
  app.sessions.push(s('an2', '/Users/u/api-server', 0), s('an3', '/Users/u/api-server', 0))
  const created = app.calls.filter(c => c === 'create_section').length
  await clock.advance(PERIOD_MS)
  expect(app.manual()).toEqual(['Study', `${HOT} api-server`, `${HOT} web-app`, SCRATCH])
  expect(app.calls.filter(c => c === 'create_section').length).toBe(created + 1)
  expect(app.misfiled).toEqual([])
  expect(app.groupOf('an')).toBe(`${HOT} api-server`)
  expect(app.groupOf('self')).toBe(`${HOT} web-app`)
  expect(app.groupOf('mine')).toBe('Study')
})

test('a session list too long for one tool result still gets read: sections whole, the rest newest first', async ($, on) => {
  const web = (n: number) => Array.from({ length: n }, (_, i) => s(`w${i}`, '/Users/u/web-app', 0.1 + i / 100))
  const api = (n: number) => Array.from({ length: n }, (_, i) => s(`a${i}`, '/Users/u/api-server', 0.2 + i / 100))
  const app = fakeApp([s('self', '/Users/u/web-app', 0), ...web(4), ...api(4)])
  const clock = await start($, on, app)
  const slots = app.manual()
  expect(slots).toHaveLength(2)

  // The listing has outgrown what one tool result may carry; a new session starts in api-server.
  app.quirks.listCap = 4
  app.sessions.push(s('fresh', '/Users/u/api-server', 0, { lastActivityAt: new Date(NOW + 60_000).toISOString() }))
  await clock.advance(PERIOD_MS)

  expect(app.groupOf('fresh')).toBe(`${HOT} api-server`)
  expect(app.manual()).toHaveLength(slots.length)
  expect(app.misfiled).toEqual([])
  expect(app.isHidden('w0')).toBe(false)
  // Only sections of the user's own kind are asked about, once each.
  expect(app.listed.sort()).toEqual(['cg-1', 'cg-2'])
})

test('a folder idle for days is still hidden when the session list is too long for one tool result', async ($, on) => {
  const old = (n: number) => Array.from({ length: n }, (_, i) => s(`o${i}`, '/Users/u/old', 0.3 + i / 100))
  const web = (n: number) => Array.from({ length: n }, (_, i) => s(`w${i}`, '/Users/u/web-app', 0.1 + i / 100))
  // A working day (2 days ago) lies between the old folder's last session and today.
  const app = fakeApp([s('self', '/Users/u/web-app', 0), ...web(4), s('wd', '/Users/u/web-app', 2), ...old(2)])
  const clock = await start($, on, app)
  expect(app.isHidden('o0')).toBe(false)

  // Their last activity turns out to be long ago, older than the 4 newest sessions the listing can hold.
  for (const x of app.sessions.filter(x => x.cwd.endsWith('/old'))) x.lastActivityAt = ago(15)
  app.quirks.listCap = 5
  await clock.advance(PERIOD_MS)

  expect(app.isHidden('o0')).toBe(true)
  expect(app.isHidden('o1')).toBe(true)
  expect(app.isHidden('w0')).toBe(false)
})

test('a listing too long even for one session stops the sync after a few tries, leaving the sidebar alone', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('k2', '/Users/u/web-app', 0.1)])
  const clock = await start($, on, app)
  const before = [app.manual(), app.groupOf('k2')]

  app.quirks.listCap = -1
  app.sessions.push(s('fresh', '/Users/u/web-app', 0))
  const asked = app.calls.filter(c => c === 'list_sessions').length
  await clock.advance(PERIOD_MS)

  // 300, 150, 75, 37, 18, 9, 4, 2, 1
  expect(app.calls.filter(c => c === 'list_sessions').length).toBe(asked + 9)
  expect([app.manual(), app.groupOf('k2')]).toEqual(before)
  expect(app.groupOf('fresh')).toBe(null)
})

test('the log says which copy synced, why, and how it ended; a repeat of the same outcome is written once', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('k2', '/Users/u/web-app', 0.1)])
  const clock = await start($, on, app)
  await clock.advance(PERIOD_MS)
  await clock.advance(PERIOD_MS)

  const lines = clock.log()
  expect(lines[0]).toMatch(new RegExp(`^\\S+ \\[\\w+ start\\] loaded ${VERSION.replace(/\./g, '\\.')}, desktop, /Users/u/web-app$`))
  const orders = lines.filter(l => l.includes('order:'))
  // The first sync filed sessions (moved 2); the first tick found nothing to do; the second tick repeats it.
  expect(orders.map(l => l.match(/\[\w{5} (\w+)\]/)![1])).toEqual(['first', 'tick'])
})

test('a refused listing is logged with the reason once, however many wake-ups of any kind meet it', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('k2', '/Users/u/web-app', 0.1)])
  app.quirks.listRefused = true
  const clock = await start($, on, app)
  await clock.advance(PERIOD_MS)
  await clock.advance(PERIOD_MS)

  const refused = clock.log().filter(l => l.includes('Session state unavailable'))
  expect(refused.map(l => l.match(/\[\w{5} (\w+)\]/)![1])).toEqual(['first'])
  expect(app.groupOf('k2')).toBe(null)
})

test('a sync that stands aside says so in the log', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0)])
  const clock = await start($, on, app, { version: '9.0.0' })
  expect(clock.log().some(l => l.includes(' outdated'))).toBe(true)
})

test('a copy installed from elsewhere stands aside for a newer one', async ($, on) => {
  // Each install source has a store of its own: only the shared file tells copies apart.
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('o', '/Users/u/api-server', 0)])
  const clock = await start($, on, app, {}, false, { '/Users/u/.claude/focus-sidebar.version': '9.0.0' })
  expect(clock.log().some(l => l.includes(' outdated'))).toBe(true)
  expect(app.manual()).toEqual([])
})

test('a copy marks its version where copies from other installs see it', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0)])
  const clock = await start($, on, app)
  expect(clock.file('/Users/u/.claude/focus-sidebar.version')).toBe(VERSION)
})

test('slots no longer needed are removed', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('o', '/Users/u/old', 0)])
  const clock = await start($, on, app)
  expect(app.manual()).toEqual([`${HOT} web-app`, `${HOT} old`])

  app.sessions[1].isArchived = true
  await clock.advance(PERIOD_MS)
  expect(app.manual()).toEqual([`${HOT} web-app`])
  expect(app.groupOf('self')).toBe(`${HOT} web-app`)
})

test('a routine run the sidebar refuses does not block the rest, and is not retried', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('routine-1', '/Users/u/web-app', 0), s('k2', '/Users/u/web-app', 0)])
  const clock = await start($, on, app)
  expect(app.groupOf('self')).toBe(`${HOT} web-app`)
  expect(app.groupOf('k2')).toBe(`${HOT} web-app`)
  expect(app.groupOf('routine-1')).toBe(null)

  const moves = app.calls.filter(c => c === 'move_sessions').length
  await clock.advance(PERIOD_MS)
  expect(app.calls.filter(c => c === 'move_sessions').length).toBe(moves)
})

test('an idle folder the app will not archive goes to the archive slot', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('yday', '/Users/u/web-app', 1), s('stuck-1', '/Users/u/old', 3), s('o2', '/Users/u/api-server', 3)])
  const clock = await start($, on, app)
  expect(app.isHidden('o2')).toBe(true)
  expect(app.isHidden('stuck-1')).toBe(false)

  await clock.advance(PERIOD_MS)
  expect(app.manual()).toEqual([`${HOT} web-app`, ARCHIVE])
  expect(app.groupOf('stuck-1')).toBe(ARCHIVE)
})

test('the session running the mod is never hidden', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/old', 3)])
  await start($, on, app)
  expect(app.isHidden('self')).toBe(false)
})

test('/show-folder lists hidden folders and brings one back for a day', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('yday', '/Users/u/web-app', 1), s('o1', '/Users/u/old', 3), s('o2', '/Users/u/old', 4)])
  const clock = await start($, on, app)
  expect(app.isHidden('o1')).toBe(true)
  expect(app.manual()).toEqual([`${HOT} web-app`])

  const list = await $.command.run({ command: COMMAND, args: '' })
  expect(String((list as any).text)).toContain('- old')

  const running = $.command.run({ command: COMMAND, args: 'ol' })
  await clock.advance(0)
  const back = await running
  expect(String((back as any).text)).toContain('2 sessions')
  expect(app.isHidden('o1')).toBe(false)
  expect(app.manual()).toEqual([`${HOT} web-app`, 'old'])

  // Still shown a while later, hidden again once the grace day is over with no activity.
  await clock.advance(PERIOD_MS)
  expect(app.isHidden('o1')).toBe(false)
  await clock.advance(DAY)
  expect(app.isHidden('o1')).toBe(true)
})

test('an idle routine run is never hidden', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('yday', '/Users/u/web-app', 1), s('routine-9', '/Users/u/old', 3), s('o', '/Users/u/old', 3)])
  await start($, on, app)
  expect(app.isHidden('routine-9')).toBe(false)
  expect(app.isHidden('o')).toBe(true)
})

test('variant D: hot folders get 🔥, no section is split into state or day subheadings, titles get their last activity time', async ($, on) => {
  const app = fakeApp([
    { ...s('self', '/Users/u/web-app', 0), title: 'Fix checkout flow' },
    { ...s('w2', '/Users/u/web-app', 0.5), title: 'Write release notes · Oct 22, 09:15' },
    { ...s('scr', '/Users/u/Library/Application Support/Claude/scratch-workspaces/a/b', 0.2), title: 'Draft a short email' },
    { ...s('w3', '/Users/u/web-app', 0.6), title: 'Bump dependencies' },
    { ...s('scr3', '/Users/u/Library/Application Support/Claude/scratch-workspaces/a/c', 0.3), title: 'Plan the week' },
    { ...s('scr2', '/Users/u/Library/Application Support/Claude/scratch-workspaces/a/d', 0.4), title: 'Explain an error' },
    { ...s('cold', '/Users/u/docs-site', 0.3), title: 'Profile slow page' },
  ])
  await start($, on, app)
  expect(app.manual()).toEqual([`${HOT} web-app`, SCRATCH, 'docs-site'])
  expect(app.viewOf(`${HOT} web-app`)).toBe('none')
  expect(app.viewOf(SCRATCH)).toBe('none')
  expect(app.viewOf('docs-site')).toBe('none')
  expect(app.titleOf('self')).toBe(`${WAITING} Fix checkout flow · ${stampOf(ago(0))}`)
  expect(app.titleOf('w2')).toBe(`${WAITING} Write release notes · ${stampOf(ago(0.5))}`)
})

test('stamps read in local time and replace an older stamp', async () => {
  expect(stampOf('2026-01-05T09:07:00')).toBe('Jan 5, 09:07')
  expect(restamp('Fix bug', '2026-01-05T09:07:00')).toBe(`${WAITING} Fix bug · Jan 5, 09:07`)
  expect(restamp('Fix bug · Jan 4, 18:00', '2026-01-05T09:07:00')).toBe(`${WAITING} Fix bug · Jan 5, 09:07`)
  expect(restamp(`${WAITING} Fix bug · Jan 5, 09:07`, '2026-01-05T09:07:00', true)).toBe(`${WORKING} Fix bug · Jan 5, 09:07`)
  expect(restamp(`${WORKING} Fix bug · Jan 5, 09:07`, '2026-01-05T09:07:00')).toBe(`${WAITING} Fix bug · Jan 5, 09:07`)
})

test('a session that comes back to life gets a fresh stamp', async ($, on) => {
  const app = fakeApp([{ ...s('self', '/Users/u/web-app', 0.1), title: 'Fix checkout flow' }])
  const clock = await start($, on, app)
  expect(app.titleOf('self')).toBe(`${WAITING} Fix checkout flow · ${stampOf(ago(0.1))}`)
  app.sessions[0].lastActivityAt = ago(0)
  await clock.advance(PERIOD_MS)
  expect(app.titleOf('self')).toBe(`${WAITING} Fix checkout flow · ${stampOf(ago(0))}`)
})

test('after days off nothing is hidden; a folder goes only once a working day passes without it', async () => {
  const friday = { ...s('fri', '', 3), project: 'web-app' }
  const monday = { ...s('mon', '', 0), project: 'api-server' }
  const weekend = plan([friday, monday], new Set(), NOW, new Set(), new Set(), [dayOf(NOW - 3 * DAY), dayOf(NOW)])
  expect(weekend.hide).toEqual([])

  const tuesday = plan([friday, monday], new Set(), NOW + DAY, new Set(), new Set(), [dayOf(NOW - 3 * DAY), dayOf(NOW)])
  expect(tuesday.hide).toEqual(['fri'])
})

test('folders worked in this hour come first, newest first, then the rest by heat', async () => {
  const rows = [
    ...[0.3, 0.35, 0.4, 0.45].map((d, i) => ({ ...s(`busy${i}`, '', d), project: 'busy' })),
    { ...s('a', '', 0.02), project: 'now-a' },
    { ...s('b', '', 0.01), project: 'now-b' },
  ]
  expect(plan(rows, new Set(), NOW).slots.map(x => x.name)).toEqual([`${HOT} now-b`, `${HOT} now-a`, 'busy'])
})

test('a new session in a hidden folder leaves its old sessions archived', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('yday', '/Users/u/web-app', 1), s('o1', '/Users/u/old', 3)])
  const clock = await start($, on, app)
  expect(app.isHidden('o1')).toBe(true)

  app.sessions.push(s('o-new', '/Users/u/old', 0))
  await clock.advance(PERIOD_MS)
  expect(app.isHidden('o1')).toBe(true)
  expect(app.groupOf('o-new')).toBe(`${HOT} old`)
})

test('a sync that finds another one running retries within seconds', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('an', '/Users/u/api-server', 0)])
  const clock = await start($, on, app, { lock: { owner: 'other', until: NOW + FIRST_RUN_MS + 10_000 } })
  expect(app.groupOf('an')).toBe(null)
  await clock.advance(12_000)
  expect(app.groupOf('an')).toBe(`${HOT} api-server`)
})

test('one section stored in two slots is split back into its own slots', async ($, on) => {
  const app = fakeApp(
    [s('self', '/Users/u/web-app', 0), s('an', '/Users/u/api-server', 0.01, { group: { id: 'cg-a', name: 'x' } })],
    [{ id: 'cg-a', kind: 'manual', name: 'x' }],
  )
  await start($, on, app, { slots: ['cg-a', 'cg-a'] })
  expect(app.groupOf('self')).not.toBe(app.groupOf('an'))
  expect(app.manual()).toEqual([`${HOT} web-app`, `${HOT} api-server`])
})

test('a re-rank never shows a session under another project, even mid-way', async ($, on) => {
  const app = fakeApp([
    s('self', '/Users/u/web-app', 0.01),
    s('an', '/Users/u/api-server', 0.02),
    s('o', '/Users/u/old', 0.03),
  ])
  const clock = await start($, on, app)
  expect(app.manual()).toEqual([`${HOT} web-app`, `${HOT} api-server`, `${HOT} old`])

  // A new folder takes the top: every slot shifts down one.
  app.sessions.push(s('n', '/Users/u/notes', 0))
  await clock.advance(PERIOD_MS)
  expect(app.manual()).toEqual([`${HOT} notes`, `${HOT} web-app`, `${HOT} api-server`, `${HOT} old`])

  // Two folders swap places.
  app.sessions.find(x => x.sessionId === 'o')!.lastActivityAt = new Date(NOW + PERIOD_MS).toISOString()
  app.sessions.find(x => x.sessionId === 'an')!.lastActivityAt = new Date(NOW + PERIOD_MS + 1).toISOString()
  await clock.advance(PERIOD_MS)
  expect(app.manual()).toEqual([`${HOT} api-server`, `${HOT} old`, `${HOT} notes`, `${HOT} web-app`])
  expect(app.groupOf('an')).toBe(`${HOT} api-server`)
  expect(app.groupOf('o')).toBe(`${HOT} old`)
  expect(app.groupOf('self')).toBe(`${HOT} web-app`)
  expect(app.misfiled).toEqual([])
})

test('two folders worked in side by side keep their places until one is 2 minutes newer', async () => {
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString()
  const rows = (a: number, b: number) => [
    { ...s('a', '', 0), lastActivityAt: at(a), project: 'a' },
    { ...s('b', '', 0), lastActivityAt: at(b), project: 'b' },
  ]
  const order = (a: number, b: number, prev: string[]) =>
    plan(rows(a, b), new Set(), NOW + 10 * 60_000, new Set(), new Set(), [], prev).slots.map(x => x.name)
  expect(order(1, 0, ['b', 'a'])).toEqual([`${HOT} b`, `${HOT} a`])
  expect(order(3, 0, ['b', 'a'])).toEqual([`${HOT} a`, `${HOT} b`])
  // A folder new to the list starts below and climbs the same way.
  expect(order(1, 0, ['b'])).toEqual([`${HOT} b`, `${HOT} a`])
  expect(order(3, 0, ['b'])).toEqual([`${HOT} a`, `${HOT} b`])
})

test('a copy older than one that already ran leaves the sidebar alone', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0)])
  await start($, on, app, { version: '99.0.0' })
  expect(app.manual()).toEqual([])
  expect(newer('0.6.10', '0.6.9')).toBe(true)
  expect(newer('0.6.5', '0.6.5')).toBe(false)
})

test('a sync records its version and holds the old lease so copies before 0.6.5 stay out', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0)])
  const { store } = await start($, on, app, { version: '0.6.4' })
  expect(store.get('version')).toBe(VERSION)
  expect(Number(store.get('leaseUntil'))).toBeGreaterThan(NOW + FIRST_RUN_MS)
  expect(store.get('lock')).toBe(undefined)
})

test('a section a crashed sync parked sessions in is emptied and removed next time', async ($, on) => {
  const app = fakeApp(
    [s('self', '/Users/u/web-app', 0), s('an', '/Users/u/api-server', 0.01, { group: { id: 'cg-p', name: `${HOT} api-server` } })],
    [{ id: 'cg-p', kind: 'manual', name: `${HOT} api-server` }],
  )
  const { store } = await start($, on, app, { parked: ['cg-p'] })
  expect(app.manual()).toEqual([`${HOT} web-app`, `${HOT} api-server`])
  expect(app.groupOf('an')).toBe(`${HOT} api-server`)
  expect(app.calls).toContain('delete_section')
  expect(store.get('parked')).toEqual([])
})

test('a section the mod made and lost track of gives its sessions back and is removed', async ($, on) => {
  const scratch = '/Users/u/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1'
  const app = fakeApp(
    [
      s('self', '/Users/u/web-app', 0),
      s('chat', scratch, 0.01, { group: { id: 'cg-lost', name: `${HOT} api-server​​` } }),
      s('an', '/Users/u/api-server', 0.01, { group: { id: 'cg-made', name: `${HOT} api-server` } }),
    ],
    [
      { id: 'cg-made', kind: 'manual', name: `${HOT} api-server` },
      { id: 'cg-lost', kind: 'manual', name: `${HOT} api-server​​` },
    ],
  )
  const { store } = await start($, on, app, { made: ['cg-made'] })
  expect(app.groupOf('chat')).toBe(SCRATCH)
  expect(app.groupOf('an')).toBe(`${HOT} api-server`)
  expect(app.manual()).toEqual([`${HOT} web-app`, `${HOT} api-server`, SCRATCH])
  expect([...(store.get('made') as string[])].sort()).toEqual([...(store.get('slots') as string[])].sort())
})

test('a section the user made by hand is left alone', async ($, on) => {
  const app = fakeApp(
    [s('self', '/Users/u/web-app', 0), s('an', '/Users/u/api-server', 0.01, { group: { id: 'cg-mine', name: 'Study' } })],
    [{ id: 'cg-mine', kind: 'manual', name: 'Study' }],
  )
  await start($, on, app)
  expect(app.groupOf('an')).toBe('Study')
  expect(app.manual()).toContain('Study')
})

test('a sidebar unlike what the sync made, twice running, pauses the mod for a day', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('an', '/Users/u/api-server', 0.01)])
  const clock = await start($, on, app)
  app.quirks.renameIgnored = true
  app.sessions.find(x => x.sessionId === 'an')!.lastActivityAt = new Date(NOW + 3 * 60_000).toISOString()
  await clock.advance(PERIOD_MS)
  expect(clock.store.get('paused')).toBe(undefined)
  await clock.advance(PERIOD_MS)
  expect(clock.store.get('paused') as object).toEqual(expect.objectContaining({ version: VERSION }))
  const calls = app.calls.length
  await clock.advance(PERIOD_MS)
  expect(app.calls.length).toBe(calls)
})

test('of two copies taking the lock at once, the one whose mark was overwritten backs off', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0)])
  const { store } = await start($, on, app, {}, true)
  expect(app.manual()).toEqual([])
  expect(store.get('lock')).toEqual({ owner: 'rival', until: NOW + DAY })
})

