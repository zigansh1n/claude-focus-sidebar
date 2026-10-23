import type { EngineInterface, Register } from 'claude-code'

// The sidebar has no "reorder sections" call, but a renamed section keeps its
// place and a new one lands after the other custom sections. So the mod owns a
// fixed run of "slot" sections and renames them by rank instead of moving them.

const SIDEBAR = 'ccd_sidebar'
const SESSIONS = 'ccd_session_mgmt'
const DAY = 86_400_000
// A folder left out of this many of your working days is hidden: its sessions are archived
// (/show-folder brings them back). Days you did not work at all do not count, so a weekend hides nothing.
const HIDE_AFTER_DAYS = 1
// Working days remembered, enough to measure any folder still visible.
const WORK_DAYS_KEPT = 60
const HEAT_DAYS = 14
const HALF_LIFE_DAYS = 3
const FIRST_RUN_MS = 5_000
const AFTER_TURN_MS = 2_000
const PERIOD_MS = 5 * 60_000
// Every open session runs this mod; the lease keeps them from syncing at once.
const LEASE_MS = 45_000
const MOVE_BATCH = 100
// Archived sessions are left out of the listing: with them it outgrows what a tool result may carry.
const LIST_LIMIT = 300
// A folder worked in this recently gets 🔥 in its section name.
const HOT_MS = 60 * 60_000
// Titles stamped per sync, so a first run over many sessions stays short.
const STAMP_BATCH = 20
// Below this many sessions a section's own subheadings cost more room than they save.
const GROUP_MIN = 3

export const ARCHIVE = '🧊 Archive'
export const SCRATCH = '💬 No folder'
export const HOME = '🏠 Home'
export const COMMAND = 'show-folder'
export const HOT = '🔥'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type Session = {
  sessionId: string
  title?: string
  cwd: string
  lastActivityAt: string
  isArchived?: boolean
  pinned?: boolean
  isRunning?: boolean
  startedBy?: string
  // Absent while the app has not reported groups yet: unknown, not ungrouped.
  group?: { id: string; name: string } | null
}

type Row = Session & { project: string }
// Inside a section the app itself groups rows: by state (needs input, running, done) or by day.
export type Slot = { name: string; sessionIds: string[]; groupBy: 'state' | 'date' | 'none' }
export type Plan = { slots: Slot[]; hide: string[] }
/** A hidden folder, by the label /show-folder lists it under. */
export type Hidden = Record<string, { folder: string; ids: string[] }>

type Section = { id: string; kind: string; name: string; group_by?: string }
type Result = { isError: boolean; content: { type: string; text?: string }[] }

const textOf = (r: Result) => r.content.map(b => b.text ?? '').join('')

export const homeOf = (path: string): string | null => path.match(/^\/(?:Users|home)\/[^/]+/)?.[0] ?? null

/** The project a session in `cwd` belongs to: its git repo root's name, else the folder's. */
export const projectOf = async (cwd: string, exists: (p: string) => Promise<boolean>): Promise<string> => {
  if (!cwd || cwd.includes('/scratch-workspaces/') || /^\/(private\/)?tmp(\/|$)/.test(cwd)) return SCRATCH

  let dir = cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '').replace(/\/+$/, '')
  const home = homeOf(dir)
  if (dir === home) return HOME

  for (let q = dir; q.length > (home ?? '').length && q.includes('/'); q = q.slice(0, q.lastIndexOf('/'))) {
    if (await exists(`${q}/.git`)) {
      dir = q
      break
    }
  }
  return dir.slice(dir.lastIndexOf('/') + 1) || dir
}

/** What is hidden as one: a project, or a single no-folder session's own scratch folder. */
export const folderOf = (s: Row) => (s.project === SCRATCH ? `${SCRATCH}:${s.cwd}` : s.project)

const labelOf = (s: Row) => (s.project === SCRATCH ? `💬 ${s.title ?? s.sessionId}` : s.project)

/** A session the mod may file: in the sidebar, not pinned or nested, and not filed by hand elsewhere. */
export const isMovable = (s: Session, owned: ReadonlySet<string>) =>
  !s.isArchived && !s.pinned && !s.startedBy && s.group !== undefined && (s.group === null || owned.has(s.group.id))

