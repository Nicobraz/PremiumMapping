# PSS Connect

A shared relationship map for the sales team. Companies and people are dots,
and the lines between them show who knows whom. Reps sign in with their work
email, and changes show up for everyone within a few seconds.

## Signing in

- **Reps** sign in with their work email, with no password. The email has to be on the admin's rep list. Sign-ins last until the browser is closed (or cookies are cleared); click your name (top right) to sign out sooner.
- **Admins** are reps with the Admin box ticked. They sign in with their email *and* a password, and can change it under ⚙ → **Your password**. To add one from the command line: `DATABASE_URL=... python app.py add-admin 'Full Name' email@company.com 'password'`.
- **Backup admin password**: the small **Admin login** link on the sign-in screen, for when no admin can get in.
- Deactivating a rep signs them out immediately.

## Using it

- **+ Company / + Person**: add someone. People pick their company, which draws a dashed "works at" line.
- **Click** a person to open their **player card**: contact info, tags, an About summary, connections (split into inside and outside their company), and running notes stamped with who wrote them and when.
- **Click** a company for its card: everyone who works there, with titles and how they're connected inside the company, plus company notes.
- **+ Add connection** on a card connects people without touching the map, and coworkers are listed first. The "Also at…" chips connect coworkers who aren't linked yet in one click.
- **Company tags**: tags are for companies only. Anyone can add or remove a company's tags right on its card, whoever owns it: click **+ Add tag** and click a suggestion (most-used first), or type a new name and click **+ Create**. Click a tag's **×** to remove it. New tags join the shared list and the Filter. Spelling is reused, so "GYM" becomes the existing "gym". In CSV imports the `tags` column tags the company.
- **Duplicate guard**: adding or renaming warns as you type if the company or person is already on the map (company names ignore capitals, punctuation and Inc/LLC/Corp; people match on name within the same company, or on email). Saving a likely duplicate asks you to open the existing record or **Add anyway**. CSV imports use the same matching.
- **Directory** lists every company (with headcount) and every person. Filter it, then click to open a card.
- **Connect** (top bar): the map way, where you click one dot and then another.
- **⚙ Admin**: add, edit, deactivate or remove reps (name and the work email they sign in with), and change the admin password.
- **Lead ownership**: a lead a rep adds is assigned to that rep automatically, and **only an admin can reassign it**. Reps can edit and delete only their own input: leads assigned to them, connections they added and notes they wrote. Anything else shows as view-only (they can still add tags, notes and connections to it). Admins can change everything, and restoring a backup is admin-only.
- **Double-click** a person to show only their network within 2 steps. This answers "who can get us in front of this decision maker?"
- **Drag** dots to arrange the map. Positions are saved for everyone. ✣ auto-arranges everything.
- **Team view / My view** (left of the legend): Team view is the whole shared map, with each company shown once. My view shows only your companies and contacts, plus any company where one of your contacts works, so a company two reps both work appears in both reps' views, each with their own contacts. Other reps' contacts you've connected to appear faded. Admins can also pick any rep's view. Search, Filter, Directory and the stats follow the view.
- **Connecting across reps:** anyone can connect their contact to any other contact, including ones they've never talked to.
- **Legend chips** show or hide relationship types. **Filter** (top bar) narrows the map and Directory by **city** (from Location), **tag** or **rep**; a company's tag or city also keeps its people in view. Company tags show under the company name on the map.
- **Activity** shows who changed what. **Data** imports a contacts CSV, downloads or restores a backup, and saves the map as a PNG.

## Wingmate sync

Wingmate leads flow in automatically as companies, with their contacts as people and lead comments as notes. The sync is one-way: nothing is sent back to Wingmate.

- **Setup (admin):** ⚙ → **Wingmate**. Paste the Pipeline API token (Wingmate article *Retrieving your Pipeline API Access Token*, which needs the API Access & Integrations add-on) and the campaign/pipeline ID. Then click **Connect**, **Preview** to see what would change, and **Sync now**. After that it runs every 15 minutes while the site is awake.
- **Mapping:**
  - lead → company (name, city/state from the address; address and description go in About)
  - contact → person at that company (email, phone, title, notes)
  - lead comments → notes on the lead's **contact** (the primary contact if there are several; on the company only when the lead has no contact), imported once each. Company notes and tags don't exist in Wingmate and are entered here.
  - lead owner → Owner rep, matched to a rep by email or name; otherwise **unassigned**
  - two reps' leads for the same company → **one** company, with each rep's contacts owned by that rep
- **What's kept:** a lead matching an existing company or person is linked, not duplicated. PSS tags, notes, connections and positions are never touched. An owner, once set, is never overwritten. A field edited in PSS stays until it changes in Wingmate. Nothing is deleted when a lead is deleted in Wingmate.
- **Editing synced records:** synced companies, people and notes follow the same rules as everything else (the owning rep or an admin edits; anyone can tag or add notes). If someone deletes a synced company, person or note here, the sync won't bring it back.
- **Syncing while asleep:** the free server sleeps after 15 idle minutes. To keep syncing around the clock, add the link under *Sync even when nobody has the site open* to a free scheduler such as cron-job.org, every 15 minutes.

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

Download a backup regularly from **Data → Download backup**, or fetch
`/api/export.json`. **Restore backup** replaces the whole map with the file's contents.

## Configuration

| Variable   | Default                  | Purpose                                 |
|------------|--------------------------|-----------------------------------------|
| `PORT`     | `8000`                   | Port when running `python3 app.py`      |
| `DATABASE_URL` | *(unset)*            | Postgres connection string; if unset, SQLite is used |
| `DB_PATH`  | `./data/pss_connect.db`  | SQLite file location                    |
| `ADMIN_PASSWORD` | *(unset)*          | Password for the ⚙ admin panel; admin is off until set |

Brand colors are CSS variables at the top of `static/styles.css`. Change `--accent` to the PSS color.
