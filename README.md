# Participation Grade Book

A client-side Svelte participation grade book. Teachers make their own copy of one Google Sheets template, choose it with Google Picker, and grade directly from the browser. Student data travels only between the browser and Google.

Google authorization runs entirely in the browser with the Google Identity Services token client. A Google popup returns a short-lived access token; there is no server, no refresh token, and no client secret.

## Local setup

Requires Node.js 20.19+ or 22.12+.

```sh
cp .env.example .env.local
npm install
npm run dev
```

The dev server is pinned to port 5173 (`strictPort`) because the OAuth client lists exactly `http://localhost:5173` as an Authorized JavaScript origin. If the port is taken, free it rather than moving the app; a different port has to be added to the OAuth client first.

Fill in `.env.local`:

- `VITE_GOOGLE_CLIENT_ID`: the Web application OAuth client ID (`….apps.googleusercontent.com`).
- `VITE_GOOGLE_API_KEY`: the browser API key Google Picker uses.
- `VITE_GOOGLE_APP_ID`: the Cloud project number of the project that owns the OAuth client. Picker uses it to grant `drive.file` access to the picked file.
- `VITE_GOOGLE_TEMPLATE_ID`: ID between `/d/` and `/edit` in the template URL. The repository is currently configured for `1cS83Iyp41lX6Hli14NfibPIjETNTwglhU_0uGRNOIYo`.
- `VITE_CF_BEACON` (optional): Cloudflare Web Analytics token. Set it in Vercel's production environment only; when unset the beacon script is not loaded.

All three Google values ship in the client bundle; none of them is a secret. Set them in Vercel for every environment that should sign in.

## Local click-through without Google

Set `VITE_FAKE_GOOGLE=true` and the Google popup, Picker and the Sheets API are all faked, so the whole onboarding ladder and the grading screen work with no Google account or OAuth client.

```sh
# .env.local
VITE_FAKE_GOOGLE=true
```

Open `http://localhost:5173/?emptyRoster` to start with no students and click through the add-roster flow.

The fake popup is a browser confirm: OK grants a token, Cancel simulates closing the Google window. Fake tokens last five minutes, so the hourly re-authorization comes up during a click-through. The fake grade book is in memory; reload to start over.

The fake never ships: `VITE_FAKE_GOOGLE` is a build-time constant, and `npm run build` with it unset drops `src/lib/fake-google.ts` from the bundle.

## How authorization works

1. **Connect Google** — the first click calls `requestAccessToken()` on a GIS token client. Google's popup asks for `drive.file` (plus `openid email`, so the app knows which account it is working with) and hands back an access token that lasts about an hour. The app keeps it in memory and remembers only the account's email, as the `login_hint` for later popups.
2. **Use it** — Google Picker and the Sheets API are called directly from the browser with the bearer token.
3. **Renew it** — there is no refresh token. When the token is within a minute of expiry, the next click that needs Google opens the popup again. Consent was already given, so it closes by itself, but it is still a popup: browsers only allow it during a click, so every handler calls `authorize()` before awaiting anything else, and nothing talks to Google on page load. A returning teacher therefore lands on the setup list with **Start grading** as the one remaining step.

`prepareAuthorization()` loads the GIS script on page load so the popup can open synchronously inside that first click. Closing the popup or pressing Cancel shows a quiet notice; a blocked popup, `admin_policy_enforced`, or a refused `drive.file` scope shows an error. A Sheets 401 drops the cached token so the next click fetches a new one. A Sheets 404 on a remembered grade book means `drive.file` does not cover it (it was picked under another OAuth client, or trashed): the app forgets it and asks the teacher to pick it again, which grants access. See `src/lib/google.ts`.

## Google Cloud setup

1. **OAuth client** — a *Web application* client. Under **Authorized JavaScript origins**, list every origin that serves the app, exactly: `https://<slug>.teacher.dev`, any custom domain, each Vercel preview origin you want to sign in from, and `http://localhost:5173`. Wildcards are not accepted. Redirect URIs are not used.
2. **Consent screen** — scopes `openid`, `email`, and `https://www.googleapis.com/auth/drive.file`. `drive.file` is non-sensitive, so no verification beyond publishing the app is required.
3. **APIs** — enable the Google Sheets API and the Google Picker API in the same project. The app calls no Drive API endpoint directly.
4. **Picker API key** — restrict it to the Google Picker API, with website restrictions for the same origins as step 1 (`https://<slug>.teacher.dev/*`, `http://localhost:5173/*`).
5. **Project number** — from the project's Dashboard; it is `VITE_GOOGLE_APP_ID`.

Do not serve the app with `Cross-Origin-Opener-Policy: same-origin`; it cuts the popup off from the page and the token never arrives. `same-origin-allow-popups` (or no header) is fine.

## Build the one spreadsheet template

The easiest option is the included CreateTemplate.gs script:

