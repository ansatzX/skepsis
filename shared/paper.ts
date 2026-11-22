/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface PaperRevision {
  id: string
  label: string
  commit: string
}

export interface PaperVersions {
  project: string
  base: PaperRevision
  bases: PaperRevision[]
  initial: string
  targets: PaperRevision[]
}

export interface PaperFile {
  path: string
  status: 'added' | 'deleted' | 'modified' | 'unchanged'
}

export interface PaperFileContents {
  left: string | null
  right: string | null
}

export const PAPER_BASE_HEADER = 'x-skepsis-review-base'
export const PAPER_TARGET_HEADER = 'x-skepsis-review-target'
export const WORKING_COPY = 'working-copy'

export const PDF_VIEWERS = ['okular', 'sioyek', 'zathura'] as const
export type PdfViewer = (typeof PDF_VIEWERS)[number]

export interface PdfSource {
  path: string
  line: number
}
