/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { PDF_VIEWERS } from '../shared/paper.ts'
import { sendGate } from './gate.ts'
import { okularViewer } from './okular.ts'

const exec = promisify(execFile)
const unzip = promisify(gunzip)
// Readers may hand off to an existing window and exit successfully.
const VIEWER_STARTUP_MS = 350
const COMPILE_TIMEOUT_MS = 120_000

class PaperPdfError extends Error {}

function openViewer(command: string, args: string[], cwd: string) {
  return new Promise<void>((ready, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' })
    const startup = setTimeout(() => {
      child.unref()
      ready()
    }, VIEWER_STARTUP_MS)
    child.once('error', (error) => {
      clearTimeout(startup)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(startup)
      if (code === 0) ready()
      else reject(new Error(`${command} failed to open the PDF.`))
    })
  })
}

export async function paperPdfRoutes(directory: string, mainTex?: string) {
  const root = await realpath(directory)
  const builds = new Map<string, Promise<boolean>>()
  const initial = mainTex
    ? await projectFile(mainTex, /\.tex$/i).catch(() => {
        throw new Error('--main-tex must name a .tex file inside the Git project.')
      })
    : null

  async function projectFile(path: string, extension: RegExp) {
    const file = await realpath(resolve(root, path))
    const local = relative(root, file)
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..' + sep) ||
      !extension.test(local) ||
      !(await stat(file)).isFile()
    ) {
      throw new Error('Expected a file inside the paper project.')
    }
    return local
  }

  async function files() {
    const { stdout } = await exec(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ':(icase,glob)**/*.tex',
      ],
      { cwd: root, timeout: 10_000 },
    )
    return [
      ...new Set([...(initial ? [initial] : []), ...stdout.split('\0').filter(Boolean)]),
    ]
  }

  async function documentFor(choice: string | undefined) {
    const main = await projectFile(choice ?? initial ?? '', /\.tex$/i)
    const pdfPath = main.replace(/\.tex$/i, '.pdf')
    const cwd = dirname(resolve(root, main))
    return {
      main,
      pdfPath,
      cwd,
      recorder: resolve(root, main.replace(/\.tex$/i, '.fls')),
      pdf: async () => resolve(root, await projectFile(pdfPath, /\.pdf$/i)),
    }
  }

  type Document = Awaited<ReturnType<typeof documentFor>>

  function mappingFile(pdfPath: string) {
    const stem = pdfPath.replace(/\.pdf$/i, '.synctex')
    return projectFile(stem + '.gz', /\.synctex\.gz$/i).catch(() =>
      projectFile(stem, /\.synctex$/i),
    )
  }

  async function recordedInputs(document: Document, recorder: string, mapping?: string) {
    const data = await readFile(recorder, 'utf8').catch(() => '')
    const inputs = [...data.matchAll(/^INPUT (.+)$/gm)].map((entry) => entry[1]!)
    if (!inputs.length && mapping) {
      // Some external compilers leave a SyncTeX map without a recorder file.
      const bytes = await readFile(resolve(root, mapping))
      const text = (mapping.endsWith('.gz') ? await unzip(bytes) : bytes).toString()
      for (const entry of text.matchAll(/^Input:\d+:(.+)$/gm)) inputs.push(entry[1]!)
    }
    const outputs = new Set(
      [...data.matchAll(/^OUTPUT (.+)$/gm)].map((entry) =>
        resolve(document.cwd, entry[1]!),
      ),
    )
    return new Set(
      inputs
        .map((input) => resolve(document.cwd, input))
        .filter((input) => {
          const local = relative(root, input)
          return (
            local &&
            !isAbsolute(local) &&
            local !== '..' &&
            !local.startsWith('..' + sep) &&
            !outputs.has(input)
          )
        }),
    )
  }

  async function needsBuild(document: Document, source?: string) {
    try {
      const [pdf, mapping] = await Promise.all([
        document.pdf(),
        mappingFile(document.pdfPath),
      ])
      const [pdfInfo, mapInfo, inputs] = await Promise.all([
        stat(pdf),
        stat(resolve(root, mapping)),
        recordedInputs(document, document.recorder, mapping),
      ])
      inputs.add(resolve(root, document.main))
      if (source) inputs.add(resolve(root, source))
      const latest = Math.min(pdfInfo.mtimeMs, mapInfo.mtimeMs)
      const changes = await Promise.all(
        [...inputs].map(async (input) => (await stat(input)).mtimeMs > latest),
      )
      return changes.some(Boolean)
    } catch {
      return true
    }
  }

  async function compile(document: Document) {
    const staging = await mkdtemp(join(document.cwd, '.skepsis-latex-'))
    const target = basename(document.main)
    const stem = target.replace(/\.tex$/i, '')
    const started = Date.now()
    try {
      await exec(
        'latexmk',
        [
          '-norc',
          '-pdf',
          '-synctex=1',
          '-recorder',
          '-interaction=nonstopmode',
          '-halt-on-error',
          '-file-line-error',
          '-latexoption=-no-shell-escape',
          '-outdir=' + staging,
          './' + target,
        ],
        { cwd: document.cwd, timeout: COMPILE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      )
      const pdf = join(staging, stem + '.pdf')
      const mapping = join(staging, stem + '.synctex.gz')
      const recorder = join(staging, stem + '.fls')
      await Promise.all([stat(pdf), stat(mapping), stat(recorder)])
      const records = (await readFile(recorder, 'utf8')).split(/\r?\n/)
      await writeFile(
        recorder,
        records
          .filter((line) => {
            const match = /^(?:INPUT|OUTPUT) (.+)$/.exec(line)
            return !match || !resolve(document.cwd, match[1]!).startsWith(staging + sep)
          })
          .join('\n'),
      )
      const inputs = await recordedInputs(document, recorder)
      inputs.add(resolve(root, document.main))
      const modifiedDuringBuild = await Promise.all(
        [...inputs].map(async (input) => (await stat(input)).mtimeMs > started),
      )
      if (modifiedDuringBuild.some(Boolean))
        throw new PaperPdfError(
          'The source changed during compilation. Open the PDF again to use the latest revision.',
        )
      await rename(recorder, document.recorder)
      await rename(
        mapping,
        resolve(root, document.pdfPath.replace(/\.pdf$/i, '.synctex.gz')),
      )
      await rename(pdf, resolve(root, document.pdfPath))
    } catch (error) {
      if (error instanceof PaperPdfError) throw error
      const failure = error as { code?: string; killed?: boolean; stdout?: string }
      if (failure.code === 'ENOENT')
        throw new PaperPdfError('Install latexmk to compile this PDF.')
      if (failure.killed)
        throw new PaperPdfError('The PDF build timed out after two minutes.')
      const detail = failure.stdout
        ?.split('\n')
        .find((line) => /^\..*\.tex:\d+: |^! /.test(line))
      throw new PaperPdfError(
        detail
          ? `PDF compilation failed. ${detail}`
          : 'PDF compilation failed. Check the selected main TeX file.',
      )
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  function ensureOutput(document: Document, source?: string) {
    const pending = builds.get(document.main)
    if (pending) return pending
    const running = (async () => {
      if (!(await needsBuild(document, source))) return false
      await compile(document)
      return true
    })().finally(() => builds.delete(document.main))
    builds.set(document.main, running)
    return running
  }

  const desktop = okularViewer(root, (url, cwd) =>
    openViewer('okular', ['--unique', url], cwd),
  )
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.get('/files', async (c) => {
    const paths = await files()
    const compiled = initial
      ? []
      : await Promise.all(
          paths.map(async (path) => {
            try {
              const document = await documentFor(path)
              await document.pdf()
              await mappingFile(document.pdfPath)
              return path
            } catch {
              return null
            }
          }),
        )
    const candidates = compiled.filter((path) => path !== null)
    return c.json({
      initial: initial ?? (candidates.length === 1 ? candidates[0] : null),
      paths,
    })
  })

  app.post(
    '/open',
    async (c, next) => {
      if (!sendGate({ host: c.req.header('host'), origin: c.req.header('origin') }))
        return c.json({ error: 'Open the PDF from the local Skepsis page.' }, 403)
      await next()
    },
    zValidator(
      'json',
      z.object({
        main: z.string(),
        viewer: z.enum(PDF_VIEWERS),
        source: z
          .object({ path: z.string(), line: z.number().int().positive() })
          .optional(),
      }),
    ),
    async (c) => {
      const request = c.req.valid('json')
      try {
        const document = await documentFor(request.main)
        const { main, cwd } = document
        const path = request.source
          ? await projectFile(request.source.path, /\.tex$/i)
          : undefined
        const rebuilt = await ensureOutput(document, path)
        const file = await document.pdf()
        let anchor: { file: string; line: number } | undefined
        if (request.source && path) {
          anchor = { file: resolve(root, path), line: request.source.line }
          const { stdout } = await exec(
            'synctex',
            ['view', '-i', `${anchor.line}:1:${anchor.file}`, '-o', file],
            { cwd, timeout: 5000 },
          )
          if (!/^Page:[1-9]\d*\s*$/m.test(stdout))
            throw new PaperPdfError(
              'This source line has no PDF location. Check that the selected main TeX file includes it.',
            )
        }
        switch (request.viewer) {
          case 'okular':
            await desktop.open(main, file, anchor, rebuilt)
            break
          case 'sioyek':
            await openViewer(
              'sioyek',
              [
                '--new-window',
                ...(anchor
                  ? [
                      '--forward-search-file',
                      anchor.file,
                      '--forward-search-line',
                      String(anchor.line),
                    ]
                  : []),
                file,
              ],
              cwd,
            )
            break
          case 'zathura':
            await openViewer(
              'zathura',
              [
                ...(anchor ? ['--synctex-forward', anchor.line + ':1:' + anchor.file] : []),
                file,
              ],
              cwd,
            )
            break
        }
        return c.json({ ok: true })
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof PaperPdfError
                ? error.message
                : 'Could not open the PDF. Check the selected reader and main TeX file.',
          },
          422,
        )
      }
    },
  )
  app.get('/selection', async (c) => {
    try {
      const document = await documentFor(c.req.query('main'))
      const { main, cwd } = document
      const selection = await desktop.selection(main)
      if (!selection) return c.json(null)
      const path = await projectFile(resolve(cwd, selection.path), /\.tex$/i)
      if (builds.has(main) || (await needsBuild(document, path))) return c.json(null)
      return c.json({
        id: selection.id,
        path,
        line: selection.line,
      })
    } catch {
      return c.json(null)
    }
  })
  return { app, close: desktop.close }
}
