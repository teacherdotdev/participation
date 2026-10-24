// Google authorization runs in the browser with the Google Identity Services token client (the
// implicit-grant model): a Google popup hands back a short-lived access token, and there is no
// refresh token anywhere. A new token needs a new popup, and browsers only allow popups straight
// from a click, so every caller must reach `authorize()` without awaiting anything first.

import { FAKE_GOOGLE, fakeAuthorize, fakePickSpreadsheet } from './fake-google'
import { getRememberedAccount, rememberAccount } from './setup'
import type { PickedSpreadsheet } from './types'

const GIS_SCRIPT = 'https://accounts.google.com/gsi/client'
const GAPI_SCRIPT = 'https://apis.google.com/js/api.js'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
// `openid email` only tells the app which account it is working with (header, copy link, login hint).
const SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE].join(' ')

export const googleConfig = {
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? '',
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY?.trim() ?? '', // Picker browser API key
  appId: import.meta.env.VITE_GOOGLE_APP_ID?.trim() ?? '', // Google Cloud project number
  templateId: import.meta.env.VITE_GOOGLE_TEMPLATE_ID?.trim() ?? '',
}

export const missingTemplateConfig = !googleConfig.templateId
export const missingGoogleConfig =
  !FAKE_GOOGLE && (!googleConfig.clientId || !googleConfig.apiKey || !googleConfig.appId)

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void
}

declare global {
  interface Window {
    google?: {
      picker?: any
      accounts?: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            callback: (response: TokenResponse) => void
            error_callback?: (failure: { type: string }) => void
          }): TokenClient
          hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean
        }
      }
    }
    gapi?: { load: (name: string, callback: () => void) => void }
  }
}

export class GoogleAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'GoogleAuthError'
  }

  /** The teacher closed the popup or pressed Cancel; not worth an error banner. */
  get cancelled(): boolean {
    return this.code === 'access_denied' || this.code === 'popup_closed'
  }
}

function messageFor(code: string): string {
  switch (code) {
    case 'access_denied':
    case 'popup_closed':
      return 'Google sign-in was cancelled.'
    case 'popup_failed_to_open':
      return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.'
    case 'admin_policy_enforced':
      return 'Your Google Workspace administrator has blocked this app. Ask them to allow it, then try again.'
    case 'scope_not_granted':
      return 'Google did not grant access to Drive files. Connect again and allow file access.'
    default:
      return `Google sign-in did not complete (${code || 'unknown'}). Try again.`
  }
}

interface DriveToken {
  accessToken: string
  expiresAt: number // epoch ms
  email: string
}

// Held in memory only. Never persisted, never logged.
let token: DriveToken | null = null
let minting: Promise<DriveToken> | null = null
let client: TokenClient | null = null
let pending: { resolve: (response: TokenResponse) => void; reject: (failure: Error) => void } | null = null

function isFresh(candidate: DriveToken | null): candidate is DriveToken {
  return !!candidate && Date.now() < candidate.expiresAt - 60_000
}

function loadScript(src: string, id: string): Promise<void> {
  const existing = document.getElementById(id) as HTMLScriptElement | null
  if (existing?.dataset.loaded === 'true') return Promise.resolve()

  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement('script')
    script.id = id
    script.src = src
    script.async = true
    script.defer = true
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    })
    script.addEventListener('error', () => reject(new Error('Google could not be reached. Check your connection and try again.')))
    if (!existing) document.head.appendChild(script)
  })
}

/** Loads Google's sign-in script ahead of the first click, so the popup can open inside that click. */
export function prepareAuthorization(): void {
  if (FAKE_GOOGLE || missingGoogleConfig) return
  loadScript(GIS_SCRIPT, 'google-identity-services').catch(() => {
    // Retried, with a visible error, on the first authorize().
  })
}

function tokenClient(): TokenClient | null {
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) return null
  client ??= oauth2.initTokenClient({
    client_id: googleConfig.clientId,
    scope: SCOPES,
    callback: (response) => {
      const settle = pending
      pending = null
      settle?.resolve(response)
    },
    error_callback: (failure) => {
      const settle = pending
      pending = null
      settle?.reject(new GoogleAuthError(messageFor(failure.type), failure.type))
    },
  })
  return client
}

