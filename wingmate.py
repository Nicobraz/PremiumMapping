"""
One-way sync from Wingmate into PSS Connect.

Wingmate leads become companies, their contacts become people, and lead
comments become notes. On later runs only name, location, email and phone
are refreshed from Wingmate; PSS-side tags, notes, connections, map positions
and an owner that's already set are never touched, and nothing is deleted.
"""

import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE_URL = os.environ.get("WINGMATE_BASE_URL", "https://api.wingmateapp.com/api/v1.0").rstrip("/")
PAGE_SIZE = 100
MAX_PAGES = 500
ACTOR = "Wingmate"


class WingmateError(Exception):
    """A problem worth showing to the admin as-is."""


class WingmateClient:
    def __init__(self, token, campaign_id):
        self.token = token
        self.campaign_id = str(campaign_id).strip()

    def get(self, path, params=None):
        query = urllib.parse.urlencode({"authorization": self.token, **(params or {})})
        req = urllib.request.Request(f"{BASE_URL}{path}?{query}",
                                     headers={"Accept": "application/json", "User-Agent": "PSS-Connect"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    body = resp.read()
                    return json.loads(body) if body else None
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                if e.code in (401, 403):
                    raise WingmateError("Wingmate rejected the API token. Check the token and that the "
                                        "API Access & Integrations add-on is active.") from None
                if e.code == 404:
                    raise WingmateError(f"Wingmate couldn't find {path}. Check the campaign (pipeline) ID.") from None
                raise WingmateError(f"Wingmate returned an error ({e.code}) for {path}.") from None
            except (urllib.error.URLError, socket.timeout, ConnectionError):
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise WingmateError("Couldn't reach Wingmate. Try again in a few minutes.") from None
            except ValueError:
                raise WingmateError(f"Wingmate sent an unreadable response for {path}.") from None
        return None

    def get_all(self, path):
        """Reads every page. The API doesn't document paging, so stop when a page is
        empty or only repeats items already seen (i.e. paging is ignored)."""
        items, seen = [], set()
        for page in range(1, MAX_PAGES + 1):
            batch = unwrap_list(self.get(path, {"page": page, "per_page": PAGE_SIZE}))
            fresh = [x for x in batch if str(x.get("id")) not in seen]
            if not fresh:
                break
            for x in fresh:
                seen.add(str(x.get("id")))
                items.append(x)
        return items

    def campaign(self):
        data = self.get(f"/campaigns/{self.campaign_id}")
        if isinstance(data, dict) and isinstance(data.get("campaign"), dict):
            data = data["campaign"]
        return data if isinstance(data, dict) else {}


# ---------- reading Wingmate's shapes defensively ----------

def unwrap_list(data):
    """Accepts a bare list or an envelope like {"leads": [...]} / {"data": [...]}."""
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list) and all(isinstance(x, dict) for x in value):
                return value
    return []


def text(value, limit=300):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return ""
    return " ".join(str(value).split())[:limit]


def custom_fields(item):
    """Custom fields arrive as {"Phone": "..."} or [{"name": "Phone", "value": "..."}]."""
    raw = item.get("custom_fields")
    pairs = []
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(value, dict):
                value = value.get("value")
            pairs.append((str(key).lower(), value))
    elif isinstance(raw, list):
        for field in raw:
            if isinstance(field, dict):
                key = field.get("name") or field.get("label") or field.get("key") or ""
                pairs.append((str(key).lower(), field.get("value")))
    return pairs


def custom_value(item, *words):
    for key, value in custom_fields(item):
        if any(w in key for w in words) and text(value):
            return text(value, 5000)
    return ""


US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
}


def state_code(state):
    return US_STATES.get(state.strip().lower(), state.strip())


def address_parts(lead):
    """Returns (location 'City, ST', full address) from a string or structured address."""
    raw = lead.get("address") or lead.get("geocoded_address") or ""
    if isinstance(raw, dict):
        city = text(raw.get("city"))
        state = state_code(text(raw.get("state") or raw.get("province") or raw.get("region")))
        street = text(raw.get("street") or raw.get("address1") or raw.get("line1"))
        full = ", ".join(p for p in (street, city, state, text(raw.get("zip") or raw.get("postal_code"))) if p)
        return ", ".join(p for p in (city, state) if p), full
    full = text(raw)
    parts = [p.strip() for p in full.split(",") if p.strip()]
    if parts and parts[-1].upper() in ("USA", "US", "UNITED STATES"):
        parts = parts[:-1]
    if len(parts) >= 3:
        state = parts[-1].split()[0] if parts[-1].split() else ""
        return f"{parts[-2]}, {state}".strip(", "), full
    if len(parts) == 2:
        return f"{parts[0]}, {parts[1].split()[0] if parts[1].split() else ''}".strip(", "), full
    return full, full


