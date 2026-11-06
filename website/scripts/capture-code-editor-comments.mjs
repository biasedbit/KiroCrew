/**
 * Demo video + evidence for comments on code files in the side panel's editor
 * (issue #18472), shot against a REAL gateway serving this checkout: the dev
 * stack (`./dev-fullstack.sh`) or a pod (`kirocrew pod up <worktree>`).
 *
 * Flow, each step asserted before the script moves on:
 *   1. open retry.py from the side panel's Files tree; it opens in the editor;
 *   2. select lines 12-13, right-click, "Comment on this section" (the first
 *      menu item), type, add; a chip appears under line 13;
 *   3. type two lines at the top; the comment moves to lines 14-15 with its code;
 *   4. select `range(3)`, comment on it; adding a comment saves nothing;
 *   5. Submit All: one chat message names `lines 14-15` and the `range(3)` line;
 *   6. the agent edits the file; the panel reloads it and shows the diff.
 *
 * Usage: node scripts/capture-code-editor-comments.mjs <base_url> <token> <project_dir> [outDir]
 *   <project_dir> must hold `retry.py` committed to git (the diff baseline).
 *   AGENT=0 stops after step 5's message is checked, without waiting for an agent.
 *
 * Output: <outDir>/code-editor-comments.webm plus a PNG per step.
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromiumExecutable } from './lib/chromium-executable.mjs'

const [BASE, TOKEN, PROJECT, OUT_ARG] = process.argv.slice(2)
if (!BASE || !TOKEN || !PROJECT) {
  console.error('usage: node scripts/capture-code-editor-comments.mjs <base_url> <token> <project_dir> [outDir]')
  process.exit(2)
}
const OUT = OUT_ARG || '../temp-screenshots/code-editor-comments'
const WITH_AGENT = process.env.AGENT !== '0'
const FILE = join(PROJECT, 'retry.py')
const W = 1440, H = 900
mkdirSync(OUT, { recursive: true })
const VIDEO_TMP = join(OUT, '.video')
rmSync(VIDEO_TMP, { recursive: true, force: true })

const ORIGINAL = readFileSync(FILE, 'utf8')
const lineOf = (text, needle) => text.split('\n').findIndex(l => l.includes(needle)) + 1
const L_EXCEPT = lineOf(ORIGINAL, 'except Exception:')
const L_LOOP = lineOf(ORIGINAL, 'for attempt in range(3):')
if (!L_EXCEPT || !L_LOOP) throw new Error('retry.py fixture is not the expected one')

let step = 0
/** The recorded page, for the failure frame. */
let livePage = null
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) throw new Error(`check failed: ${label}`)
}

/** Shows a fake cursor (headless video has none) and a caption bar. */
function overlayInit() {
  const install = () => {
    if (document.getElementById('demo-cursor')) return
    const c = document.createElement('div')
    c.id = 'demo-cursor'
    Object.assign(c.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', width: '18px', height: '18px',
      marginLeft: '-9px', marginTop: '-9px', borderRadius: '50%', border: '2px solid #fff',
      background: 'rgba(255,170,0,.75)', boxShadow: '0 0 0 2px rgba(0,0,0,.5)', left: '-50px', top: '-50px',
      transition: 'transform .08s',
    })
    const cap = document.createElement('div')
    cap.id = 'demo-caption'
    Object.assign(cap.style, {
      position: 'fixed', zIndex: 2147483646, pointerEvents: 'none', left: '73%', bottom: '18px',
      transform: 'translateX(-50%)', padding: '8px 16px', borderRadius: '8px', font: '600 15px system-ui, sans-serif',
      background: 'rgba(20,20,24,.88)', color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,.4)', display: 'none',
      maxWidth: '80vw', textAlign: 'center',
    })
    document.documentElement.append(c, cap)
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)' }, true)
    addEventListener('mouseup', () => { c.style.transform = '' }, true)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install)
  else install()
}

