# Kvitbit v1 user flows

Status: **approved**, 2026-11-22 (with user decisions recorded in section 6: full mobile parity in Expo v1, composite ~25-30 screen-by-screen rounds, two-step MCP preview-then-confirm on issue/send, no hard-delete on issued documents + soft-delete Workspace/account for 10-year tax retention, and Credit Note inheriting original Invoice FX/VAT rate per Czech VAT Act §42). Every screen in section 5 traces back to a flow in section 3.

Terms follow [CONTEXT.md](../../CONTEXT.md) exactly. Two terms used here are not in the glossary yet and need a decision (see section 6):

- Final Invoice. An Invoice issued after a Proforma that deducts the deposit already paid.
- EPC QR. The European Payments Council SEPA credit transfer QR code, used on EUR documents. QR Platba covers CZK only, because the Czech standard v1.2 permits CZK only.

Inputs: [ADR 0001](../adr/0001-foldkit-web-adapter.md), [ADR 0002](../adr/0002-altcha-pow-bot-protection.md), [ADR 0003](../adr/0003-alchemy-gcp-neon-cluster-and-nix-self-hosting.md), [Czech invoicing specs](../research/czech-invoicing-specs.md), and the command catalogue in [core-ports-opt-3.md](core-ports-opt-3.md).

## 1. Shared rules every flow assumes

- Every signed-in screen acts inside one active Workspace. The Workspace switcher changes it. URLs carry the Workspace slug, so a link opened by a Member of another Workspace shows "No access" instead of leaking data.
- Document status has two parts. The lifecycle is Draft → Issued. Issued documents then carry derived badges: Sent, Viewed, Partially paid, Paid, Overdue, Credited. Document Lock is a separate flag on any issued document.
- A document gets its number from its Numbering Series when it is issued, not when the draft is created. Drafts show "Draft" in place of a number.
- The Tax Regime of the Issuing Entity on the issue date decides which fields the document editor shows:
  - `non_vat_payer` hides VAT columns and prints "Dodavatel není plátcem DPH." in the footer.
  - `vat_payer` shows taxable supply date, VAT rate per line (21%, 12%, exempt with legal reference, reverse charge), and a VAT recap per rate in CZK.
  - `identified_person` hides domestic VAT, prints the identified-person footer, and offers reverse charge for EU B2B services.
- VAT is computed per rate bucket. For a non-CZK document, each bucket's VAT converts to CZK with the CNB rate valid on the taxable supply date.
- The QR code follows the document currency. CZK gets QR Platba, EUR gets EPC QR, and any other currency gets bank details with no QR. If no bank account exists for the document currency, the editor warns before issue.
- Every write to an issued document, every send, view, Payment, lock, and unlock lands in the document's audit history with actor and timestamp.
- UI language is per user (CZ or EN). Document, PDF, and email language is per document, defaulting from the Contact.

## 2. Surface map

### 2.1 Surfaces

| Surface | Who uses it | Served by | Session |
|---|---|---|---|
| Public Web | Visitors, invited people, document recipients, MCP clients during OAuth | Foldkit web adapter, SSR | None, or a signed-in session for OAuth consent |
| App Web | Members on desktop and laptop | Foldkit web adapter at `/` | Signed in, one active Workspace |
| Expo Mobile | Members on phones. Android APK from `/android` and the PWA at `/app/` run the same Expo build | `apps/mobile`, PWA static export served by `apps/server` | Signed in, one active Workspace |
| Remote MCP | AI clients acting for one Member in one Workspace | `apps/server` at `/mcp`, OAuth 2.1 | Bearer token from flow 10.8 |
| HTTP API | Scripts and integrations | `apps/server` at `/api` | API Key from flow 10.7 |
| Email | Members and document recipients | Resend | None |

### 2.2 Where each flow lives

Mobile layout tags:

- Mobile-first. Design the phone layout first. The web layout adapts from it.
- Both. Full function on both. Design desktop first, then adapt.
- Desktop-only. App Web only in v1. Mobile shows a read-only summary where useful and an "Open on web" link.
- Public. Public Web only, responsive, no app session.
- System. No screen. A background workflow runs it and other screens show the result.

| Group | Flow | Public Web | App Web | Mobile | MCP | Mobile tag |
|---|---|---|---|---|---|---|
| 1 Public and auth | 1.1 Landing and legal pages | yes | | | | Public |
| | 1.2 Sign up | yes | | yes | | Both |
| | 1.3 to 1.6 Log in, password reset | yes | | yes | | Both. Passkey is mobile-first |
| | 1.7 Install mobile app | yes | | | | Public |
| | 1.8 Manage account and security | | yes | yes | | Both |
| | 1.9 Delete account | | yes | | | Desktop-only |
| 2 Workspace and team | 2.1 Onboarding | | yes | yes | | Both |
| | 2.2 Create another Workspace | | yes | yes | | Both |
| | 2.3 Switch Workspace | | yes | yes | yes | Mobile-first |
| | 2.4 to 2.9 Team, ownership, deletion | yes for 2.5 | yes | | | Desktop-only |
| 3 Issuing lifecycle | 3.1 to 3.3 Create, issue, send | | yes | yes | yes | Both. Quick invoice is mobile-first |
| | 3.4 to 3.7 Edit issued, lock, history, drafts | | yes | yes | partly | Both |
| | 3.8 Proforma settlement | | yes | yes | yes | Both |
| | 3.9 Credit Note | | yes | yes | yes | Both |
| | 3.10 PDF download and template | | yes | yes | yes | Both |
| 4 Templates and recurring | 4.1, 4.3, 4.5 Edit templates and schedules | | yes | | read | Desktop-only |
| | 4.2 Create from Invoice Template | | yes | yes | yes | Mobile-first |
| | 4.4 Recurring run | | | | | System |
| 5 Expenses | 5.1 Record Expense | | yes | yes | yes | Both |
| | 5.2 Capture from photo or PDF | | yes | yes | | Mobile-first |
| | 5.3 to 5.5 Edit, pay, browse | | yes | yes | yes | Both |
| 6 Contacts and Price List | 6.1 to 6.3 Contacts and ARES | | yes | yes | yes | Both |
| | 6.4 Price List | | yes | read | yes | Desktop-only editing |
| 7 Payments and reminders | 7.1, 7.2 Record and remove Payment | | yes | yes | yes | Mobile-first |
| | 7.3 Automatic reminders | | | | | System |
| | 7.4 Manual reminder | | yes | yes | yes | Both |
| | 7.5 Reminder settings | | yes | | | Desktop-only |
| 8 Public Share Link | 8.1, 8.5, 8.6 Member side | | yes | yes | yes | Mobile-first for copy and share |
| | 8.2 to 8.4 Recipient side | yes | | | | Public, phone-first |
| 9 Reports | 9.1 Dashboard | | yes | yes | yes | Both |
| | 9.2 to 9.6 Report views | | yes | summary | yes | Desktop-only full view |
| | 9.7 Export | | yes | yes | yes | Both |
| 10 Settings and API | 10.1 to 10.7, 10.9 | | yes | | | Desktop-only |
| | 10.8 Connect MCP client | yes | | | yes | Public |
| | 10.10 Work through MCP | | | | yes | MCP only |

Why the desktop-only set looks like this: those flows are configuration done once or rarely, with dense forms such as Numbering Series patterns, image uploads for branding, and API Key secrets. The mobile-first set covers what happens away from a desk: snapping a receipt, checking whether a client paid, recording a bank transfer, sending a quick Invoice, and signing in with a phone passkey.

## 3. Flow catalog

Each flow lists Entry, Actor, Happy path, Branches (errors and empty states), and Outcome. Actor names the lowest role that can run it. Section 4 has the full matrix.

### Group 1. Public and auth

#### 1.1 Visit landing and legal pages

- Entry: direct visit to `/`, a search result, or the footer link on a Public Share Link page.
- Actor: anonymous visitor.
- Happy path:
  1. Visitor lands on `/`, which states that v1 is free and shows what the app does for Czech and EU businesses.
  2. Visitor switches CZ or EN in the header. The choice persists in a cookie.
  3. Visitor opens Terms of Service or Privacy Policy from the footer. Each page has a CZ and an EN version and a "last updated" date.
  4. Visitor clicks "Sign up" or "Log in".
