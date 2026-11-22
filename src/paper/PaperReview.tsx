/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PDF_VIEWERS, WORKING_COPY } from '../../shared/paper.ts'
import { App } from '../App.tsx'
import type {
  PaperFile,
  PaperFileContents,
  PaperVersions,
  PdfSource,
  PdfViewer,
} from '../../shared/paper.ts'
import { usePaperRequest } from './usePaperRequest.ts'
import type { JsonFetch } from './usePaperRequest.ts'
import './paper.css'

const pdfApi = '/api/paper/pdf'
const viewerLabels: Record<PdfViewer, string> = {
  okular: 'Okular',
  sioyek: 'Sioyek',
  zathura: 'Zathura',
}

function Source({
  text,
  anchor,
  openPdf,
}: {
  text: string
  anchor?: number
  openPdf: (line: number) => void
}) {
  const focus = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    focus.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [anchor])
  const lines = text.split(/\r?\n/)
  const offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  return (
    <pre className="paper-source-pane">
      {lines.map((line, index) => {
        const active = index + 1 === anchor
        return (
          <span
            key={offsets[index]}
            ref={active ? focus : undefined}
            className="paper-source-line"
            data-anchor={active || undefined}
          >
            <button
              type="button"
              className="paper-line"
              aria-label={`Find source line ${index + 1} in PDF`}
              onClick={() => openPdf(index + 1)}
            >
              {index + 1}
            </button>
            <span>{line}</span>
          </span>
        )
      })}
    </pre>
  )
}