async function main() {
  const browser = await chromium.launch({ executablePath: chromiumExecutable() })
  // Warm-up, not recorded: authenticate, create the chat, and get past a fresh
  // home's first-run setup, so the video opens on the chat itself.
  const warm = await browser.newContext({ viewport: { width: W, height: H } })
  const wp = await warm.newPage()
  await wp.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' })
  await wp.waitForTimeout(3000)
  const skip = wp.getByRole('button', { name: 'Skip all setup and onboarding' })
  if (await skip.count()) { await skip.first().click(); await wp.waitForTimeout(1500) }
  const slot = await wp.evaluate(async project => {
    const headers = { 'Content-Type': 'application/json', 'X-Session-Key': 'dashboard:ui' }
    // Every run gets a chat of its own, in temporary memory mode: the agent
    // reads no memory, so it cannot recall an earlier run's edits to this same
    // fixture (which is reset between runs) and report the reset as a problem.
    const created = await fetch('/api/chat/slots', { method: 'POST', headers, body: JSON.stringify({ name: `Retry helper review ${Date.now().toString(36)}`, memory_mode: 'temporary' }) })
    if (!created.ok) throw new Error(`POST /api/chat/slots → ${created.status} ${await created.text()}`)
    const body = await created.json()
    const key = body.slot ?? body.key ?? body.name
    const proj = await fetch(`/api/chat/slots/${encodeURIComponent(key)}/project`, { method: 'POST', headers, body: JSON.stringify({ project }) })
    if (!proj.ok) throw new Error(`POST project → ${proj.status} ${await proj.text()}`)
    // This throwaway chat only edits the fixture, so it runs on Trust: no
    // approval prompt interrupts the recording.
    const mode = await fetch('/api/chat/mode', { method: 'POST', headers, body: JSON.stringify({ mode: 'trust', slot: key }) })
    if (!mode.ok) throw new Error(`POST /api/chat/mode → ${mode.status} ${await mode.text()}`)
    return key
  }, PROJECT)
  console.log('slot:', slot)
  await wp.evaluate(slot => {
    localStorage.setItem('mc-theme', 'dark')
    localStorage.setItem('mc-onboarded', '1')
    localStorage.setItem('mc-active-slot-chat', slot)
    localStorage.setItem('mc-activity-open:' + slot, 'true')
    localStorage.setItem('mc-side-panel-width', '860')
    localStorage.setItem('kirocrew:comment-hint-dismissed', '1')
    localStorage.removeItem('mc-comment-drafts')
  }, slot)
  // Reload once to confirm the first-run dialog stays away before recording.
  await wp.goto(`${BASE}/?sid=${encodeURIComponent(slot)}`, { waitUntil: 'domcontentloaded' })
  await wp.waitForTimeout(3000)
  const stillThere = await wp.getByRole('button', { name: 'Skip all setup and onboarding' }).count()
  if (stillThere) { await wp.getByRole('button', { name: 'Skip all setup and onboarding' }).first().click(); await wp.waitForTimeout(1500) }
  const storageState = await warm.storageState()
  await warm.close()

  const context = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, storageState,
    recordVideo: { dir: VIDEO_TMP, size: { width: W, height: H } },
  })
  await context.addInitScript(overlayInit)
  const page = await context.newPage()
  livePage = page
  page.on('pageerror', e => console.log('PAGE ERROR', e.message))
  const caption = async text => {
    await page.evaluate(t => {
      const el = document.getElementById('demo-caption')
      if (el) { el.textContent = t; el.style.display = t ? 'block' : 'none' }
    }, text)
  }
  const shot = async name => {
    step += 1
    const file = join(OUT, `${String(step).padStart(2, '0')}-${name}.png`)
    await page.screenshot({ path: file })
    console.log('      frame', file)
  }

  await page.goto(`${BASE}/?sid=${encodeURIComponent(slot)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  if (await page.getByRole('dialog', { name: 'Customize Kiro Crew' }).count()) {
    throw new Error('first-run dialog still covers the page after the warm-up')
  }

  // 1 — open the file from the Files tree, as a user does. It opens in the editor.
  await caption('Open retry.py from the side panel. Code files open in the editor.')
  const panel = page.locator('div:has(> .side-panel-strip)').last()
  await panel.waitFor({ timeout: 30000 })
  const filesTab = panel.getByRole('tab', { name: 'Files' })
  if (await filesTab.count()) await filesTab.first().click()
  // The Files tab opens on the files this chat edited; the tree is under Browse.
  const browse = panel.getByRole('button', { name: 'Browse', exact: true })
  await browse.first().waitFor({ timeout: 10000 }).catch(() => {})
  if (await browse.count()) { await page.waitForTimeout(600); await browse.first().click() }
  const entry = page.getByRole('treeitem', { name: 'retry.py', exact: true }).first()
  await entry.waitFor({ timeout: 20000 })
  await page.waitForTimeout(800)
  const eb = await entry.boundingBox()
  await page.mouse.move(eb.x + 30, eb.y + eb.height / 2, { steps: 15 })
  await entry.click()
  await page.locator(`[data-column-number="${L_EXCEPT}"]`).first().waitFor({ timeout: 20000 })
  check('the code file opens in the editor', await page.evaluate(() =>
    document.querySelector('diffs-container')?.shadowRoot?.querySelector('[contenteditable="true"]') != null))
  await page.waitForTimeout(1200)
  await shot('editor')

  /** Viewport rect of `needle` on the first editor line that contains `lineHas`. */
  const rectOf = (lineHas, needle) => page.evaluate(([lineHas, needle]) => {
    for (const host of document.querySelectorAll('diffs-container')) for (const line of host.shadowRoot?.querySelectorAll('[data-line]') ?? []) {
      const text = line.textContent ?? ''
      if (!text.includes(lineHas)) continue
      const at = text.indexOf(needle)
      if (at < 0) continue
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let off = 0, n, start = null, end = null
      while ((n = walker.nextNode())) {
        const len = n.data.length
        if (!start && at < off + len) start = [n, at - off]
        if (at + needle.length <= off + len) { end = [n, at + needle.length - off]; break }
        off += len
      }
      const r = document.createRange(); r.setStart(...start); r.setEnd(...end)
      const b = r.getBoundingClientRect()
      return { x: b.left, y: b.top, w: b.width, h: b.height }
    }
    return null
  }, [lineHas, needle])
  const drag = async (a, b) => {
    await page.mouse.move(a.x + 1, a.y + a.h / 2, { steps: 18 })
    await page.waitForTimeout(250)
    await page.mouse.down()
    await page.mouse.move(b.x + b.w, b.y + b.h / 2, { steps: 14 })
    await page.mouse.up()
    await page.waitForTimeout(500)
  }
  const composer = page.getByLabel('Comment on the selected text')
  const chips = page.locator('[data-mc-code-chip]')
  const menuComment = page.getByRole('menuitem', { name: /Comment on this section/ })
  const drafts = async () => Object.values(JSON.parse(await page.evaluate(() => localStorage.getItem('mc-comment-drafts') || '{}')))[0] || []

  /** Right-click at `at`, pick "Comment on this section", type `text`. */
  async function commentViaMenu(at, text, menuShot) {
    await page.mouse.move(at.x + 4, at.y + at.h / 2, { steps: 8 })
    await page.mouse.click(at.x + 4, at.y + at.h / 2, { button: 'right' })
    await menuComment.waitFor({ timeout: 5000 })
    const items = await page.getByRole('menuitem').allInnerTexts()
    check('"Comment on this section" is first in the right-click menu', items[0]?.includes('Comment on this section'), items.map(t => t.replace(/\s+/g, ' ').trim()).join(' | '))
    await page.waitForTimeout(1300)
    if (menuShot) await shot(menuShot)
    const mb = await menuComment.boundingBox()
    await page.mouse.move(mb.x + 30, mb.y + mb.height / 2, { steps: 8 })
    await page.waitForTimeout(300)
    await menuComment.click()
    await composer.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForTimeout(300)
    await composer.pressSequentially(text, { delay: 28 })
    await page.waitForTimeout(500)
  }

  // 2 — select lines 12-13 and comment on them through the right-click menu.
  await caption(`Select lines ${L_EXCEPT}-${L_EXCEPT + 1}, right-click, Comment on this section.`)
  await drag(await rectOf('except Exception', 'except'), await rectOf('            pass', 'pass'))
  await commentViaMenu(await rectOf('except Exception', 'Exception'), 'Never swallow every exception. Catch requests.RequestException and log it.', 'menu')
  await shot('composer')
  await composer.press('Enter')
  await composer.waitFor({ state: 'detached', timeout: 10000 })
  await chips.first().waitFor({ timeout: 10000 })
  let list = await drafts()
  check(`the comment covers lines ${L_EXCEPT}-${L_EXCEPT + 1}`, list[0]?.line === L_EXCEPT && list[0]?.endLine === L_EXCEPT + 1)
  await page.waitForTimeout(1200)
  await shot('chip')

  // 3 — keep editing: two lines typed above move the comment and its chip.
  await caption('Keep editing. The comment and its chip follow their lines.')
  const top = await rectOf('import time', 'import')
  await page.mouse.move(top.x + 1, top.y + top.h / 2, { steps: 15 })
  await page.mouse.click(top.x + 1, top.y + top.h / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.type('"""Retry helper for flaky HTTP endpoints."""\n\n', { delay: 35 })
  await page.waitForTimeout(1000)
  list = await drafts()
  check(`after 2 new lines above, the comment is on lines ${L_EXCEPT + 2}-${L_EXCEPT + 3}`, list[0]?.line === L_EXCEPT + 2 && list[0]?.endLine === L_EXCEPT + 3, JSON.stringify(list[0] && [list[0].line, list[0].endLine]))
  await shot('moved')

  // 4 — part of one line; adding a comment saves the file.
  await caption('Comment on part of a line. Nothing is saved yet.')
  const r3 = await rectOf('for attempt', 'range(3)')
  await drag(r3, r3)
  await commentViaMenu(r3, 'Make the attempt count and backoff parameters, and back off exponentially.')
  await composer.press('Enter')
  await composer.waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForTimeout(1500)
  list = await drafts()
  check('the second comment is on part of one line', list[1]?.anchor === 'range(3)' && list[1]?.endLine === undefined, JSON.stringify(list[1] && { line: list[1].line, column: list[1].column }))
  check('two chips, two pending comments', (await chips.count()) === 2)
  check('adding a comment does not save the file', !readFileSync(FILE, 'utf8').startsWith('"""Retry helper'))
  await page.waitForTimeout(800)
  await shot('two-comments')

  // 5 — an unsaved edit: a note beside Submit All says it will save it first.
  await caption('A warning beside Submit All: submitting saves unsaved changes.')
  const imp = await rectOf('import time', 'import')
  await page.mouse.move(imp.x + 2, imp.y + imp.h / 2, { steps: 12 })
  await page.mouse.click(imp.x + 2, imp.y + imp.h / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.type('import logging\n', { delay: 35 })
  await page.waitForTimeout(1000)
  const note = page.getByTestId('submit-note')
  check('the note shows beside Submit All', await note.isVisible().catch(() => false), await note.innerText().catch(() => ''))
  check('the unsaved line is not on disk yet', !readFileSync(FILE, 'utf8').includes('import logging'))
  list = await drafts()
  const L_RANGE = list[1]?.line
  const [R_START, R_END] = [list[0]?.line, list[0]?.endLine]
  await page.waitForTimeout(1200)
  await shot('submit-note')

  // 6 — send them to the agent as one message.
  await caption('Submit All saves the file, then sends both comments with their lines.')
  const submit = page.getByRole('button', { name: /submit all/i }).first()
  const sb = await submit.boundingBox()
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2, { steps: 15 })
  await page.waitForTimeout(500)
  await submit.click()
  // Read the disk at once: a fast agent rewrites the file within seconds.
  let SAVED = readFileSync(FILE, 'utf8')
  for (let i = 0; i < 20 && !SAVED.includes('import logging'); i++) { await page.waitForTimeout(100); SAVED = readFileSync(FILE, 'utf8') }
  const sent = page.getByText(/Document feedback on .*retry\.py/).first()
  await sent.waitFor({ timeout: 15000 })
  // The chat may show the long message collapsed, so read what the gateway recorded.
  const transcript = await page.evaluate(async slot => {
    const r = await fetch(`/api/chat/slots/${encodeURIComponent(slot)}`, { headers: { 'X-Session-Key': 'dashboard:ui' } })
    const msgs = (await r.json()).messages ?? []
    return msgs.filter(m => m.role === 'user').map(m => String(m.content ?? m.text ?? '')).pop() ?? ''
  }, slot)
  console.log('      sent message:', JSON.stringify(transcript.slice(0, 400)))
  const savedLines = SAVED.split('\n')
  check('Submit All saved the unsaved edit', savedLines.includes('import logging'))
  check(`chat message names lines ${R_START}-${R_END}`, transcript.includes(`lines ${R_START}-${R_END}`))
  check(`lines ${R_START}-${R_END} on disk are the commented code`, savedLines[R_START - 1]?.includes('except Exception') && savedLines[R_END - 1]?.includes('pass'))
  check('chat message names the part-of-line comment', transcript.includes(`line ${L_RANGE}, col`))
  check(`line ${L_RANGE} on disk holds range(3)`, savedLines[L_RANGE - 1]?.includes('range(3)'))
  await page.waitForTimeout(1500)
  await shot('sent')

  if (WITH_AGENT) {
    // 6 — the agent applies the comments; the panel follows the file.
    await caption('The agent edits the file. The side panel reloads it.')
    const deadline = Date.now() + 8 * 60_000
    let changed = false
    while (Date.now() < deadline) {
      // Approve any tool call the agent asks for in this throwaway chat.
      const approve = page.getByRole('button', { name: /^(Approve|Allow|Allow once|Yes)$/ })
      if (await approve.count()) await approve.first().click().catch(() => {})
      const now = readFileSync(FILE, 'utf8')
      if (now !== SAVED) changed = true
      const busy = await page.evaluate(async slot => {
        const r = await fetch(`/api/chat/slots/${encodeURIComponent(slot)}`, { headers: { 'X-Session-Key': 'dashboard:ui' } })
        return r.ok ? !!(await r.json()).running : true
      }, slot)
      if (changed && !busy) break
      await page.waitForTimeout(2000)
    }
    const after = readFileSync(FILE, 'utf8')
    check('the agent changed retry.py', after !== SAVED)
    check('the bare except is gone', !after.includes('except Exception:\n            pass'), 'checked on disk')
    await page.waitForTimeout(2500)
    await shot('agent-done')
    await caption('Show changes: the diff of what the agent did, before any CR.')
    // The panel shows the edited file in Review; the diff toggle shows what changed.
    const diffBtn = page.getByRole('button', { name: /^(Show changes|Toggle diff view)$/ }).first()
    await diffBtn.waitFor({ timeout: 15000 })
    const db = await diffBtn.boundingBox()
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 15 })
    await page.waitForTimeout(400)
    await diffBtn.click()
    await page.waitForTimeout(5000)
    await shot('diff')
  }
  await caption('')
  await page.waitForTimeout(800)

  await context.close()
  await browser.close()
  const vids = readdirSync(VIDEO_TMP).filter(f => f.endsWith('.webm'))
  if (vids.length !== 1) throw new Error(`expected one video, found ${vids.length}`)
  const dest = join(OUT, 'code-editor-comments.webm')
  renameSync(join(VIDEO_TMP, vids[0]), dest)
  rmSync(VIDEO_TMP, { recursive: true, force: true })
  console.log('video', dest)
}

main().catch(async err => {
  console.error(err)
  if (livePage) {
    const dbg = join(OUT, 'debug-failure.png')
    await livePage.screenshot({ path: dbg }).catch(() => {})
    console.error('debug frame', dbg)
    console.error((await livePage.locator('body').innerText().catch(() => '')).slice(0, 1500))
  }
  process.exit(1)
})
