# PSS Connect

A shared relationship map for the sales team. Companies and people are dots,
and the lines between them show who knows whom. Reps sign in with their work
email, and changes show up for everyone within a few seconds.

## Signing in

- **Reps** sign in with their work email and password. A new rep's password is their first name + 123 (e.g. *Bryton123*) unless the admin types another one. Anyone can change theirs by tapping their name (top right), and admins can **Reset password** in ⚙ → Reps. Sign-ins last until the browser is closed (or cookies are cleared); click your name (top right) to sign out sooner.
- **Admins** are reps with the Admin box ticked. They sign in with their email *and* a password, and can change it under ⚙ → **Your password**. To add one from the command line: `DATABASE_URL=... python app.py add-admin 'Full Name' email@company.com 'password'`.
- **Backup admin password**: the small **Admin login** link on the sign-in screen, for when no admin can get in.
- Deactivating a rep signs them out immediately.

## Using it

- **+ Company / + Person**: add someone. People pick their company, which draws a dashed "works at" line.
- **Click** a person to open their **player card**: contact info, tags, an About summary, connections (split into inside and outside their company), and running notes stamped with who wrote them and when.
- **Click** a company for its card: everyone who works there, with titles and how they're connected inside the company, plus company notes.
- **Changing companies**: on a contact's card, **Add to a company** / **Change company** lets you pick a company or type a new name (which adds the company), for when someone joins a company or moves to another one. A note like "Moved from Acme to Peak Climbing" is added to the contact (untick to skip), and **Remove from…** takes them off a company. On a company's card, **+ Add existing contact** finds someone already in PSS Connect and adds or moves them there. Reps can move their own contacts; admins anyone. Claude and ChatGPT can do the same ("Riley moved to Granite Gyms").
- **+ Add connection** on a card connects people without touching the map, and coworkers are listed first. The "Also at…" chips connect coworkers who aren't linked yet in one click.
- **Company tags**: tags are for companies only, from a fixed list: *Commercial GC, Residential GC, Custom Homes, Pools, Landscapers, Property Management, Government* (`TAG_LIST` in `app.py`). Anyone can add or remove a company's tags right on its card, whoever owns it: click **+ Add tag** and pick one (typing narrows the list). Click a tag's **×** to remove it. Tags from before the list stay until someone removes them. In CSV imports the `tags` column tags the company; tags not on the list are left out ("pool" counts as *Pools*).
- **Request transfer**: on a lead that belongs to someone else, a rep can tap **Request transfer** (with an optional reason). The current owner, or an admin, approves or declines it from the banner on the card or from **Requests** in the top bar (**More → Transfer requests** on phones). Requests for unassigned leads go to admins. Approving moves the lead, and for a company also the previous owner's contacts there. Requesters can cancel a pending request and see the outcome.
- **Card color**: anyone can recolor any company or contact from its card (**Color**), and everyone sees it. Contacts follow their company's color unless given their own.
- **High priority** (contacts): anyone can flag a contact with **☆ Mark high priority**. Flagged contacts get a gold star and ring on the map and a star in lists, and **Filter → Priority** narrows to them.
- **Pipeline stage** (contacts): shows on each contact's card, in company rosters and in the Directory, so every rep can see where a contact stands, even another rep's. Wingmate contacts get it from their lead's status, and a change in Wingmate updates it; other contacts' owners set it under Edit. Filter → Stage narrows the map to it.
- **Merge…** (on a contact's card): folds a duplicate into this contact. Notes and connections move over, missing details are filled in, and the duplicate is removed; Wingmate keeps syncing into the kept contact. Reps can merge their own contacts, admins any.
- **Duplicate guard**: adding or renaming warns as you type if the company or person is already on the map (company names ignore capitals, punctuation and Inc/LLC/Corp; people match on name within the same company, or on email). Saving a likely duplicate asks you to open the existing record or **Add anyway**. CSV imports use the same matching.
- **Contacts** (top bar) lists every rep's contacts, with a Companies tab, whatever view the map is in. Use **Filter by** (Company, Priority, Tag, City, Rep) to stack filters: several values of one kind show any of them, different kinds narrow it down. Click anyone to open their card.
- **Connect** (top bar): the map way, where you click one dot and then another.
- **⚙ Admin**: add, edit, deactivate or remove reps (name and the work email they sign in with), and change the admin password.
- **Lead ownership**: a lead a rep adds is assigned to that rep automatically, and **only an admin can reassign it**. Reps can edit and delete only their own input: leads assigned to them, connections they added and notes they wrote. Anything else shows as view-only (they can still add tags, notes and connections to it). Admins can change everything, and restoring a backup is admin-only.
- **Double-click** a person to show only their network within 2 steps. This answers "who can get us in front of this decision maker?"
- **Drag** dots to arrange the map. Positions are saved for everyone. **✣** arranges the whole map as an org chart: companies in rows across the top, each company's people underneath it in rows of 5, newest first: the most recently added or edited company on the left (a company counts as edited when any of its people is) and the most recently added or edited person first under each company. Connected records are kept side by side (coworkers who know each other next to each other, connected companies next to each other), so their lines stay short. Anywhere on the map, a connection line that would run through someone else's dot curves around it, and contacts without a company in a block at the bottom. New contacts are placed in the next free spot under their company.
- **Team view / My view** (left of the legend): Team view is the whole shared map, with each company shown once. My view shows only your companies and contacts, plus any company where one of your contacts works, so a company two reps both work appears in both reps' views, each with their own contacts. Other reps' contacts you've connected to appear faded. Admins can also pick any rep's view. Search, Filter, Directory and the stats follow the view.
- **Connecting across reps:** anyone can connect their contact to any other contact, including ones they've never talked to.
- **Legend chips** show or hide relationship types. **Filter** (top bar) narrows the map and Directory by **city** (from Location), **tag** or **rep**; a company's tag or city also keeps its people in view. Company tags show under the company name on the map.
- **Activity** shows who changed what. **Data** imports a contacts CSV and saves the map as a PNG. Admins also get **Export to CSV** (contacts or companies, everything or just what's showing) and **Backup / Restore**.

## On a phone

The site switches to a phone layout built for looking things up and adding contacts on the go. It opens on the **Contacts** list (with search), and the bottom bar has **Contacts · Companies · ＋ Add · Map · More**. Cards open full screen and show who each contact knows; closing a card goes back to the list. On phones the map's dots can't be dragged (arrange them from a computer), and filtering the map is under **More**. To install it like an app, open the site in Safari (iPhone) or Chrome (Android) and choose **Share → Add to Home Screen** (iPhone) or **⋮ → Add to Home screen / Install app** (Android).

## Wingmate sync

Wingmate leads flow in automatically as companies, with their contacts as people and lead comments as notes. The sync is one-way: nothing is sent back to Wingmate.

- **Setup (admin):** ⚙ → **Wingmate**. Paste the Pipeline API token (Wingmate article *Retrieving your Pipeline API Access Token*, which needs the API Access & Integrations add-on) and the campaign/pipeline ID. Then click **Connect**, **Preview** to see what would change, and **Sync now**. After that it runs every 15 minutes while the site is awake.
- **More pipelines (admin):** ⚙ → Wingmate → *Other pipelines* → **+ Add another pipeline** → **Find my pipelines** lists the company's other pipelines (a company API token reads them all); click **Add** on one. Or type its campaign ID (plus its own API token only if it has one; blank uses the main token) and click **Check pipeline**. Either way you see its stages in pipeline order with how many leads are in each. Choose **Show on the map from this stage on** (e.g. a clients pipeline from *Follow Up - Post Job* on) or *Every stage*, or **Never** for a list nobody has contacted yet (e.g. *Cold Outreach*: its contacts go on the map once they show up in another pipeline, such as the main one, and aren't duplicated), then **Save pipeline**, **Preview** and **Sync now**. Every lead and contact in the pipeline comes into PSS Connect and can be found in search, *Contacts* and Claude/ChatGPT; ones before the chosen stage are kept off the map and go on it automatically once they reach that stage.
- **On or off the map:** a record that isn't on the map shows *Not on map* in Contacts and search, and its card has **+ Put on the map** (a company brings its contacts; a contact brings its company). **Take off map** on any card hides it again without deleting anything; the sync won't put back something a person took off. Contacts can be filtered by *Map* and *Stage*. Every pipeline syncs together, and Claude/ChatGPT's Wingmate lookups search them all.
- **Sync now (any rep):** the **↻ Wingmate** button in the top bar (on phones: More → Sync with Wingmate) brings in what was just added in Wingmate without waiting for the 15-minute sync. If a sync finished in the last minute it just says you're up to date.
- **Mapping:**
  - lead → company (name, city/state from the address; address and description go in About)
  - contact → person at that company (email, phone, title, notes)
  - lead comments → notes on the lead's **contact** (the primary contact if there are several; on the company only when the lead has no contact), imported once each. Company notes and tags don't exist in Wingmate and are entered here.
  - lead owner → Owner rep, matched to a rep by email or name; otherwise **unassigned**
  - two reps' leads for the same company → **one** company, with each rep's contacts owned by that rep
- **What's kept:** a lead matching an existing company or person is linked, not duplicated. PSS tags, notes, connections and positions are never touched. An owner, once set, is never overwritten. A field edited in PSS stays until it changes in Wingmate. Nothing is deleted when a lead is deleted in Wingmate.
- **Editing synced records:** synced companies, people and notes follow the same rules as everything else (the owning rep or an admin edits; anyone can tag or add notes). If someone deletes a synced company, person or note here, the sync won't bring it back.
- **Syncing while asleep:** the free server sleeps after 15 idle minutes. To keep syncing around the clock, add the link under *Sync even when nobody has the site open* to a free scheduler such as cron-job.org, every 15 minutes.

## Outbound flows (admins)

Apollo-style sequences, for admins only for now. **Flows** in the top bar opens them on a page of their own (pss-connect.onrender.com/flows) in a new browser tab; on a phone, *More → Outbound flows*. **‹ Map** goes back to the map.

- **Build a flow:** *Flows → + New flow*. A new flow starts as the standard sequence: 1. Email, 2. Call, 3. Email, 4. LinkedIn (connection request), 5. Call, 6. Email, 7. LinkedIn message, 2–3 days apart except the second email, which comes due as soon as the call is logged; write the emails, and change, add (**Email**, **Call**, **LinkedIn**, **Task**), reorder or remove steps as you like. Each step has a wait in days (the first step counts from when a contact is added, later ones from when the step before was done). Emails and call scripts can use fill-ins: `{{first_name}}`, `{{last_name}}`, `{{name}}`, `{{company}}`, `{{title}}`, `{{city}}`, `{{sender}}`. Optionally pick stages that take contacts out automatically (e.g. *Meeting Set*).
- **Fill it from a Wingmate pipeline:** under *Where contacts come from*, pick a pipeline (e.g. *Cold Outreach*), optionally the stage to start contacts at, and how many new contacts to add a day. Each sync then adds that pipeline's contacts until the day's number is reached; a contact is only ever added to a flow once. Anyone who leaves the pipeline in Wingmate (moved to another pipeline or deleted) leaves the flow too. Stages are listed in that pipeline's order.
- **Update Wingmate:** a flow tied to a pipeline can write back to the contact's Wingmate lead, set under *Update Wingmate* in the flow editor: log each step on the lead (as an Email, Phone or Social update, under your Wingmate user when your PSS email matches it), and move the lead to a chosen stage after the first step, on **Replied**, on **Meeting booked** and when the flow finishes with no reply. **Meeting booked** can also move the lead into another pipeline (e.g. the main one) at a chosen stage. Only admins' actions are sent, for now. It happens the moment you click, and if Wingmate refuses, its message shows on screen (fix it in Wingmate by hand). Updates written this way aren't imported back as duplicate notes.
- **Add contacts by hand:** **Add to flow** on a contact's card, or filter the **Contacts** list and use *Add N contacts to …* at the top. Contacts already in the flow or already at an exit stage are skipped.
- **Work it:** *To do* lists every step due today or overdue. Email steps come written; edit if you like, then **Open in email app** / **Open in Gmail** (or **Copy text**), send it yourself, and click **Mark sent**. Calls have a call button, the script and an outcome to log. LinkedIn steps have the message ready to copy and a **Find on LinkedIn** button. Nothing is sent from PSS Connect.
- Every step done is saved as a note on the contact's card. **Replied** or **Meeting booked** takes the contact out of the flow; so does **Remove**, the last step, or their stage (synced from Wingmate) reaching an exit stage. **Put back** on the flow page restarts them where they left off.

## Ask AI (built-in assistant)

The **✦ Ask AI** tab on the right edge (on phones: More → Ask AI) opens Claude or ChatGPT in
a new tab with the rep's question filled in ("Using PSS Connect: …"), using the connector below
that each rep connects once. If an admin adds an Anthropic API key, the tab instead becomes a
built-in chat with Claude
(Sonnet 5.5) inside PSS Connect. Reps can ask about any company or contact, tell it about a
meeting, or attach a business-card photo, PDF or CSV, and it updates PSS Connect as them, with
the same tools and rules as the connector below (no deleting; bulk adds show a preview first).
Names in its answers link to the cards. Each rep's conversation is kept, so it follows them
between phone and computer; *New chat* starts over.

It runs on the team's Anthropic account, so reps don't need their own Claude or ChatGPT:
an admin creates an API key at console.anthropic.com (with billing, and ideally a monthly spend
limit) and pastes it in ⚙ → AI assistant (or sets `ANTHROPIC_API_KEY` in Render). The same
section shows this month's questions and estimated cost per rep. Each rep can ask up to 150
questions a day. Typical cost is a few cents per question.

## Claude and ChatGPT

PSS Connect is also a connector (an MCP server) for Claude and ChatGPT, at
`https://pss-connect.onrender.com/mcp`. Each rep adds it to their own Claude or ChatGPT and
signs in with their PSS Connect email and password; the assistant then works as that rep.
The link and step-by-step instructions are in the app under your name → *Use with Claude or ChatGPT*.

- **Claude** (any plan, free accounts get one custom connector): Settings → Connectors →
  Add custom connector → paste the link → Connect.
- **ChatGPT**: Settings → Apps → Advanced settings → Developer mode → Create app → paste the
  link, OAuth. Adding and editing needs a Business/Enterprise workspace (an admin adds the
  app once for everyone); Plus/Pro may be read-only.

What it can do: search and read companies, contacts, notes and connections; find how two
records are connected; add companies and contacts (with duplicate checks); bulk-add a pasted
list or spreadsheet (it always shows a preview first and saves only after the rep agrees);
edit the rep's own records; add notes, company tags, connections and high priority; request
a lead; and search Wingmate live (read-only). It cannot delete anything. The same ownership
rules as the app apply, and its changes show in Activity marked "(via Claude)" / "(via ChatGPT)".

Sign-ins last 90 days. Changing your password, being deactivated, or *Disconnect my AI
assistants* in the account menu signs the assistant out. The free Render server can take
up to a minute to wake up outside work hours, so the first request may be slow.

## Run locally

```bash
pip3 install -r requirements.txt
python3 app.py            # http://localhost:8000
```

Or double-click `Run PSS Connect.command` on a Mac. Locally, data is stored in `data/pss_connect.db` (SQLite).

## Deploy to Render (free)

Render's free plan wipes the server's disk whenever it sleeps, so the data lives in a
free [Neon](https://neon.tech) Postgres database instead.

1. **Neon:** sign up, create a project, and copy the connection string
   (`postgresql://…neon.tech/neondb?sslmode=require`).
2. **Render:** **New → Blueprint**, then pick this repo. When it asks for `DATABASE_URL`, paste the Neon string.
3. Share the `https://pss-connect-….onrender.com` URL with the team.

The app creates its tables on first start. Free-plan notes: the site sleeps after
15 minutes with no visitors, and the first visit after that takes about a minute to wake up.
Neon also sleeps when idle, and that's fine because the data stays put.

## Backups

- **Nightly copies:** a full copy of the map (companies, contacts, notes, connections, tags, reps) is saved in the database every night, and the last 30 are kept. A copy is also saved before every restore.
- **Data → Backups** (admin): **Back up now**, download any copy, or **Restore** one. Restoring replaces the whole map, but the current map is saved first, so a restore can be undone from the same list.
- **Off-site:** a private GitHub repository (`pss-connect-backups`) downloads the nightly copy every night and keeps 90 days, in case the database itself is ever lost.
- Backups never contain passwords or the Wingmate token.

## Configuration

| Variable   | Default                  | Purpose                                 |
|------------|--------------------------|-----------------------------------------|
| `PORT`     | `8000`                   | Port when running `python3 app.py`      |
| `DATABASE_URL` | *(unset)*            | Postgres connection string; if unset, SQLite is used |
| `DB_PATH`  | `./data/pss_connect.db`  | SQLite file location                    |
| `ADMIN_PASSWORD` | *(unset)*          | Password for the ⚙ admin panel; admin is off until set |

Brand colors are CSS variables at the top of `static/styles.css`. Change `--accent` to the PSS color.
