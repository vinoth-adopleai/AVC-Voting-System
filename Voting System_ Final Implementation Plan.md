# Voting System: Final Implementation Plan

Admin panel, Entry panel, Booth panel, and the 7-screen voting terminal, with UI/UX design, frontend, backend, infrastructure, testing, and election day. Everything is split into phases and small tasks.

Companion file: `schema.sql` (the final database script, 13 tables).

---

## How to read this plan

- **Phases** are numbered 0 to 12. Each has a goal, a task table, and a "done when" check.
- **Task IDs** look like `P4-03` (Phase 4, task 3).
- **Who:** `UX` designer, `FE` frontend developer, `BE` backend developer, `OPS` DevOps, `QA` tester, `LEAD` project lead.
- **Size:** `S` = up to half a day, `M` = about 1 day, `L` = about 2 days. Anything bigger is split.
- Tasks inside a phase can usually run in parallel unless a dependency is listed.

---

## 1. Fixed facts and decisions

| Item | Decision |
| --- | --- |
| Votes per voter | **23, fixed** (3 single-choice posts and 4 five-choice posts; confirm against the real ballot) |
| Voting screens | **Exactly 7**, one per position. The review step is a panel on Screen 7, not an extra screen |
| Ballot type | **Traceable**: each ballot is linked to its voter. Lookups are limited to the Auditor, approved, and logged |
| Candidate order | Alphabetical by Tamil name (Tamil collation), the same for every voter |
| Voting language | Tamil on voting screens (English underneath for officers). Staff panels in English with Tamil labels where useful |
| Hosting | Cloud, behind a load balancer, at least 2 API servers |
| Panels | Admin, Entry (Gate 1), Booth, and the Voting terminal. One React app, one FastAPI backend, separated by role |
| Halls | Not used now (one venue area). Can be added later with a small migration |

### Size tiers (design for 3x, deploy for the real size)

| Item | 1x | 2x | 3x |
| --- | --- | --- | --- |
| Voters | 5,000 | 10,000 | 15,000 |
| Votes per voter | 23 | 23 | 23 |
| Vote rows | 115,000 | 230,000 | 345,000 |
| Voting systems (touch laptops) | 150 | 300 | 450 |
| Booths (2 to 3 laptops each) | 50 | 100 | 150 |
| Entry desks | 5 | 10 | 15 |
| Devices on the network | 205 | 410 | 615 |
| Candidates | current | up to 2x | up to 3x |

The vote total does not grow, so the ballot logic and the 7 screens are the same at every tier. What grows is device count, traffic, and candidate list length.

---

## 2. Architecture and technology

```
Entry desks / Booths / Voting systems (touch laptops)
                        |
                 HTTPS, one address
                        |
        Load balancer (AWS ALB or Azure Application Gateway)
              |               |               |
        FastAPI server 1  FastAPI server 2  ... N  (2+ zones)
              \               |               /
               Redis (live state)   PostgreSQL (primary + standby)
```

| Layer | Choice |
| --- | --- |
| Backend | Python, FastAPI, SQLAlchemy 2, Alembic migrations |
| Database | PostgreSQL 15 or newer (`pg_trgm` extension for name search) |
| Live state | Redis (needed from 2x; optional at 1x) |
| Frontend | React, Vite, TypeScript, React Router, TanStack Query, Zustand, Tailwind CSS |
| Tamil text | Noto Sans Tamil, bundled locally (no internet font loading) |
| i18n | react-i18next with Tamil and English files |
| Testing | pytest, Playwright, Locust |
| Hosting | AWS (ALB, ECS, RDS) or Azure (Application Gateway, App Service, Flexible Server) |

### Real-time updates

- **1x:** voting systems and booth boards poll every 2 seconds.
- **2x and 3x:** Server-Sent Events (SSE) with Redis pub/sub, plus a slow fallback poll every 10 seconds.

---

## 3. Roles and panels

| Role | Panel | Device | Can do |
| --- | --- | --- | --- |
| `ADMIN` | Admin panel | Office laptop | Set up, import, manage staff and devices, open and close voting, handle exceptions |
| `GATE1_OFFICER` | Entry panel | Entry desks | Search voter, mark entry |
| `MONITOR_OFFICER` | Booth panel | Booths | See entered voters, unlock a free voting system in their own booth, reset it |
| `MONITOR_SUPERVISOR` | Booth panel (wider view) | Supervisor booth | See about 10 booths, move voters, help with resets |
| `AUDITOR` | Reports and lookups | Any | Read results, run approved voter and candidate lookups |
| Voting system | Voting terminal | Touch laptop | Show the ballot for the assigned voter and submit. Identified by a secret device token |

