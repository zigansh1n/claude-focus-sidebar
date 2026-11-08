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
export const VERSION = '0.6.10'
// Every open session runs this mod, each the version it started with; the lock keeps them from syncing
// at once. It is released when a sync ends and only outlives one that crashed mid-way. A busy sync
// (a re-rank with titles to stamp) once ran past 45 s, a second one started, and a section was lost.
const LEASE_MS = 3 * 60_000
// The store has no compare-and-set: a copy writes its mark, waits this long and goes on only if the
// mark is still its own.
const SETTLE_MS = 300
// Copies before 0.6.5 know only `leaseUntil` and wait while it lies ahead: holding it keeps them from
// undoing what this one files. Once no newer copy runs, they come back after this long.
const LEGACY_HOLD_MS = 10 * 60_000
// A sidebar found unlike what the sync just made, twice running, stops the mod for this long rather
// than let it reshuffle sections it no longer understands.
const PAUSE_MS = DAY
// A sync that found the lease taken tries again this soon, so a new session is filed within seconds.
const RETRY_MS = 3_000
const RETRIES = 15
const MOVE_BATCH = 100
// Archived sessions are left out of the listing: with them it outgrows what a tool result may carry.
const LIST_LIMIT = 300
// A folder worked in this recently gets 🔥 in its section name.
const HOT_MS = 60 * 60_000
const STICKY_MS = 2 * 60_000
// Titles stamped per sync, so a first run over many sessions stays short.
const STAMP_BATCH = 20

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
// Inside a section the app itself could group rows by state, but its own dots already say that.
export type Slot = { name: string; sessionIds: string[]; groupBy: 'none' }
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

/**
 * A session the mod may file: in the sidebar, not pinned, not nested under a session
 * still listed (`live`), and not filed by hand elsewhere. A fork whose parent is gone
 * stands on its own in the sidebar.
 */
export const isMovable = (s: Session, owned: ReadonlySet<string>, live: ReadonlySet<string> = new Set()) =>
  !s.isArchived &&
  !s.pinned &&
  !(s.startedBy && live.has(s.startedBy)) &&
  s.group !== undefined &&
  (s.group === null || owned.has(s.group.id))

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
 * archive (`kept`) go to the archive slot instead. `prev` is the last order, by project name.
 */