/** The local calendar day of a moment, `2026-10-23`. */
export const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The slots top to bottom and the sessions to hide. Folders worked in during the
 * last hour come first, newest first, marked 🔥; the rest follow by heat (recent
 * sessions weigh more). A folder is hidden once HIDE_AFTER_DAYS of your finished
 * working days (`workDays`, today excluded) went by without it. Folders in
 * `shown` were just brought back and stay. Idle sessions the app would not
 * archive (`kept`) go to the archive slot instead.
 */
export const plan = (
  sessions: Row[],
  owned: ReadonlySet<string>,
  now: number,
  kept: ReadonlySet<string> = new Set(),
  shown: ReadonlySet<string> = new Set(),
  workDays: readonly string[] = sessions.map(s => dayOf(Date.parse(s.lastActivityAt) || 0)),
): Plan => {
  const lastByFolder = new Map<string, number>()
  for (const s of sessions) {
    const at = Date.parse(s.lastActivityAt) || 0
    lastByFolder.set(folderOf(s), Math.max(lastByFolder.get(folderOf(s)) ?? 0, at))
  }
  const today = dayOf(now)
  const days = [...new Set(workDays)]
  const missedDays = (last: number) => days.filter(d => d > dayOf(last) && d < today).length
  const isIdle = (s: Row) =>
    !s.isRunning && !shown.has(folderOf(s)) && missedDays(lastByFolder.get(folderOf(s)) ?? 0) >= HIDE_AFTER_DAYS

  const projects = new Map<string, { heat: number; last: number; ids: string[] }>()
  const hide: string[] = []
  const archived: string[] = []
  for (const s of sessions) {
    const at = Date.parse(s.lastActivityAt) || 0
    const p = projects.get(s.project) ?? { heat: 0, last: 0, ids: [] }
    const ageDays = (now - at) / DAY
    if (ageDays <= HEAT_DAYS) p.heat += 0.5 ** (Math.max(ageDays, 0) / HALF_LIFE_DAYS)
    p.last = Math.max(p.last, at)
    if (isMovable(s, owned)) {
      if (!isIdle(s)) p.ids.push(s.sessionId)
      else if (kept.has(s.sessionId)) archived.push(s.sessionId)
      else hide.push(s.sessionId)
    }
    projects.set(s.project, p)
  }

  const isHot = (name: string, last: number) => name !== SCRATCH && now - last < HOT_MS
  const slots: Slot[] = [...projects]
    .filter(([, p]) => p.ids.length > 0)
    .sort(([an, a], [bn, b]) => {
      const ah = isHot(an, a.last)
      const bh = isHot(bn, b.last)
      if (ah !== bh) return ah ? -1 : 1
      return ah ? b.last - a.last : b.heat - a.heat || b.last - a.last
    })
    .map(([name, p]) => ({
      name: isHot(name, p.last) ? `${HOT} ${name}` : name,
      sessionIds: p.ids,
      groupBy: p.ids.length < GROUP_MIN ? 'none' : name === SCRATCH ? 'date' : 'state',
    }))
  if (archived.length > 0) {
    slots.push({ name: ARCHIVE, sessionIds: archived, groupBy: archived.length < GROUP_MIN ? 'none' : 'date' })
  }
  return { slots, hide }
}