function requestToken(): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const open = (ready: TokenClient) => {
      pending = { resolve, reject }
      // prompt '' skips the consent screen once it has been granted; the hint skips the chooser.
      const hint = getRememberedAccount()
      ready.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: '' })
    }
    const ready = tokenClient()
    if (ready) return open(ready)
    // The script was not loaded by the time of the click. The popup may now be blocked, in which
    // case the teacher sees popup_failed_to_open and the next click works.
    loadScript(GIS_SCRIPT, 'google-identity-services')
      .then(() => {
        const loaded = tokenClient()
        if (!loaded) throw new Error('Google sign-in did not finish loading.')
        open(loaded)
      })
      .catch(reject)
  })
}

async function accountEmail(accessToken: string): Promise<string> {
  try {
    const response = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } })
    const body = response.ok ? await response.json() : {}
    return typeof body?.email === 'string' ? body.email : ''
  } catch {
    return ''
  }
}

async function mint(): Promise<DriveToken> {
  if (FAKE_GOOGLE) {
    const fake = await fakeAuthorize()
    if (!fake) throw new GoogleAuthError(messageFor('access_denied'), 'access_denied')
    return fake
  }
  const response = await requestToken()
  if (response.error || !response.access_token) {
    const code = response.error ?? 'unknown'
    throw new GoogleAuthError(messageFor(code), code)
  }
  if (!window.google?.accounts?.oauth2.hasGrantedAllScopes(response, DRIVE_FILE_SCOPE)) {
    throw new GoogleAuthError(messageFor('scope_not_granted'), 'scope_not_granted')
  }
  return {
    accessToken: response.access_token,
    expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000,
    email: await accountEmail(response.access_token),
  }
}

// Synchronous up to the popup: the click that called it must still be "active" when it opens.
function currentToken(): Promise<DriveToken> {
  if (isFresh(token)) return Promise.resolve(token)
  minting ??= mint()
    .then((minted) => {
      token = minted
      if (minted.email) rememberAccount(minted.email)
      return minted
    })
    .finally(() => {
      minting = null
    })
  return minting
}

/** Returns a Drive access token, opening the Google popup when none is fresh. Call it from a click. */
export function authorize(): Promise<string> {
  return currentToken().then((current) => current.accessToken)
}

export function clearAuthorization(): void {
  token = null
}

async function initializePicker(): Promise<void> {
  await loadScript(GAPI_SCRIPT, 'google-api-loader')
  if (!window.gapi) throw new Error('Google Picker did not finish loading.')
  await new Promise<void>((resolve) => window.gapi?.load('picker', resolve))
}

export async function pickSpreadsheet(): Promise<PickedSpreadsheet | null> {
  if (FAKE_GOOGLE) {
    await currentToken()
    return fakePickSpreadsheet()
  }
  const [current] = await Promise.all([currentToken(), initializePicker()])
  const picker = window.google?.picker
  if (!picker) throw new Error('Google Picker is unavailable.')

  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setOwnedByMe(true)
      .setMimeTypes('application/vnd.google-apps.spreadsheet')

    // setAppId is what grants drive.file access to the picked file, so it must be the project
    // number of the project that owns the OAuth client.
    const instance = new picker.PickerBuilder()
      .setAppId(googleConfig.appId)
      .setDeveloperKey(googleConfig.apiKey)
      .setOAuthToken(current.accessToken)
      .setTitle('Choose your participation grade book')
      .addView(view)
      .setCallback((data: Record<string, any>) => {
        const action = data[picker.Response.ACTION]
        if (action === picker.Action.CANCEL) resolve(null)
        if (action === picker.Action.PICKED) {
          const document = data[picker.Response.DOCUMENTS]?.[0]
          resolve({
            id: document[picker.Document.ID],
            name: document[picker.Document.NAME],
            url: document[picker.Document.URL],
          })
        }
      })
      .build()

    instance.setVisible(true)
  })
}

// `authuser` pins the copy page to the connected Google account, so a browser whose default
// profile is a different account does not drop the copy into the wrong Drive.
export function templateCopyUrl(email?: string): string {
  if (!googleConfig.templateId) return '#'
  const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(googleConfig.templateId)}/copy`)
  if (email) url.searchParams.set('authuser', email)
  return url.toString()
}
