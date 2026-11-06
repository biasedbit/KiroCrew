/** Real-browser checks for comments in the side panel's code editor (#18472),
 * with no gateway: starts Vite in-process and drives the ISOLATED capture entry
 * (website/capture/code-editor-comments.html, the REAL `MarkdownPanel` over a
 * fetch stub, with `onSave` and `onSubmitComments` recorded on `window`).
 *
 * Checks, in order:
 *   1. the right-click menu opens with "Comment on this section" first;
 *   2. a two-line selection gets a comment on those lines and a chip;
 *   3. typing two lines above moves the comment with its code;
 *   4. right-clicking a line with nothing selected comments on that line;
 *   5. adding a comment saves nothing;
 *   6. with unsaved edits, a warning beside Submit All says it saves them;
 *   7. Submit All saves first, and every line number it sends names the same
 *      text in the saved file;
 *   8. a refused clipboard read shows a note naming the keyboard paste, and
 *      without a clipboard API the menu has no Paste item.
 *
 * Usage (from website/): node scripts/capture-code-editor-comments-isolated.mjs [outDir]
 * Output: a PNG per step and code-editor-comments-isolated.webm in outDir.
 */
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromiumExecutable } from './lib/chromium-executable.mjs'

const OUT = process.argv[2] || '../temp-screenshots/code-editor-comments-isolated'
const PORT = 6872
mkdirSync(OUT, { recursive: true })
const VIDEO_TMP = join(OUT, '.video')
rmSync(VIDEO_TMP, { recursive: true, force: true })

const server = await createServer({ server: { host: '127.0.0.1', port: PORT, strictPort: true } })
await server.listen()
const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, recordVideo: { dir: VIDEO_TMP, size: { width: 1100, height: 760 } } })
const page = await context.newPage()
page.on('pageerror', e => console.log('PAGE ERROR', e.message))

let failures = 0
let step = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const shot = async name => { step++; await page.screenshot({ path: join(OUT, `${String(step).padStart(2, '0')}-${name}.png`) }) }

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
  await page.mouse.move(a.x + 1, a.y + a.h / 2, { steps: 10 })
  await page.mouse.down()
  await page.mouse.move(b.x + b.w, b.y + b.h / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}
const composer = page.getByLabel('Comment on the selected text')
const chips = page.locator('[data-mc-code-chip]')
const note = page.getByTestId('submit-note')
const drafts = async () => Object.values(JSON.parse(await page.evaluate(() => localStorage.getItem('mc-comment-drafts') || '{}')))[0] || []