export const plan = (
  sessions: Row[],
  owned: ReadonlySet<string>,
  now: number,
  kept: ReadonlySet<string> = new Set(),
  shown: ReadonlySet<string> = new Set(),
  workDays: readonly string[] = sessions.map(s => dayOf(Date.parse(s.lastActivityAt) || 0)),
  prev: readonly string[] = [],
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

  const live = new Set(sessions.filter(s => !s.isArchived).map(s => s.sessionId))
  const projects = new Map<string, { heat: number; last: number; ids: string[] }>()
  const hide: string[] = []
  const archived: string[] = []
  for (const s of sessions) {
    const at = Date.parse(s.lastActivityAt) || 0
    const p = projects.get(s.project) ?? { heat: 0, last: 0, ids: [] }
    const ageDays = (now - at) / DAY
    if (ageDays <= HEAT_DAYS) p.heat += 0.5 ** (Math.max(ageDays, 0) / HALF_LIFE_DAYS)
    p.last = Math.max(p.last, at)
    if (isMovable(s, owned, live)) {
      if (!isIdle(s)) p.ids.push(s.sessionId)
      else if (kept.has(s.sessionId)) archived.push(s.sessionId)
      else hide.push(s.sessionId)
    }
    projects.set(s.project, p)
  }

  const isHot = (name: string, last: number) => name !== SCRATCH && now - last < HOT_MS
  const ranked = [...projects]
    .filter(([, p]) => p.ids.length > 0)
    .sort(([an, a], [bn, b]) => {
      const ah = isHot(an, a.last)
      const bh = isHot(bn, b.last)
      if (ah !== bh) return ah ? -1 : 1
      return ah ? b.last - a.last : b.heat - a.heat || b.last - a.last
    })
  // Hot folders keep their last order and one climbs past another only when it is STICKY_MS newer,
  // so two folders worked in side by side do not trade places on every turn.
  const hot = ranked.filter(([name, p]) => isHot(name, p.last))
  const at = (name: string) => (prev.includes(name) ? prev.indexOf(name) : prev.length)
  const settled: typeof hot = []
  for (const entry of [...hot].sort(([a], [b]) => at(a) - at(b))) {
    let k = settled.length
    while (k > 0 && entry[1].last > settled[k - 1][1].last + STICKY_MS) k--
    settled.splice(k, 0, entry)
  }
  const slots: Slot[] = [...settled, ...ranked.slice(hot.length)]
    .map(([name, p]) => ({
      name: isHot(name, p.last) ? `${HOT} ${name}` : name,
      sessionIds: p.ids,
      groupBy: 'none',
    }))
  if (archived.length > 0) {
    slots.push({ name: ARCHIVE, sessionIds: archived, groupBy: 'none' })
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
export const WORKING = '🟢'
export const WAITING = '🔴'
const MARK = /^(🟢|🔴) /

/**
 * The title led by the session's state and ended by its last activity. A session that is not
 * running waits for you until you answer or archive it: whether its work is done is your call.
 */
export const restamp = (title: string, lastActivityAt: string, running = false) =>
  `${running ? WORKING : WAITING} ${title.replace(MARK, '').replace(STAMP, '')} · ${stampOf(lastActivityAt)}`

let logFile: string | null = null
let markFile: string | null = null
const me = Math.random().toString(36).slice(2)
// Which copy wrote a line, and what woke it: every open session runs its own copy.
const tag = (why: string) => `[${me.slice(0, 5)} ${why}]`
// The last outcome this copy wrote: the same outcome is written once, whatever woke the copy, so wake-ups
// of several kinds in a row (a prompt, a turn, the 5 s start) do not repeat it.
let lastNote = ''

const note = async ($: EngineInterface, why: string, line: string) => {
  if (!logFile || line === lastNote) return
  lastNote = line
  const text = `${tag(why)} ${line}`
  try {
    const prev = (await $.fs.exists(logFile)) ? await $.fs.read(logFile) : ''
    await $.fs.write(logFile, (prev + `${new Date().toISOString()} ${text}\n`).slice(-20000))
  } catch {}
}

type Lock = { owner: string; until: number }
type Paused = { version: string; until: number; reason: string }

export const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(n => Number(n) || 0))
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

type Json = (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>

// A tool result may carry only so much. When the listing outgrows it, the count is halved until it fits;
// `limit` says whether that cut anything off.
async function listFitting(json: Json, args: Record<string, unknown>) {
  for (let limit = LIST_LIMIT; ; limit = Math.floor(limit / 2)) {
    try {
      return { limit, found: (await json(SESSIONS, 'list_sessions', { ...args, limit })) as Session[] }
    } catch (err) {
      if (!/exceeds maximum/.test(String(err)) || limit <= 1) throw err
    }
  }
}

// After a cut, each section is read on its own: its sessions are what the mod moves and renames, so it
// needs all of them, while of the rest the newest are enough.
async function listSessions(json: Json): Promise<Session[]> {
  const { limit, found } = await listFitting(json, {})
  if (limit === LIST_LIMIT) return found
  const sections = (await json(SIDEBAR, 'list_sections', {})) as Section[]
  const parts = await Promise.all(sections.filter(s => s.kind === 'manual').map(s => listFitting(json, { group: s.id })))
  return [...new Map([found, ...parts.map(p => p.found)].flat().map(x => [x.sessionId, x])).values()]
}

/** Whether a newer copy already ran; if not, records this one's version for the others. */
async function outdated($: EngineInterface): Promise<boolean> {
  const version = String((await $.store.get('version')) ?? '0')
  if (newer(version, VERSION)) return true
  if (newer(VERSION, version)) await $.store.set('version', VERSION)
  // The store belongs to one install source (a marketplace, a local folder): a copy installed from
  // elsewhere never sees it. The file next to the log is seen by every copy.
  if (!markFile) return false
  const marked = (await $.fs.exists(markFile)) ? (await $.fs.read(markFile)).trim() : '0'
  if (newer(marked, VERSION)) return true
  if (newer(VERSION, marked)) await $.fs.write(markFile, VERSION)
  return false
}

/** Brings the sidebar in line with the plan; resolves what it did, for the log. */
async function syncOnce($: EngineInterface, why: string): Promise<string> {
  const log = (line: string) => note($, why, line)
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
  const now = await $.clock.now()
  // A copy older than one that already ran stays out of the way of the newer rules.
  if (await outdated($)) return 'outdated'
  const paused = (await $.store.get('paused')) as Paused | undefined
  if (paused && paused.version === VERSION && paused.until > now) return 'paused'

  const held = (await $.store.get('lock')) as Lock | undefined
  if (held && held.until > now && held.owner !== me) return 'leased'
  await $.store.set('lock', { owner: me, until: now + LEASE_MS })
  await $.clock.sleep(SETTLE_MS)
  if (((await $.store.get('lock')) as Lock | undefined)?.owner !== me) return 'leased'
  await $.store.set('leaseUntil', now + LEGACY_HOLD_MS)
  try {

    const others = await listSessions(json)
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
    // Two syncs racing past the lease once left one section in two slots, and the slots took turns renaming it.
    const owned = [...new Set(((await $.store.get('slots')) as string[] | undefined) ?? [])].filter(id => byId.has(id))
    // Sections a sync made and then lost track of (it parked sessions and did not get to remove them, or a
    // racing sync overwrote its slots): their sessions are filed afresh and the sections go. Only the mod
    // ends a name in ​, so such a section is its own even when made before it kept a list.
    const made = ((await $.store.get('made')) as string[] | undefined) ?? []
    const marked = [...byId.values()].filter(s => /​$/.test(s.name)).map(s => s.id)
    const stray = [...new Set([...(((await $.store.get('parked')) as string[] | undefined) ?? []), ...made, ...marked])].filter(
      id => byId.has(id) && !owned.includes(id),
    )
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
      new Set([...owned, ...stray]),
      now,
      kept,
      shown,
      workDays,
      owned.map(id => byId.get(id)!.name.replace(`${HOT} `, '')),
    )

    const hiddenFolders = ((await $.store.get('hidden')) as Hidden | undefined) ?? {}
    const byIdRow = new Map(rows.map(s => [s.sessionId, s]))
    let hidden = 0
    const archived = new Set<string>()
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
        archived.add(id)
        hidden++
      } catch {
        kept.add(id)
      }
    }
    // A new session in a hidden folder does not bring the old ones back: what was put away stays away
    // until /show-folder asks for it.
    if (hidden > 0) await $.store.set('hidden', hiddenFolders)
    if (hidden < hide.length) await $.store.set('kept', [...kept])

    // create_section hands back the section already holding a name instead of making a second one, and
    // taking that for a new section once got a live slot deleted. A name no section holds gets a new one.
    const fresh = async (name: string) => {
      const taken = new Set([...byId.values()].map(s => s.name))
      let unique = name
      while (taken.has(unique)) unique += '\u200b'
      const made = (await json(SIDEBAR, 'create_section', { name: unique })) as Section
      if (byId.has(made.id)) throw new Error(`create_section: "${name}" came back as an existing section`)
      byId.set(made.id, made)
      await $.store.set('made', [...new Set([...(((await $.store.get('made')) as string[] | undefined) ?? []), made.id])])
      return made.id
    }
    while (owned.length < slots.length) owned.push(await fresh(slots[owned.length].name))
    await $.store.set('slots', owned)

    // Where each session sits right now, kept current as sessions move.
    const at = new Map(rows.filter(s => !archived.has(s.sessionId)).map(s => [s.sessionId, s.group?.id ?? null]))
    const target = new Map(slots.flatMap((slot, i) => slot.sessionIds.map(id => [id, i] as const)))
    let renamed = 0
    let moved = 0
    const move = async (ids: string[], sectionId: string) => {
      for (let k = 0; k < ids.length; k += MOVE_BATCH) {
        const batch = ids.slice(k, k + MOVE_BATCH)
        try {
          await call(SIDEBAR, 'move_sessions', { session_ids: batch, section_id: sectionId })
          for (const id of batch) at.set(id, sectionId)
          moved += batch.length
        } catch {
          // One refused id fails the whole batch: retry one by one and remember the refusals.
          for (const id of batch) {
            try {
              await call(SIDEBAR, 'move_sessions', { session_ids: [id], section_id: sectionId })
              at.set(id, sectionId)
              moved++
            } catch {
              refused.add(id)
            }
          }
          await $.store.set('refused', [...refused])
        }
      }
    }

    // A slot is renamed only once no other project's sessions are left in it, so no session is ever
    // shown under another project's name, even for the seconds a re-rank takes.
    const projectOfName = (name = '') => name.replace(`${HOT} `, '').replace(/\u200b+$/, '')
    const fits = (i: number) => projectOfName(byId.get(owned[i])?.name) === projectOfName(slots[i].name)
    const strangers = (i: number) =>
      [...at].filter(([id, where]) => where === owned[i] && target.has(id) && target.get(id) !== i && !refused.has(id)).map(([id]) => id)
    const parked = new Map<number, string>()
    const left = new Set(slots.keys())
    while (left.size > 0) {
      let i = [...left].find(fits) ?? [...left].find(k => strangers(k).length === 0)
      if (i === undefined) {
        // Every slot left holds sessions bound for another (two folders swapping places): park them
        // in a section of their own name until their slot is free.
        i = [...left][0]
        const ids = strangers(i)
        for (const j of new Set(ids.map(id => target.get(id)!))) {
          if (!parked.has(j)) {
            parked.set(j, await fresh(slots[j].name))
            await $.store.set('parked', [...stray, ...parked.values()])
          }
          await move(ids.filter(id => target.get(id) === j), parked.get(j)!)
        }
      }
      left.delete(i)
      if (byId.get(owned[i])?.name !== slots[i].name) {
        await call(SIDEBAR, 'rename_section', { section_id: owned[i], name: slots[i].name })
        byId.set(owned[i], { ...byId.get(owned[i])!, name: slots[i].name })
        renamed++
      }
      await move(slots[i].sessionIds.filter(id => at.get(id) !== owned[i]), owned[i])
    }
    for (const id of [...stray, ...parked.values()]) if (!owned.includes(id)) await call(SIDEBAR, 'delete_section', { section_id: id })
    if (stray.length > 0 || parked.size > 0) await $.store.set('parked', [])

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
      .filter(s => s.title && restamp(s.title, s.lastActivityAt, s.isRunning) !== s.title)
      .slice(0, STAMP_BATCH)
    for (const s of stale) {
      try {
        await call(SESSIONS, 'set_session_title', { session_id: s.sessionId, title: restamp(s.title!, s.lastActivityAt, s.isRunning) })
        stamped++
      } catch {}
    }

    const extra = owned.splice(slots.length)
    for (const id of extra) await call(SIDEBAR, 'delete_section', { section_id: id })
    await $.store.set('slots', owned)

    // The tests stand in for the app; this checks the app itself did what they assume.
    const after = new Map(((await json(SIDEBAR, 'list_sections', {})) as (Section & { session_count?: number })[]).map(s => [s.id, s]))
    await $.store.set('made', (((await $.store.get('made')) as string[] | undefined) ?? []).filter(id => after.has(id)))
    const off = slots.flatMap((slot, i) => {
      const s = after.get(owned[i])
      const filed = slot.sessionIds.filter(id => at.get(id) === owned[i] && !refused.has(id)).length
      if (!s) return [`"${slot.name}" is gone`]
      if (s.name !== slot.name) return [`"${slot.name}" reads "${s.name}"`]
      if ((s.session_count ?? filed) < filed) return [`"${slot.name}" holds ${s.session_count} of ${filed}`]
      return []
    })
    if (off.length > 0) {
      const strikes = Number((await $.store.get('strikes')) ?? 0) + 1
      await $.store.set('strikes', strikes)
      if (strikes >= 2) await $.store.set('paused', { version: VERSION, until: now + PAUSE_MS, reason: off.join('; ') } satisfies Paused)
      await log(`${strikes >= 2 ? 'paused' : 'check failed'}: ${off.join('; ')}`)
    } else if ((await $.store.get('strikes')) !== undefined) await $.store.delete('strikes')

    const line = `order: ${slots.map(s => s.name).join(' | ')}; renamed ${renamed}, moved ${moved}, removed ${extra.length}, hidden ${hidden}, stamped ${stamped}`
    return line
  } catch (err) {
    return `skipped: ${String(err).slice(0, 300)}`
  } finally {
    if (((await $.store.get('lock')) as Lock | undefined)?.owner === me) await $.store.delete('lock')
  }
}