- Branches:
  - A signed-in user visiting `/` goes straight to their last active Workspace dashboard.
  - First visit picks CZ when the browser's `Accept-Language` prefers Czech, EN otherwise.
- Outcome: visitor reaches flow 1.2 or 1.3. No data stored except the language cookie.

#### 1.2 Sign up with ALTCHA and email verification

- Entry: "Sign up" on the landing page, or the mobile app's first screen.
- Actor: anonymous visitor.
- Happy path:
  1. Visitor enters email and a password, or picks "Use a passkey instead".
  2. Visitor ticks acceptance of Terms and Privacy Policy. Both links open in a new tab.
  3. ALTCHA solves its proof-of-work in the background while the visitor types. The submit button shows "Verifying you're human" until the solution is ready.
  4. Visitor submits. The server verifies the ALTCHA solution and creates an unverified user.
  5. The "Check your email" screen shows the address and a resend button with a 60-second cooldown.
  6. Visitor clicks the link in the verification email (E01).
  7. The link marks the email verified, signs the visitor in, and opens onboarding (flow 2.1).
- Branches:
  - Email already registered: the form shows the same "Check your email" screen and sends a "You already have an account, log in here" email. The UI does not reveal whether the account exists.
  - ALTCHA fails or expires: inline error, the widget restarts, the form keeps its values.
  - Self-hosted install with `NoopBotProtection`: no widget, same flow otherwise.
  - Weak or breached password: inline error under the field.
  - Verification link expired or used: P04 shows "Link expired" and a button to send a new one.
  - Visitor closes the tab before verifying: logging in later with an unverified email lands on "Check your email" with resend.
  - Passkey path: the browser or phone prompts to create a passkey after step 4. The email still needs verification before onboarding.
  - On mobile, the ALTCHA solver runs natively. A mid-range Android phone may take a few seconds, so the screen shows progress.
- Outcome: a verified user with no Workspace, sitting in onboarding.

#### 1.3 Log in with password

- Entry: "Log in" on Public Web or the mobile sign-in screen.
- Actor: verified user.
- Happy path:
  1. User enters email and password.
  2. Server checks credentials and creates a session.
  3. User lands on the dashboard of their last active Workspace.
- Branches:
  - Wrong email or password: one generic error. After repeated failures the form requires an ALTCHA solution.
  - Unverified email: "Check your email" with resend.
  - User has no Workspace yet, or was removed from all of them: onboarding (flow 2.1).
  - User arrived from a deep link, such as a document URL or an OAuth consent: returns to that URL after login.
- Outcome: signed-in session, active Workspace set.

#### 1.4 Log in with magic link

- Entry: "Email me a login link" on the login screen.
- Actor: verified user.
- Happy path:
  1. User enters email and submits.
  2. P06 says "If an account exists, we sent a link".
  3. User clicks the link in E02 on any device.
  4. The link signs in the browser that opened it and opens the dashboard.
- Branches:
  - Link expired after 15 minutes or already used: P07 shows "Link expired" with a resend button.
  - Link opened on a phone with the APK installed: Android offers to open it in the app through an App Link. Declining signs in the mobile browser instead.
  - Unknown email: same confirmation screen, no email sent.
- Outcome: signed-in session.

#### 1.5 Log in with a passkey, and add one

- Entry: "Log in with passkey" on the login screen, or Account settings → Passkeys → "Add passkey".
- Actor: verified user.
- Happy path (log in):
  1. User taps "Log in with passkey".
  2. The browser or Android credential manager shows the account picker.
  3. User confirms with fingerprint, face, or PIN.
  4. User lands on the dashboard.
- Happy path (add):
  1. In Account settings, user taps "Add passkey" and names it, for example "Pixel 9".
  2. The platform prompt creates the credential.
  3. The new passkey appears in the list with its creation date.
- Branches:
  - No passkey on this device: the platform offers a QR code to use a phone. Cancelling returns to the login form with password and magic link still available.
  - User cancels the platform prompt: no error banner, just back to the form.
  - Removing the last sign-in method is blocked. The account must keep a password or at least one passkey.
- Outcome: signed-in session, or a new passkey listed.

#### 1.6 Reset password

- Entry: "Forgot password" on the login screen.
- Actor: verified user.
- Happy path:
  1. User enters email. P08 confirms "If an account exists, we sent a link".
  2. User clicks the link in E03 and lands on P09.
  3. User sets a new password.
  4. All other sessions end. User is signed in and lands on the dashboard.
- Branches:
  - Link expired or used: P09 shows "Link expired" with a button back to step 1.
  - Passkey-only account: the email offers a magic link login and a "set a password" link.
- Outcome: new password, other sessions revoked.

#### 1.7 Install the mobile app

- Entry: "Get the Android app" on the landing page, or the "Install app" item in the App Web user menu.
- Actor: anyone.
- Happy path (APK):
  1. User opens `/android`, which shows version, release date, file size, and the SHA-256 checksum of the signing certificate.
  2. User taps "Download APK". Android asks to allow installs from the browser.
  3. User installs and opens the app, then signs in (flows 1.3 to 1.5).
- Happy path (Obtainium):
  1. On `/android`, user taps "Add to Obtainium".
  2. Obtainium opens with the source URL prefilled and tracks updates.
- Happy path (PWA):
  1. User opens `/app/` in any mobile browser.
  2. The page shows an "Install" button where the browser supports it, or iOS steps "Share → Add to Home Screen".
- Branches:
  - Desktop visitor on `/android`: the page shows a QR code that opens `/android` on a phone.
  - iPhone visitor on `/android`: the page explains there is no iOS build and points to `/app/`.
- Outcome: app installed and signed in.

#### 1.8 Manage account and security

- Entry: user menu → "Account".
- Actor: any signed-in user.
- Happy path: user edits any of these on W39 or M19.
  - Name and UI language.
  - Email change. Entering a new address sends E07 to it. The old address stays active until the user clicks that link, and the old address gets a notice.
  - Password change. Needs the current password.
  - Passkeys. List, rename, remove (flow 1.5).
  - Active sessions. Device, location by IP, last seen, and "Sign out" per session or "Sign out everywhere else".
- Branches:
  - New email already used by another account: generic "Could not change email" after confirmation, no leak.
  - Removing the last sign-in method is blocked.
- Outcome: account updated, audit entry on the user.

#### 1.9 Delete account

- Entry: Account settings → "Delete account".
- Actor: any signed-in user.
- Happy path:
  1. The dialog lists every Workspace the user belongs to and their role there.
  2. User types their email to confirm.
  3. The account is deleted, sessions end, and the user lands on `/` with a confirmation banner.
- Branches:
  - User is the owner of a Workspace that has other Members: deletion is blocked until they transfer ownership (flow 2.8) or delete that Workspace (flow 2.9).
  - User is the sole Member of a Workspace: the dialog says that Workspace will be deleted too and points to export first. See open question Q7 on retention.
- Outcome: account gone. Documents the user created stay in their Workspaces, attributed to "Deleted user" in audit history.

#### 1.10 Log out

- Entry: user menu → "Log out".
- Actor: any signed-in user.
- Happy path: session ends, user lands on `/` (web) or the sign-in screen (mobile).
- Outcome: session revoked on that device only.

### Group 2. Workspace and team

#### 2.1 Onboarding: create the first Workspace

- Entry: first login after verification, or any login while the user has no Workspace.
- Actor: verified user with no Workspace.
- Happy path (wizard W02 / M03):
  1. "Who issues your invoices?" User types an IČO.
  2. ARES lookup fills name, registered office, legal form, and DIČ. User confirms or edits.
  3. User picks the Tax Regime: not a VAT payer, VAT payer, or identified person. Each option has one sentence explaining it. ARES does not decide this, because a DIČ in ARES does not prove VAT-payer status.
  4. User enters a bank account: account number or IBAN, currency, optional BIC. They can add more later.
  5. User reviews default Numbering Series, one per document kind: `YYYY-NNNN` for Invoices, `ZF-YYYY-NNNN` for Proformas, `DD-YYYY-NNNN` for Payment Tax Documents (VAT payers only), `OD-YYYY-NNNN` for Credit Notes. They can edit the pattern and starting number, for example to continue numbering from a previous tool.
  6. Optional: upload a logo and pick a PDF template (Classic Czech or Modern Minimal). "Skip for now" is always visible.
  7. The Workspace opens on the dashboard with a "Getting started" checklist: add a Contact, create your first Invoice, invite your accountant.
