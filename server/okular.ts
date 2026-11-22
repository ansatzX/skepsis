/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Use a rendered PDF line instead of guessing how TeX source appears on the page.
export function uniqueTextAtSyncTeXLocation(layout: string, syncTeX: string) {
  const page = Number(/^Page:(\d+)\s*$/m.exec(syncTeX)?.[1])
  const x = Number(/^x:([^\r\n]+)/m.exec(syncTeX)?.[1])
  const y = Number(/^y:([^\r\n]+)/m.exec(syncTeX)?.[1])
  if (!(page > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return

  const lines: { atLocation: boolean; words: string[] }[] = []
  let line: (typeof lines)[number] | undefined
  for (const row of layout.split('\n')) {
    const [level, rowPage, , , , , left, top, width, height, , word] = row.split('\t')
    if (level === '4') {
      // SyncTeX reports the baseline, which can sit slightly below the glyph box.
      const atLocation =
        Number(rowPage) === page &&
        x >= Number(left) - 8 &&
        x <= Number(left) + Number(width) + 8 &&
        y >= Number(top) - 2 &&
        y <= Number(top) + Number(height) + 2
      line = { atLocation, words: [] }
      lines.push(line)
    } else if (level === '5' && word) {
      line?.words.push(word.trim())
    }
  }
  const matches = lines.filter((candidate) => candidate.atLocation)
  if (matches.length !== 1) return
  const phrase = matches[0]!.words.join(' ').replace(/\s+/g, ' ').trim()
  if (phrase.length < 12 || phrase.length > 180) return

  // Okular's search can move the viewport. Only use it for unique text.
  const document = lines
    .flatMap(({ words }) => words)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  const query = phrase.toLowerCase()
  const first = document.indexOf(query)
  if (first >= 0 && first === document.lastIndexOf(query)) return phrase
}

async function okularHighlight(pdf: string, syncTeX: string | undefined) {
  if (!syncTeX) return
  try {
    const { stdout } = await exec('pdftotext', ['-tsv', '-enc', 'UTF-8', pdf, '-'], {
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024,
    })
    return uniqueTextAtSyncTeXLocation(stdout, syncTeX)
  } catch {
    // A missing extractor or a PDF without searchable text still allows a jump.
    return undefined
  }
}

async function sendLocation(url: string, highlight?: string) {
  const find = highlight ? Buffer.from(highlight).toString('base64') : ''
  const options = `0:0:0:1:0::${find}:`
  const { stdout } = await exec(
    'dbus-send',
    [
      '--session',
      '--dest=org.kde.okular',
      '--print-reply',
      '--reply-timeout=8000',
      '/okularshell',
      'org.kde.okular.openDocument',
      'string:' + url,
      'string:' + options,
    ],
    { timeout: 9000 },
  )
  if (!/^\s*boolean true\s*$/m.test(stdout))
    throw new Error('The existing Okular window did not accept the PDF location.')
}

export function okularViewer(
  root: string,
  openWindow: (url: string, cwd: string, highlight?: string) => Promise<void>,
) {
  let review: { directory: string; main?: string } | undefined
  let queue = Promise.resolve()
  let closed = false

  function open(
    main: string,
    pdf: string,
    source?: { file: string; line: number },
    rebuilt = false,
    syncTeX?: string,
  ) {
    const url = pathToFileURL(pdf)
    if (source) url.hash = `src:${source.line} ${source.file}`
    const run = queue.then(async () => {
      if (closed) throw new Error('The review has closed.')
      const cwd = dirname(pdf)
      if (!review) {
        const directory = join(homedir(), '.local', 'state', 'skepsis', 'okular')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        review = { directory: mkdtempSync(join(directory, 'review-')) }
      }
      if (review.main !== main || rebuilt)
        await rm(join(review.directory, 'selection'), { force: true })
      const highlight = await okularHighlight(pdf, syncTeX)
      if (closed) return
      try {
        await sendLocation(url.href, highlight)
      } catch {
        await openWindow(url.href, cwd, highlight)
      }
      if (closed) return
      const registration = join(review.directory, 'review.json')
      writeFileSync(
        registration + '.tmp',
        JSON.stringify({ root, cwd, pid: process.pid, opened: Date.now() }),
        { mode: 0o600 },
      )
      renameSync(registration + '.tmp', registration)
      review.main = main
    })
    queue = run.catch(() => {})
    return run
  }

  async function selection(main: string) {
    if (review?.main !== main) return null
    const event = await readFile(join(review.directory, 'selection'), 'utf8').catch(
      () => '',
    )
    const [path, rawLine, id] = event.split('\0')
    const line = Number(rawLine)
    return id && path && Number.isSafeInteger(line) && line > 0
      ? { id: basename(id), path, line }
      : null
  }

  return {
    open,
    selection,
    close() {
      closed = true
      if (review) rmSync(review.directory, { recursive: true, force: true })
    },
  }
}