def first_id(value):
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("id") or value.get("user_id")
    return str(value) if value not in (None, "") else ""


def as_iso(value):
    if isinstance(value, (int, float)) and value > 0:
        seconds = value / 1000 if value > 10 ** 11 else value
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="seconds")
    return text(value) or datetime.now(timezone.utc).isoformat(timespec="seconds")


COMMENT_TYPES = {"PhoneCorrespondence": "Phone call", "EmailCorrespondence": "Email",
                 "TextCorrespondence": "Text", "Meeting": "Meeting"}


def comment_label(comment):
    """Wingmate's note kind ("Texted", "Connected Via Phone", an email…) so the context survives."""
    kind = comment.get("comment_type")
    if isinstance(kind, dict) and text(kind.get("name")):
        return text(kind["name"])
    return COMMENT_TYPES.get(text(comment.get("type")), "")


# ---------- pipeline stages ----------
# A pipeline's stages in order, so a pipeline can sync only leads from one stage on
# (e.g. a clients pipeline from "Follow Up - Post Job" onward).

# Wingmate's fixed lead statuses, in pipeline order; used when the campaign doesn't
# list its own stages.
STATUS_RANK = {"fresh": 0, "received_by_sales": 1, "work_in_progress": 2, "pending_decision": 3,
               "contract_signed": 4, "completed": 5, "hibernated": 6, "failed": 7}


def stage_name(item):
    if isinstance(item, dict):
        for key in ("name", "label", "title", "status_string", "value"):
            if text(item.get(key)):
                return text(item.get(key))
        return ""
    return text(item)


def pipeline_stages(campaign, leads):
    """The pipeline's stage names in order: the campaign's own list when it has one,
    otherwise the stages its leads are in, ordered by Wingmate's lead status."""
    raw = campaign.get("lead_statuses") if isinstance(campaign, dict) else None
    if isinstance(raw, list) and raw:
        items = list(enumerate(raw))
        def position(pair):
            i, item = pair
            if isinstance(item, dict):
                for key in ("position", "order", "sort_order", "index", "rank"):
                    if isinstance(item.get(key), (int, float)):
                        return (item[key], i)
            return (i, i)
        names = [stage_name(item) for _, item in sorted(items, key=position)]
        names = [n for n in names if n]
        if names:
            return list(dict.fromkeys(names))
    seen = {}
    for lead in leads:
        name = text(lead.get("status_string"))
        if name:
            rank = STATUS_RANK.get(text(lead.get("status")), 99)
            seen[name] = min(rank, seen.get(name, 99))
    return sorted(seen, key=lambda n: (seen[n], n.lower()))


def stages_from(stages, first):
    """Lower-cased names of `first` and every stage after it; None means every stage."""
    if not first:
        return None
    lowered = [s.lower() for s in stages]
    if first.lower() not in lowered:
        return {first.lower()}
    return set(lowered[lowered.index(first.lower()):])


# ---------- the sync ----------

