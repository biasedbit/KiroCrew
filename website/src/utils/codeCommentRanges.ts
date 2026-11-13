/**
 * Keeping pending comments on a code file attached to the text they were made
 * on, as the file changes before Submit All.
 *
 * A code-editor comment stores where its section starts (`line`, `column`,
 * 1-based) and the section's text (`anchor`); a multi-line section also stores
 * `endLine`. Two kinds of change move a section:
 *   - an edit in the editor, which Pierre reports as text replacements with
 *     offsets into the text before the edit: both ends of each section are
 *     mapped through them (`mapCommentsThroughEdits`);
 *   - a new version of the file from disk (an agent's edit), which comes with no
 *     edit list: each section is found again by its text, at the occurrence
 *     nearest where it was (`relocateCommentsByText`).
 * Either way the stored location ends up naming exactly the stored text, or a
 * comment whose text is gone loses its location rather than keep a wrong one.
 */
import type { InlineComment } from '../components/CommentOverlay'

/** One replacement, in offsets into the text before it. */
export interface TextChange { start: number; end: number; text: string }

/** Whether a pending comment is located on code text (not an image box). */
function isCodeComment(c: InlineComment): c is InlineComment & { line: number; column: number } {
  return c.line != null && c.column != null && !c.image
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** The offset of 1-based `line`, `column`, or null when it is outside `text`. */
function offsetOf(starts: number[], text: string, line: number, column: number): number | null {
  if (line < 1 || line > starts.length) return null
  const off = starts[line - 1] + column - 1
  return off >= 0 && off <= text.length ? off : null
}

/** 1-based line and column of `offset`. */
function positionOf(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 }
}

/** The comment placed at [start, end) of `text`, or without a location when the range is empty. */
function placed(c: InlineComment, text: string, starts: number[], start: number, end: number): InlineComment {
  if (end <= start) {
    const { line: _l, column: _c, endLine: _e, ...rest } = c
    return rest
  }
  const anchor = text.slice(start, end)
  const at = positionOf(starts, start)
  const last = positionOf(starts, end - 1)
  const { endLine: _e, ...rest } = c
  return { ...rest, anchor, line: at.line, column: at.column, ...(last.line > at.line ? { endLine: last.line } : {}) }
}

/**
 * Moves every code comment through one editor edit. `before` is the text the
 * changes' offsets refer to and `after` the text they produce.
 *
 * A section's start stays before text inserted exactly at it, and its end stays
 * before text inserted exactly at it, so typing at either edge does not pull the
 * new text into the comment. Text typed inside a section becomes part of it.
 * A section whose text was deleted entirely loses its location.
 * Returns the same array when no comment changed.
 */
export function mapCommentsThroughEdits(comments: InlineComment[], before: string, after: string, changes: TextChange[]): InlineComment[] {
  if (changes.length === 0) return comments
  // Applied from the last change to the first: a change only moves positions
  // after it, so each earlier change's offsets still refer to `before`.
  const ordered = [...changes].sort((a, b) => b.start - a.start)
  const mapStart = (p: number) => ordered.reduce((q, ch) => q < ch.start ? q : q >= ch.end ? q + ch.text.length - (ch.end - ch.start) : ch.start, p)
  const mapEnd = (p: number) => ordered.reduce((q, ch) => q <= ch.start ? q : q >= ch.end ? q + ch.text.length - (ch.end - ch.start) : ch.start + ch.text.length, p)
  const beforeStarts = lineStarts(before)
  const afterStarts = lineStarts(after)
  let changed = false
  const next = comments.map(c => {
    if (!isCodeComment(c)) return c
    const start = offsetOf(beforeStarts, before, c.line, c.column)
    // A comment whose stored text is not where it says cannot be mapped.
    if (start == null || before.slice(start, start + c.anchor.length) !== c.anchor) return c
    const moved = placed(c, after, afterStarts, mapStart(start), mapEnd(start + c.anchor.length))
    if (moved.line === c.line && moved.column === c.column && moved.endLine === c.endLine && moved.anchor === c.anchor) return c
    changed = true
    return moved
  })
  return changed ? next : comments
}

/**
 * Finds every code comment again in a new version of the file that arrived
 * without an edit list (from disk): the occurrence of its text nearest its old
 * start, ties going to the earlier one. A comment whose text no longer appears
 * loses its location and is sent with its text alone.
 * Returns the same array when no comment changed.
 */
export function relocateCommentsByText(comments: InlineComment[], before: string, after: string): InlineComment[] {
  const beforeStarts = lineStarts(before)
  const afterStarts = lineStarts(after)
  let changed = false
  const next = comments.map(c => {
    if (!isCodeComment(c) || !c.anchor) return c
    const was = offsetOf(beforeStarts, before, c.line, c.column) ?? 0
    let best: number | null = null
    for (let at = after.indexOf(c.anchor); at >= 0; at = after.indexOf(c.anchor, at + 1)) {
      if (best == null || Math.abs(at - was) < Math.abs(best - was)) best = at
    }
    const moved = best == null ? placed(c, after, afterStarts, 0, 0) : placed(c, after, afterStarts, best, best + c.anchor.length)
    if (moved.line === c.line && moved.column === c.column && moved.endLine === c.endLine) return c
    changed = true
    return moved
  })
  return changed ? next : comments
}

/**
 * The range of text a code comment covers, in 1-based lines and columns with
 * an exclusive end, worked out from where it starts and its text. Returns null
 * for a comment with no location or no text.
 */
export function commentRange(c: InlineComment): { line: number; column: number; endLine: number; endColumn: number } | null {
  if (!isCodeComment(c) || !c.anchor) return null
  const lines = c.anchor.split('\n')
  const last = lines[lines.length - 1]
  return lines.length === 1
    ? { line: c.line, column: c.column, endLine: c.line, endColumn: c.column + last.length }
    : { line: c.line, column: c.column, endLine: c.line + lines.length - 1, endColumn: last.length + 1 }
}

/**
 * The pending code comments whose text overlaps `section` (1-based lines and
 * columns, exclusive end), in the order they were added. Text that only
 * touches a section's edge does not overlap it.
 */
export function overlappingComments(
  comments: InlineComment[],
  section: { startLine: number; startColumn: number; endLine: number; endColumn: number },
): InlineComment[] {
  const before = (aLine: number, aCol: number, bLine: number, bCol: number) => aLine < bLine || (aLine === bLine && aCol < bCol)
  return comments.filter(c => {
    const r = c.image ? null : commentRange(c)
    if (!r) return false
    return before(r.line, r.column, section.endLine, section.endColumn) && before(section.startLine, section.startColumn, r.endLine, r.endColumn)
  })
}
