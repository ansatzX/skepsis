#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { randomUUID } from 'node:crypto'
import { readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

async function jump(file, line) {
  if (!file || !/\.tex$/i.test(file) || !Number.isSafeInteger(line) || line < 1) {
    throw new Error('Usage: skepsis-jump <source.tex> <line>')
  }

  const directory = join(homedir(), '.local', 'state', 'skepsis', 'okular')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('review-'))
      .map(async (entry) => {
        const session = join(directory, entry.name)
        try {
          const { root, cwd, pid, opened } = JSON.parse(
            await readFile(join(session, 'review.json'), 'utf8'),
          )
          if (!Number.isSafeInteger(pid) || pid < 1) return null
          process.kill(pid, 0)
          const path = await realpath(resolve(cwd, file))
          const local = relative(root, path)
          if (
            !local ||
            local === '..' ||
            local.startsWith('..' + sep) ||
            isAbsolute(local)
          ) {
            return null
          }
          return { session, root, path, opened }
        } catch (error) {
          if (error.code === 'ESRCH') await rm(session, { recursive: true, force: true })
          return null
        }
      }),
  )

  const candidates = matches.filter(Boolean)
  candidates.sort((a, b) => b.root.length - a.root.length || b.opened - a.opened)
  const target = candidates[0]
  if (!target) throw new Error('Open this PDF from an active Skepsis paper review first.')
  if (!isAbsolute(file) && candidates.some((candidate) => candidate.path !== target.path)) {
    throw new Error('The relative source path matches multiple Skepsis paper reviews.')
  }
  const id = randomUUID()
  const temporary = join(target.session, id)
  await writeFile(temporary, [target.path, line, id, ''].join('\0'), { mode: 0o600 })
  try {
    await rename(temporary, join(target.session, 'selection'))
  } finally {
    await rm(temporary, { force: true })
  }
}

jump(process.argv[2], Number(process.argv[3])).catch((error) => {
  console.error('skepsis-jump: ' + error.message)
  process.exitCode = 1
})
