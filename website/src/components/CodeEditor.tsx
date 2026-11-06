import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { LineAnnotation } from '@pierre/diffs'
import { ClipboardPaste, Copy, MessageSquarePlus, Redo2, Scissors, TextSelect, TriangleAlert, Undo2 } from 'lucide-react'

import { PierreEditor, type EditorSelectionInfo, type PierreEditorHandle } from '../pierre'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu'
import { ThreadChip } from './CodeBlock'
import type { CodeLineAnnotationMeta } from './codeComments'
import { copyToClipboard } from '../utils/clipboard'
import { isMac } from '../utils/platform'
import { i18nT } from '../i18n/t'

/** Pending comments in the editor, owned by the host. */
export interface EditorCommenting {
  /** One chip per pending comment, under the last line of its range. */
  annotations: CodeLineAnnotationMeta[]
  /** The comment whose chip was last clicked; its chip renders filled. */
  activeId: string | null
  onActivate: (id: string) => void
  /** "Comment on this section": the selection to comment on (the caret's line
   *  when nothing is selected) and where the menu was opened, in viewport px. */
  onComment: (section: EditorSelectionInfo, x: number, y: number) => void
  /** An edit in the editor, as text replacements in offsets into `before`. */
  onEdits: (before: string, after: string, changes: { start: number; end: number; text: string }[]) => void
}

/** The section "Comment on this section" acts on: the selection when there is
 *  one, otherwise the whole line that was right-clicked (or, failing that, the
 *  caret's line). Null when there is neither, e.g. before the editor attached. */
function sectionOf(sel: EditorSelectionInfo | null, clickedLine: number | null, content: string): EditorSelectionInfo | null {
  if (sel?.text) return sel
  const lineNo = clickedLine ?? sel?.startLine
  if (lineNo == null) return null
  const line = content.split('\n')[lineNo - 1] ?? ''
  return { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length + 1, text: line }
}

/** Where the comment box opens for a keyboard comment: under the left edge of
 *  the section's last line (Pierre marks each row with `data-line`), or the
 *  editor's top-left when that row is not rendered. */
function sectionPoint(root: HTMLElement, line: number): { x: number; y: number } {
  for (const host of root.querySelectorAll('diffs-container')) {
    const row = host.shadowRoot?.querySelector(`[data-line="${line}"]`)
    if (row) { const r = row.getBoundingClientRect(); return { x: r.left, y: r.bottom } }
  }
  const r = root.getBoundingClientRect()
  return { x: r.left + 40, y: r.top + 40 }
}

/** The 1-based line under a right-click: Pierre marks each row with `data-line`. */
function clickedLineOf(e: React.MouseEvent): number | null {
  for (const el of e.nativeEvent.composedPath()) {
    const v = el instanceof HTMLElement ? el.dataset.line : undefined
    if (v && /^\d+$/.test(v)) return Number(v)
  }
  return null
}

const mod = isMac ? '⌘' : 'Ctrl+'