---

## 4. Database (final)

13 tables, full script in `schema.sql`.

| Table | Purpose |
| --- | --- |
| `elections` | The election, its status, and `ballot_total` (23) |
| `positions` | The 7 posts with min and max choices and screen order |
| `candidates` | Candidates per position (Tamil name, English name, photo) |
| `staff_users` | Staff accounts, roles, 2FA, lockout |
| `voters` | Voter list plus journey: `entered_at`, `entry_allowed_by`, `vote_allowed_by`, `voted_at`, `status` |
| `monitor_desks` | One booth officer's booth, with an optional supervisor |
| `voting_systems` | The touch laptops: booth, token, status, current voter, heartbeat |
| `ballots` | One per voter: voter, voting system, authorizing officer, status (`SUBMITTED` or `VOID`), time |
| `votes` | One row per chosen candidate (23 per ballot) |
| `idempotency_keys` | Stops double submits and retries from creating duplicates |
| `exception_events` | Resets, undos, reassignments, voids, always with a reason |
| `audit_logs` | Record of every action |
| `vote_lookups` | Log of every voter-to-votes or candidate-to-voters lookup |

**Built-in rules in the database:** one valid ballot per voter, a candidate must belong to its position, exact vote count per position and exact total (23) checked at commit, votes and audit logs cannot be edited or deleted, a ballot can only change from `SUBMITTED` to `VOID`.

**Views:** `v_voter_choices`, `v_candidate_voters`, `v_results` (valid ballots only). Grant the first two only to the Auditor role.

**Rows at 3x (100% turnout):** about 483,000 in total, of which `votes` is 345,000.

---

## 5. Voter flow and rules

```
ELIGIBLE --> GATE1_ENTERED --> BOOTH_ASSIGNED --> VOTED
  list        Entry panel       Booth panel       Voting terminal
```

1. **Entry:** officer types the serial number, presses Mark Entry. Server sets `GATE1_ENTERED`, `entered_at`, `entry_allowed_by`.
2. **Unlock:** booth officer picks the voter and a free voting system in their booth, presses Give Access. Server sets `BOOTH_ASSIGNED`, `vote_allowed_by`, and marks the system `OCCUPIED` with the voter.
3. **Vote:** the system wakes up and shows Screen 1 to 7.
4. **Submit:** one transaction locks the voter and system, inserts the ballot and 23 votes, sets `VOTED` and `voted_at`, frees the system. The deferred trigger checks the counts at commit. Any failure cancels everything.

Every state change is one server function with one transaction, an idempotency key, and an audit row. Nothing changes `status` directly.

---

## 6. Frontend and UI design

### 6.1 Design principles

1. **One job per screen.** Staff do the same thing hundreds of times. Remove everything else.
2. **Keyboard first at the Entry desk.** Type, Enter, Enter. No mouse needed.
3. **Big and clear for voters.** Large text, large touch targets, no hidden gestures.
4. **State is always visible.** Colors, icons, and words together. Never color alone.
5. **Errors tell people what to do next,** in plain words, in Tamil for voters.
6. **The voter cannot get lost.** No address bar, no tabs, no back-out, always one clear next step.

### 6.2 Design system (build once, use in all panels)

**Colors (tokens)**

| Token | Use | Value |
| --- | --- | --- |
| `primary` | Main buttons, selected items, header | `#1F4E79` |
| `primary-soft` | Selected card background | `#E3EEF8` |
| `success` | FREE, done, correct count | `#2E7D32` |
| `warning` | OCCUPIED, long wait | `#B26A00` |
| `danger` | Errors, needs attention | `#C62828` |
| `neutral-900` | Main text | `#1A1A1A` |
| `neutral-600` | Secondary text | `#555B66` |
| `neutral-200` | Borders and dividers | `#D9DDE3` |
| `neutral-50` | Page background | `#F5F7FA` |
| `offline` | OFFLINE, disabled | `#8A8F98` |

All text and button colors must pass a contrast ratio of at least 4.5 to 1. Check this in the design phase.

**Typography**

| Use | Staff panels | Voting terminal |
| --- | --- | --- |
| Page title | 24 px | 40 px |
| Section or card title | 18 px | 30 px |
| Body text | 16 px | 24 px |
| Candidate name | n/a | 28 px (Tamil), 18 px English under it |
| Small text | 13 px | 18 px |