- Branches:
  - No IČO, or a foreign entity: "Enter details manually" link skips step 2. IČO stays optional only for non-Czech entities.
  - ARES unreachable or rate-limited: inline warning, fields stay editable, user continues manually.
  - IČO not found or entity has a termination date: inline error with the ARES result, user may continue manually.
  - Same IČO already used by another Workspace this user belongs to: warning "You already have a Workspace for this IČO", with a link to it. Creating a second one is allowed.
  - User quits mid-wizard: the next login resumes at the first incomplete step. Nothing is saved until step 3 completes.
- Outcome: a Workspace with an Issuing Entity, Tax Regime, at least one bank account, four Numbering Series, and the user as owner.

#### 2.2 Create another Workspace

- Entry: Workspace switcher → "New Workspace".
- Actor: any signed-in user.
- Happy path: the same wizard as 2.1, then the switcher shows the new Workspace as active.
- Outcome: the user owns the new Workspace. Other Workspaces are untouched.

#### 2.3 Switch Workspace

- Entry: Workspace switcher in the app shell header (web) or the top of the More tab (mobile). Keyboard shortcut on web: `Ctrl/Cmd + K`, then type the name.
- Actor: Member of two or more Workspaces.
- Happy path:
  1. User opens the switcher. It lists Workspaces by most recent use, each with name, IČO, and the user's role.
  2. User picks one. The current page reloads in that Workspace if the page exists there, otherwise the dashboard opens.
- Branches:
  - One Workspace only: the switcher shows it plus "New Workspace".
  - Unsaved draft changes: confirm "Discard changes?" before switching.
  - MCP clients pick the Workspace at consent time (flow 10.8), not through this switcher.
- Outcome: active Workspace changed. The choice persists per device.

#### 2.4 Invite a Member

- Entry: Settings → Team → "Invite".
- Actor: admin or owner.
- Happy path:
  1. Admin enters one or more emails and picks a role: admin, member, or accountant.
  2. The server sends E04 to each address.
  3. Pending invitations show in the Team list with role, sender, and expiry in 7 days.
- Branches:
  - Email already a Member: inline error on that address.
  - Admin tries to invite with role owner: not offered. Ownership moves only through flow 2.8.
  - Resend and revoke actions on each pending row.
- Outcome: pending invitation, email sent.

#### 2.5 Accept an invitation

- Entry: the link in E04.
- Actor: invited person.
- Happy path:
  1. P10 shows the Workspace name, inviter, and role.
  2. If signed in with the invited email, "Join" adds the Membership and opens the dashboard.
  3. If not signed in, P10 offers "Log in" or "Create account". Account creation prefills and locks the email. Clicking the invitation link already proved the email, so no separate verification step follows.
- Branches:
  - Signed in as a different email: P10 says "This invitation is for x@y. Log out and continue?".
  - Expired or revoked: P10 says so and names the inviter to ask for a new one.
- Outcome: new Member with the invited role. Inviter sees the row move from pending to active.

#### 2.6 Change a Member's role or remove a Member

- Entry: Settings → Team → row menu.
- Actor: owner for any change. Admin for members and accountants only.
- Happy path: pick the new role, or "Remove", and confirm. The change takes effect on the Member's next request.
- Branches:
  - The owner's row has no menu. Ownership moves through flow 2.8.
  - Removed Member's API Keys and MCP grants for this Workspace are revoked in the same step. The dialog states how many.
- Outcome: role changed or Membership removed, audit entry written.

#### 2.7 Leave a Workspace

- Entry: Settings → Team → "Leave Workspace", or the switcher row menu.
- Actor: any Member except the owner.
- Happy path: confirm, lose access, land in another Workspace or onboarding.
- Branches: the owner sees "Transfer ownership first".
- Outcome: Membership ended, own API Keys and MCP grants for it revoked.

#### 2.8 Transfer ownership

- Entry: Settings → Danger zone → "Transfer ownership".
- Actor: owner.
- Happy path:
  1. Owner picks an existing admin.
  2. Owner confirms with their password or passkey.
  3. The admin becomes owner. The old owner becomes admin.
- Branches: no admins exist, so the dialog asks the owner to promote someone first.
- Outcome: one new owner, both users get an email notice.

#### 2.9 Delete a Workspace

- Entry: Settings → Danger zone → "Delete Workspace".
- Actor: owner.
- Happy path:
  1. The dialog explains the retention duty for tax documents and offers "Export all data" first (flow 9.7, full export).
  2. Owner types the Workspace name and confirms with password or passkey.
  3. All Members lose access. Recurring Schedules stop. Public Share Links stop working.
- Branches: see open question Q7 on soft delete versus hard delete.
- Outcome: Workspace gone from every switcher.

### Group 3. Issuing lifecycle

#### 3.1 Create an Invoice draft

- Entry: "New" → Invoice from Documents list, dashboard, a Contact's detail page, or the mobile "+" button. Also "Duplicate" on any document.
- Actor: member.
- Happy path (W05 / M07):
  1. User picks a Contact by search, or creates one inline (flow 6.1 in a side panel).
  2. Editor fills defaults from the Contact and Workspace: currency, language, due days, payment method, PDF template, and bank account matching the currency.
  3. User adds lines. Typing in the description field searches the Price List. Picking an item fills description, unit, unit price, and VAT rate. Free-text lines are allowed.
  4. User sets dates. Issue date defaults to today. VAT payers also see taxable supply date, defaulting to the issue date. Due date follows due days.
  5. Totals recalculate on every change: subtotal, VAT recap per rate, total, and amount due.
  6. Autosave keeps the draft every few seconds. "Saved" shows in the header.
- Branches:
  - No Contacts yet: the picker shows "Add your first Contact" with ARES lookup inline.
  - Price List empty: the search shows "Save this line to the Price List" on free-text lines.
  - Non-CZK currency: the FX panel shows the CNB rate for the taxable supply date, its fixing date, and the CZK equivalent per VAT bucket (flow 3.11).
  - No bank account in the document currency: warning banner with "Add bank account" (opens 10.3 in a dialog for admins; members see "Ask an admin").
  - Reverse charge selected on a line: the editor requires the Contact's DIČ and adds "Daň odvede zákazník." to the PDF.
  - Mobile quick invoice: M07 starts from a Contact or an Invoice Template and shows one line per card. All fields stay reachable.
- Outcome: a Draft that appears in the Documents list under "Drafts". No number assigned, no email sent.

#### 3.2 Issue a document

- Entry: "Issue" on the draft editor or the draft's detail page.
- Actor: member.
- Happy path:
  1. W07 validates required fields for this document kind and Tax Regime, then previews the number the Numbering Series will assign.
  2. User confirms. The document becomes Issued with that number. A Public Share Link is created at the same moment.
  3. The confirmation offers "Send now" (flow 3.3), "Download PDF", and "Copy share link".
- Branches:
  - Validation fails: W07 lists each missing field with a link that focuses it. Examples: buyer DIČ missing on a VAT tax invoice to a business, no lines, due date before issue date.
  - Issue date is earlier than the last issued document in the same series: warning "Numbers and dates will be out of order", user may confirm.
  - Taxable supply date in the future for a non-CZK document: no CNB rate exists yet. See open question Q4.
  - Two users issue at once: each gets a distinct sequential number. The series never skips or repeats.
- Outcome: Issued document with number, PDF available, Public Share Link active, history entry "Issued by X".

#### 3.3 Send a document by email

