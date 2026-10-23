import { expect, mock, test } from 'claude-code/testing'
import { ARCHIVE, COMMAND, HOT, SCRATCH, dayOf, plan, projectOf, restamp, stampOf, type Session } from '../hooks/register'

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
  const answer = (tool: string, args: Record<string, unknown>): string => {
    calls.push(tool)
    if (tool === 'list_sessions') {
      if (args.include_archived) throw new Error('result exceeds maximum allowed tokens')
      return JSON.stringify(sessions.slice(1).filter(s => !s.isArchived))
    }
    if (tool === 'get_session') {
      const one = args.session_id === 'self' ? sessions[0] : sessions.find(s => s.sessionId === args.session_id)!
      const detail = { ...one, createdAt: '2026-10-23T07:30:00Z' }
      return JSON.stringify(one.sessionId.startsWith('routine') ? { ...detail, scheduledTaskId: 'daily' } : detail)
    }
    if (tool === 'list_sections') return JSON.stringify(sections)
    if (tool === 'create_section') {
      const s = { id: `cg-${++n}`, kind: 'manual', name: String(args.name) }
      sections.splice(sections.length - 1, 0, s)
      return JSON.stringify(s)
    }
    if (tool === 'rename_section') {
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
  return { answer, manual, groupOf, isHidden, viewOf, titleOf, calls, sessions }
}

const FIRST_RUN_MS = 5_000
const PERIOD_MS = 5 * 60_000

/** Starts a desktop session over the fake app with the mod loaded, and lets its first sync run. */
const start = async ($: any, on: any, app: ReturnType<typeof fakeApp>) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('mcp.call', (_: unknown, e: any) => {
    try {
      return { value: { isError: false, content: [{ type: 'text', text: app.answer(e.tool, e.args) }] } }
    } catch (err) {
      return { value: { isError: true, content: [{ type: 'text', text: String(err) }] } }
    }
  })
  on('fs.exists', (_: unknown, e: any) => ({ value: REPOS.has(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: COMMAND } }))
  await $.session.start({ cwd: '/Users/u/web-app', surface: 'desktop', isInteractive: true })
  await clock.advance(FIRST_RUN_MS)
  return clock
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

  // api-server is the one worked in last: on the next tick it climbs to the top slot, no section created.
  const later = new Date(NOW + 60_000).toISOString()
  for (const id of ['an', 'pin', 'mine']) app.sessions.find(x => x.sessionId === id)!.lastActivityAt = later
  app.sessions.push(s('an2', '/Users/u/api-server', 0), s('an3', '/Users/u/api-server', 0))
  const created = app.calls.filter(c => c === 'create_section').length
  await clock.advance(PERIOD_MS)
  expect(app.manual()).toEqual(['Study', `${HOT} api-server`, `${HOT} web-app`, SCRATCH])
  expect(app.calls.filter(c => c === 'create_section').length).toBe(created)
  expect(app.groupOf('an')).toBe(`${HOT} api-server`)
  expect(app.groupOf('self')).toBe(`${HOT} web-app`)
  expect(app.groupOf('mine')).toBe('Study')
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

  const back = await $.command.run({ command: COMMAND, args: 'ol' })
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

test('variant D: hot folders get 🔥, sections of 3+ group by state (no-folder by day), small ones stay plain, titles get their last activity time', async ($, on) => {
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
  expect(app.viewOf(`${HOT} web-app`)).toBe('state')
  expect(app.viewOf(SCRATCH)).toBe('date')
  expect(app.viewOf('docs-site')).toBe('none')
  expect(app.titleOf('self')).toBe(`Fix checkout flow · ${stampOf(ago(0))}`)
  expect(app.titleOf('w2')).toBe(`Write release notes · ${stampOf(ago(0.5))}`)
})

test('stamps read in local time and replace an older stamp', async () => {
  expect(stampOf('2026-01-05T09:07:00')).toBe('Jan 5, 09:07')
  expect(restamp('Fix bug', '2026-01-05T09:07:00')).toBe('Fix bug · Jan 5, 09:07')
  expect(restamp('Fix bug · Jan 4, 18:00', '2026-01-05T09:07:00')).toBe('Fix bug · Jan 5, 09:07')
  expect(restamp('Fix bug · Jan 5, 09:07', '2026-01-05T09:07:00')).toBe('Fix bug · Jan 5, 09:07')
})

test('a session that comes back to life gets a fresh stamp', async ($, on) => {
  const app = fakeApp([{ ...s('self', '/Users/u/web-app', 0.1), title: 'Fix checkout flow' }])
  const clock = await start($, on, app)
  expect(app.titleOf('self')).toBe(`Fix checkout flow · ${stampOf(ago(0.1))}`)
  app.sessions[0].lastActivityAt = ago(0)
  await clock.advance(PERIOD_MS)
  expect(app.titleOf('self')).toBe(`Fix checkout flow · ${stampOf(ago(0))}`)
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

test('working in a hidden folder again brings its other sessions back', async ($, on) => {
  const app = fakeApp([s('self', '/Users/u/web-app', 0), s('yday', '/Users/u/web-app', 1), s('o1', '/Users/u/old', 3)])
  const clock = await start($, on, app)
  expect(app.isHidden('o1')).toBe(true)

  app.sessions.push(s('o-new', '/Users/u/old', 0))
  await clock.advance(PERIOD_MS)
  expect(app.isHidden('o1')).toBe(false)
  await clock.advance(PERIOD_MS)
  expect(app.groupOf('o1')).toBe(app.groupOf('o-new'))
})