Font: Noto Sans Tamil for Tamil, Noto Sans or system sans for English. Tamil needs about 1.5 line height, so letters with marks above and below don't touch.

**Spacing and size:** 8 px grid. Voting terminal touch targets at least 56 px high, with 16 px or more between them. Staff panels: buttons at least 44 px high.

**Core components (shared UI kit)**

`Button` (primary, secondary, danger), `TextField`, `SearchBox`, `StatusBadge`, `Card`, `Table`, `Dialog`, `Toast`, `Tabs`, `ProgressBar`, `StepBar`, `CandidateCard`, `SelectionCounter`, `SystemTile`, `EmptyState`, `ErrorMessage`, `LoadingSpinner`, `ConnectionLight`.

**Status colors (used everywhere)**

| State | Color | Icon | Label |
| --- | --- | --- | --- |
| FREE | green | check circle | Free |
| OCCUPIED | amber | person | Voting |
| NEEDS ATTENTION | red | warning | Needs help |
| OFFLINE | gray | slash | Offline |

### 6.3 Screen designs

#### Entry panel (one main screen)

```
+------------------------------------------------------------------+
|  Entry Desk 3                    Officer: Meena       [Log out]  |
+------------------------------------------------------------------+
|                                                                  |
|   Serial number                                                  |
|   [ A1023________________________________ ]   (auto-focused)     |
|                                                                  |
|   +------------------------------------------------------------+ |
|   |  A1023   Ravi Kumar                                        | |
|   |  Age 42   Male   12, Gandhi Street                         | |
|   |  Status:  Not entered yet                                  | |
|   |                                                            | |
|   |            [        MARK ENTRY  (Enter)        ]           | |
|   +------------------------------------------------------------+ |
|                                                                  |
|   Last entries:  A1022 10:41   A1021 10:40   A1020 10:40  [Undo] |
+------------------------------------------------------------------+
```

- The search box is always focused. After Mark Entry, the card clears and focus returns.
- Messages: *Not on the list*, *Already entered at 10:42*, *Already voted*, *Voting has not started*. Each has its own color and icon.
- Undo is available for 60 seconds.

#### Booth panel

