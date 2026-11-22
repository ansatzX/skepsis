/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { exec, startCli } from '../server/testUtil.ts'

test('reflows TeX in the native diff and preserves a draft across PDF jumps and base aliases', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-paper-test-'))
  const sections = join(directory, 'sections')
  const git = (...args: string[]) =>
    exec(
      'git',
      [
        '-c',
        'user.name=Paper test',
        '-c',
        'user.email=paper@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: directory },
    )
  let proc: Awaited<ReturnType<typeof startCli>>['proc'] | undefined
  try {
    await git('init', '-q', '-b', 'main')
    await mkdir(sections)
    const file = join(sections, 'results.tex')
    const unchanged = join(sections, 'unchanged.tex')
    const notes = join(sections, 'notes.md')
    const context = Array.from({ length: 30 }, (_, i) => `Context line ${i + 2}.\n`).join(
      '',
    )
    await writeFile(file, 'Original result.\n' + context)
    await writeFile(unchanged, 'Background line.\n')
    await writeFile(notes, 'Old notes.\n')
    await git('add', '.')
    await git('commit', '-qm', 'Initial paper')
    await git('tag', 'base')
    await git('tag', 'same-base')
    const changed = 'Measured at 0.25 eV. The residual was small.'
    await writeFile(file, changed + '\n' + context)
    await writeFile(notes, 'First note. Second note.\n')
    await writeFile(join(sections, 'untracked.tex'), 'New working copy source.\n')
    const instance = await startCli(sections, [
      '--paper',
      '--main-tex',
      'sections/results.tex',
    ])
    proc = instance.proc
    let selection: { id: string; path: string; line: number } | null = null
    let forward: { path: string; line: number } | undefined
    await page.route('**/api/paper/pdf/open', (route) => {
      forward = route.request().postDataJSON().source
      return route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/paper/pdf/selection?*', (route) =>
      route.fulfill({ json: selection }),
    )
    await page.goto(instance.url)
    await page.getByLabel('Fixed base').selectOption('refs/tags/base')
    await expect(page.getByText('git diff base', { exact: true })).toBeVisible()
    const tex = page.locator('diffs-container').filter({ hasText: 'sections/results.tex' })
    const jump = tex.getByRole('button', { name: 'Find source line 1 in PDF', exact: true })
    await jump.click()
    await expect.poll(() => forward).toEqual({ path: 'sections/results.tex', line: 1 })
    const row = tex
      .locator('[data-additions] [data-content] [data-line]')
      .filter({ hasText: changed })
    await expect(row.locator('br[data-tex-break]')).toHaveCount(1)
    expect(await row.textContent()).toBe(changed)
    const plain = page.locator('diffs-container').filter({ hasText: 'sections/notes.md' })
    await expect(
      plain.locator('[data-content]').filter({ hasText: 'First note. Second note.' }),
    ).toBeVisible()
    await expect(plain.locator('[data-tex-break]')).toHaveCount(0)

    const line = tex.locator('[data-additions] [data-column-number="1"]')
    await line.hover()
    await line.locator('[data-gutter-utility-slot]').click({ timeout: 5000 })
    const draft = page.getByPlaceholder('Leave a review comment')
    await draft.fill('Please check the wording.')
    await page.getByLabel('Fixed base').selectOption('refs/tags/same-base')
    await expect(page.getByText('git diff same-base', { exact: true })).toBeVisible()
    await expect(draft).toHaveValue('Please check the wording.')

    selection = { id: 'pdf-return-diff', path: 'sections/results.tex', line: 24 }
    const active = tex.locator('[data-line][data-editor-active-line]')
    await expect(active).toHaveText('Context line 24.')
    await expect(active).toBeInViewport()
    await expect(page.getByRole('region', { name: 'PDF source' })).toHaveCount(0)
    selection = { id: 'pdf-return-source', path: 'sections/unchanged.tex', line: 1 }
    const unchangedDiff = page
      .locator('diffs-container')
      .filter({ hasText: 'sections/unchanged.tex' })
    await expect(
      unchangedDiff.locator('[data-additions] [data-line][data-editor-active-line]'),
    ).toHaveText('Background line.')
    await expect(unchangedDiff.locator('[data-deletions] [data-line]')).toHaveText(
      'Background line.',
    )
    await expect(
      unchangedDiff.locator('[data-content] [data-line-type="change-addition"]'),
    ).toHaveCount(0)
    await expect(
      page.getByRole('treeitem', { name: 'unchanged.tex', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: 'PDF source' })).toHaveCount(0)
    await expect(page.getByText('git diff same-base', { exact: true })).toBeVisible()
    selection = { id: 'pdf-return-untracked', path: 'sections/untracked.tex', line: 1 }
    const untrackedDiff = page
      .locator('diffs-container')
      .filter({ hasText: 'sections/untracked.tex' })
    await expect(untrackedDiff.locator('[data-line][data-editor-active-line]')).toHaveText(
      'New working copy source.',
    )
    await writeFile(join(sections, 'untracked.tex'), 'Refreshed working copy source.\n')
    selection = { id: 'pdf-return-refreshed', path: 'sections/untracked.tex', line: 1 }
    await expect(untrackedDiff.locator('[data-line][data-editor-active-line]')).toHaveText(
      'Refreshed working copy source.',
    )
    await expect(page.getByRole('region', { name: 'PDF source' })).toHaveCount(0)
    await expect(draft).toHaveValue('Please check the wording.')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resolve comment' })).toBeVisible()
    expect(await readFile(file, 'utf8')).toContain('% Please check the wording.')
  } finally {
    if (proc?.exitCode === null) {
      const exit = new Promise<void>((resolve) => proc?.once('exit', () => resolve()))
      proc.kill()
      await exit
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('rebuilds stale PDF and SyncTeX for external readers and keeps the last good build', async ({
  page,
}) => {
  const tools = ['latexmk']
  const installed = await Promise.all(
    tools.map((tool) =>
      exec('which', [tool]).then(
        () => true,
        () => false,
      ),
    ),
  )
  test.skip(installed.includes(false), 'TeX Live is required for the PDF fixture')

  const directory = await mkdtemp(join(tmpdir(), 'skepsis-paper-preview-'))
  const git = (...args: string[]) => exec('git', args, { cwd: directory })
  let proc: Awaited<ReturnType<typeof startCli>>['proc'] | undefined
  try {
    await mkdir(join(directory, 'sections'))
    await writeFile(
      join(directory, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\input{sections/results}\n\\end{document}\n',
    )
    await writeFile(
      join(directory, 'sections/results.tex'),
      '\\section{Results}\nThis is the first sentence.\nThis is the second sentence.\n',
    )
    await git('init', '-q', '-b', 'main')
    await git('add', '.')
    await git(
      '-c',
      'user.name=Paper test',
      '-c',
      'user.email=paper@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Paper fixture',
    )
    await writeFile(join(directory, 'sections/unused.tex'), 'Unmapped source.\n')
    await exec('latexmk', ['-norc', '-pdf', '-synctex=1', '-halt-on-error', 'main.tex'], {
      cwd: directory,
    })
    const pdf = join(directory, 'main.pdf')
    const mapping = join(directory, 'main.synctex.gz')
    const originalMapping = (await stat(mapping)).mtimeMs

    const bin = join(directory, 'bin')
    const capture = join(directory, 'reader-args')
    await mkdir(bin)
    await Promise.all(
      ['sioyek', 'zathura'].map((reader) =>
        writeFile(
          join(bin, reader),
          '#!/bin/sh\nprintf "%s\\n" "$@" >"$READER_CAPTURE"\n',
          { mode: 0o700 },
        ),
      ),
    )
    const source = join(directory, 'sections/results.tex')
    const modified =
      '\\section{Results}\nThis is the first revised sentence.\nThis is the second sentence.\n'
    await writeFile(source, modified)
    const sourceTime = new Date(2000, 0, 1)
    await utimes(join(directory, 'sections/unused.tex'), sourceTime, sourceTime)
    const instance = await startCli(directory, ['--paper'], {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      READER_CAPTURE: capture,
    })
    proc = instance.proc
    await page.goto(instance.url)
    await expect(page.getByRole('button', { name: 'PDF preview' })).toHaveCount(0)
    await page.locator('.paper-pdf-menu summary').click()
    const mainFile = page.getByLabel('Main TeX file')
    await expect(mainFile).toHaveValue('main.tex')
    await page.getByLabel('PDF reader').selectOption('sioyek')
    await page.getByRole('button', { name: 'Open PDF', exact: true }).click()
    const captured = () => readFile(capture, 'utf8').catch(() => '')
    await expect.poll(captured).toContain(pdf)
    const afterOpen = (await stat(mapping)).mtimeMs
    expect(afterOpen).toBeGreaterThan(originalMapping)
    await expect(
      page
        .getByLabel('Main TeX file')
        .locator('option', { hasText: 'sections/unused.tex' }),
    ).toHaveCount(1)
    await page.getByRole('treeitem', { name: 'unused.tex', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'sections/unused.tex' })).toBeVisible()
    await page
      .getByRole('button', { name: 'Find source line 1 in PDF', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      'This source line has no PDF location',
    )
    expect(await captured()).not.toContain('unused.tex')
    await page.getByRole('button', { name: 'Back to changes' }).click()
    const withComment = modified.replace('\n', '\n% Inserted review comment.\n')
    await writeFile(source, withComment)
    await page.getByRole('button', { name: 'PDF source', exact: true }).click()
    await page
      .getByRole('button', { name: 'Find source line 3 in PDF', exact: true })
      .click()
    await expect
      .poll(captured)
      .toContain(
        '--forward-search-file\n' +
          join(directory, 'sections/results.tex') +
          '\n--forward-search-line\n3\n',
      )
    const afterJump = (await stat(mapping)).mtimeMs
    expect(afterJump).toBeGreaterThan(afterOpen)
    await page.locator('.paper-pdf-menu summary').click()
    await expect(mainFile).toHaveValue('main.tex')
    await page.getByLabel('PDF reader').selectOption('zathura')
    await page.locator('.paper-pdf-menu summary').click()
    await page
      .getByRole('button', { name: 'Find source line 3 in PDF', exact: true })
      .click()
    await expect.poll(captured).toContain('--synctex-forward\n3:1:' + source)
    expect((await stat(mapping)).mtimeMs).toBe(afterJump)

    const lastPdf = await readFile(pdf)
    const lastMapping = await readFile(mapping)
    await writeFile(source, withComment + '\\UnknownSkepsisTestCommand\n')
    await page.locator('.paper-pdf-menu summary').click()
    await page.getByRole('button', { name: 'Open PDF', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('PDF compilation failed')
    expect((await readFile(pdf)).equals(lastPdf)).toBe(true)
    expect((await readFile(mapping)).equals(lastMapping)).toBe(true)
    await writeFile(source, withComment)
    await writeFile(join(bin, 'zathura'), '#!/bin/sh\nexit 7\n')
    await page.getByRole('button', { name: 'Open PDF', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Could not open the PDF')
    await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible()
  } finally {
    if (proc?.exitCode === null) {
      const exit = new Promise<void>((resolve) => proc?.once('exit', () => resolve()))
      proc.kill()
      await exit
    }
    await rm(directory, { recursive: true, force: true })
  }
})
