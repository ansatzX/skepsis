/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, expect, it } from 'vitest'
import { splitSentences } from './sentences.ts'

describe('paper sentence review', () => {
  it('ignores editor reflow and retains the raw source range', () => {
    const base = 'The fitted residual was small. The next sentence is unchanged.'
    const target = 'The fitted residual\nwas small.\nThe next sentence is unchanged.'
    const rows = splitSentences(target)
    expect(rows.map((row) => row.text)).toEqual(splitSentences(base).map((row) => row.text))
    const first = rows[0]!
    expect(target.slice(first.start, first.end)).toBe('The fitted residual\nwas small.')
    expect([first.firstLine, first.lastLine]).toEqual([1, 2])
  })

  it('protects references, abbreviations, macros, and math from splitting', () => {
    const sentences = splitSentences(String.raw`See Fig. 2 and Smith et al. for details.
Use 0.25 eV, $x=0.125$, and \cite[see Fig. 1]{a.b}. Is it stable?`)
    expect(sentences.map(({ text }) => text)).toEqual([
      'See Fig. 2 and Smith et al. for details.',
      String.raw`Use 0.25 eV, $x=0.125$, and \cite[see Fig. 1]{a.b}.`,
      'Is it stable?',
    ])
    expect(splitSentences('第一个结论。第二个结论？第三句！')).toHaveLength(3)
  })

  it('keeps structural blocks and comments visible separately', () => {
    const text = String.raw`\section{Results}
The line is unchanged. % Comment.
\begin{align}
a &= 0.25.
\end{align}
Last sentence.`
    const rows = splitSentences(text)
    expect(rows).toHaveLength(5)
    expect(rows[2]!.text).toBe('% Comment.')
    expect(rows[3]!.text).toContain('\na &= 0.25.\n')
    expect(rows[4]!.text).toBe('Last sentence.')
  })

  it('keeps prose after a structural command with spaced arguments', () => {
    const text = String.raw`\section [Short title] {Results} The first sentence. The second.`
    expect(splitSentences(text).map((row) => row.text)).toEqual([
      String.raw`\section [Short title] {Results}`,
      'The first sentence.',
      'The second.',
    ])
  })

  it('keeps LaTeX commands, literals, equations, and comments intact', () => {
    const before = String.raw`\input{first}
Text with \cite{one}, \verb|a  b| and $x  + 1$.
% Old note.
\begin{align}
x &= 1
\end{align}`
    const after = before
      .replace('first', 'second')
      .replace('one', 'two')
      .replace('a  b', 'a b')
      .replace('x  + 1', 'x + 2')
      .replace('Old note', 'New note')
      .replace('x &= 1', 'x &= 2')
    expect(
      splitSentences(after)
        .map(({ text }) => text)
        .join('\n'),
    ).toBe(after)
    expect(splitSentences(before)[1]?.text).toContain(String.raw`\verb|a  b|`)
  })
})