/** Pierre-based code editor for editable text content. */
export function CodeEditor({
  content, lang, lineNums, wordWrap, onChange, onSave, flush, editorRef, filePath, diffBase, diffSplit, diffExpandUnchanged, onLiveDiffDegraded, commenting,
}: {
  content: string
  lang: string
  lineNums: boolean
  wordWrap: boolean
  onChange: (v: string) => void
  /** Cmd/Ctrl+S inside the editor surface. */
  onSave?: () => void
  /** Drop the rounded border box — the host surface provides the frame. */
  flush?: boolean
  /** Imperative reveal/focus handle — how a host jumps to a cited line. */
  editorRef?: React.Ref<PierreEditorHandle>
  filePath?: string
  /** Live-diff editing baseline (`null` = new file; `undefined` = plain editor). */
  diffBase?: string | null
  /** Live-diff surface: show unchanged regions instead of folding them. */
  diffExpandUnchanged?: boolean
  /** Split vs unified layout for the live-diff surface. */
  diffSplit?: boolean
  /** Live-diff editing only: whether the live diff was dropped for being
   *  over the inline budget (see `PierreEditorImpl`). */
  onLiveDiffDegraded?: (degraded: boolean) => void
  /** Pending comments: chips under their lines, "Comment on this section" at
   *  the top of the right-click menu, and moved line numbers after each edit.
   *  Absent, the menu has only the edit actions. */
  commenting?: EditorCommenting
}) {
  // Pierre owns the buffer during an edit session. Keep its file identity
  // stable for changes it emitted, but reseed on an external source change.
  const initialRef = useRef<{ key: string; file: { name: string; contents: string; cacheKey: string } }>()
  const lastEmittedRef = useRef<string | null>(null)
  const lastContentRef = useRef<string | null>(null)
  const seedRef = useRef(0)
  // Each comment's line as the editor last reported it; see `lineAnnotations`.
  const liveLinesRef = useRef(new Map<string, number>())
  const key = `${filePath ?? ''}:${lang}:${diffBase === undefined ? 'plain' : 'diff'}`
  const seedFile = () => ({
    key,
    file: {
      name: filePath?.split('/').pop() || `file.${lang}`,
      contents: content,
      cacheKey: `edit:${key}:${seedRef.current}`,
    },
  })
  if (initialRef.current?.key !== key) {
    initialRef.current = seedFile()
  } else if (content !== lastContentRef.current) {
    if (content === lastEmittedRef.current) {
      lastEmittedRef.current = null
    } else {
      seedRef.current++
      initialRef.current = seedFile()
      // A new document from outside: the host's stored lines are the truth again.
      liveLinesRef.current = new Map()
    }
  }
  lastContentRef.current = content
  const handleChange = useCallback((value: string) => {
    lastEmittedRef.current = value
    onChange(value)
  }, [onChange])
  const liveFile = useMemo(
    // `contents` is the live buffer; the seed `cacheKey` stays stable so it is
    // the editing SESSION identity (caret survives typing) and the React remount
    // identity below. PierreEditorImpl owns Pierre's `file` contract: it keeps a
    // seed key that moves only on an outside change and one session file object
    // whose contents it mirrors on edit, so callers do not touch that contract.
    () => ({ ...initialRef.current!.file, contents: content }),
    [content],
  )
  const options = useMemo(
    () => ({
      disableLineNumbers: !lineNums,
      overflow: (wordWrap ? 'wrap' : 'scroll') as 'wrap' | 'scroll',
    }),
    [lineNums, wordWrap],
  )

  // The menu acts on the editor through its handle, so the host's ref and this
  // one both see it.
  const handleRef = useRef<PierreEditorHandle | null>(null)
  useImperativeHandle(editorRef, () => ({
    jumpToLine: (line, endLine) => handleRef.current?.jumpToLine(line, endLine),
    focus: () => handleRef.current?.focus(),
    getSelection: () => handleRef.current?.getSelection() ?? null,
    replaceSelection: text => handleRef.current?.replaceSelection(text),
    selectAll: () => handleRef.current?.selectAll(),
    undo: () => handleRef.current?.undo(),
    redo: () => handleRef.current?.redo(),
  }), [])
  // Where the right-click landed: the comment box opens there.
  const menuPointRef = useRef({ x: 0, y: 0 })
  const menuLineRef = useRef<number | null>(null)

  // The editor owns where each chip is while it is being edited: it moves the
  // chips on every edit and reports the moves. Pierre's File re-applies the
  // `lineAnnotations` prop on EVERY render, so the prop must already carry the
  // moved lines when the next render runs, or that render puts a chip back on
  // the line it just left and the next edit shifts it from there. The reported
  // lines land in this ref synchronously, inside the editor's change callback,
  // before React renders; the host's own copy (via `onAnnotationsMoved`) can
  // trail it by a render.
  // An empty array, not undefined, once the last comment goes: Pierre keeps its
  // previous annotations when the prop is undefined.
  const lineAnnotations: LineAnnotation<unknown>[] | undefined = commenting
    ? commenting.annotations.map(m => ({ lineNumber: liveLinesRef.current.get(m.id) ?? m.line, metadata: m }))
    : undefined
  const activeId = commenting?.activeId ?? null
  const onActivate = commenting?.onActivate
  const renderAnnotation = useCallback((a: LineAnnotation<unknown>) => {
    const m = a.metadata as CodeLineAnnotationMeta
    return <ThreadChip meta={m} active={activeId === m.id} onActivate={id => onActivate?.(id)} />
  }, [activeId, onActivate])
  const handleAnnotationsChange = useCallback((moved: LineAnnotation<unknown>[]) => {
    const next = new Map<string, number>()
    for (const a of moved) next.set((a.metadata as CodeLineAnnotationMeta).id, a.lineNumber)
    liveLinesRef.current = next
  }, [])

  const selectionNow = () => handleRef.current?.getSelection() ?? null

  const commentOnSection = () => {
    if (!commenting) return
    const section = sectionOf(selectionNow(), menuLineRef.current, content)
    if (!section || !section.text.trim()) return
    commenting.onComment(section, menuPointRef.current.x, menuPointRef.current.y)
  }
  /** Cmd/Ctrl+L, as in Kiro IDE: comment on the selection, or the caret's line,
   *  with the comment box opened under that section. */
  const commentFromKeyboard = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!commenting || e.altKey || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey) || e.key.toLowerCase() !== 'l') return
    // Claimed even when there is nothing to comment on, so the browser does not
    // move focus to its address bar from inside the editor.
    e.preventDefault()
    e.stopPropagation()
    const section = sectionOf(selectionNow(), null, content)
    if (!section || !section.text.trim()) return
    const at = sectionPoint(e.currentTarget, section.endLine)
    commenting.onComment(section, at.x, at.y)
  }
  const copySelection = () => { const s = selectionNow(); if (s?.text) void copyToClipboard(s.text) }
  const cutSelection = () => {
    const s = selectionNow()
    if (!s?.text) return
    void copyToClipboard(s.text).then(ok => { if (ok) handleRef.current?.replaceSelection('') })
  }
  // The menu's Paste reads the clipboard API. Where the API is missing (a page
  // that is not a secure context, or an engine with write-only clipboard
  // support) the item is hidden. When the browser refuses the read, a note
  // over the editor names the keyboard paste, which needs no permission.
  const canPasteFromMenu = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText
  const [pasteRefused, setPasteRefused] = useState(false)
  useEffect(() => {
    if (!pasteRefused) return
    const t = setTimeout(() => setPasteRefused(false), 5000)
    return () => clearTimeout(t)
  }, [pasteRefused])
  const paste = () => {
    navigator.clipboard.readText()
      .then(text => { if (text) handleRef.current?.replaceSelection(text) })
      .catch(() => { setPasteRefused(true) })
  }

  return (
    // Non-modal: a modal menu traps focus and blocks the page's pointer events
    // while open, and the editor then does not take focus on the next click.
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          className={`relative w-full h-full overflow-hidden ${flush ? '' : 'border border-border rounded-md'}`}
          onKeyDownCapture={commentFromKeyboard}
          onContextMenuCapture={e => { menuPointRef.current = { x: e.clientX, y: e.clientY }; menuLineRef.current = clickedLineOf(e) }}
        >
          <PierreEditor
            key={initialRef.current.file.cacheKey}
            ref={handleRef}
            file={liveFile}
            options={options}
            onChange={handleChange}
            onSave={onSave}
            diffBase={diffBase}
            diffSplit={diffSplit}
            diffExpandUnchanged={diffExpandUnchanged}
            onLiveDiffDegraded={onLiveDiffDegraded}
            lineAnnotations={lineAnnotations}
            renderAnnotation={commenting ? renderAnnotation : undefined}
            onLineAnnotationsChange={commenting ? handleAnnotationsChange : undefined}
            onEdits={commenting?.onEdits}
          />
          {pasteRefused && (
            <span role="status" data-testid="code-editor-paste-refused" className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated text-warn px-2 py-1 text-[11px] shadow-sm">
              <TriangleAlert size={12} aria-hidden="true" />
              {i18nT('components.codeEditor.paste_refused', { shortcut: `${mod}V` })}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[13rem]"
        // Radix would focus the trigger (the wrapper div), which takes keystrokes
        // away from the editor. A programmatic editor.focus() here is no better:
        // Pierre then ignores the next click's caret move. Leave focus alone; the
        // next click in the editor focuses it with the caret where it lands.
        onCloseAutoFocus={e => { e.preventDefault() }}
        // The Escape that closes this menu must not also reach the file panel's
        // document Escape handler, which would close the file or ask to discard
        // unsaved edits (same rule as `ui/select.tsx`).
        onEscapeKeyDown={e => { e.stopPropagation() }}
      >
        {commenting && (
          <>
            <ContextMenuItem onSelect={commentOnSection}>
              <MessageSquarePlus size={14} aria-hidden="true" />
              <span className="flex-1">{i18nT('components.codeEditor.comment_on_section')}</span>
              <span className="text-muted text-[11px]">{mod}L</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={cutSelection}>
          <Scissors size={14} aria-hidden="true" />
          <span className="flex-1">{i18nT('components.codeEditor.cut')}</span>
          <span className="text-muted text-[11px]">{mod}X</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={copySelection}>
          <Copy size={14} aria-hidden="true" />
          <span className="flex-1">{i18nT('components.codeEditor.copy')}</span>
          <span className="text-muted text-[11px]">{mod}C</span>
        </ContextMenuItem>
        {canPasteFromMenu && (
          <ContextMenuItem onSelect={paste}>
            <ClipboardPaste size={14} aria-hidden="true" />
            <span className="flex-1">{i18nT('components.codeEditor.paste')}</span>
            <span className="text-muted text-[11px]">{mod}V</span>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleRef.current?.selectAll()}>
          <TextSelect size={14} aria-hidden="true" />
          <span className="flex-1">{i18nT('components.codeEditor.select_all')}</span>
          <span className="text-muted text-[11px]">{mod}A</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleRef.current?.undo()}>
          <Undo2 size={14} aria-hidden="true" />
          <span className="flex-1">{i18nT('components.codeEditor.undo')}</span>
          <span className="text-muted text-[11px]">{mod}Z</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleRef.current?.redo()}>
          <Redo2 size={14} aria-hidden="true" />
          <span className="flex-1">{i18nT('components.codeEditor.redo')}</span>
          <span className="text-muted text-[11px]">{isMac ? '⇧⌘Z' : 'Ctrl+Y'}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
