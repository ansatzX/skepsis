/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createRoot } from 'react-dom/client'
import './styles.css'
import { App, apiFetch } from './App.tsx'
import { PaperReview } from './paper/PaperReview.tsx'

const paper = new URLSearchParams(window.location.search).get('paper') === '1'
createRoot(document.getElementById('root')!).render(
  paper ? <PaperReview fetchJson={apiFetch} /> : <App />,
)