def run_sync(db, client, tools, dry_run=False, from_stage="", pipeline_name=""):
    """tools: dict with norm_name, now, bump_version (from app.py, passed in to avoid
    a circular import). Returns counts; writes nothing when dry_run is True.
    from_stage: only bring in leads at that stage of the pipeline or later.
    pipeline_name: names the pipeline in the activity feed when more than one is synced."""
    norm_name, now = tools["norm_name"], tools["now"]
    cid = client.campaign_id
    users = {str(u.get("id")): u for u in client.get_all(f"/campaigns/{cid}/users")}
    leads = client.get_all(f"/campaigns/{cid}/leads")
    contacts = client.get_all(f"/campaigns/{cid}/contacts")
    held_back = set()  # leads before the starting stage, and their contacts, are left out
    allowed = stages_from(pipeline_stages(client.campaign(), leads), from_stage) if from_stage else None
    if allowed is not None:
        held_back = {str(l.get("id")) for l in leads if text(l.get("status_string")).lower() not in allowed}
        leads = [l for l in leads if str(l.get("id")) not in held_back]
        contacts = [c for c in contacts if first_id(c.get("lead_id") or c.get("lead")) not in held_back]
    for lead in leads:  # the campaign user list can be partial; leads embed their owners and worker
        for user in (lead.get("owners") or []) + [lead.get("worker")]:
            if isinstance(user, dict) and user.get("id") is not None:
                users.setdefault(str(user["id"]), user)

    reps = [dict(r) for r in db.execute("SELECT name, email FROM reps WHERE active = 1")]
    rep_by_email = {r["email"].strip().lower(): r["name"] for r in reps if r["email"]}
    rep_by_name = {r["name"].strip().lower(): r["name"] for r in reps}

    def rep_for(user_id):
        user = users.get(user_id) or {}
        email = text(user.get("email")).lower()
        name = text(user.get("full_name") or user.get("name")).lower()
        return rep_by_email.get(email) or rep_by_name.get(name) or ""

    def author_for(comment):
        """The rep's PSS name when the commenter is a known rep, else their Wingmate name."""
        user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
        user_id = first_id(comment.get("user_id")) or first_id(user.get("id"))
        user = {**(users.get(user_id) or {}), **user}
        email = text(user.get("email")).lower()
        name = text(user.get("full_name") or user.get("name"))
        return rep_by_email.get(email) or rep_by_name.get(name.lower()) or name or ACTOR

    dismissed = {r["ref"] for r in db.execute("SELECT ref FROM wingmate_dismissed")}
    nodes = [dict(r) for r in db.execute(
        "SELECT id, type, name, location, email, phone, title, stage, owner_rep, company_id, wingmate_id, "
        "wingmate_seen, wingmate_sync FROM nodes")]
    by_wm = {n["wingmate_id"]: n for n in nodes if n["wingmate_id"]}
    companies_by_name = {}
    people_by_key, people_by_email = {}, {}
    for n in nodes:
        if n["type"] == "company":
            companies_by_name.setdefault(norm_name(n["name"], True), n)
        else:
            people_by_key.setdefault((norm_name(n["name"]), n["company_id"]), n)
            if n["email"].strip():
                people_by_email.setdefault(n["email"].strip().lower(), n)

    counts = {"leads": len(leads), "contacts": len(contacts), "companies_added": 0, "companies_linked": 0,
              "companies_updated": 0, "people_added": 0, "people_linked": 0, "people_updated": 0,
              "notes_added": 0, "notes_moved": 0, "skipped": 0, "held_back": len(held_back)}
    ts = now()
    fake_id = [0]

    def insert(values):
        if dry_run:
            fake_id[0] -= 1
            return fake_id[0]
        return db.insert("nodes", values)

    def update(node, changes):
        changes = {k: v for k, v in changes.items() if node.get(k) != v}
        if changes and not dry_run and node["id"] > 0:
            changes.update(updated_at=ts, updated_by=ACTOR)
            assignments = ", ".join(f"{col} = ?" for col in changes)
            db.execute(f"UPDATE nodes SET {assignments} WHERE id = ?", [*changes.values(), node["id"]])
        node.update(changes)
        return bool(changes)

    def sync_fields(node, wm_values, linking=False):
        """Applies a Wingmate value only when it changed in Wingmate since the last sync, so
        edits made in PSS Connect stick. When linking an existing record, only blanks are filled."""
        try:
            snapshot = json.loads(node.get("wingmate_sync") or "{}")
        except ValueError:
            snapshot = {}
        changes = {}
        for key, value in wm_values.items():
            if not value or snapshot.get(key) == value:
                continue
            if (not linking and key in snapshot) or not node.get(key):
                changes[key] = value
            snapshot[key] = value
        visible = {k: v for k, v in changes.items() if node.get(k) != v}
        update(node, {**changes, "wingmate_sync": json.dumps(snapshot, sort_keys=True)})
        return bool(visible)

    # Leads -> companies. Two reps' leads for the same company share one company here:
    # the first lead "owns" it (wingmate_id); later ones are recorded as aliases.
    aliases = {r["ref"]: (r["node_id"], r["seen"]) for r in db.execute("SELECT ref, node_id, seen FROM wingmate_aliases")}
    by_id = {n["id"]: n for n in nodes}
    lead_nodes, lead_owner, lead_stage, comment_queue = {}, {}, {}, []
    for lead in leads:
        lead_id = str(lead.get("id"))
        name = text(lead.get("name") or lead.get("identifier"))
        if not lead_id or not name:
            counts["skipped"] += 1
            continue
        wm_id = f"lead:{lead_id}"
        if wm_id in dismissed:  # deleted here on purpose
            continue
        location, full_address = address_parts(lead)
        owner = rep_for(first_id(lead.get("owner_ids")) or first_id(lead.get("worker_id")))
        lead_owner[lead_id] = owner
        lead_stage[lead_id] = text(lead.get("status_string"))
        seen = text(lead.get("actioned_at") or lead.get("created_at"))
        fresh = False
        node = by_wm.get(wm_id)
        if node is None and wm_id in aliases and aliases[wm_id][0] in by_id:
            node = by_id[aliases[wm_id][0]]
        elif node is None:
            fresh = True
            candidate = companies_by_name.get(norm_name(name, True))
            if candidate is not None and not candidate.get("wingmate_id"):
                counts["companies_linked"] += 1
                update(candidate, {"wingmate_id": wm_id, **({"owner_rep": owner} if owner and not candidate["owner_rep"] else {})})
                sync_fields(candidate, {"name": name, "location": location}, linking=True)
                node = by_wm[wm_id] = candidate
            elif candidate is not None:
                counts["companies_linked"] += 1
                if not dry_run and candidate["id"] > 0:
                    db.execute("INSERT INTO wingmate_aliases (ref, node_id, seen) VALUES (?, ?, '') "
                               "ON CONFLICT (ref) DO NOTHING", (wm_id, candidate["id"]))
                aliases[wm_id] = (candidate["id"], "")
                node = candidate
            else:
                about = "\n".join(p for p in (f"Address: {full_address}" if full_address else "",
                                              text(lead.get("description"), 5000)) if p)
                values = {"type": "company", "name": name, "location": location, "notes": about,
                          "owner_rep": owner, "wingmate_id": wm_id, "wingmate_seen": "",
                          "wingmate_sync": json.dumps({"name": name, "location": location}, sort_keys=True),
                          "created_at": ts, "updated_at": ts, "updated_by": ACTOR}
                node = {**values, "id": insert(values), "email": "", "phone": "", "title": "", "company_id": None}
                companies_by_name[norm_name(name, True)] = node
                by_wm[wm_id] = node
                counts["companies_added"] += 1
        primary = node.get("wingmate_id") == wm_id
        if not fresh:
            changed = sync_fields(node, {"name": name, "location": location}) if primary else False
            if owner and not node["owner_rep"]:
                changed = update(node, {"owner_rep": owner}) or changed
            counts["companies_updated"] += changed
        lead_nodes[lead_id] = node
        # Re-read comments only when the lead has new activity (or no timestamp to tell).
        last_seen = node.get("wingmate_seen") if primary else aliases.get(wm_id, (None, ""))[1]
        if not seen or seen != last_seen:
            comment_queue.append((lead_id, node, seen, primary))

    # Contacts -> people at their company.
    lead_contacts = {}  # lead id -> [(is primary, person node)]
    for contact in contacts:
        contact_id = str(contact.get("id"))
        lead_id = first_id(contact.get("lead_id") or contact.get("lead"))
        company = lead_nodes.get(lead_id)
        name = text(contact.get("name"))
        if not contact_id or not name or company is None:
            counts["skipped"] += 1
            continue
        wm_id = f"contact:{contact_id}"
        if wm_id in dismissed:
            continue
        email = text(contact.get("email")).lower()
        phone = text(contact.get("phone") or contact.get("phone_number")) or custom_value(contact, "phone", "mobile", "cell")
        title = custom_value(contact, "title", "position", "role") or ("Decision maker" if contact.get("primary_contact") else "")
        stage = lead_stage.get(lead_id, "")
        node = by_wm.get(wm_id)
        merged_into = aliases.get(wm_id)
        if node is None and merged_into and merged_into[0] in by_id:
            node = by_id[merged_into[0]]  # merged into another contact here: keep it current
            counts["people_updated"] += sync_fields(node, {"stage": stage})
        elif node is None:
            node = people_by_email.get(email) if email else None
            node = node or people_by_key.get((norm_name(name), company["id"]))
            if node is not None and not node.get("wingmate_id"):
                counts["people_linked"] += 1
                update(node, {"wingmate_id": wm_id})
                sync_fields(node, {"name": name, "email": email, "phone": phone, "stage": stage}, linking=True)
            else:
                values = {"type": "person", "name": name, "company_id": company["id"], "email": email,
                          "phone": phone, "title": title, "notes": custom_value(contact, "note", "comment"),
                          # Each contact belongs to the rep whose lead it came from.
                          "owner_rep": lead_owner.get(lead_id) or company.get("owner_rep", ""),
                          "wingmate_id": wm_id, "wingmate_seen": "",
                          "wingmate_sync": json.dumps({"name": name, "email": email, "phone": phone}, sort_keys=True),
                          "created_at": ts, "updated_at": ts, "updated_by": ACTOR}
                if dry_run and company["id"] < 0:
                    values["company_id"] = None  # the company doesn't exist yet in a preview
                values["stage"] = stage
                values["wingmate_sync"] = json.dumps({"name": name, "email": email, "phone": phone, "stage": stage},
                                                     sort_keys=True)
                node = {**values, "id": insert(values)}
                people_by_key[(norm_name(name), company["id"])] = node
                if email:
                    people_by_email[email] = node
                counts["people_added"] += 1
            by_wm[wm_id] = node
        else:
            counts["people_updated"] += sync_fields(node, {"name": name, "email": email, "phone": phone, "stage": stage})
        lead_contacts.setdefault(lead_id, []).append((bool(contact.get("primary_contact")), node))

    def note_target(lead_id, company):
        """Wingmate notes are about the person: the lead's primary contact, else its first
        contact; the company only when the lead has no contact here."""
        people = [(primary, n) for primary, n in lead_contacts.get(lead_id, []) if n["id"] > 0]
        people.sort(key=lambda pair: not pair[0])
        return people[0][1] if people else company

    # Lead comments -> notes (each Wingmate comment imported once).
    if dry_run:
        counts["notes_to_check"] = len(comment_queue)
    else:
        known = {r["external_id"] for r in db.execute("SELECT external_id FROM notes WHERE external_id <> ''")}
        known |= dismissed
        # Move notes that an earlier sync put on the company over to the contact
        # (only for single-lead companies, where it's clear which contact they belong to).
        shared = {node_id for node_id, _ in aliases.values()}
        for lead_id, company in lead_nodes.items():
            target = note_target(lead_id, company)
            if target is not company and company["id"] > 0 and company["id"] not in shared:
                moved = db.execute("UPDATE notes SET node_id = ? WHERE node_id = ? AND external_id LIKE ?",
                                   (target["id"], company["id"], "wingmate-comment:%"))
                counts["notes_moved"] += max(moved.rowcount or 0, 0)
        for lead_id, node, seen, primary in comment_queue:
            target = note_target(lead_id, node)
            for comment in client.get_all(f"/leads/{lead_id}/comments"):
                ext = f"wingmate-comment:{comment.get('id')}"
                body = text(comment.get("text") or comment.get("body") or comment.get("comment"), 5000)
                if ext in known or not body:
                    continue
                label = comment_label(comment)
                db.insert("notes", {"node_id": target["id"], "body": f"{label}: {body}" if label else body,
                                    "author": author_for(comment),
                                    "created_at": as_iso(comment.get("created_at")), "external_id": ext})
                known.add(ext)
                counts["notes_added"] += 1
            if primary:
                update(node, {"wingmate_seen": seen})
            else:
                db.execute("UPDATE wingmate_aliases SET seen = ? WHERE ref = ?", (seen, f"lead:{lead_id}"))

    changed = any(counts[k] for k in ("companies_added", "companies_linked", "companies_updated", "people_added",
                                      "people_linked", "people_updated", "notes_added", "notes_moved"))
    if changed and not dry_run:
        summary = (f"Wingmate sync{f' ({pipeline_name})' if pipeline_name else ''}: +{counts['companies_added']} companies, +{counts['people_added']} people, "
                   f"+{counts['notes_added']} notes, "
                   + (f"{counts['notes_moved']} notes moved to contacts, " if counts["notes_moved"] else "") +
                   f"{counts['companies_updated'] + counts['people_updated']} updated, "
                   f"{counts['companies_linked'] + counts['people_linked']} linked")
        db.execute("INSERT INTO activity (ts, actor, action, summary) VALUES (?, ?, ?, ?)",
                   (ts, ACTOR, "sync", summary))
        tools["bump_version"](db)
    if not dry_run:
        db.commit()
    return counts