async function commentViaMenu(at, text) {
  await page.mouse.click(at.x + 4, at.y + at.h / 2, { button: 'right' })
  const item = page.getByRole('menuitem', { name: /Comment on this section/ })
  await item.waitFor({ timeout: 5000 })
  const items = await page.getByRole('menuitem').allInnerTexts()
  await page.waitForTimeout(400)
  await item.click()
  await composer.waitFor({ state: 'visible', timeout: 5000 })
  await composer.pressSequentially(text, { delay: 15 })
  await composer.press('Enter')
  await composer.waitFor({ state: 'detached', timeout: 5000 })
  await page.waitForTimeout(800)
  return items
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/capture/code-editor-comments.html?theme=dark`, { waitUntil: 'networkidle', timeout: 180000 })
  await page.locator('[data-column-number="12"]').first().waitFor({ timeout: 60000 })
  await page.waitForTimeout(1500)
  check('the code file opens in the editor', await page.evaluate(() =>
    document.querySelector('diffs-container')?.shadowRoot?.querySelector('[contenteditable="true"]') != null))
  await shot('editor')

  // 1-2: select lines 12-13, right-click, comment.
  await drag(await rectOf('except Exception', 'except'), await rectOf('            pass', 'pass'))
  const items = await commentViaMenu(await rectOf('except Exception', 'Exception'), 'Never swallow every exception.')
  check('the menu item shows Ctrl+L', /Comment on this section\s*Ctrl\+L/.test(items[0] ?? ''), items[0]?.replace(/\s+/g, ' '))
  check('"Comment on this section" is the first menu item', items[0]?.includes('Comment on this section'), items.map(t => t.replace(/\s+/g, ' ').trim()).join(' | '))
  let list = await drafts()
  check('the comment covers lines 12-13', list[0]?.line === 12 && list[0]?.endLine === 13, JSON.stringify(list[0] && [list[0].line, list[0].endLine]))
  check('a chip shows in the editor', (await chips.count()) === 1)
  await shot('range-comment')

  // 3: two lines typed above move the comment.
  const top = await rectOf('import time', 'import')
  await page.mouse.click(top.x + 1, top.y + top.h / 2)
  // A person pauses between clicking and typing; Pierre moves its caret on
  // the next selectionchange, so typing within a few ms lands on the old one.
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.type('# a\n# b\n')
  await page.waitForTimeout(800)
  list = await drafts()
  check('after 2 lines above, the comment is on lines 14-15', list[0]?.line === 14 && list[0]?.endLine === 15, JSON.stringify(list[0] && [list[0].line, list[0].endLine]))

  // 4-5: right-click a line with nothing selected; adding the comment saves.
  const savesBefore = await page.evaluate(() => window.__saves.length)
  const loop = await rectOf('for attempt', 'for')
  await page.mouse.click(loop.x + 2, loop.y + loop.h / 2)
  await page.waitForTimeout(200)
  await commentViaMenu(await rectOf('for attempt', 'attempt'), 'Make the attempt count a parameter.')
  list = await drafts()
  check('right-click with no selection comments on that line', list[1]?.line === 10 && list[1]?.anchor?.includes('for attempt in range(3):'), JSON.stringify(list[1] && { line: list[1].line, anchor: list[1].anchor }))
  const disk1 = await page.evaluate(() => window.__disk)
  check('adding a comment does not save the file', (await page.evaluate(() => window.__saves.length)) === savesBefore && !disk1.startsWith('# a'))
  check('the warning shows while edits are unsaved', await note.isVisible().catch(() => false))
  await shot('two-comments')

  // 6: unsaved edits show the note.
  const top2 = await rectOf('# a', '#')
  await page.mouse.click(top2.x + 1, top2.y + top2.h / 2)
  // A person pauses between clicking and typing; Pierre moves its caret on
  // the next selectionchange, so typing within a few ms lands on the old one.
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.type('# c\n')
  await page.waitForTimeout(800)
  check('the note shows with unsaved edits', await note.isVisible(), await note.innerText().catch(() => ''))
  check('the edit is not on disk yet', !(await page.evaluate(() => window.__disk)).startsWith('# c'))
  await shot('submit-note')

  // 6b: Ctrl+L comments without the menu, on a selection and on the caret's line.
  const before = (await drafts()).length
  const word = await rectOf('time.sleep', 'time.sleep(1)')
  await drag(word, word)
  await page.keyboard.press('Control+l')
  await composer.waitFor({ state: 'visible', timeout: 5000 })
  check('Ctrl+L opens the comment box for the selection', true)
  await composer.pressSequentially('Back off exponentially.', { delay: 10 })
  await composer.press('Enter')
  await composer.waitFor({ state: 'detached', timeout: 5000 })
  await page.waitForTimeout(500)
  let after = await drafts()
  check('Ctrl+L comment covers the selected text', after.length === before + 1 && after.at(-1)?.anchor === 'time.sleep(1)', JSON.stringify(after.at(-1) && { line: after.at(-1).line, anchor: after.at(-1).anchor }))
  const ret = await rectOf('return None', 'return')
  await page.mouse.click(ret.x + 2, ret.y + ret.h / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+l')
  await composer.waitFor({ state: 'visible', timeout: 5000 })
  await composer.pressSequentially('Raise instead of returning None.', { delay: 10 })
  await composer.press('Enter')
  await composer.waitFor({ state: 'detached', timeout: 5000 })
  await page.waitForTimeout(500)
  after = await drafts()
  check('Ctrl+L with no selection covers the caret line', after.at(-1)?.anchor === '    return None', JSON.stringify(after.at(-1)?.anchor))

  // 7: Submit All saves, then sends lines that match the saved file.
  await page.getByRole('button', { name: /submit all/i }).first().click()
  await page.waitForTimeout(1500)
  const disk = await page.evaluate(() => window.__disk)
  const sent = await page.evaluate(() => window.__sent.at(-1) ?? '')
  console.log('      sent:', JSON.stringify(sent))
  check('Submit All saved the file first', disk.startsWith('# c\n# a\n# b\n'))
  const diskLines = disk.split('\n')
  const range = /\(lines (\d+)-(\d+), "([^"]*)/.exec(sent)
  check('the range comment is sent as lines 15-16', range?.[1] === '15' && range?.[2] === '16', range?.slice(1, 3).join('-'))
  check('lines 15-16 on disk are the commented code', diskLines[14]?.includes('except Exception') && diskLines[15]?.includes('pass'))
  const single = /\(line (\d+), /.exec(sent)
  check('the line comment is sent as line 11', single?.[1] === '11', single?.[1])
  check('line 11 on disk is the commented code', diskLines[10]?.includes('for attempt in range(3):'))
  check('the note is gone after the save', !(await note.isVisible().catch(() => false)))
  await shot('submitted')
  check('no chips are left after the comments are sent', (await chips.count()) === 0)

  // 8: the cases the review raised, on a fresh load.
  await page.goto(`http://127.0.0.1:${PORT}/capture/code-editor-comments.html?theme=dark`, { waitUntil: 'networkidle', timeout: 180000 })
  await page.locator('[data-column-number="12"]').first().waitFor({ timeout: 60000 })
  await page.waitForTimeout(1200)
  // 8a: a line break typed INSIDE a two-line section keeps its start.
  await drag(await rectOf('except Exception', 'except'), await rectOf('            pass', 'pass'))
  await page.keyboard.press('Control+l')
  await composer.waitFor({ state: 'visible', timeout: 5000 })
  await composer.pressSequentially('Inside-edit check.', { delay: 5 })
  await composer.press('Enter')
  await composer.waitFor({ state: 'detached', timeout: 5000 })
  const exc = await rectOf('except Exception', 'Exception:')
  await page.mouse.click(exc.x + exc.w + 2, exc.y + exc.h / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  list = await drafts()
  check('a line break inside the section keeps its start and grows its end', list[0]?.line === 12 && list[0]?.endLine === 14, JSON.stringify(list[0] && [list[0].line, list[0].endLine]))
  // 8b: the agent changes the file on disk while the buffer is clean.
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(600)
  await page.evaluate(() => { window.__writeDisk('# added by the agent\n# and another line\n' + window.__disk); window.__reloadFromDisk() })
  await page.waitForTimeout(1000)
  list = await drafts()
  const diskNow = (await page.evaluate(() => window.__disk)).split('\n')
  check('after an agent edit on disk, the comment is found again by its text', list[0]?.line === 14 && list[0]?.endLine === 16 && diskNow[13]?.includes('except Exception'), JSON.stringify(list[0] && [list[0].line, list[0].endLine]))
  check('its chip follows it', (await chips.count()) === 1)
  // 8c: unsaved edits plus a newer file on disk: Submit All refuses to write over it.
  const sentBefore = await page.evaluate(() => window.__sent.length)
  const firstLine = await rectOf('# added by the agent', '#')
  await page.mouse.click(firstLine.x + 1, firstLine.y + firstLine.h / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.type('# mine\n')
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__writeDisk(window.__disk + '\n# a newer agent edit\n'))
  await page.getByRole('button', { name: /add overall instruction/i }).first().click()
  await page.waitForTimeout(300)
  await page.keyboard.type('Keep it short.')
  await page.getByRole('button', { name: /submit all/i }).first().click()
  await page.waitForTimeout(1500)
  const saveError = page.getByTestId('markdown-panel-save-error')
  check('Submit All refuses when the file changed on disk', await saveError.isVisible().catch(() => false), (await saveError.innerText().catch(() => '')).slice(0, 80))
  check('nothing was sent and the agent edit is intact', (await page.evaluate(() => window.__sent.length)) === sentBefore && (await page.evaluate(() => window.__disk)).includes('# a newer agent edit'))
  const keptDrafts = (await drafts()).length
  const keptText = await page.locator('textarea').evaluateAll(els => els.map(e => e.value))
  check('the comment and the typed instruction are kept', keptDrafts === 1 && keptText.includes('Keep it short.'), JSON.stringify({ keptDrafts, keptText }))
  await shot('conflict')

  // Paste with the clipboard read refused: a visible note names the keyboard paste.
  await page.goto(`http://127.0.0.1:${PORT}/capture/code-editor-comments.html?theme=dark`, { waitUntil: 'networkidle', timeout: 180000 })
  await page.locator('[data-column-number="12"]').first().waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    navigator.clipboard.readText = () => Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'))
  })
  const at1 = await rectOf('import time', 'import')
  await page.mouse.click(at1.x + 4, at1.y + at1.h / 2, { button: 'right' })
  const pasteItem = page.getByRole('menuitem', { name: /Paste/ })
  await pasteItem.waitFor({ timeout: 5000 })
  await page.waitForTimeout(400)
  await pasteItem.click()
  const refused = page.getByTestId('code-editor-paste-refused')
  await refused.waitFor({ timeout: 3000 }).catch(() => {})
  check('a refused clipboard read shows a note naming Ctrl+V', /Ctrl\+V/.test(await refused.innerText().catch(() => '')), await refused.innerText().catch(() => ''))
  await shot('paste-refused')

  // No clipboard API (a page that is not a secure context): no Paste item.
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true }) })
  await page.goto(`http://127.0.0.1:${PORT}/capture/code-editor-comments.html?theme=dark`, { waitUntil: 'networkidle', timeout: 180000 })
  await page.locator('[data-column-number="12"]').first().waitFor({ timeout: 60000 })
  const at2 = await rectOf('import time', 'import')
  await page.mouse.click(at2.x + 4, at2.y + at2.h / 2, { button: 'right' })
  await page.getByRole('menuitem', { name: /Comment on this section/ }).waitFor({ timeout: 5000 })
  const menuNow = await page.getByRole('menuitem').allInnerTexts()
  check('without a clipboard API the menu has no Paste item', menuNow.length > 0 && !menuNow.some(t => /^\s*Paste/.test(t)), menuNow.map(t => t.replace(/\s+/g, ' ').trim()).join(' | '))
  await page.keyboard.press('Escape')
} finally {
  await context.close()
  await browser.close()
  await server.close()
}
const vids = readdirSync(VIDEO_TMP).filter(f => f.endsWith('.webm'))
if (vids.length === 1) renameSync(join(VIDEO_TMP, vids[0]), join(OUT, 'code-editor-comments-isolated.webm'))
rmSync(VIDEO_TMP, { recursive: true, force: true })
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