- Entry: "Send" on the document detail, the issue confirmation, or the mobile share sheet.
- Actor: member.
- Happy path (W08 / M08):
  1. Recipients prefill from the Contact's billing emails. User can add CC.
  2. Subject and message prefill from the Workspace's email text for this document kind and language.
  3. PDF attachment is on by default. The email always contains the Public Share Link button.
  4. User sends. Resend accepts the message.
  5. History shows "Sent to a@b by X". Delivery status updates later to Delivered or Bounced.
- Branches:
  - Contact has no email: recipient field empty, Send disabled until filled. Option "Save to Contact" on the new address.
  - Bounce: the document shows a red "Email bounced" badge with the reason and a "Fix address and resend" action.
  - Sending a Draft: the dialog issues it first, using flow 3.2 validation.
  - Resending: allowed any number of times. Each send appears in history.
- Outcome: E05 delivered, document badge "Sent".

#### 3.4 Edit an issued, unlocked document

- Entry: "Edit" on an issued document's detail page.
- Actor: member.
- Happy path:
  1. A banner warns "This document was issued on D. Changes are recorded in its history".
  2. User edits any field in W05, including lines and totals. The number stays.
  3. User saves. History records a field-level diff.
  4. If the document was already sent, a prompt offers "Send updated version".
- Branches:
  - Document is locked: "Edit" is replaced by "Locked by X on D". Admins see "Unlock" (flow 3.5).
  - Edit changes the total below the amount already paid: warning showing the resulting overpayment. See open question Q3.
  - Document has a Credit Note against it: warning that the Credit Note refers to the old amounts.
  - Changing the currency or Contact on a sent document: extra confirmation, because the recipient already holds the old version.
- Outcome: document updated, diff in history, Public Share Link shows the new version.

#### 3.5 Lock and unlock a document

- Entry: "Lock" on the document detail, or bulk "Lock" on selected rows in the Documents list.
- Actor: member to lock. Admin to unlock.
- Happy path:
  1. User clicks "Lock" and confirms. A lock icon appears on the detail page and in the list.
  2. Edit and delete disappear. Payments, sends, reminders, Credit Notes, and share links still work.
  3. An admin may later click "Unlock", enter a reason, and confirm.
- Branches: bulk lock skips Drafts and reports how many it skipped.
- Outcome: Document Lock state changed, history entry with actor and, for unlock, the reason.

#### 3.6 View document history

- Entry: "History" tab on the document detail.
- Actor: accountant.
- Happy path: a timeline lists every event newest first: created, edited with expandable diff (W13), issued, sent, delivered or bounced, viewed, reminded, Payment recorded or removed, locked, unlocked, Credit Note issued, converted.
- Outcome: read only, no state change.

#### 3.7 Delete a draft, duplicate a document

- Entry: row menu or detail page.
- Actor: member.
- Happy path:
  - Delete draft: confirm, draft disappears. No number was used.
  - Duplicate: opens a new Draft with the same Contact, lines, and currency, and today's dates.
- Branches: issued documents have no Delete. The corrective path is a Credit Note (flow 3.9). See open question Q2.
- Outcome: draft removed, or a new draft created.

#### 3.8 Issue a Proforma and settle it

- Entry: "New" → Proforma.
- Actor: member.
- Happy path:
  1. User creates and issues a Proforma like flow 3.1 and 3.2. The PDF title reads "Zálohová faktura" and states it is not a tax document.
  2. The client pays. User records the Payment (flow 7.1) or an MCP client does.
  3. For a `vat_payer` Workspace, the Payment dialog shows "Issue Payment Tax Document" checked by default. Confirming issues a Payment Tax Document dated on the Payment date, in its own Numbering Series, for the amount received.
  4. When the work is delivered, user clicks "Create Final Invoice" on the Proforma. W10 opens a Draft Invoice with the Proforma's lines and a deduction line for each deposit, split by VAT rate when Payment Tax Documents exist.
  5. User issues the Final Invoice. The Proforma shows "Settled by Invoice N".
- Branches:
  - `non_vat_payer` or `identified_person`: step 3 is skipped. The Final Invoice deducts the paid amount as one line with no VAT split.
  - Partial deposit: each Payment issues its own Payment Tax Document. The Final Invoice deducts all of them.
  - Final Invoice total lower than deposits: the amount due goes negative and the editor suggests a Credit Note or refund note. Issue stays allowed.
  - User records a Payment but unticks "Issue Payment Tax Document": the Proforma shows a reminder "Payment Tax Document due within 15 days of receipt" until issued or dismissed.
  - Should the Final Invoice be issued automatically? See open question Q1.
- Outcome: Proforma marked Paid then Settled, linked Payment Tax Documents, linked Final Invoice. All three link to each other on their detail pages and PDFs.

#### 3.9 Issue a Credit Note

- Entry: "Create Credit Note" on an issued Invoice or Final Invoice.
- Actor: member.
- Happy path:
  1. W11 asks "Full or partial?" and a required reason, for example "Discount agreed after delivery".
  2. Full fills negative copies of every line. Partial opens W05 with the original lines listed for picking quantities or amounts.
  3. Editor shows the delta in tax base, VAT, and total, and the original Invoice number. The correction date defaults to today.
  4. User issues. The Credit Note gets a number from its own series.
  5. The original Invoice shows "Credited" and its amount due drops by the credited total.
- Branches:
  - Original is locked: allowed, since a Credit Note does not edit it.
  - Original already fully paid: the Credit Note shows "Refund due" with the amount, and a Payment of the refund can be recorded against it (flow 7.1, negative direction).
  - Credit total exceeds what remains uncredited: blocked with the remaining amount shown.
  - Original in foreign currency: the Credit Note uses the same currency. Its CZK VAT uses the rate of the correction date. See open question Q5.
- Outcome: Credit Note issued and linked, original's balance updated, both histories updated.

#### 3.10 Download a PDF, pick template and language

- Entry: "PDF" on the document detail, the Documents list row menu, or the mobile document detail.
- Actor: accountant.
- Happy path:
  1. A preview shows the PDF in the document's template and language.
  2. A member can switch template (Classic Czech or Modern Minimal) and language (CZ or EN) for this document. The choice saves on the document.
  3. "Download" saves `<number>.pdf`.
- Branches: Drafts download with a "DRAFT" watermark and no number.
- Outcome: file downloaded. No history entry for downloads by Members.

#### 3.11 Foreign-currency document with CNB rate

- Entry: user picks a non-CZK currency in the editor, or the Contact's default currency is non-CZK.
- Actor: member.
- Happy path:
  1. The FX panel fetches the CNB rate valid on the taxable supply date and shows "1 EUR = 25.210 CZK, CNB fixing 21.11.2026".
  2. Each VAT bucket shows its VAT in the document currency and in CZK.
  3. The PDF prints the rate, the fixing date, and CZK VAT per rate.
- Branches:
  - Taxable supply date is a weekend or holiday: the panel uses the last valid fixing and says so.
  - Today before about 14:30: today's fixing is not out yet, so the panel shows "Waiting for today's CNB rate" and the previous fixing marked as provisional.
  - CNB unreachable: the panel shows the last cached rate with a warning, and the user can enter a rate by hand. A manual rate prints the same way and history records it.
  - Currency not on the CNB daily list: the panel asks for a manual rate.
- Outcome: document stores the rate, source, and fixing date used.

### Group 4. Templates and recurring

#### 4.1 Create an Invoice Template

- Entry: Templates → "New template", or "Save as template" on any document.
- Actor: member.
- Happy path:
  1. W15 holds a name, Contact, document kind (Invoice or Proforma), currency, language, lines, due days, and note.
  2. Save. The template appears in the Templates list and in the "From template" picker.
- Branches: "Save as template" copies the document's fields and strips dates and number.
- Outcome: reusable Invoice Template.

#### 4.2 Create a document from an Invoice Template

- Entry: "New" → "From template", the Templates list, or the mobile quick invoice.
- Actor: member.
- Happy path: pick the template, and a Draft opens with its fields and today's dates. Continue with flows 3.1 to 3.3.
- Branches: template's Contact was archived, so the editor shows the Contact picker with a warning.
- Outcome: a Draft linked to its template.

#### 4.3 Set up a Recurring Schedule

