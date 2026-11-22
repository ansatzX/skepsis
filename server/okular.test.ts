/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from 'vitest'
import { uniqueTextAtSyncTeXLocation } from './okular.ts'

function pdfLine(page: number, left: number, text: string) {
  return [
    [4, page, 0, 0, 0, 0, left, 100, 90, 10, -1, '###LINE###'].join('\t'),
    ...text
      .split(' ')
      .map((word, i) => [5, page, 0, 0, 0, i, left, 100, 10, 10, 100, word].join('\t')),
  ].join('\n')
}

test('finds the rendered text in the SyncTeX column', () => {
  const left = pdfLine(1, 40, 'Another column of text')
  const right = pdfLine(1, 190, 'The intended phrase')
  expect(uniqueTextAtSyncTeXLocation(left + '\n' + right, 'Page:1\nx:205\ny:111')).toBe(
    'The intended phrase',
  )
})

test('skips search when it could move the viewer to a duplicate on another page', () => {
  const first = pdfLine(1, 40, 'A repeated PDF line')
  const second = pdfLine(2, 40, 'a repeated PDF line')
  expect(
    uniqueTextAtSyncTeXLocation(first + '\n' + second, 'Page:2\nx:65\ny:110'),
  ).toBeUndefined()
})
