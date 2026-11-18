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
- **Changing companies** (any contact, including ones from Wingmate): on a contact's card, **Add to a company** / **Change company** lets you pick a company or type a new name (which adds the company), for when someone joins a company or moves to another one. A note like "Moved from Acme to Peak Climbing" is added to the contact (untick to skip), and **Remove from…** takes them off a company. On a company's card, **+ Add existing contact** finds someone already in PSS Connect and adds or moves them there. Reps can move their own contacts; admins anyone. Claude and ChatGPT can do the same ("Riley moved to Granite Gyms").
- **+ Add connection** on a card connects people without touching the map, and coworkers are listed first. The "Also at…" chips connect coworkers who aren't linked yet in one click.
- **Company tags**: every company should have at least one tag. One without shows **(unknown)** on the map, on its card and in lists, and *(unknown)* is a choice under Filter → Tag and in Contacts so untagged companies are easy to find. Tags come from a shared list: the built-in *Commercial GC, Residential GC, Custom Homes, Pools, Landscapers, Property Management, Government* (`TAG_LIST` in `app.py`) plus any tag a rep creates. Anyone can tag a company right on its card, whoever owns it: every tag on the list shows there, and tapping one turns it on (✓) or off, so a company can have as many as apply. **+ New tag** on a card creates a tag and adds it to that company; it goes on the list for everyone straight away (a name that matches an existing tag, ignoring capitals and a trailing *s*, just uses that one). Tags from before the list show with an **×** until someone removes them. In CSV imports the `tags` column tags the company; tags not on the list are left out ("pool" counts as *Pools*).
- **Lead requests:** ownership only changes in Wingmate, so there are no transfer requests in PSS Connect. To move a lead, reassign it in Wingmate; the next sync moves it (and its contacts) to the new rep. Requests made before this change can still be declined or cancelled under **Requests**.
- **Card color**: anyone can recolor any company or contact from its card (**Color**), and everyone sees it. Contacts follow their company's color unless given their own.
- **High priority** (contacts): anyone can flag a contact with **☆ Mark high priority**. Flagged contacts get a gold star and ring on the map and a star in lists, and **Filter → Priority** narrows to them.
- **Pipeline stage** (contacts): shows on each contact's card, in company rosters and in the Directory, so every rep can see where a contact stands, even another rep's. Wingmate contacts get it from their lead's status, and a change in Wingmate updates it; other contacts' owners set it under Edit. Filter → Stage narrows the map to it.
- **Merge…** (on a contact's card): folds a duplicate into this contact. Notes and connections move over, missing details are filled in, and the duplicate is removed; Wingmate keeps syncing into the kept contact. Reps can merge their own contacts, admins any.
- **Suggestions while adding**: typing a new company's or person's name (or a person's email or phone) drops down matching records already in PSS Connect, everyone's, not just your map, with who they belong to. Click one (or arrow down and Enter) to open it instead of adding a duplicate.
- **Duplicate guard**: adding or renaming warns as you type if the company or person is already on the map (company names ignore capitals, punctuation and Inc/LLC/Corp; people match on name within the same company, or on email). Saving a likely duplicate asks you to open the existing record or **Add anyway**. CSV imports use the same matching.
- **Contacts** (top bar) lists every rep's contacts, with a Companies tab, whatever view the map is in. Use **Filter by** (Company, Priority, Tag, City, Rep) to stack filters: several values of one kind show any of them, different kinds narrow it down. Click anyone to open their card.
- **Connect** (top bar): the map way, where you click one dot and then another.
- **⚙ Admin**: add, edit, deactivate or remove reps (name and the work email they sign in with), and change the admin password.
- **Messages to reps (admin):** ⚙ → **Messages to reps** → write a message → **Send to everyone**. Each rep gets it as a pop-up the next time they open PSS Connect and clicks **Got it**; it doesn't come back after that. Several waiting messages show one after another. The list shows who has read each message and who hasn't, and **Stop showing** keeps it from reps who haven't seen it yet (including reps added later).
- **Lead ownership**: Wingmate is the source of truth for who a lead belongs to, and **nobody can reassign a record in PSS Connect, not even an admin**. A Wingmate lead follows its owner in Wingmate; a record added in PSS Connect stays with the rep who added it (an admin adding one picks its owner). Reps can edit only their own input: leads assigned to them, connections they added and notes they wrote. Anything else shows as view-only (they can still add tags, notes and connections to it). Restoring a backup is admin-only.
- **Double-click** a person to show only their network within 2 steps. This answers "who can get us in front of this decision maker?"
- **Standard grid**: each map is laid out as a grid of columns. Companies go A to Z (connected records kept next to each other), each with its people underneath in rows of 3, stacked down the columns with no empty gaps; contacts without a company go in a block at the bottom. The grid is worked out live, so it stays tidy as leads come and go. **Drag** dots to rearrange: nothing is kept until you click **Save layout** in the bar that appears (**Undo** puts them back; switching views or leaving the page asks first). Once saved, that view keeps your layout (new records go beside it); **✣** removes it and goes back to the live grid. New contacts are placed in the next free spot under their company.
- **Pipeline view**: the menu beside the view menu (shown once Wingmate is connected) picks a Wingmate pipeline. The map then shows only that pipeline's leads and contacts (plus the companies its contacts work at) within the current view (a rep sees just their own in it), laid out in a fresh grid. That grid isn't saved; **All pipelines** goes back to the saved layout. Membership is as of each pipeline's last sync.
- **Each rep's map is just their clients**: a rep's map shows only what's assigned to them (their Wingmate leads and the records they added), plus any company where one of their contacts works. If that company belongs to another rep it's drawn **gray with a dashed ring**, and a small *Another rep's* key appears by the view menu. Other reps' contacts and companies are never drawn on a rep's map. **Search finds everyone's records**: the list under the search box opens any company or contact, with *Not on your map* beside ones that aren't drawn. There's no Team view: every map is one rep's. Reps see their own; **admins** pick any rep's view from the menu (their own is *My view*). Each rep's view has its own layout: the live grid of just their records, or the layout they saved. The Contacts and Companies lists show the rep's records first, then *Everyone else*. Filter and the stats follow the view.
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
  - lead owner → Owner rep on the company and its contacts, matched to a rep by email or name, and kept in step on every sync; a lead with no owner is **unassigned**
  - two reps' leads for the same company → **one** company, with each rep's contacts owned by that rep
- **Pause / Resume (admin):** ⚙ → Wingmate → **Pause** stops syncing in both directions: the 15-minute sync, the scheduler link, reps' sync button and flows' updates to Wingmate leads all stop until **Resume syncing**. **Preview** still works while paused, so you can see what the next sync would change before resuming. Wingmate starts out paused (it was paused when this was added, while Wingmate was being reorganized).
- **PSS Connect Push:** only Wingmate leads whose lead info has **PSS Connect Push** set to **Yes** are brought into PSS Connect. Leads already here keep syncing whatever the field says, and nothing is removed when it's set back to No. **Preview** shows how many leads are marked Yes and how many were left out, and warns if it can't find the field on any lead.
- **PSS Connect (Company or Contact):** a second lead info field says what the lead is. **Company**: the lead becomes a company card (even if its name has a dash). **Contact**: the lead's contact goes under the company card it's linked to, meaning the Company lead in Wingmate that lists the same person (same email, or same name); if none does, a name like *Peak Pools - Lee Fox* says the company; if there's still no company, the contact comes in on its own. A Contact lead sets its contact's stage and owner. Leads with the field blank work as below.
- **"Company - Person" leads:** a lead named like *Jackson Leroy - Joshua Glauser* (one lead per contact, linked to the company) isn't made into a company of its own. Its contact goes under the company (*Jackson Leroy*; created if it isn't here yet), and that contact's stage and owner come from their own lead, even where they're also listed on the company's lead. Companies an earlier sync made from such leads are folded into the real company on the next sync: their contacts, notes, connections and tags move over, and duplicate contacts are merged.
- **What's kept:** a lead matching an existing company or person is linked, not duplicated. PSS tags, notes, connections and positions are never touched. The owner rep always follows the lead's owner in Wingmate (Wingmate is the source of truth): reassign a lead there and the next sync moves it, and its contacts, to that rep's view; a lead unassigned in Wingmate becomes unassigned here. A Wingmate owner who isn't on the PSS rep list leaves the owner as it is. A field edited in PSS stays until it changes in Wingmate. Nothing is deleted when a lead is deleted in Wingmate.
- **Editing synced records:** a record from Wingmate takes its owner and pipeline stage from Wingmate (change those there). Everything else can be tidied in PSS Connect: rename it, fix the email, phone, title or location, or move a contact to another company. An edit sticks until that field changes in Wingmate, and a contact moved here stays where you put it. Notes, connections, tags, the About summary, color, high priority and on/off the map work as on any record. The owning rep or an admin can also merge or delete a synced record; if someone deletes one here, the sync won't bring it back.
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