1. Open [script.google.com](https://script.google.com) and create a new project.
2. Replace Code.gs with the contents of CreateTemplate.gs.
3. Run createParticipationTemplate.
4. Approve the requested Google Sheets permission.
5. Open the spreadsheet URL shown in the execution log.
6. Share that file as view-only with the intended audience and allow viewers to copy it.
7. Put its spreadsheet ID into VITE_GOOGLE_TEMPLATE_ID.

The script creates and formats all four tabs, installs the formulas and validation, and leaves the roster ready to fill. TEMPLATE_TIME_ZONE defaults to America/New_York and can be changed at the top of the script before it runs.

### Manual fallback

Create a Google Sheet and set its timezone under **File → Settings**. Make it viewable by anyone who needs to copy it, with copying enabled. It needs four tabs.

### Day Records

Put these headers in `A1:H1`. `Name`, `Date`, and `Total` are fixed; every column between `Date` and `Total` is a participation behavior, headed by an emoji, a space, and its name:

```text
Name | Date | ⏰ On time | ✏️ Prepared | 👀 Focused | 💬 Participated | 🤝 Teamwork | Total
```

(Copies made from the earlier template, with `Timely-ness` … `Collaboration-ness` headers, still open fine; the app maps those to the same five defaults.)

Format column B as `yyyy-mm-dd`. Put this formula in `H2`:

```gs
=ARRAYFORMULA(IF(A2:A="","",N(C2:C="Yes")+N(D2:D="Yes")+N(E2:E="Yes")+N(F2:F="Yes")+N(G2:G="Yes")))
```

### Class Roster

Put these exact headers in `A1:B1`:

```text
Name | Initials
```

Initials are optional; the app derives them when blank.

### Week Ranges

Put these exact headers in `A1:C1` and format B:C as `yyyy-mm-dd`:

```text
Week | Start Date | End Date
```

### Weekly Grades

Put these headers in `A1:C1`:

```text
Name | Week | Average
```

Put this formula in `A2`:

```gs
=ARRAYFORMULA(SPLIT(FLATTEN(FILTER('Class Roster'!A2:A,'Class Roster'!A2:A<>"")&"♦"&TRANSPOSE(FILTER('Week Ranges'!A2:A,'Week Ranges'!A2:A<>""))),"♦"))
```

Put this formula in `C2`:

```gs
=MAP(FILTER(A2:A,A2:A<>""),FILTER(B2:B,A2:A<>""),LAMBDA(name,week,IFERROR(AVERAGEIFS('Day Records'!H:H,'Day Records'!A:A,name,'Day Records'!B:B,">="&XLOOKUP(week,'Week Ranges'!A:A,'Week Ranges'!B:B),'Day Records'!B:B,"<="&XLOOKUP(week,'Week Ranges'!A:A,'Week Ranges'!C:C)),"")))
```

Do not include an example row in Day Records. On the first load each day, the app creates a row for every rostered student with Yes in every active behavior.

## Behaviors

The five behaviors above are only the defaults. **Behaviors** in the grade book's top bar opens an editor, modelled on the one in class-notes, where a teacher can add a behavior, rename one or change its emoji, remove one, or restore one that was removed. Everything edits the "Day Records" tab directly, so the sheet stays the single source of truth across devices:

- **Add** inserts a column just before `Total`, formatted like the first behavior column, rewrites the `Total` formula to include it, and marks today's existing rows Yes.
- **Rename** rewrites the header cell as `emoji name`.
- **Remove** hides the column when it has grades on an earlier day (so past days and their totals stay intact; the app skips the hidden column on new days) and deletes it outright when it has only ever been graded today. Hidden columns appear under *Archived* in the editor, where **Restore** unhides them. At least one active behavior must remain.

The `Weekly Grades` formula references `Total` by column, and Google shifts that reference when columns are inserted or deleted, so it keeps working.

## Commands

```sh
npm run dev
npm run check
npm run build
```

## Privacy and concurrency

The Google access token is kept in memory only and is discarded on expiry, sign-out, and tab close. No refresh token exists. Local storage holds the connected account's email, spreadsheet IDs and names, onboarding progress, and a copy of each grade book opened on this device (its roster, behaviors and today's grades) along with any grades not yet saved to the sheet. Student data travels only between the browser and Google.

Grades are saved on the device first. While the Google token is fresh, each grade is written to the sheet straight away; once it has expired, grades queue up, the cards show a dot, and **Save to sheet** in the top bar shows how many are waiting. Pressing it opens Google's popup if needed and writes them all. Because the roster is kept on the device, a returning teacher lands on it without signing in again. Roster, behavior and rename edits still go straight to Google, and write any queued grades first.

**Sign out** forgets the token and everything this device remembers, including the local copies (it asks for a second press if grades are still unsaved), but leaves the Drive grant with Google, so coming back is one Google click. Teachers revoke the grant from their Google Account's third-party access page. **Switch grade book** only forgets the saved spreadsheet.

Setup is a four-step ladder — connect Google, copy the template, pick the copy, start grading — and each step unlocks the next. Steps 1–3 are remembered per device in local storage (the browser cannot observe the copy being made, so "Make a copy" marks step 2 done when pressed).

Writes are serialized across tabs in the same browser with the Web Locks API. Google Sheets does not offer a cross-device conditional upsert, so this app assumes one teacher is actively grading from one device at a time.