export function PaperReview({ fetchJson }: { fetchJson: JsonFetch }) {
  const catalog = usePaperRequest<PaperVersions>(fetchJson, '/api/paper/versions')
  const [mainTex, setMainTex] = useState<string>()
  const [viewer, setViewer] = useState<PdfViewer>('okular')
  const [pdfError, setPdfError] = useState('')
  const [openingPdf, setOpeningPdf] = useState(false)
  const openingPdfRef = useRef(false)
  const [pendingJump, setPendingJump] = useState<PdfSource>()
  const [destination, setDestination] = useState<PdfSource>()
  const [okularDocument, setOkularDocument] = useState('')
  const pdfMenu = useRef<HTMLDetailsElement>(null)
  const pdfFiles = usePaperRequest<{ initial: string | null; paths: string[] }>(
    fetchJson,
    pdfApi + '/files',
  )
  const main = mainTex ?? pdfFiles?.data?.initial ?? ''
  const [baseChoice, setBaseChoice] = useState('')
  const [choice, setChoice] = useState('')
  const [source, setSource] = useState<{ path: string; line?: number } | null>(null)
  const data = catalog?.data
  const base = data?.bases.find((item) => item.id === baseChoice) ?? data?.base
  const target = choice || data?.initial || ''
  const targetVersion = data?.targets.find((item) => item.id === target)
  const workingCopy = target === WORKING_COPY
  const workingCopyRef = useRef(workingCopy)
  workingCopyRef.current = workingCopy
  const contents = usePaperRequest<PaperFileContents>(
    fetchJson,
    base && source
      ? `/api/paper/file?${new URLSearchParams({ base: base.id, target: WORKING_COPY, path: source.path })}`
      : null,
  )
  const context =
    workingCopy && source?.line !== undefined && contents?.data?.right != null
      ? { path: source.path, contents: contents.data }
      : undefined
  const located = useMemo(
    () =>
      workingCopy && source?.line !== undefined && contents?.data?.right != null
        ? { path: source.path, line: source.line }
        : undefined,
    [workingCopy, source, contents?.data],
  )
  const showSource =
    source &&
    (!workingCopy ||
      source.line === undefined ||
      contents?.error ||
      contents?.data?.right === null)
  const files = usePaperRequest<PaperFile[]>(
    fetchJson,
    base && workingCopy
      ? `/api/paper/files?${new URLSearchParams({ base: base.id, target })}`
      : null,
  )
  const addedFiles = useMemo(
    () =>
      files?.data?.filter((file) => file.status === 'added').map((file) => file.path) ?? [],
    [files?.data],
  )
  const openSource = useCallback((path: string) => setSource({ path }), [])
  const openFallback = useCallback((anchor: PdfSource) => {
    setSource((current) =>
      current?.path === anchor.path && current.line === anchor.line ? current : anchor,
    )
  }, [])

  async function openPdf(anchor?: PdfSource) {
    if (openingPdfRef.current) return
    if (!main) {
      if (pdfMenu.current) pdfMenu.current.open = true
      setPendingJump(anchor)
      setPdfError('Choose the main TeX file first.')
      return
    }
    setPdfError('')
    openingPdfRef.current = true
    setOpeningPdf(true)
    try {
      await fetchJson(pdfApi + '/open', {
        method: 'POST',
        body: { main, viewer, source: anchor },
      })
      if (viewer === 'okular') setOkularDocument(main)
      setPendingJump(undefined)
      if (pdfMenu.current) pdfMenu.current.open = false
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : String(error))
    } finally {
      openingPdfRef.current = false
      setOpeningPdf(false)
    }
  }

  useEffect(() => {
    if (!okularDocument) return
    let active = true
    let inFlight = false
    let last = ''
    async function poll() {
      if (inFlight) return
      inFlight = true
      try {
        const selection = await fetchJson<(PdfSource & { id: string }) | null>(
          pdfApi + '/selection?' + new URLSearchParams({ main: okularDocument }),
        )
        if (!active || !selection || selection.id === last) return
        last = selection.id
        const anchor = { path: selection.path, line: selection.line }
        if (workingCopyRef.current) {
          setSource(null)
          setDestination(anchor)
        } else {
          setSource(anchor)
        }
      } catch {
        // The review server may have closed.
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => void poll(), 650)
    document.addEventListener('visibilitychange', poll)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [fetchJson, okularDocument])

  return (
    <div className="paper-shell">
      <header className="paper-toolbar">
        <div className="paper-project">
          <h1>{data?.project ?? 'Paper review'}</h1>
        </div>
        {data && (
          <div className="paper-versions">
            <label className="paper-version">
              <span>Fixed base</span>
              <select
                value={base?.id}
                onChange={(event) => {
                  setBaseChoice(event.target.value)
                  setSource(null)
                  setDestination(undefined)
                }}
              >
                {data.bases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.commit.slice(0, 7)}
                  </option>
                ))}
              </select>
            </label>
            <label className="paper-version">
              <span>Compare with</span>
              <select
                value={target}
                onChange={(event) => {
                  setChoice(event.target.value)
                  setSource(null)
                  setDestination(undefined)
                }}
              >
                <option value={WORKING_COPY}>Working copy</option>
                {data.targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.commit.slice(0, 7)}
                  </option>
                ))}
              </select>
            </label>
            <details className="paper-pdf-menu" ref={pdfMenu}>
              <summary>PDF</summary>
              <div className="paper-pdf-options">
                <label className="paper-version">
                  <span>Main TeX file</span>
                  <select
                    value={main}
                    onChange={(event) => {
                      setMainTex(event.target.value)
                      setPdfError('')
                    }}
                  >
                    <option value="">Choose a project file</option>
                    {pdfFiles?.data?.paths.map((file) => (
                      <option key={file} value={file}>
                        {file}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="paper-version">
                  <span>PDF reader</span>
                  <select
                    value={viewer}
                    onChange={(event) => setViewer(event.target.value as PdfViewer)}
                  >
                    {PDF_VIEWERS.map((reader) => (
                      <option key={reader} value={reader}>
                        {viewerLabels[reader]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!main || openingPdf}
                  onClick={() => void openPdf(pendingJump)}
                >
                  {pendingJump ? 'Jump to PDF' : 'Open PDF'}
                </button>
              </div>
            </details>
          </div>
        )}
        {openingPdf && (
          <p className="paper-pdf-progress" role="status">
            Preparing PDF…
          </p>
        )}
        {(pdfError || pdfFiles?.error) && (
          <p className="paper-pdf-error" role="alert">
            {pdfError || pdfFiles?.error}
          </p>
        )}
      </header>
      {catalog?.error ? (
        <p className="paper-message" role="alert">
          {catalog.error}
        </p>
      ) : !base ? (
        <p className="paper-message" role="status">
          Loading paper versions…
        </p>
      ) : (
        <div className="paper-workspace">
          <div className="paper-native" hidden={Boolean(showSource)}>
            <App
              key={`${base.commit}:${targetVersion?.commit ?? target}`}
              review={{ base: base.id, target }}
              paper={{
                addedFiles,
                open: workingCopy ? openSource : undefined,
                forward: workingCopy ? (anchor) => void openPdf(anchor) : undefined,
                destination: workingCopy ? (located ?? destination) : undefined,
                context,
                fallback: openFallback,
              }}
            />
          </div>
          {showSource && (
            <section className="paper-source-panel" aria-label="PDF source">
              <header className="paper-file-header">
                <h2>{source.path}</h2>
                <button
                  type="button"
                  className="viewed-button"
                  onClick={() => setSource(null)}
                >
                  Back to changes
                </button>
              </header>
              {contents?.error ? (
                <p className="paper-message" role="alert">
                  {contents.error}
                </p>
              ) : !contents?.data ? (
                <p className="paper-message" role="status">
                  Loading source…
                </p>
              ) : contents.data.right === null ? (
                <p className="paper-message">File absent in the working copy.</p>
              ) : (
                <Source
                  text={contents.data.right}
                  anchor={source.line}
                  openPdf={(line) => void openPdf({ path: source.path, line })}
                />
              )}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