- Entry: Invoice Template detail → "Make recurring".
- Actor: member.
- Happy path (W16):
  1. User picks cadence: monthly, quarterly, yearly, or every N weeks. User picks the day, for example "1st of the month" or "last day of the month".
  2. User picks start date and end: never, after N documents, or on a date.
  3. User picks mode: "Create Draft for review" or "Issue automatically". Issue mode adds a toggle "Email to Contact".
  4. A preview lists the next three run dates and the line period text that will print, such as "Hosting 12/2026".
  5. Save. The schedule shows Active with its next run.
- Branches:
  - Contact has no email and "Email to Contact" is on: save blocked until the Contact has an email.
  - Day 31 on a short month: runs on the month's last day. The preview shows this.
- Outcome: an active Recurring Schedule on the template.

#### 4.4 Recurring run

- Entry: the schedule's next run time. Runs for non-CZK templates start at 15:00 Europe/Prague so that day's CNB fixing exists.
- Actor: system, recorded as "Recurring Schedule" in history.
- Happy path:
  1. The workflow creates the document from the template, with dates set for this run and period placeholders filled.
  2. In issue mode, it issues the document. If emailing is on, it sends E05.
  3. The run appears in the schedule's run history with a link to the document.
- Branches:
  - Validation fails, for example a missing bank account for the currency: the run creates a Draft instead, marks the run "Needs attention", and emails owners and admins (E08).
  - Email bounces: the document shows the bounce like flow 3.3.
  - Workspace Tax Regime changed since template creation: the run uses the current regime and history notes it.
- Outcome: one document per run, run history updated.

#### 4.5 Pause, resume, or end a schedule, and fix a failed run

- Entry: Recurring Schedules list (W17) or template detail.
- Actor: member.
- Happy path: "Pause" stops future runs. "Resume" asks whether to run missed dates or skip them. "End" stops for good and keeps history.
- Branches: "Needs attention" runs show a "Review draft" link. Issuing that draft clears the flag.
- Outcome: schedule state changed, history entry.

### Group 5. Expenses and attachments

#### 5.1 Record an Expense manually

- Entry: Expenses → "New Expense", or the mobile "+" → Expense.
- Actor: member.
- Happy path (W19 / M13):
  1. User types the supplier IČO. ARES fills name, address, and DIČ. If the supplier exists as a Contact it links. Otherwise "Save as Contact" is ticked.
  2. User enters the supplier's document number, issue date, taxable supply date, and due date.
  3. User enters amounts per VAT rate, or a single total for non-VAT receipts. Currency defaults to CZK. Non-CZK shows the CNB rate panel from flow 3.11.
  4. User picks a category and optional tags.
  5. User sets payment status: Unpaid, Paid (with date and method), or Partially paid via flow 5.4.
  6. User attaches files. Save.
- Branches:
  - Foreign supplier with no IČO: skip lookup, enter details by hand.
  - ARES unreachable: manual entry with a warning.
  - Same supplier and document number already recorded: warning "Possible duplicate" with a link. Save stays allowed.
  - VAT entered while the Workspace is a `non_vat_payer`: VAT fields stay visible for records, and the VAT summary report excludes them from input VAT.
- Outcome: an Expense in the list, with Contact link and attachments.

#### 5.2 Capture an Expense from a photo or PDF

- Entry: mobile "+" → "Snap receipt", web drag-and-drop onto the Expenses list, or "Upload" on an empty Expense.
- Actor: member.
- Happy path:
  1. On mobile, the camera opens with edge guides. User takes one or more photos, or picks a PDF from files or the share sheet.
  2. The upload starts at once with a progress bar. The Expense editor opens beside the preview.
  3. User fills fields as in 5.1 while looking at the file.
  4. Save.
- Branches:
  - Upload fails or the phone is offline: the file stays queued on the device with "Retry". The Expense cannot save until the upload finishes. See open question Q9.
  - File over the size limit or an unsupported type: inline error listing allowed types (PDF, JPEG, PNG, HEIC) and the limit.
  - User saves the file without filling fields: the Expense saves as "Incomplete" and shows in a filter for later.
  - Android share sheet: sharing a PDF to Kvitbit opens this flow with the file attached.
- Outcome: Expense with attachments. No text extraction in v1.

#### 5.3 Edit an Expense and manage attachments

- Entry: Expense detail.
- Actor: member.
- Happy path: edit fields, add files, remove files, reorder pages. Each change records in the Expense's history.
- Branches: deleting the whole Expense requires confirmation and keeps an audit entry.
- Outcome: Expense updated.

#### 5.4 Mark an Expense paid or record a partial Payment

- Entry: "Mark paid" on the Expense detail or list row, or "Record payment".
- Actor: member.
- Happy path: the Payment dialog (W09 / M09) prefills the remaining amount and today's date. User confirms.
- Branches: same as flow 7.1.
- Outcome: status Paid or Partially paid, Payment listed on the Expense.

#### 5.5 Browse and filter Expenses

- Entry: Expenses tab.
- Actor: accountant.
- Happy path: list shows supplier, number, date, total, currency, category, status, and attachment icon. Filters: period, category, tag, status, supplier, incomplete. Search by supplier or number.
- Branches: empty Workspace shows "Snap your first receipt" with the upload target.
- Outcome: read only. Accountants can download attachments.

### Group 6. Contacts and Price List

#### 6.1 Create a Contact with ARES lookup

- Entry: Contacts → "New Contact", the document editor's Contact picker, or the Expense supplier field.
- Actor: member.
- Happy path (W21 / M16):
  1. User types an IČO. ARES fills name, address, legal form, and DIČ.
  2. User adds billing emails, phone, default currency, default language, default due days, and a note.
  3. Save.
- Branches:
  - User types a name instead: ARES search lists matching subjects with IČO and city. Picking one runs step 1.
  - IČO invalid by checksum: inline error before any request.
  - IČO not found or entity terminated: shown with its termination date. User may still save.
  - IČO already saved as a Contact: link to the existing one.
- Outcome: Contact saved, marked "From ARES" with the lookup date.

#### 6.2 Create a Contact manually

- Entry: same as 6.1, then "Enter manually".
- Actor: member.
- Happy path: country picker first. For non-CZ, fields switch to company ID, VAT ID, and a free-form address.
- Outcome: Contact saved. EU VAT IDs are not validated in v1 (see open question Q10).

#### 6.3 Edit, refresh, or archive a Contact

- Entry: Contact detail (W22).
- Actor: member.
- Happy path:
  - The detail shows documents, Expenses, outstanding balance, and overdue count for this Contact.
  - "Refresh from ARES" shows a diff of changed fields before applying.
  - "Archive" hides the Contact from pickers. Its documents stay.
- Branches: editing a Contact does not change already issued documents. A note says so.
- Outcome: Contact updated or archived.

#### 6.4 Manage Price List Items

- Entry: Price List tab, or "Save to Price List" on a document line.
- Actor: member.
- Happy path: table of items with name, unit, unit price, currency, VAT rate. Inline add and edit. Archive hides an item from the picker.
- Branches: an item in EUR used on a CZK document fills the price unconverted and warns. See open question Q6.
- Outcome: Price List Items available in the line picker.

### Group 7. Payments and reminders

#### 7.1 Record a full or partial Payment on a document

- Entry: "Record payment" on the document detail, the Documents list row, or the mobile document detail. MCP tool `record_payment`.
- Actor: member.
- Happy path (W09 / M09):
  1. Dialog prefills amount due, the document currency, today's date, and method "bank transfer".
  2. User adjusts amount or date and confirms.
  3. Status becomes Paid or Partially paid. A Proforma continues at flow 3.8 step 3.
  4. Pending reminders for this document stop when it is fully paid.
- Branches:
  - Amount exceeds amount due: warning showing the overpayment. User may confirm.
  - Payment in another currency: the dialog asks for the received amount in that currency and the equivalent applied to the document.
  - Payment date before the issue date: warning, allowed.
- Outcome: Payment listed on the document, history entry, dashboard totals updated.

#### 7.2 Remove or correct a Payment