```
+------------------------------------------------------------------+
|  Booth 12                          Officer: Selvi      [Log out]  |
+------------------------------------------------------------------+
|  MY VOTING SYSTEMS                                               |
|  +----------------+ +----------------+ +----------------+        |
|  | System 34      | | System 35      | | System 36      |        |
|  | [green] FREE   | | [amber] VOTING | | [red] HELP     |        |
|  |                | | Ravi K.  3:12  | | Anand S. 11:40 |        |
|  | [ Give Access ]| |                | | [ Reset ]      |        |
|  +----------------+ +----------------+ +----------------+        |
|                                                                  |
|  WAITING VOTERS (passed entry)            [ Search serial ____ ] |
|  +------------------------------------------------------------+ |
|  | A1031  Latha M.     waiting 4 min             [ Select ]   | |
|  | A1033  Karthik R.   waiting 2 min             [ Select ]   | |
|  +------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

- Select opens a small dialog: voter details, the free systems of this desk, and a **Give Access** button.
- A voter who has not passed entry, has already voted, or is already at a system is blocked with a clear reason.
- Tiles update live. A red tile means the voter has been there too long (10 minutes) or the system stopped reporting.

#### Voting terminal: locked screen

```
+------------------------------------------------------------------+
|                                                                  |
|                                                                  |
|                 தயவுசெய்து அதிகாரிக்காக காத்திருக்கவும்              |
|                    Please wait for the officer                   |
|                                                                  |
|                         System 34         (green dot)            |
+------------------------------------------------------------------+
```

#### Voting terminal: the 7 screens (same layout, different position)

```
+------------------------------------------------------------------+
|  <Position name in Tamil, large>                Screen 4 of 7    |
|  <Position name in English>                [======----] progress |
+------------------------------------------------------------------+
|  5 வேட்பாளர்களைத் தேர்ந்தெடுக்கவும்   (Select exactly 5)            |
|                                                                  |
|  +--------+ +--------+ +--------+ +--------+                     |
|  | photo  | | photo  | | photo  | | photo  |                     |
|  | Name   | | Name   | | Name   | | Name   |                     |
|  | [check]| |        | |        | | [check]|   <- selected cards |
|  +--------+ +--------+ +--------+ +--------+     get thick border|
|  ...                                              + check mark   |
+------------------------------------------------------------------+
|  Selected 2 of 5     [chip][chip]                                |
|  [ < பின்செல் Back ]  [ Clear ]              [ அடுத்து Next > ] |
+------------------------------------------------------------------+
```

Rules for every voting screen:

- **Header** shows the position and "Screen X of 7".
- **Instruction line** says exactly how many to pick.
- **Counter** is sticky at the bottom. It turns green when the count is exactly right. **Next** stays disabled until then.
- **Too many:** a tap on an extra candidate shows a short Tamil message ("You can choose only 5. Tap one to remove it first.") and changes nothing.
- **Candidate card:** photo, Tamil name, English name. No number and no symbol. Cards are in alphabetical order.
- **Selected state:** thick border, tinted background, and a check mark, so color is not the only signal.
- **Long lists (more than 12 candidates):** scrolling grid with a sticky header and counter, plus chips of the selected candidates. Above 30, add a Tamil-letter index at the side.
- **Back** keeps selections. Only the voter's own tap changes selections.

#### Screen 7 final review panel

```
+------------------------------------------------------------------+
|  Please check your choices                                        |
|  1  <Position 1>      Name A                           [Edit]     |
|  2  <Position 2>      Name B                           [Edit]     |
|  ...                                                              |
|  7  <Position 7>      Name, Name, Name, Name, Name     [Edit]     |
|                                                                  |
|  [ Go back ]                     [ உறுதிசெய்து சமர்ப்பிக்கவும்      ]  |
|                                   Confirm and Submit              |
+------------------------------------------------------------------+
```

After Confirm: a spinner (button disabled so it can't be pressed twice), then a full-screen thank-you ("உங்கள் வாக்கு பதிவு செய்யப்பட்டது", about 5 seconds), selections erased, back to the locked screen. If saving fails: "Could not save. Please call the officer." The selections stay on screen and nothing was saved, so retry is safe.

> The Tamil sentences above are working drafts. A native Tamil reader must review every voting-screen sentence before launch.

#### Admin panel

Layout: left navigation, top bar with election status, main area.

| Screen | Main parts |
| --- | --- |
| Dashboard | Counters (entered, in progress, voted, remaining), turnout by hour chart, grid of booths with status colors, alerts list |
| Election setup | Name, date, status, **pre-flight checklist**, Open and Close buttons with confirmation |
| Positions | List of 7 with min and max, order, preview of how each voting screen looks |
| Candidates | Table per position, bulk upload (spreadsheet plus photo zip), withdraw toggle |
| Voters | Import wizard (upload, preview, errors, confirm), searchable list, journey of one voter |
| Staff | Table, create, bulk CSV, deactivate, reset password |
| Booths and systems | Create booths and voting systems in bulk, assign booth officers, QR sheet for registration, offline toggle |
| Exceptions | Reset a system, undo an entry, void a ballot (reason and second approval) |
| Reports | Turnout, results (after close), exports to PDF and Excel |
| Auditor lookups | Voter to votes, candidate to voters, each requires a reason and is logged |
| Audit log | Searchable list of every action |

### 6.4 Accessibility and kiosk rules

- Text and buttons sized as in 6.2. High contrast. Works with the officer setting a larger text size.
- The voting terminal runs in browser kiosk mode: no address bar, no tabs, no refresh, no right-click, developer tools off, a locked-down device account.
- Inactivity: warning after 5 minutes, red tile on the booth after 8 to 10 minutes.
- Optional audio prompt per screen if your rules require assisted voting (decide in Phase 0).

---

## 7. Backend API summary

| Group | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout` |
| Entry | `GET /entry/voters?serial=`, `POST /entry/enter`, `POST /entry/undo`, `GET /entry/my-log` |
| Monitor | `GET /monitor/board`, `GET /monitor/waiting`, `GET /monitor/voters?serial=`, `POST /monitor/assign`, `POST /monitor/systems/{id}/reset` |
| Voting terminal | `GET /booth/session` (or SSE `/booth/events`), `POST /ballots`, `POST /booth/heartbeat` |
| Admin | `/admin/election`, `/admin/positions`, `/admin/candidates`, `/admin/voters/import`, `/admin/staff`, `/admin/monitor-desks`, `/admin/voting-systems`, `/admin/ballots/{id}/void`, `/admin/dashboard`, `/admin/audit` |
| Auditor | `GET /reports/results`, `POST /auditor/lookups/by-voter`, `POST /auditor/lookups/by-candidate` (each writes a `vote_lookups` row first) |
| Health | `GET /healthz` (checks the database and Redis) |

Backend folders: `core` (config, security, dependencies), `models`, `schemas`, `routers`, `services` (voter flow, ballot, import, audit), `tests`.

