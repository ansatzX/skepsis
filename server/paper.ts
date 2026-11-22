/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { WORKING_COPY } from '../shared/paper.ts'
import type {
  PaperFile,
  PaperFileContents,
  PaperRevision,
  PaperVersions,
} from '../shared/paper.ts'

import type { DiffArgs } from '../shared/types.ts'
import { paperPdfRoutes } from './paperPdf.ts'

export interface PaperOptions {
  base: string
  target?: string
  mainTex?: string
}

const exec = promisify(execFile)
const MAX_SOURCE_BYTES = 512 * 1024

/** Only Git object IDs derived from the selected revisions may reach cat-file. */
export async function paperRoutes(directory: string, options: PaperOptions) {
  const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: directory })
  const root = await realpath(stdout.replace(/\r?\n$/, ''))
  const git = async (args: string[], maxBuffer = 4 * 1024 * 1024) =>
    (await exec('git', args, { cwd: root, maxBuffer, timeout: 10_000 })).stdout

  async function revision(id: string, label: string, ref: string): Promise<PaperRevision> {
    try {
      const output = await git([
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${ref}^{commit}`,
      ])
      return { id, label, commit: output.trim() }
    } catch {
      throw new Error(`Paper review needs a Git commit, branch, or tag: ${ref}`)
    }
  }

  const base = await revision('base', options.base, options.base)
  const initial = options.target
    ? await revision('target', options.target, options.target)
    : undefined
  const refs = await git([
    'for-each-ref',
    '--format=%(refname)%09%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)',
    'refs/heads',
    'refs/tags',
    'refs/remotes',
  ])
  const choices: PaperRevision[] = []
  for (const line of refs.split('\n')) {
    const [id, label, type, object, peeledType, peeled] = line.split('\t')
    const commit = type === 'commit' ? object : peeledType === 'commit' ? peeled : undefined
    if (id && label && commit) choices.push({ id, label, commit })
  }

  async function tree(commit: string): Promise<Map<string, string>> {
    const entries = await git(['ls-tree', '-r', '-z', '--full-tree', commit])
    const result = new Map<string, string>()
    for (const entry of entries.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab < 0) continue
      const [mode, type, oid] = entry.slice(0, tab).split(' ')
      const path = entry.slice(tab + 1)
      if (
        type === 'blob' &&
        (mode === '100644' || mode === '100755') &&
        /\.tex$/i.test(path) &&
        oid
      ) {
        result.set(path, oid)
      }
    }
    return result
  }

  const head = await revision('head', 'HEAD', 'HEAD')
  const revisions = [head, ...choices]
  const bases = [base, ...revisions.filter((item) => item.label !== base.label)]
  const targets = initial
    ? [initial, ...revisions.filter((item) => item.label !== initial.label)]
    : revisions
  const byBase = new Map(bases.map((item) => [item.id, item]))
  const byTarget = new Map(targets.map((item) => [item.id, item]))
  function diffFor(baseId: string, targetId = WORKING_COPY): DiffArgs | undefined {
    const from = byBase.get(baseId)
    const to = byTarget.get(targetId)
    if (!from || (!to && targetId !== WORKING_COPY)) return undefined
    return {
      vcs: 'git',
      args: to ? [from.commit, to.commit] : [from.commit],
      displayArgs: to ? [from.label, to.label] : [from.label],
      toWorkingCopy: !to,
      files: [],
      endpoints: { left: from.commit, right: to ? { rev: to.commit } : 'workingCopy' },
    }
  }

  // Reuse the two selected trees across the list and file requests.
  const trees = new Map<string, Promise<Map<string, string>>>()
  function revisionTree(commit: string) {
    const existing = trees.get(commit)
    if (existing) return existing
    if (trees.size >= 2) {
      const oldest = trees.keys().next().value
      if (oldest !== undefined) trees.delete(oldest)
    }
    const entries = tree(commit).catch((error: unknown) => {
      if (trees.get(commit) === entries) trees.delete(commit)
      throw error
    })
    trees.set(commit, entries)
    return entries
  }

  async function worktreeFiles(from: PaperRevision, left: Map<string, string>) {
    const [changes, untracked] = await Promise.all([
      git(['diff', '--name-status', '-z', '--no-renames', from.commit, '--']),
      git([
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        '--',
        ':(icase,glob)**/*.tex',
      ]),
    ])
    const fields = changes.split('\0')
    const result = new Map<string, PaperFile['status']>(
      Array.from(left.keys(), (path) => [path, 'unchanged']),
    )
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [status, path] = [fields[i], fields[i + 1]]
      if (!path || !/\.tex$/i.test(path)) continue
      result.set(path, status === 'D' ? 'deleted' : left.has(path) ? 'modified' : 'added')
    }
    for (const path of untracked.split('\0')) {
      if (path) result.set(path, left.has(path) ? 'modified' : 'added')
    }
    return result
  }

  async function worktreeText(path: string) {
    const file = resolve(root, path)
    // The name comes from Git. Also reject symlinks in the path on disk.
    if ((await realpath(file)) !== file) throw new Error('Working file is a symlink.')
    const entry = await lstat(file)
    if (!entry.isFile() || entry.size > MAX_SOURCE_BYTES)
      throw new Error('Unreadable file.')
    return readFile(file, 'utf8')
  }

  const app = new Hono()
  const pdf = await paperPdfRoutes(root, options.mainTex)
  app.route('/pdf', pdf.app)
  app.get('/versions', (c) =>
    c.json({
      project: basename(root),
      base,
      bases,
      initial: initial?.id ?? WORKING_COPY,
      targets,
    } satisfies PaperVersions),
  )
  app.get('/files', async (c) => {
    const from = byBase.get(c.req.query('base') ?? base.id)
    const targetId = c.req.query('target')
    const target = byTarget.get(targetId ?? '')
    if (!from || (!target && targetId !== WORKING_COPY))
      return c.json({ error: 'Unknown paper version.' }, 404)
    const left = await revisionTree(from.commit)
    if (!target) {
      const statuses = await worktreeFiles(from, left)
      return c.json(
        Array.from(statuses.keys())
          .toSorted()
          .map(
            (path) =>
              ({
                path,
                status: statuses.get(path)!,
              }) satisfies PaperFile,
          ),
      )
    }
    const right = await revisionTree(target.commit)
    const paths = Array.from(new Set([...left.keys(), ...right.keys()])).toSorted()
    return c.json(
      paths.map((path): PaperFile => {
        const before = left.get(path)
        const after = right.get(path)
        const status =
          before === after
            ? 'unchanged'
            : !before
              ? 'added'
              : !after
                ? 'deleted'
                : 'modified'
        return { path, status }
      }),
    )
  })
  app.get('/file', async (c) => {
    const from = byBase.get(c.req.query('base') ?? base.id)
    const targetId = c.req.query('target')
    const target = byTarget.get(targetId ?? '')
    if (!from || (!target && targetId !== WORKING_COPY))
      return c.json({ error: 'Unknown paper version.' }, 404)
    const path = c.req.query('path') ?? ''
    const left = await revisionTree(from.commit)
    const before = left.get(path)
    const blob = async (oid: string | undefined) =>
      oid ? git(['cat-file', 'blob', oid], MAX_SOURCE_BYTES) : null
    try {
      if (!target) {
        const status = (await worktreeFiles(from, left)).get(path)
        if (!status) return c.json({ error: 'File is not in the paper comparison.' }, 404)
        const [oldText, newText] = await Promise.all([
          blob(before),
          status === 'deleted' ? null : worktreeText(path),
        ])
        return c.json({ left: oldText, right: newText } satisfies PaperFileContents)
      }
      const after = (await revisionTree(target.commit)).get(path)
      if (!before && !after)
        return c.json({ error: 'File is not in either paper version.' }, 404)
      const [oldText, newText] = await Promise.all([
        blob(before),
        before === after ? null : blob(after),
      ])
      return c.json({
        left: oldText,
        right: before === after ? oldText : newText,
      } satisfies PaperFileContents)
    } catch {
      return c.json(
        { error: 'File could not be read or exceeds the 512 KiB review limit.' },
        422,
      )
    }
  })
  return { app, diffFor, close: pdf.close }
}