- Entry: Payment row menu on the document or Expense.
- Actor: member.
- Happy path: "Remove" with confirmation. Status recalculates. Correcting means removing and recording again.
- Branches: a Payment that triggered a Payment Tax Document warns that the Payment Tax Document stays issued and needs a Credit Note if wrong.
- Outcome: Payment gone, history keeps both events.

#### 7.3 Automatic overdue reminders

- Entry: a daily check at 09:00 Europe/Prague.
- Actor: system.
- Happy path:
  1. For each unpaid Invoice past its due date, the workflow checks the Workspace reminder schedule. The default sends on day 3, 10, and 30 after the due date.
  2. It sends E06 in the document's language with the amount due, days overdue, and the Public Share Link.
  3. History records "Reminder 1 of 3 sent".
- Branches:
  - Reminders off in Workspace settings, or off on this document or Contact: no send.
  - Document Paid, Credited in full, or the Contact has no email: no send.
  - Proformas get no reminders by default. A setting turns them on.
- Outcome: reminder emails sent, overdue badge stays until paid.

#### 7.4 Send a manual reminder

- Entry: "Send reminder" on an overdue document.
- Actor: member.
- Happy path: the send dialog (W08) opens with the reminder text prefilled. User sends.
- Outcome: reminder sent and logged. It does not reset the automatic schedule.

#### 7.5 Configure reminders

- Entry: Settings → Documents and reminders (W34).
- Actor: admin.
- Happy path: toggle reminders, set the day offsets, edit CZ and EN reminder texts with placeholders, preview the email.
- Outcome: new schedule applies from the next daily check.

### Group 8. Public Share Link

#### 8.1 Copy or share the link

- Entry: "Share link" on the issued document detail, the mobile share sheet, or MCP tool `get_share_link`.
- Actor: accountant can copy. Member can create and revoke.
- Happy path: "Copy link" copies the URL. On mobile, "Share" opens the system share sheet.
- Outcome: link in the clipboard. No history entry.

#### 8.2 Recipient views the document

- Entry: the link in E05 or E06, or a URL pasted anywhere.
- Actor: anyone with the link.
- Happy path (P14):
  1. The page loads in the document's language with a CZ/EN toggle.
  2. The header shows the issuer's logo, document kind, number, amount due, due date, and a status badge: Unpaid, Partially paid, Paid, or Overdue.
  3. Below: issuer and recipient details, lines, VAT recap, and notes, as on the PDF.
  4. The first view per browser session records a view event. The issuing Workspace sees "Viewed".
- Branches:
  - A Member of that Workspace opens the link while signed in: no view event, and a banner "You are viewing as the issuer".
  - Revoked link or unknown token: P15 says "This link is no longer available. Contact the issuer", with the issuer's name only for revoked links.
  - Document edited after sending: the page shows the current version with "Updated on D".
  - Credit Note or Payment Tax Document: no payment section. A Credit Note shows the original Invoice number.
- Outcome: view event recorded, recipient can pay or download.

#### 8.3 Recipient pays with the QR code

- Entry: the payment section on P14.
- Actor: recipient.
- Happy path (desktop): recipient scans the QR Platba (CZK) or EPC QR (EUR) with their banking app. The app fills account, amount, variable symbol, and due date.
- Happy path (phone): QR scanning from the same screen does not work, so the section shows account number or IBAN, amount, and variable symbol, each with a copy button, above the QR code.
- Branches:
  - Paid documents hide the QR and show "Paid on D".
  - Other currencies show bank details only.
  - Partially paid: the QR encodes the remaining amount.
- Outcome: no state change. The issuer records the Payment by hand (flow 7.1).

#### 8.4 Recipient downloads the PDF

- Entry: "Download PDF" on P14.
- Actor: recipient.
- Happy path: the PDF downloads in the language currently shown.
- Outcome: download event recorded alongside views.

#### 8.5 Revoke or regenerate the link

- Entry: share link menu on the document detail.
- Actor: member.
- Happy path: "Revoke" ends the old URL. "Regenerate" revokes and creates a new one, and offers to resend the email.
- Outcome: old token returns P15.

#### 8.6 See view tracking

- Entry: document detail badge, History tab, or the Documents list "Viewed" column.
- Actor: accountant.
- Happy path: badge "Viewed 3 times, last 21.11.2026 14:02". History lists each view and download with time and a coarse device type.
- Outcome: read only.

### Group 9. Reports

All reports default to the current month, convert foreign amounts to CZK with the stored document rates, and accept a period picker: month, quarter, year, or custom range.

#### 9.1 Dashboard

- Entry: login, or the Dashboard tab.
- Actor: accountant.
- Happy path (W03 / M04): tiles for revenue this month, unpaid total, overdue total and count, and expenses this month. A 12-month cashflow chart. Lists of the five most overdue documents and the latest activity: sent, viewed, paid.
- Branches: new Workspace shows the "Getting started" checklist from flow 2.1 instead of empty tiles.
- Outcome: read only. Each tile links to its report.

#### 9.2 Revenue report

- Entry: Reports → Revenue.
- Actor: accountant.
- Happy path: issued totals by month, by Contact, and by currency. Credit Notes subtract. Proformas are excluded and Final Invoices count once.
- Outcome: read only.

#### 9.3 Expense report

- Entry: Reports → Expenses.
- Actor: accountant.
- Happy path: totals by month, category, tag, and supplier.
- Outcome: read only.

#### 9.4 Cashflow

- Entry: Reports → Cashflow.
- Actor: accountant.
- Happy path: Payments in versus Payments out per month, with net line. Uses Payment dates, not issue dates.
- Outcome: read only.

#### 9.5 Unpaid and overdue

- Entry: Reports → Receivables, or the dashboard overdue tile.
- Actor: accountant.
- Happy path: aging buckets (not due, 1 to 30, 31 to 60, 61 to 90, over 90 days) with document lists. Members get a "Send reminder" action per row.
- Outcome: read only for accountants.

#### 9.6 VAT summary

- Entry: Reports → VAT.
- Actor: accountant. Visible only for `vat_payer` and `identified_person` Workspaces.
- Happy path: for the period, output VAT per rate from issued documents and Payment Tax Documents, minus advances settled on Final Invoices, plus Credit Note deltas. Input VAT per rate from Expenses. All in CZK. Each figure drills down to the documents behind it.
- Branches: a `non_vat_payer` Workspace sees a short note in place of the tab, including the turnover so far this year against the registration threshold. See open question Q11.
- Outcome: read only. Not a filing. The page says so.

#### 9.7 Export

- Entry: "Export" on any report, or Settings → Danger zone → "Export all data".
- Actor: accountant.
- Happy path:
  1. User picks format: CSV or PDF for a report, or a ZIP of all document PDFs, Expense attachments, and CSVs for a full export.
  2. Small exports download at once. Large ones run in the background and show a "Ready to download" link in the app for 7 days.
- Outcome: file downloaded.

### Group 10. Settings and API/MCP

#### 10.1 Edit the Issuing Entity

- Entry: Settings → Issuing Entity (W30).
- Actor: admin.
- Happy path: edit name, address, IČO, DIČ, commercial register text, and email sender name. "Refresh from ARES" shows a diff.
- Branches: changes apply to documents issued from now on. Issued documents keep their stored copy.
- Outcome: updated Issuing Entity, audit entry.

#### 10.2 Change the Tax Regime

- Entry: Settings → Issuing Entity → "Change Tax Regime".
- Actor: admin.
- Happy path:
  1. User picks the new regime and its effective date.
  2. The dialog explains what changes on documents and which default Numbering Series it will add, for example Payment Tax Documents when becoming a VAT payer.
  3. Confirm.
- Branches: open Drafts dated on or after the effective date show a banner to recheck VAT.
- Outcome: regime history with effective dates, so documents pick the regime valid on their issue date.

#### 10.3 Manage bank accounts

- Entry: Settings → Bank accounts (W31).
- Actor: admin.
- Happy path: add account number with bank code or IBAN, optional BIC, currency, and label. Mark one default per currency.
- Branches: IBAN checksum fails, so inline error. Removing an account used on Drafts asks to pick a replacement.
- Outcome: accounts available in the editor and QR codes.