---

## 8. Phases and tasks

### Phase 0: Decisions and discovery (3 days)

**Goal:** remove every open question that would cause rework later.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P0-01 | Confirm the 7 positions, names, and the 3 single plus 4 five-choice split | LEAD | S |
| P0-02 | Confirm traceable votes and who may run lookups (and the second approver) | LEAD | S |
| P0-03 | Confirm candidate order (alphabetical, Tamil collation) and whether `ballot_no` is removed from `candidates` | LEAD, BE | S |
| P0-04 | Decide which size tier the first election uses, and when 3x is needed | LEAD | S |
| P0-05 | List candidate counts per position and the voter list format | LEAD | S |
| P0-06 | Decide on assisted voting and audio prompts | LEAD | S |
| P0-07 | Survey the venue: network, power, space, laptop model and screen size | OPS | M |
| P0-08 | Write acceptance criteria for each panel | LEAD, QA | M |

**Done when:** a one-page signed decision sheet exists.

### Phase 1: UX and UI design (8 days, runs alongside Phase 2)

**Goal:** a tested design the developers can copy.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P1-01 | Interview 2 officers and 3 voters; write down what slows them | UX | M |
| P1-02 | Draw the flow for each role (Entry, Monitor, Voting, Admin) | UX | M |
| P1-03 | Test Tamil typography on the real touch laptop (sizes, line height) | UX | S |
| P1-04 | Define design tokens: colors, type, spacing | UX | M |
| P1-05 | Design the shared components in section 6.2 | UX | L |
| P1-06 | Wireframe and design the Entry panel | UX | M |
| P1-07 | Wireframe and design the Booth panel | UX | M |
| P1-08 | Design the 7-screen voting terminal: locked, voting screen, long list, review panel, thank-you, error states | UX | L |
| P1-09 | Design the Admin panel screens | UX | L |
| P1-10 | Build a clickable prototype of the voting terminal | UX | M |
| P1-11 | Test the prototype with 5 first-time voters; fix every point where 2 or more hesitate | UX, QA | M |
| P1-12 | Native Tamil reader reviews all text on the voting screens | UX | S |
| P1-13 | Hand off: design files, token file, component notes | UX, FE | S |

**Done when:** the voting prototype passes the 5-voter test and the Tamil text is signed off.

### Phase 2: Project foundation (5 days)

**Goal:** a working skeleton that deploys automatically.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P2-01 | Create the repositories, branch rules, code style, and CI pipeline | OPS, BE | M |
| P2-02 | FastAPI skeleton: config, error format (Tamil and English messages), logging | BE | M |
| P2-03 | Alembic set up; run `schema.sql` as the first migration | BE | M |
| P2-04 | Login: password hashing, tokens, lockout, role check dependency | BE | L |
| P2-05 | Audit helper that writes `audit_logs` in the same transaction | BE | S |
| P2-06 | React project: Vite, TypeScript, Tailwind with design tokens, router, i18n, bundled fonts | FE | M |
| P2-07 | Login page and role-based route guards | FE | M |
| P2-08 | Cloud environment: network, PostgreSQL, one API server, build and deploy pipeline | OPS | L |
| P2-09 | Staging and production environments separated | OPS | S |

**Done when:** a staff user logs in on staging and lands on an empty page for their role.

### Phase 3: Shared backend core (4 days)

**Goal:** the rules that every panel depends on.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P3-01 | Voter state machine: one function per transition with checks and one transaction | BE | L |
| P3-02 | Idempotency helper (key lookup, store result, return same result on retry) | BE | M |
| P3-03 | Election status guard (voting endpoints only when `OPEN`) | BE | S |
| P3-04 | Voting-system device authentication with hashed token | BE | M |
| P3-05 | Database tests: duplicate ballot, wrong candidate for position, wrong count, wrong total, edit of a vote | BE, QA | M |
| P3-06 | Unit tests for every state transition and illegal transition | BE, QA | M |

**Done when:** all rule tests pass, including the attempts to break the database rules.

### Phase 4: Admin panel (8 days)

