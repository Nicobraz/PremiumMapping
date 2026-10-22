# PSS Connect

A shared relationship map for the sales team. Companies and people are dots,
and the lines between them show who knows whom. Reps sign in with their work
email, and changes show up for everyone within a few seconds.

## Signing in

- **Reps** sign in with their work email, with no password. The email has to be on the admin's rep list. A browser stays signed in for 30 days; click your name (top right) to sign out.
- **Admin** uses **Admin login** on the sign-in screen (or ⚙ once inside) with the admin password. The first time, the admin signs in this way and adds the reps.
- Deactivating a rep signs them out immediately.

## Using it

- **+ Company / + Person**: add someone. People pick their company, which draws a dashed "works at" line.
- **Click** a person to open their **player card**: contact info, tags, an About summary, connections (split into inside and outside their company), and running notes stamped with who wrote them and when.
- **Click** a company for its card: everyone who works there, with titles and how they're connected inside the company, plus company notes.
- **+ Add connection** on a card connects people without touching the map, and coworkers are listed first. The "Also at…" chips connect coworkers who aren't linked yet in one click.
- **Directory** lists every company (with headcount) and every person. Filter it, then click to open a card.
- **Connect** (top bar): the map way, where you click one dot and then another.
- **⚙ Admin**: add, edit, deactivate or remove reps (name and the work email they sign in with), and change the admin password.
- **Lead ownership**: a lead a rep adds is assigned to that rep automatically. Reps can edit any lead's details, notes and connections, but **only the admin can change who a lead is assigned to**. Restoring a backup is also admin-only.
- **Double-click** a person to show only their network within 2 steps. This answers "who can get us in front of this decision maker?"
- **Drag** dots to arrange the map. Positions are saved for everyone. ✣ auto-arranges everything.
- **Legend chips** show or hide relationship types. The **rep / tag** dropdowns highlight one rep's or one tag's records.
- **Activity** shows who changed what. **Data** imports a contacts CSV, downloads or restores a backup, and saves the map as a PNG.

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