#### 10.4 Branding, stamp, and PDF template

- Entry: Settings → Branding (W32).
- Actor: admin.
- Happy path: upload logo and a stamp or signature image, pick the default PDF template and accent color, edit footer text. A live PDF preview updates on each change.
- Branches: image too large or wrong type gives an inline error. Transparent PNG recommended for the stamp.
- Outcome: new documents and the Public Share Link page use the branding.

#### 10.5 Numbering Series

- Entry: Settings → Numbering Series (W33).
- Actor: admin.
- Happy path: list per document kind. Edit pattern with tokens `YYYY`, `YY`, `MM`, `NNNN`, and the next number. Preview shows the next three numbers. Add extra series, for example one per business line, and pick which is the default per kind.
- Branches:
  - Changing the next number below a used number: blocked, showing the highest used number.
  - Pattern without `N` tokens: blocked.
  - Yearly reset happens automatically when the pattern contains `YYYY` or `YY`.
- Outcome: series updated, used by the next issue.

#### 10.6 Document defaults and email texts

- Entry: Settings → Documents and reminders (W34).
- Actor: admin.
- Happy path: default due days, language, note, payment method, constant symbol, delivery and reminder email texts in CZ and EN, and reminder schedule (flow 7.5).
- Outcome: defaults apply to new Drafts.

#### 10.7 Create and revoke an API Key

- Entry: Settings → API Keys (W36).
- Actor: admin.
- Happy path:
  1. "New key", name it, pick access: read only, or read and write.
  2. The key shows once with a copy button and a warning that it will not show again.
  3. The list shows name, creator, access, created date, and last used.
  4. "Revoke" ends it at once.
- Branches: a key never has more access than its creator. Removing the creator from the Workspace revokes it.
- Outcome: key usable on `/api` for this Workspace only.

#### 10.8 Connect an MCP client with OAuth 2.1 consent

- Entry: a user adds `https://<host>/mcp` in an MCP client such as Claude.
- Actor: any Member.
- Happy path:
  1. The client gets a 401, discovers the authorization server, and registers itself.
  2. The browser opens the login page if needed (flows 1.3 to 1.5).
  3. P16 shows the client name and its redirect host, a Workspace picker, and the access level: read only, or read and write. The choice is capped by the Member's role. Accountants only see read only.
  4. User approves. The browser returns to the client, which receives a token.
- Branches:
  - User denies: the client gets an error and nothing is stored.
  - Member of no Workspace: P16 says to create one first.
  - Unknown or mismatched redirect URI: P16 refuses with an error and no approve button.
- Outcome: a grant for one client, one Member, one Workspace, listed in Connected apps.

#### 10.9 Manage connected apps

- Entry: Settings → Connected apps (W37).
- Actor: any Member for their own grants. Admins see and revoke all grants in the Workspace.
- Happy path: list of grants with client name, Member, access, created, last used. "Revoke" ends the grant.
- Outcome: revoked client gets 401 on its next call.

#### 10.10 Work through MCP

- Entry: an AI client calls MCP tools with a valid token.
- Actor: the Member who granted access, with their role and the granted access level.
- Tool coverage, mapped to flows:

| Tool | Flow | Write |
|---|---|---|
| `list_documents`, `get_document`, `get_document_pdf` | 3.6, 3.10 | no |
| `create_draft`, `update_draft`, `issue_document`, `send_document` | 3.1 to 3.3 | yes |
| `settle_proforma`, `create_final_invoice`, `create_credit_note` | 3.8, 3.9 | yes |
| `lock_document` | 3.5 | yes |
| `list_invoice_templates`, `create_from_template` | 4.2 | yes for create |
| `list_expenses`, `get_expense`, `record_expense` | 5.1, 5.5 | yes for record |
| `list_contacts`, `lookup_ares`, `upsert_contact` | 6.1 to 6.3 | yes for upsert |
| `list_price_list_items` | 6.4 | no |
| `record_payment`, `send_reminder` | 7.1, 7.4 | yes |
| `get_share_link` | 8.1 | no |
| `get_report` (revenue, expenses, cashflow, receivables, vat) | 9.2 to 9.6 | no |
| `get_fx_rate` | 3.11 | no |

- Not exposed through MCP in v1: unlock, delete, settings, team, API Keys, Recurring Schedule changes, Expense file upload.
- Branches: a tool call above the grant or role returns a permission error naming the missing access. `issue_document` and `send_document` return a preview first and need a second call with `confirm: true`. See open question Q8.
- Outcome: same history entries as the web, with actor "X via <client name>".

## 4. Role permission matrix

Exactly one owner per Workspace (see open question Q12). Rows marked "own" apply to the Member's own items only.

| Action | owner | admin | member | accountant |
|---|---|---|---|---|
| View dashboard, documents, Expenses, Contacts, Price List, reports | yes | yes | yes | yes |
| Download PDFs and Expense attachments | yes | yes | yes | yes |
| Export reports and full data export | yes | yes | yes | yes |
| Copy an existing Public Share Link | yes | yes | yes | yes |
| View document history and view tracking | yes | yes | yes | yes |
| Create, edit, delete Drafts | yes | yes | yes | no |
| Issue and send documents, send reminders | yes | yes | yes | no |
| Edit issued unlocked documents | yes | yes | yes | no |
| Lock a document | yes | yes | yes | no |
| Unlock a document | yes | yes | no | no |
| Proforma settlement, Payment Tax Document, Final Invoice, Credit Note | yes | yes | yes | no |
| Create, revoke, regenerate Public Share Links | yes | yes | yes | no |
| Record and remove Payments | yes | yes | yes | no |
| Manage Invoice Templates and Recurring Schedules | yes | yes | yes | no |
| Create, edit, delete Expenses and attachments | yes | yes | yes | no |
| Create, edit, archive Contacts and Price List Items | yes | yes | yes | no |
| View settings | yes | yes | read only | read only |
| Edit Issuing Entity, Tax Regime, bank accounts, branding | yes | yes | no | no |
| Edit Numbering Series, document defaults, reminders | yes | yes | no | no |
| Invite Members and change roles of members and accountants | yes | yes | no | no |
| Invite or change admins | yes | no | no | no |
| Remove Members | yes | members and accountants | no | no |
| Create and revoke API Keys | yes | yes | no | no |
| Connect an MCP client | yes | yes | yes | read only |
| Revoke MCP grants | all | all | own | own |
| Leave Workspace | no, transfer first | yes | yes | yes |
| Transfer ownership, delete Workspace | yes | no | no | no |

## 5. Screen inventory preview

IDs are the units screen-by-screen will design. One screen may have several states; the main states are listed so nothing is missed. The brief asked for Web, Public, PDF, and Mobile. Emails are designed artifacts too, so they get their own list.

### 5.1 Public Web (17)

| ID | Screen | Flows | Key states |
|---|---|---|---|
| P01 | Landing | 1.1 | CZ, EN, signed-out only |
| P02 | Sign up | 1.2, 2.5 | ALTCHA solving, error, passkey path, invited email locked |
| P03 | Check your email | 1.2 | resend cooldown |
| P04 | Email link result | 1.2, 1.8 | verified, email changed, expired |
| P05 | Log in | 1.3, 1.4, 1.5 | password, passkey, ALTCHA after failures, return-to URL |
| P06 | Magic link sent | 1.4 | resend |
| P07 | Magic link landing | 1.4 | signing in, expired |
| P08 | Forgot password | 1.6 | sent |
| P09 | Set new password | 1.6 | expired |
| P10 | Invitation | 2.5 | join, log in or sign up, wrong account, expired |
| P11 | Terms of Service | 1.1, 1.2 | CZ, EN |
| P12 | Privacy Policy | 1.1, 1.2 | CZ, EN |
| P13 | Android download | 1.7 | phone, desktop with QR, iPhone |
| P14 | Public Share Link page | 8.2 to 8.4 | unpaid CZK, unpaid EUR, other currency, partially paid, paid, overdue, Proforma, Credit Note, Payment Tax Document, issuer viewing |
| P15 | Share link unavailable | 8.2, 8.5 | revoked, unknown |
| P16 | MCP OAuth consent | 10.8 | Workspace picker, accountant read only, no Workspace, bad redirect |
| P17 | Error pages | all | 404, no access to Workspace, 500, maintenance |

