import { describe, it, expect } from 'vitest'
import type { InlineComment } from '../components/CommentOverlay'
import { mapCommentsThroughEdits, relocateCommentsByText, type TextChange } from '../utils/codeCommentRanges'

const FILE = [
  'def retry(fn):',            // 1
  '    for i in range(3):',    // 2
  '        try:',              // 3
  '            return fn()',   // 4
  '        except Exception:', // 5
  '            pass',          // 6
].join('\n')
const lineAt = (text: string, n: number) => text.split('\n').slice(0, n - 1).reduce((o, l) => o + l.length + 1, 0)
const RANGE = '        except Exception:\n            pass'
const range = (): InlineComment => ({ id: 'r', anchor: RANGE, text: 't', line: 5, endLine: 6, column: 1 })
const word = (): InlineComment => ({ id: 'w', anchor: 'range(3)', text: 't', line: 2, column: 14 })

/** Applies `changes` (offsets into `before`) and returns the new text. */
function apply(before: string, changes: TextChange[]): string {
  return [...changes].sort((a, b) => b.start - a.start).reduce((t, ch) => t.slice(0, ch.start) + ch.text + t.slice(ch.end), before)
}
/** Every located comment's stored text is the text at its stored location. */
function namesItsText(text: string, c: InlineComment) {
  const at = lineAt(text, c.line!) + c.column! - 1
  expect(text.slice(at, at + c.anchor.length)).toBe(c.anchor)
  expect(c.endLine ?? c.line).toBe(c.line! + (c.anchor.match(/\n/g)?.length ?? 0))
}

describe('mapCommentsThroughEdits', () => {
  const edit = (changes: TextChange[], cs = [range(), word()]) => {
    const after = apply(FILE, changes)
    return { after, out: mapCommentsThroughEdits(cs, FILE, after, changes) }
  }

  it('moves both ends when lines are typed above', () => {
    const { after, out } = edit([{ start: 0, end: 0, text: '# a\n# b\n' }])
    expect(out[0]).toMatchObject({ line: 7, endLine: 8, anchor: RANGE })
    expect(out[1]).toMatchObject({ line: 4, column: 14 })
    out.forEach(c => namesItsText(after, c))
  })

  it('keeps the start when a line break is typed inside a multi-line section', () => {
    const inside = lineAt(FILE, 5) + '        except'.length
    const { after, out } = edit([{ start: inside, end: inside, text: '\n' }])
    expect(out[0]).toMatchObject({ line: 5, endLine: 7 })
    namesItsText(after, out[0])
  })

  it('moves the column when text is typed earlier on the same line', () => {
    const at = lineAt(FILE, 2) + 4
    const { after, out } = edit([{ start: at, end: at, text: 'xx' }])
    expect(out[1]).toMatchObject({ line: 2, column: 16, anchor: 'range(3)' })
    namesItsText(after, out[1])
  })

  it('does not pull text typed at either edge into the section', () => {
    const start = lineAt(FILE, 2) + 13
    const end = start + 'range(3)'.length
    const { out } = edit([{ start, end: start, text: 'L' }, { start: end, end, text: 'R' }], [word()])
    expect(out[0]).toMatchObject({ anchor: 'range(3)', column: 15 })
  })

  it('takes in text typed inside the section', () => {
    const at = lineAt(FILE, 2) + 13 + 'range('.length
    const { out } = edit([{ start: at, end: at + 1, text: 'attempts' }], [word()])
    expect(out[0]).toMatchObject({ anchor: 'range(attempts)', line: 2, column: 14 })
  })

  it('drops the location of a section that was deleted', () => {
    const start = lineAt(FILE, 2) + 13
    const { out } = edit([{ start, end: start + 'range(3)'.length, text: '' }], [word()])
    expect(out[0].line).toBeUndefined()
    expect(out[0].anchor).toBe('range(3)')
  })

  it('returns the same array when nothing moved', () => {
    const cs = [range()]
    const at = lineAt(FILE, 6) + 16
    expect(mapCommentsThroughEdits(cs, FILE, apply(FILE, [{ start: at, end: at, text: '!' }]), [{ start: at, end: at, text: '!' }])).toBe(cs)
  })
})

describe('relocateCommentsByText', () => {
  it('finds a section again after lines were added above it on disk', () => {
    const after = '"""Doc."""\n\nimport logging\n' + FILE
    const out = relocateCommentsByText([range(), word()], FILE, after)
    expect(out[0]).toMatchObject({ line: 8, endLine: 9 })
    expect(out[1]).toMatchObject({ line: 5, column: 14 })
    out.forEach(c => namesItsText(after, c))
  })

  it('picks the occurrence nearest the old position', () => {
    const after = FILE + '\n' + FILE
    expect(relocateCommentsByText([word()], FILE, after)[0]).toMatchObject({ line: 2 })
  })

  it('drops the location when the text is gone', () => {
    const after = FILE.replace('range(3)', 'range(attempts)')
    const out = relocateCommentsByText([word()], FILE, after)
    expect(out[0].line).toBeUndefined()
    expect(out[0].column).toBeUndefined()
  })
})