**Goal:** an admin can prepare a complete election.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P4-01 | Build the shared UI kit components from Phase 1 | FE | L |
| P4-02 | Admin layout, navigation, and election status bar | FE | M |
| P4-03 | Election setup API and screen | BE, FE | M |
| P4-04 | Positions API and screen (min, max, order, preview) | BE, FE | M |
| P4-05 | Candidates API and screen (including photo upload with automatic resizing) | BE, FE | L |
| P4-06 | Candidate bulk upload (spreadsheet plus photo zip) | BE, FE | M |
| P4-07 | Voter import: upload, validation, preview, rejected-row list, one transaction | BE, FE | L |
| P4-08 | Voter list and one-voter journey view | BE, FE | M |
| P4-09 | Staff API and screen, plus bulk CSV creation | BE, FE | M |
| P4-10 | Booths and voting systems: bulk create, assign booth officers, token generation, QR sheet | BE, FE | L |
| P4-11 | Pre-flight checklist (all positions defined, totals add up to 23, candidates present, voters imported, all systems registered, every desk has an officer, at least 2 servers healthy) and the Open and Close actions | BE, FE | M |
| P4-12 | Lock configuration after the election opens | BE | S |

**Done when:** an admin can create a full election from empty and the checklist turns green.

### Phase 5: Entry panel (4 days)

**Goal:** an officer marks entry in a few seconds.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P5-01 | Voter search by serial (exact) and by name (trigram index) | BE | M |
| P5-02 | Enter endpoint with idempotency key and clear error codes | BE | M |
| P5-03 | Undo endpoint (within 60 seconds, writes `exception_events`) | BE | S |
| P5-04 | Entry screen: auto-focus, Enter key to search and to mark, result card, messages | FE | L |
| P5-05 | "My last entries" list with Undo | FE | S |
| P5-06 | Speed test: search under 300 ms, mark entry under 500 ms | QA | S |

**Done when:** a trained tester processes a voter with only the keyboard in under 5 seconds.

### Phase 6: Booth panel (7 days)

**Goal:** an officer unlocks the right voting system for the right voter.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P6-01 | Board endpoint: this booth's voting systems and states | BE | M |
| P6-02 | Waiting list endpoint (entered, not assigned, longest wait first) | BE | M |
| P6-03 | Assign endpoint: lock voter and system rows, check booth ownership, set `vote_allowed_by`, mark system `OCCUPIED` | BE | L |
| P6-04 | Reset endpoint: free the system, return the voter to `GATE1_ENTERED`, clear `vote_allowed_by`, log the event; refuse if the ballot was already saved | BE | M |
| P6-05 | Heartbeat and "needs attention" rules (10 minutes, or no heartbeat) | BE | M |
| P6-06 | Booth board screen with system tiles and status colors | FE | L |
| P6-07 | Waiting list, search, and the Give Access dialog | FE | M |
| P6-08 | Reset flow with confirmation | FE | S |
| P6-09 | Live updates (2-second polling now, built so SSE can replace it) | FE | M |
| P6-10 | Concurrency test: two officers assign the same voter at once; exactly one wins | QA | M |

**Done when:** an officer cannot unlock a system of another booth, and a double assignment is impossible.

### Phase 7: Voting terminal, the 7 screens (8 days)

**Goal:** a voter can complete the 7 screens and the ballot is saved correctly.

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P7-01 | Session endpoint: returns "locked", or the voter session plus the full ballot (7 positions, candidates in alphabetical order) in one response | BE | M |
| P7-02 | Ballot submit endpoint: lock rows, validate, insert ballot and 23 votes, set `VOTED`, free the system, idempotent | BE | L |
| P7-03 | Device registration page (scan QR, save token) | FE, BE | M |
| P7-04 | Locked screen with connection light and wake-up on assignment | FE | M |
| P7-05 | Ballot store (in-memory selections, wipe on submit) | FE | M |
| P7-06 | Voting screen component: header, instruction line, candidate grid, `CandidateCard` | FE | L |
| P7-07 | Selection counter and rule enforcement (exact counts, Next disabled, "too many" message) | FE | M |
| P7-08 | Long-list layout: scrolling grid, sticky header and counter, chips, Tamil-letter index | FE | M |
| P7-09 | Build the 7 screens from server data (nothing hard-coded to positions) | FE | M |
| P7-10 | Review panel on Screen 7 with Edit buttons | FE | M |
| P7-11 | Submit flow: spinner, double-press protection, thank-you, wipe, return to locked | FE | M |
| P7-12 | Failure handling: save error message, automatic retry with the same key, selections kept | FE | M |
| P7-13 | Inactivity warning and heartbeat | FE | S |
| P7-14 | Image pre-caching on the laptop (service worker) | FE | M |
| P7-15 | Kiosk setup guide and script (browser flags, locked account) | OPS | M |
| P7-16 | End-to-end test: Entry, Monitor, voting, and the saved 23 rows | QA | M |

**Done when:** a full ballot saves with exactly 23 rows, the voter shows `VOTED`, and the system returns to locked.

