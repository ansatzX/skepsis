/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState } from 'react'

export type JsonFetch = <T>(
  url: string,
  options?: { method: string; body?: unknown },
) => Promise<T>
type Load<T> = { url: string; data?: T; error?: string }

export function usePaperRequest<T>(
  fetchJson: JsonFetch,
  url: string | null,
): Load<T> | undefined {
  const [result, setResult] = useState<Load<T>>()
  useEffect(() => {
    if (!url) return
    let active = true
    fetchJson<T>(url).then(
      (data) => {
        if (active) setResult({ url, data })
      },
      (error: unknown) => {
        if (active)
          setResult({ url, error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      active = false
    }
  }, [fetchJson, url])
  return result && result.url === url ? result : undefined
}
