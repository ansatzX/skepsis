/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface Sentence {
  text: string
  start: number
  end: number
  firstLine: number
  lastLine: number
}

const abbreviation =
  /(?:\b(?:figs?|eqs?|refs?|secs?|dr|prof|mr|mrs|ms|vs|no|cf|e\.g|i\.e|et al))\.$/i
const terminal = /[.!?。！？]/
const closing = /[”’"'»」』)\]]/
const latexArgument =
  /^(?:[Cc]ite\w*|[Cc]ref|autoref|eqref|pageref|ref|label|url|href|footnote)\*?$/
const rawEnvironment =
  /^(?:align\*?|equation\*?|gather\*?|multline\*?|displaymath|verbatim\*?|lstlisting|minted|tikzpicture|tabular\*?)$/

function escaped(source: string, index: number) {
  let count = 0
  while (source[index - count - 1] === '\\') count++
  return count % 2 === 1
}

function closingDelimiter(source: string, start: number, delimiter: string) {
  let end = source.indexOf(delimiter, start)
  while (end >= 0 && escaped(source, end)) end = source.indexOf(delimiter, end + 1)
  return end < 0 ? source.length : end + delimiter.length
}

function skipGroup(source: string, start: number): number {
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (escaped(source, i)) continue
    if (source[i] === open) depth++
    if (source[i] === close && --depth === 0) return i + 1
  }
  return source.length
}

/** Split TeX source for display, retaining its raw UTF-16 offsets and lines. */
export function splitSentences(source: string): Sentence[] {
  const rows: Sentence[] = []
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
  function lineAt(offset: number) {
    let lo = 0
    let hi = lineStarts.length
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid
    }
    return lo + 1
  }

  let start = 0
  const inlineCode: { start: number; end: number }[] = []
  function emit(until: number, preserveSpace = false) {
    const raw = source.slice(start, until)
    const trimmed = raw.trim()
    if (trimmed) {
      const from = start + (raw.length - raw.trimStart().length)
      const end = from + trimmed.length
      let text = trimmed
      if (!preserveSpace) {
        const pieces: string[] = []
        let cursor = from
        for (const span of inlineCode) {
          pieces.push(
            source.slice(cursor, span.start).replace(/[ \t\r]*\n\s*/g, ' '),
            source.slice(span.start, span.end),
          )
          cursor = span.end
        }
        pieces.push(source.slice(cursor, end).replace(/[ \t\r]*\n\s*/g, ' '))
        text = pieces.join('')
      }
      rows.push({
        text,
        start: from,
        end,
        firstLine: lineAt(from),
        lastLine: lineAt(end - 1),
      })
    }
    inlineCode.length = 0
    start = until
  }

  for (let i = 0; i < source.length;) {
    const ch = source[i]!
    if (ch === '%' && !escaped(source, i)) {
      const lineEnd = source.indexOf('\n', i)
      const end = lineEnd < 0 ? source.length : lineEnd
      emit(i)
      emit(end, true)
      i = end
      continue
    }
    if (ch === '$' && !escaped(source, i)) {
      const delimiter = source[i + 1] === '$' ? '$$' : '$'
      const end = closingDelimiter(source, i + delimiter.length, delimiter)
      if (delimiter === '$$') {
        emit(i)
        emit(end, true)
      } else {
        inlineCode.push({ start: i, end })
      }
      i = end
      continue
    }
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === '(' || next === '[') {
        const end = closingDelimiter(source, i + 2, next === '(' ? '\\)' : '\\]')
        if (next === '[') {
          emit(i)
          emit(end, true)
        } else {
          inlineCode.push({ start: i, end })
        }
        i = end
        continue
      }
      const rest = source.slice(i)
      const begin = /^\\begin[ \t]*\{([^}]+)\}/.exec(rest)
      if (begin?.[1] && rawEnvironment.test(begin[1])) {
        const endPattern = /\\end[ \t]*\{([^}]+)\}/g
        endPattern.lastIndex = i + begin[0].length
        let closingCommand = endPattern.exec(source)
        while (
          closingCommand &&
          (closingCommand[1] !== begin[1] || escaped(source, closingCommand.index))
        ) {
          closingCommand = endPattern.exec(source)
        }
        const end = closingCommand ? endPattern.lastIndex : source.length
        emit(i)
        emit(end, true)
        i = end
        continue
      }
      const macro = /^\\([A-Za-z]+\*?)/.exec(rest)
      if (macro) {
        const commandStart = i
        i += macro[0].length
        const name = macro[1]!
        if (/^verb\*?$/.test(name) && source[i] && !/\s/.test(source[i]!)) {
          const close = source.indexOf(source[i]!, i + 1)
          const lineEnd = source.indexOf('\n', i + 1)
          if (close >= 0 && (lineEnd < 0 || close < lineEnd)) {
            i = close + 1
            inlineCode.push({ start: commandStart, end: i })
          }
        } else if (latexArgument.test(name)) {
          const groups = name === 'href' ? 2 : 1
          for (let braces = 0; braces < groups;) {
            const whitespace = /^[ \t]*/.exec(source.slice(i))?.[0].length ?? 0
            const open = source[i + whitespace]
            if (open !== '[' && open !== '{') break
            i = skipGroup(source, i + whitespace)
            if (open === '{') braces++
          }
          inlineCode.push({ start: commandStart, end: i })
        } else if (
          /^(?:part|chapter|(?:sub)*section|paragraph|begin|end|documentclass|usepackage|input|include|bibliography|bibliographystyle)\*?$/.test(
            name,
          )
        ) {
          const end = source.indexOf('\n', i)
          const after = end < 0 ? source.length : end
          emit(i - macro[0].length)
          // Keep adjacent prose on the same line outside the structural command.
          let argumentEnd = i
          for (;;) {
            const whitespace = /^[ \t]*/.exec(source.slice(argumentEnd))?.[0].length ?? 0
            const open = argumentEnd + whitespace
            if (source[open] !== '[' && source[open] !== '{') break
            argumentEnd = skipGroup(source, open)
            if (source[open] === '{') break
          }
          emit(argumentEnd > i ? argumentEnd : after, true)
          i = start
        }
        continue
      }
      i += 2
      continue
    }
    if (ch === '\n') {
      const blank = /^\n[ \t\r]*\n/.exec(source.slice(i))
      if (blank) {
        emit(i)
        i += blank[0].length
        start = i
        continue
      }
    }
    if (terminal.test(ch)) {
      let end = i + 1
      while (end < source.length && terminal.test(source[end]!)) end++
      while (end < source.length && closing.test(source[end]!)) end++
      const next = source[end]
      const separated = next === undefined || /[\s\\%]/.test(next)
      if (
        (separated || /[。！？]/.test(ch)) &&
        (ch !== '.' || !abbreviation.test(source.slice(Math.max(start, i - 24), i + 1)))
      ) {
        emit(end)
        i = end
        continue
      }
    }
    i++
  }
  emit(source.length)
  return rows
}