### Phase 8: Reports, exceptions, and auditor tools (4 days)

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P8-01 | Live dashboard with counters (cached) and booth grid | BE, FE | L |
| P8-02 | Results screen from `v_results` (hidden until the election is closed) | BE, FE | M |
| P8-03 | PDF and Excel exports as background jobs | BE | M |
| P8-04 | Auditor lookups by voter and by candidate; reason required; write `vote_lookups` first | BE, FE | M |
| P8-05 | Admin exceptions screen: reset a system, correct a voter, void a ballot with second approval | BE, FE | M |
| P8-06 | Audit log search screen | BE, FE | S |
| P8-07 | Reconciliation report: voters `VOTED` = valid ballots, votes = 23 times valid ballots | BE | S |

**Done when:** results match a hand count of test ballots, and every lookup leaves a log row.

### Phase 9: Scale, load balancer, and security (6 days)

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P9-01 | Load balancer: HTTPS, certificate, health check `/healthz`, 2 or more servers in 2 zones, no sticky sessions, connection draining, idle timeout 120 seconds or more | OPS | L |
| P9-02 | Database connection pool, standby database, backup every 15 minutes, restore test | OPS | M |
| P9-03 | Redis for live state and counters; SSE with a slow fallback poll (from the 2x tier) | BE, OPS | L |
| P9-04 | Per-user and per-device rate limits (never per IP) | BE | M |
| P9-05 | Second factor for Admin and Auditor | BE, FE | M |
| P9-06 | Database permissions: app user cannot update or delete votes, audit logs, or ballots except the void rule | OPS, BE | S |
| P9-07 | Trigram index check and query review at 15,000 voters | BE | S |
| P9-08 | Alarms: healthy servers, 5xx errors, slow responses, certificate expiry, heartbeat loss | OPS | M |
| P9-09 | Security checklist and a basic penetration check | QA, OPS | M |

**Done when:** killing one server during a test submit loses and doubles nothing.

### Phase 10: Testing and load (6 days)

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P10-01 | Playwright end-to-end tests for each panel and each exception | QA | L |
| P10-02 | Locust test at 1.5 times the largest size (about 700 simulated devices) | QA, OPS | L |
| P10-03 | Concurrency tests: double assign, double submit, retry through a different server | QA | M |
| P10-04 | Failure drills: stop a server, fail over the database, cut one ISP, drop a switch | OPS, QA | M |
| P10-05 | Restore a backup at full data size | OPS | S |
| P10-06 | Usability test of the finished terminal with 10 new voters | UX, QA | M |
| P10-07 | Fix list and retest | ALL | L |

**Done when:** there are no errors at the target load, and the failure drills recover within the agreed time.

### Phase 11: Dress rehearsal (3 days)

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P11-01 | Train all staff (Entry, Monitor, Admin) with a one-page guide each | LEAD | M |
| P11-02 | Full mock election with volunteers on the real laptops and network | ALL | L |
| P11-03 | Measure time per voter at each stage; adjust the number of entry desks | LEAD, QA | S |
| P11-04 | Rehearse the exceptions: frozen laptop, wrong voter unlocked, network drop | ALL | M |
| P11-05 | Collect feedback and fix | ALL | M |

**Done when:** a mock election finishes with all counts reconciled.

### Phase 12: Deployment and venue (3 days)

| ID | Task | Who | Size |
| --- | --- | --- | --- |
| P12-01 | Production release; then **freeze** (no code changes until the election closes) | OPS | S |
| P12-02 | Register every voting system, install kiosk mode, test against production | OPS | L |
| P12-03 | Venue network check: wired and managed Wi-Fi, address pool, dual ISP failover, UPS and generator | OPS | M |
| P12-04 | Create staff accounts and test each login | BE, LEAD | M |
| P12-05 | Final data freeze and double check of voters and candidates by two people | LEAD | M |
| P12-06 | Run the pre-flight checklist and the go-live checklist | LEAD | S |

---

## 9. Timeline and team

| Phase | Duration | Can overlap with |
| --- | --- | --- |
| 0. Decisions | 3 days | none |
| 1. UX and UI design | 8 days | Phase 2 |
| 2. Foundation | 5 days | Phase 1 |
| 3. Shared backend core | 4 days | end of Phase 2 |
| 4. Admin panel | 8 days | Phases 5 and 6 (different developers) |
| 5. Entry panel | 4 days | Phases 4 and 6 |
| 6. Booth panel | 7 days | Phases 4 and 5 |
| 7. Voting terminal | 8 days | end of Phase 6 |
| 8. Reports and exceptions | 4 days | Phase 7 |
| 9. Scale, load balancer, security | 6 days | Phases 7 and 8 |
| 10. Testing and load | 6 days | none |
| 11. Dress rehearsal | 3 days | none |
| 12. Deployment and venue | 3 days | none |

