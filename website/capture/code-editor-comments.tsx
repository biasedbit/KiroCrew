/** Isolated capture entry for comments in the side panel's code editor (#18472).
 *
 * Mounts the REAL `MarkdownPanel` for a Python file, in the editor it opens in,
 * with no gateway: the API boundary is a fetch stub, and the two seams that
 * reach the gateway in the product are recorded instead.
 *   - `onSave` writes to `window.__disk` (the file "on disk") and appends to
 *     `window.__saves`;
 *   - `onSubmitComments` appends the message to `window.__sent` and reports it
 *     delivered, as the chat send does.
 * So a driver can check that the line numbers Submit All sends are the lines
 * the saved file has.
 *
 * Query string: ?theme=dark|light
 */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '../src/api/queryClient'
import { Provider } from 'react-redux'
import { initI18n } from '../src/i18n/all'
import '../src/index.css'
import { ThemeProvider } from '../src/hooks/useTheme'
import { store } from '../src/store'
import MarkdownPanel from '../src/components/MarkdownPanel'

initI18n()

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
localStorage.setItem('mc-theme', theme)
localStorage.removeItem('mc-comment-drafts')
document.documentElement.setAttribute('data-theme', theme === 'light' ? 'kiro-light' : 'kiro-dark')

const PATH = '/repo/retry.py'
const INITIAL = [
  'import time',
  '',
  'import requests',
  '',
  '',
  'def fetch_with_retry(url):',
  '    """Fetch a JSON document, retrying when the request fails."""',
  '    for attempt in range(3):',
  '        try:',
  '            response = requests.get(url)',
  '            return response.json()',
  '        except Exception:',
  '            pass',
  '        time.sleep(1)',
  '    return None',
  '',
].join('\n')

declare global {
  interface Window {
    __disk: string; __saves: string[]; __sent: string[]
    /** Another writer (the agent) changes the file on disk. */
    __writeDisk: (text: string) => void
    /** The panel reloads the file from disk, as its watch does for a clean buffer. */
    __reloadFromDisk: () => void
  }
}
window.__disk = INITIAL
window.__saves = []
window.__sent = []

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.includes('/api/')) return realFetch(input, init)
  // The file read answers with the raw file, as the gateway does.
  if (url.includes('/api/file-read')) return new Response(window.__disk, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  const body = url.includes('/api/file-read')
    ? { content: window.__disk, binary: false, partial: false }
    : url.includes('/api/file-diff')
      ? { status: 'unmodified', diff: '', original: window.__disk }
      : url.includes('/api/knowledge/sources') ? [] : {}
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function Panel() {
  const [content, setContent] = useState(INITIAL)
  // What the panel last loaded or saved: the side panel's tab keeps the same.
  const [baseline, setBaseline] = useState(INITIAL)
  window.__writeDisk = text => { window.__disk = text }
  window.__reloadFromDisk = () => { setContent(window.__disk); setBaseline(window.__disk) }
  return (
    <MarkdownPanel
      embedded
      active
      filePath={PATH}
      content={content}
      savedBaseline={baseline}
      onContentChange={setContent}
      onDiskContent={text => { setContent(text); setBaseline(text) }}
      onSave={async (_path, text) => {
        window.__disk = text
        window.__saves.push(text)
        setBaseline(text)
      }}
      onSubmitComments={message => {
        window.__sent.push(message)
        return true
      }}
      onClose={() => {}}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <Provider store={store}>
      <ThemeProvider>
        <MemoryRouter>
          <div data-capture-root style={{ display: 'flex', justifyContent: 'center', height: '100vh', background: 'var(--bg)', color: 'var(--text)', font: '13px system-ui, sans-serif' }}>
            <div style={{ width: 860, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>
              <Panel />
            </div>
          </div>
        </MemoryRouter>
      </ThemeProvider>
    </Provider>
  </QueryClientProvider>,
)