### 5.2 App Web (39)

| ID | Screen | Flows |
|---|---|---|
| W01 | App shell with navigation, Workspace switcher, user menu | 2.3, 1.10 |
| W02 | Workspace wizard | 2.1, 2.2 |
| W03 | Dashboard | 9.1 |
| W04 | Documents list | 3.5, 3.7, 8.6 |
| W05 | Document editor, with Invoice, Proforma, Credit Note, and Final Invoice variants and the FX panel | 3.1, 3.4, 3.9, 3.11, 4.2 |
| W06 | Document detail with preview, status, Payments, share link, related documents | 3.2 to 3.10, 7.1, 8.1, 8.5 |
| W07 | Issue confirmation | 3.2 |
| W08 | Send dialog | 3.3, 7.4 |
| W09 | Record Payment dialog | 5.4, 7.1, 3.8 |
| W10 | Proforma settlement and Final Invoice dialog | 3.8 |
| W11 | Credit Note start dialog | 3.9 |
| W12 | Lock, unlock, and edit-issued confirmations | 3.4, 3.5 |
| W13 | History and diff view | 3.6, 8.6 |
| W14 | Invoice Templates list | 4.1, 4.2 |
| W15 | Invoice Template editor | 4.1 |
| W16 | Recurring Schedule editor | 4.3 |
| W17 | Recurring Schedules list and run history | 4.4, 4.5 |
| W18 | Expenses list with drop target | 5.2, 5.5 |
| W19 | Expense editor and detail with attachment viewer | 5.1 to 5.4 |
| W20 | Contacts list | 6.3 |
| W21 | Contact editor with ARES lookup and search | 6.1, 6.2 |
| W22 | Contact detail | 6.3 |
| W23 | Price List | 6.4 |
| W24 | Revenue report | 9.2 |
| W25 | Expense report | 9.3 |
| W26 | Cashflow report | 9.4 |
| W27 | Receivables report | 9.5 |
| W28 | VAT summary | 9.6 |
| W29 | Export dialog and downloads list | 9.7 |
| W30 | Settings: Issuing Entity and Tax Regime | 10.1, 10.2 |
| W31 | Settings: bank accounts | 10.3 |
| W32 | Settings: branding and PDF | 10.4 |
| W33 | Settings: Numbering Series | 10.5 |
| W34 | Settings: documents and reminders | 7.5, 10.6 |
| W35 | Settings: Team | 2.4, 2.6, 2.7 |
| W36 | Settings: API Keys | 10.7 |
| W37 | Settings: connected apps | 10.9 |
| W38 | Settings: danger zone | 2.8, 2.9, 9.7 |
| W39 | Account settings | 1.5, 1.8, 1.9 |

### 5.3 PDF (11)

Each document PDF has these variants: CZ or EN, the three Tax Regimes, QR Platba, EPC QR, or no QR, Draft watermark, and with or without logo and stamp.

| ID | Template | Document |
|---|---|---|
| D01 | Classic Czech | Invoice |
| D02 | Classic Czech | Proforma |
| D03 | Classic Czech | Payment Tax Document |
| D04 | Classic Czech | Credit Note |
| D05 | Classic Czech | Final Invoice with deposit deduction |
| D06 | Modern Minimal | Invoice |
| D07 | Modern Minimal | Proforma |
| D08 | Modern Minimal | Payment Tax Document |
| D09 | Modern Minimal | Credit Note |
| D10 | Modern Minimal | Final Invoice with deposit deduction |
| D11 | Shared | Report export PDF |

### 5.4 Email (8)

| ID | Email | Flows |
|---|---|---|
| E01 | Verify your email, plus the "you already have an account" variant | 1.2 |
| E02 | Magic link | 1.4 |
| E03 | Password reset | 1.6 |
| E04 | Workspace invitation | 2.4 |
| E05 | Document delivery | 3.3, 4.4 |
| E06 | Overdue reminder | 7.3, 7.4 |
| E07 | Confirm email change, plus notice to the old address | 1.8 |
| E08 | Needs attention notice for owners and admins | 4.4 |

### 5.5 Mobile, APK and PWA (19)

| ID | Screen | Flows |
|---|---|---|
| M01 | Sign in with passkey, password, magic link | 1.3 to 1.5 |
| M02 | Sign up and verification pending | 1.2 |
| M03 | Workspace wizard, compact | 2.1, 2.2 |
| M04 | Home dashboard | 9.1 |
| M05 | Documents list | 3.5, 8.6 |
| M06 | Document detail with PDF view | 3.2, 3.5, 3.6, 3.10 |
| M07 | Document editor with quick start from Invoice Template | 3.1, 3.4, 4.2 |
| M08 | Send and share sheet | 3.3, 7.4, 8.1 |
| M09 | Record Payment sheet | 5.4, 7.1 |
| M10 | Proforma settlement sheet | 3.8 |
| M11 | Credit Note start sheet | 3.9 |
| M12 | Expense capture: camera, gallery, files | 5.2 |
| M13 | Expense editor | 5.1, 5.3 |
| M14 | Expenses list | 5.5 |
| M15 | Contacts list and detail | 6.3 |
| M16 | Contact editor with ARES lookup | 6.1, 6.2 |
| M17 | Reports summary | 9.2 to 9.7 |
| M18 | More tab with Workspace switcher and "Open on web" links | 2.3, desktop-only flows |
| M19 | Account and security | 1.5, 1.8 |

Total: 94 designable units. Public 17, App Web 39, PDF 11, Email 8, Mobile 19.

## 6. Resolved flow decisions

All 15 flow questions are settled as of 2026-11-22:

1. **Q1. Proforma to Final Invoice**: Wait for the user (auto-issue Payment Tax Document on payment for `vat_payer`; Final Invoice deducting deposit is an explicit user action).
2. **Q2. Deleting an issued document**: Never hard-delete issued documents; correct via Credit Note or Cancel/Storno (drafts remain deletable).
3. **Q3. Edits dropping total below Payments already recorded**: Allow on unlocked issued documents with an explicit warning.
4. **Q4. Non-CZK document with future taxable supply date**: Allow issuing with a manual FX rate, marked as manual on the PDF and in audit history.
5. **Q5. Credit Note FX and VAT rate**: Inherit the **original Invoice's FX rate and VAT rate** per Czech VAT Act §42 (statutory rule).
6. **Q6. Price List Item currency differs from document currency**: Fill unconverted with a clear warning.
7. **Q7. Workspace and account deletion vs 10-year tax retention**: Soft-delete immediately (hidden from active use, exportable during the 10-year retention window, purged after retention expires).
8. **Q8. MCP issue and send safety**: Two-step preview then confirm for MCP `issue` and `send`; reads, drafts, lookups, and payments stay single-call.
9. **Q9. Offline on mobile**: Queue Expense photo/PDF captures offline; other actions require connectivity.
10. **Q10. VIES and Czech VAT register (RWS)**: Deferred to v2; v1 uses ARES and stores DIČ as entered.
11. **Q11. VAT registration threshold hint for non-VAT payers**: Show as informational guidance on the VAT tab.
12. **Q12. Workspace ownership**: Exactly one owner per Workspace, transferable.
13. **Q13. Document viewed/paid notifications**: In-app activity and badges only in v1.
14. **Q14. Glossary additions**: Add **Final Invoice** and **EPC QR** to `CONTEXT.md`.
15. **Q15. Public Share Link lifetime**: Never expire unless explicitly revoked or regenerated.
16. **Mobile parity override (user decision)**: Full feature parity in Expo mobile v1 (Settings, Team, Invoice Template & Recurring Schedule editors, Price List editing, and Reports are all native in `apps/mobile`, not desktop-only).
17. **Screen-by-screen grouping (user decision)**: Composite rounds (~25-30 screens total), showing desktop 1280x800 and mobile 390x844 together with key states and dialogs.