**Total: about 9 to 10 weeks** for the team below, because design overlaps the foundation and the three panels are built in parallel. Built one after another, the same work takes about 14 weeks.

**Suggested team:** 1 UX designer, 2 frontend developers, 2 backend developers, 1 QA, 1 DevOps (part time), 1 project lead.

**If the first election is 1x:** build everything in this plan but skip SSE and Redis, the read replica, and the supervisor features at first. They are small to add later. Keep: settings-driven sizes, a stateless API, the connection pool, per-device rate limits, bulk Admin tools, the long-list voting layout, and image caching.

---

## 10. Testing plan

- **Unit tests:** state transitions, vote count validation, role checks.
- **Database tests:** second ballot, wrong candidate for a position, wrong count, wrong total, editing a vote, deleting a ballot. All must be rejected.
- **End-to-end:** one voter through all three stages for every role, and every exception.
- **Concurrency:** two officers assigning the same voter; two submits of one ballot. Exactly one succeeds.
- **Load:** about 700 simulated devices; 100 or more submissions in one minute; 450 laptops loading the ballot and photos together; kill a server at peak.
- **Usability:** 10 first-time voters on the touch screens; fix any point where more than one person hesitates.
- **Tamil check:** a native reader reviews every voting-screen sentence and the layout of every candidate name.

---

## 11. Election day runbook

**The day before**

- Production deployed and frozen, backups running, 2 or more servers healthy, certificate valid for more than 30 days.
- Voter list and candidates checked by two people.
- Every voting system registered, in kiosk mode, tested against production. Spares ready (5 to 10 percent).
- All staff have tested their logins. Alarms reach a person who confirmed a test alert.

**Opening**

- Admin runs the pre-flight checklist and opens the election.
- Each booth officer confirms their systems show green.
- Entry desks do a test entry with a dummy voter, removed afterwards.

**During**

- Admin watches the dashboard: queue at entry, waiting list, red tiles, server health.
- A technical person stays on call at the venue.

**After closing**

- Admin closes the election.
- Reconcile: voters `VOTED` = valid ballots, and votes = 23 times valid ballots.
- Publish results only after reconciliation. Take a final backup and archive the audit log and `vote_lookups`.

---

## 12. Main risks

| Risk | Effect | Prevention |
| --- | --- | --- |
| Traceable votes are exposed | Voter trust and legal problems | Auditor-only views, second approval, every lookup logged, tell voters |
| Venue network overloaded | Slow or frozen laptops | Wired LAN or managed Wi-Fi, dual ISP, on-site survey, load test |
| Per-IP rate limit blocks the venue | Everyone locked out | Rate limit per user and per device only |
| Tamil text errors | Wrong or confusing screens | Native reader sign-off, real-device typography test |
| Laptop freezes mid-vote | Voter stuck | Reset flow, spares, red tile after 10 minutes |
| Code change during voting | Unknown breakage | Release freeze |
| Candidate list longer than expected | Slow or confusing screens | Long-list layout, image pre-cache, tested at 3x |
| Too few entry desks at larger size | Queues | Measure in rehearsal, add desks by arrival rate |

---

## 13. Open decisions (answer in Phase 0)

1. The exact 7 positions, and which are single-choice and which are five-choice.
2. Remove `ballot_no` from `candidates` (the schema still has it), or keep it unused?
3. Who may run auditor lookups, and who approves them?
4. Which size tier is the first election, and when is 3x needed?
5. Is assisted voting or audio needed?
6. How should voters be told that their votes are traceable?
7. Who approves a ballot void (one admin or two)?
8. Should the booth waiting list be per booth or shared across all booths?

---

## 14. Quick checklist for the project lead

- [ ] Phase 0 decision sheet signed
- [ ] Voting prototype passed the 5-voter test, Tamil text signed off
- [ ] Rule tests pass (database and state machine)
- [ ] Admin can build a full election; pre-flight is green
- [ ] Entry desk under 5 seconds per voter, keyboard only
- [ ] Booth officer cannot unlock another booth's system
- [ ] A full ballot saves exactly 23 rows
- [ ] Results match a hand count
- [ ] Failure drills passed
- [ ] Mock election reconciled
- [ ] Release freeze in effect