/** Syncs once and writes how it ended to the log, whatever the end: standing aside, a refusal, no change. */
export async function sync($: EngineInterface, why = 'tick'): Promise<string> {
  const line = await syncOnce($, why)
  await note($, why, line)
  return line
}

/** Syncs now, or as soon as another session's sync lets go of the lease. */
const syncSoon = ($: EngineInterface, why: string, tries = RETRIES): void =>
  void sync($, why).then(r => {
    if (r === 'leased' && tries > 0) $.clock.after(RETRY_MS, () => syncSoon($, why, tries - 1))
  })

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
  await $.store.delete('lock')
  await sync($)
  return `Back in the sidebar: ${matched.join(', ')} (${back} sessions). It hides again after a working day without it.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = homeOf(e.cwd)
    logFile = home ? `${home}/.claude/focus-sidebar.log` : null
    markFile = home ? `${home}/.claude/focus-sidebar.version` : null
    await $.command.register({
      name: COMMAND,
      description: 'Bring a hidden folder back to the sidebar (no name: list hidden folders)',
      argumentHint: '[folder]',
    })
    $.clock.after(FIRST_RUN_MS, () => syncSoon($, 'first'))
    $.clock.every(PERIOD_MS, () => void sync($, 'tick'))
    await note($, 'start', `loaded ${VERSION}, ${e.surface}, ${e.cwd}`)
    return started
  })

  // A prompt sent re-sorts at once, not when the turn ends.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    $.clock.after(AFTER_TURN_MS, () => syncSoon($, 'prompt'))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    $.clock.after(AFTER_TURN_MS, () => syncSoon($, 'turn'))
    return done
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await showFolder($, e.args) }))
}