/** `Oct 23, 10:30` in the machine's own time zone. */
export const stampOf = (iso: string): string => {
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hm}`
}

const STAMP = / · [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/

/** The title with its trailing stamp replaced by the session's last activity. */
export const restamp = (title: string, lastActivityAt: string) => `${title.replace(STAMP, '')} · ${stampOf(lastActivityAt)}`

let logFile: string | null = null

/** Brings the sidebar in line with the plan; resolves what it did, for the log. */
export async function sync($: EngineInterface): Promise<string> {
  const log = async (line: string) => {
    if (!logFile) return
    try {
      // Background processes without the sidebar fail the same way every tick: keep one line per change.
      if ((await $.store.get('lastLog')) === line) return
      await $.store.set('lastLog', line)
      const prev = (await $.fs.exists(logFile)) ? await $.fs.read(logFile) : ''
      await $.fs.write(logFile, (prev + `${new Date().toISOString()} ${line}\n`).slice(-20000))
    } catch {}
  }
  const call = async (server: string, tool: string, args: Record<string, unknown>) => {
    const r = (await $.mcp.call(server, tool, args)) as Result
    if (r.isError) throw new Error(`${tool}: ${textOf(r)}`)
    return textOf(r)
  }
  const json = async (server: string, tool: string, args: Record<string, unknown>) => {
    const text = await call(server, tool, args)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`${tool}: ${text.slice(0, 160)}`)
    }
  }

  try {
    const now = await $.clock.now()
    if (Number((await $.store.get('leaseUntil')) ?? 0) > now) return 'leased'
    await $.store.set('leaseUntil', now + LEASE_MS)

    const others = (await json(SESSIONS, 'list_sessions', { limit: LIST_LIMIT })) as Session[]
    const self = (await json(SESSIONS, 'get_session', { session_id: 'self' })) as Session
    const all = [self, ...others.filter(s => s.sessionId !== self.sessionId)]

    const cache = new Map<string, Promise<string>>()
    const rows: Row[] = await Promise.all(
      all.map(async s => {
        if (!cache.has(s.cwd)) cache.set(s.cwd, projectOf(s.cwd, p => $.fs.exists(p)))
        return { ...s, project: await cache.get(s.cwd)! }
      }),
    )

    const sections = (await json(SIDEBAR, 'list_sections', {})) as Section[]
    const byId = new Map(sections.filter(s => s.kind === 'manual').map(s => [s.id, s]))
    const owned = (((await $.store.get('slots')) as string[] | undefined) ?? []).filter(id => byId.has(id))
    // Routine runs look like any other session in the list, yet the sidebar refuses to file them.
    const refused = new Set(((await $.store.get('refused')) as string[] | undefined) ?? [])
    const kept = new Set(((await $.store.get('kept')) as string[] | undefined) ?? [])
    const shownUntil = ((await $.store.get('shownUntil')) as Record<string, number> | undefined) ?? {}
    const shown = new Set(Object.keys(shownUntil).filter(f => shownUntil[f] > now))
    const seenDays = rows.map(s => dayOf(Date.parse(s.lastActivityAt) || 0))
    const workDays = [...new Set([...(((await $.store.get('workDays')) as string[] | undefined) ?? []), ...seenDays])]
      .sort()
      .slice(-WORK_DAYS_KEPT)
    await $.store.set('workDays', workDays)
    const { slots, hide } = plan(
      rows.filter(s => !refused.has(s.sessionId)),
      new Set(owned),
      now,
      kept,
      shown,
      workDays,
    )

    const hiddenFolders = ((await $.store.get('hidden')) as Hidden | undefined) ?? {}
    const byIdRow = new Map(rows.map(s => [s.sessionId, s]))
    let hidden = 0
    for (const id of hide.filter(id => id !== self.sessionId)) {
      try {
        // A routine's runs belong to the routine: leave its history as the app keeps it.
        const detail = (await json(SESSIONS, 'get_session', { session_id: id })) as { scheduledTaskId?: string }
        if (detail.scheduledTaskId) {
          refused.add(id)
          await $.store.set('refused', [...refused])
          continue
        }
        await call(SESSIONS, 'archive_session', { session_id: id, reason: `folder idle ${HIDE_AFTER_DAYS}+ day` })
        const row = byIdRow.get(id)!
        const entry = hiddenFolders[labelOf(row)] ?? { folder: folderOf(row), ids: [] }
        if (!entry.ids.includes(id)) entry.ids.push(id)
        hiddenFolders[labelOf(row)] = entry
        hidden++
      } catch {
        kept.add(id)
      }
    }
    // Working in a hidden folder again brings its other sessions back with it.
    const liveFolders = new Set(slots.flatMap(slot => slot.sessionIds).map(id => folderOf(byIdRow.get(id)!)))
    let restored = 0
    for (const [label, entry] of Object.entries(hiddenFolders)) {
      if (!liveFolders.has(entry.folder)) continue
      for (const id of entry.ids) {
        const r = (await $.mcp.call(SESSIONS, 'unarchive_session', { session_id: id })) as Result
        if (!r.isError) restored++
      }
      delete hiddenFolders[label]
      await $.store.set('leaseUntil', 0)
    }
    if (hidden > 0 || restored > 0) await $.store.set('hidden', hiddenFolders)
    if (hidden < hide.length) await $.store.set('kept', [...kept])

    while (owned.length < slots.length) {
      const made = (await json(SIDEBAR, 'create_section', { name: slots[owned.length].name })) as Section
      owned.push(made.id)
      byId.set(made.id, made)
    }
    await $.store.set('slots', owned)

    let renamed = 0
    let moved = 0
    for (const [i, slot] of slots.entries()) {
      if (byId.get(owned[i])?.name !== slot.name) {
        await call(SIDEBAR, 'rename_section', { section_id: owned[i], name: slot.name })
        renamed++
      }
      const toMove = slot.sessionIds.filter(id => byIdRow.get(id)?.group?.id !== owned[i])
      for (let k = 0; k < toMove.length; k += MOVE_BATCH) {
        const batch = toMove.slice(k, k + MOVE_BATCH)
        try {
          await call(SIDEBAR, 'move_sessions', { session_ids: batch, section_id: owned[i] })
          moved += batch.length
        } catch {
          // One refused id fails the whole batch: retry one by one and remember the refusals.
          for (const id of batch) {
            try {
              await call(SIDEBAR, 'move_sessions', { session_ids: [id], section_id: owned[i] })
              moved++
            } catch {
              refused.add(id)
            }
          }
          await $.store.set('refused', [...refused])
        }
      }
    }

    for (const [i, slot] of slots.entries()) {
      if (byId.get(owned[i])?.group_by !== slot.groupBy) {
        await call(SIDEBAR, 'set_view', { section_id: owned[i], group_by: slot.groupBy, sort_by: 'recency' })
      }
    }

    // Renaming does not count as activity, so the stamp settles once the session goes quiet.
    // The app regenerates a title after the first exchange; a lost stamp is simply added again.
    let stamped = 0
    const stale = slots
      .flatMap(slot => slot.sessionIds)
      .map(id => byIdRow.get(id)!)
      .filter(s => s.title && restamp(s.title, s.lastActivityAt) !== s.title)
      .slice(0, STAMP_BATCH)
    for (const s of stale) {
      try {
        await call(SESSIONS, 'set_session_title', { session_id: s.sessionId, title: restamp(s.title!, s.lastActivityAt) })
        stamped++
      } catch {}
    }

    const extra = owned.splice(slots.length)
    for (const id of extra) await call(SIDEBAR, 'delete_section', { section_id: id })
    await $.store.set('slots', owned)

    const line = `order: ${slots.map(s => s.name).join(' | ')}; renamed ${renamed}, moved ${moved}, removed ${extra.length}, hidden ${hidden}, restored ${restored}, stamped ${stamped}`
    if (renamed || moved || extra.length || hidden || restored || stamped) await log(line)
    return line
  } catch (err) {
    const line = `skipped: ${String(err).slice(0, 300)}`
    await log(line)
    return line
  }
}

/** /show-folder: lists the hidden folders, or brings back the ones matching `query` for a day. */
export async function showFolder($: EngineInterface, query: string): Promise<string> {
  const hiddenFolders = ((await $.store.get('hidden')) as Hidden | undefined) ?? {}
  const labels = Object.keys(hiddenFolders)
  const q = query.trim().toLowerCase()
  if (!q) {
    return labels.length === 0
      ? 'No hidden folders.'
      : `Hidden folders:\n${labels.map(l => `- ${l}`).join('\n')}\n\nBring one back: /${COMMAND} <name>`
  }

  const matched = labels.filter(l => l.toLowerCase().includes(q))
  if (matched.length === 0) return `No hidden folder matches "${query.trim()}". List them: /${COMMAND}`

  const now = await $.clock.now()
  const shownUntil = ((await $.store.get('shownUntil')) as Record<string, number> | undefined) ?? {}
  let back = 0
  for (const label of matched) {
    const { folder, ids } = hiddenFolders[label]
    for (const id of ids) {
      const r = (await $.mcp.call(SESSIONS, 'unarchive_session', { session_id: id })) as Result
      if (!r.isError) back++
    }
    shownUntil[folder] = now + HIDE_AFTER_DAYS * DAY
    delete hiddenFolders[label]
  }
  await $.store.set('shownUntil', shownUntil)
  await $.store.set('hidden', hiddenFolders)
  await $.store.set('leaseUntil', 0)
  await sync($)
  return `Back in the sidebar: ${matched.join(', ')} (${back} sessions). It hides again after a working day without it.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = homeOf(e.cwd)
    logFile = home ? `${home}/.claude/focus-sidebar.log` : null
    await $.command.register({
      name: COMMAND,
      description: 'Bring a hidden folder back to the sidebar (no name: list hidden folders)',
      argumentHint: '[folder]',
    })
    $.clock.after(FIRST_RUN_MS, () => void sync($))
    $.clock.every(PERIOD_MS, () => void sync($))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    $.clock.after(AFTER_TURN_MS, () => void sync($))
    return done
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await showFolder($, e.args) }))
}
