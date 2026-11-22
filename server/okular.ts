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

async function sendLocation(url: string) {
  const options = '0:0:0:1:0:::'
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
  openWindow: (url: string, cwd: string) => Promise<void>,
) {
  let review: { directory: string; main?: string } | undefined
  let queue = Promise.resolve()
  let closed = false

  function open(
    main: string,
    pdf: string,
    source?: { file: string; line: number },
    rebuilt = false,
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
      try {
        await sendLocation(url.href)
      } catch {
        await openWindow(url.href, cwd)
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
