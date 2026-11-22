/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { splitSentences } from './sentences.ts'

/** Add visual breaks inside rendered diff rows, keeping their source text and numbers. */
export function formatTexRows(root: ShadowRoot, enabled: boolean) {
  for (const row of root.querySelectorAll('[data-content] > [data-line]')) {
    if (enabled && row.querySelector('[data-tex-break]')) continue
    if (!enabled) {
      for (const marker of row.querySelectorAll('[data-tex-break]')) marker.remove()
      continue
    }

    const text = row.textContent ?? ''
    if (!/[.!?。！？]/.test(text)) continue
    const sentences = splitSentences(text)
    const breaks = sentences
      .slice(1)
      .flatMap((sentence, index) =>
        /[.!?。！？][”’"'»」』)\]]*$/.test(sentences[index]!.text) &&
        !/^[%\\]/.test(sentence.text)
          ? [sentence.start]
          : [],
      )
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let offset = 0
    let next = 0
    for (let node = walker.nextNode() as Text | null; node && next < breaks.length;) {
      const end = offset + node.length
      while (next < breaks.length && breaks[next]! < end) {
        const position = breaks[next++]!
        const following: Text = node.splitText(position - offset)
        const marker = document.createElement('br')
        marker.setAttribute('data-tex-break', '')
        following.before(marker)
        node = following
        offset = position
      }
      offset += node.length
      node = walker.nextNode() as Text | null
    }
  }
}
