"""
Outbound flows (admin only for now), similar to Apollo sequences.

A flow is an ordered list of steps (email, call or task), each with a wait in days.
Contacts are enrolled; each enrollment walks the steps one at a time. A step comes due
`wait_days` after the previous one was done (the first: after enrolling). Nothing is sent
from here: email steps are drafts the admin sends from their own mailbox, and every step
done is recorded as a note on the contact.

A flow can be tied to a Wingmate pipeline (e.g. Cold Outreach): it then adds that pipeline's
contacts by itself, up to a set number a day, optionally only those at a starting stage.

A contact leaves a flow when it's marked replied or meeting booked, when it's removed, after
the last step, when its pipeline stage (synced from Wingmate) reaches one of the flow's
exit stages, or when it's no longer in the flow's pipeline (e.g. moved to another one).
"""
import json
from datetime import datetime, timedelta, timezone

from flask import jsonify, request

try:
    from zoneinfo import ZoneInfo
    LOCAL = ZoneInfo("America/Denver")  # where the team works; due dates roll over at local midnight
except Exception:  # no tz database on this machine
    LOCAL = None

core = None  # the app module, set by install()

STEP_KINDS = ("email", "call", "linkedin", "task")
MAX_STEPS = 20
ENDINGS = {"replied": "Replied", "meeting": "Meeting booked", "stopped": "Removed from the flow",
           "finished": "Finished every step", "exited": "Stage reached"}
CALL_OUTCOMES = ("No answer", "Left voicemail", "Talked", "Wrong number")
AUTO = "Auto (Wingmate)"  # enrolled_by for contacts a pipeline flow added by itself
MAX_DAILY = 500

SCHEMA = """
CREATE TABLE IF NOT EXISTS flows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    exit_stages  TEXT NOT NULL DEFAULT '[]',
    steps        TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS flow_enrollments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id       INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'active',
    step_index    INTEGER NOT NULL DEFAULT 0,
    due_on        TEXT NOT NULL DEFAULT '',
    enrolled_at   TEXT NOT NULL,
    enrolled_by   TEXT NOT NULL DEFAULT '',
    last_done_at  TEXT NOT NULL DEFAULT '',
    ended_at      TEXT NOT NULL DEFAULT '',
    ended_reason  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_flow_enrollments_flow ON flow_enrollments(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_enrollments_node ON flow_enrollments(node_id);
"""


def today():
    return (datetime.now(LOCAL) if LOCAL else datetime.now()).date()


def due_after(days, start=None):
    return ((start or today()) + timedelta(days=max(0, int(days or 0)))).isoformat()


def loads(text, fallback):
    try:
        value = json.loads(text or "")
    except ValueError:
        return fallback
    return value if isinstance(value, type(fallback)) else fallback


def flow_row(row):
    return {"id": row["id"], "name": row["name"], "exit_stages": loads(row["exit_stages"], []),
            "steps": loads(row["steps"], []), "created_at": row["created_at"],
            "pipeline": row["pipeline"], "start_stage": row["start_stage"], "auto_daily": row["auto_daily"],
            "updated_at": row["updated_at"], "updated_by": row["updated_by"]}


def clean_flow(data):
    """Returns (values, error) for a flow from the builder."""
    name = str(data.get("name") or "").strip()[:120]
    if not name:
        return None, "Give the flow a name"
    steps = []
    for raw in (data.get("steps") or [])[:MAX_STEPS]:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("kind") if raw.get("kind") in STEP_KINDS else "task"
        wait = core.to_int(raw.get("wait_days")) or 0
        step = {"kind": kind, "wait_days": min(365, max(0, wait)),
                "subject": str(raw.get("subject") or "").strip()[:300] if kind == "email" else "",
                "body": str(raw.get("body") or "").strip()[:5000]}
        if kind == "email" and not (step["subject"] or step["body"]):
            return None, f"Step {len(steps) + 1} is an email with no subject or text"
        steps.append(step)
    if not steps:
        return None, "Add at least one step"
    stages = [str(s).strip()[:120] for s in (data.get("exit_stages") or []) if str(s).strip()]
    pipeline = str(data.get("pipeline") or "").strip()[:60]
    start = str(data.get("start_stage") or "").strip()[:120] if pipeline else ""
    daily = min(MAX_DAILY, max(0, core.to_int(data.get("auto_daily")) or 0)) if pipeline else 0
    if start and start.lower() in {x.lower() for x in stages}:
        return None, f"“{start}” can't be both the starting stage and an exit stage"
    return {"name": name, "steps": json.dumps(steps), "exit_stages": json.dumps(sorted(set(stages))),
            "pipeline": pipeline, "start_stage": start, "auto_daily": daily}, None


def pipelines(db):
    """Connected Wingmate pipelines with their stages in order (as of the last sync)."""
    stages = loads(core.get_setting(db, "wingmate_stages"), {})
    out = []
    for settings, _ in core.wingmate_pipelines(db):
        cid = str(settings["campaign_id"])
        out.append({"campaign_id": cid, "name": settings.get("name") or f"Pipeline {cid}",
                    "main": bool(settings.get("main")), "stages": stages.get(cid, [])})
    return out


def members(db, campaign_id):
    return {r["node_id"] for r in db.execute("SELECT node_id FROM wingmate_members WHERE campaign_id = ?", (campaign_id,))}


def local_day(iso):
    try:
        moment = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (moment.astimezone(LOCAL) if LOCAL else moment).date().isoformat()


def auto_enroll(db):
    """Adds pipeline contacts to the flows tied to that pipeline, up to each flow's daily
    number. A contact is added to a flow once: one who left it isn't added again."""
    connected = {p["campaign_id"] for p in pipelines(db)}
    flows = [flow_row(r) for r in db.execute("SELECT * FROM flows WHERE auto_daily > 0 AND pipeline <> ''")]
    added = 0
    day = today().isoformat()
    for flow in flows:
        if flow["pipeline"] not in connected or not flow["steps"]:
            continue
        rows = db.execute("SELECT node_id, enrolled_by, enrolled_at FROM flow_enrollments WHERE flow_id = ?",
                          (flow["id"],)).fetchall()
        room = flow["auto_daily"] - sum(1 for r in rows if r["enrolled_by"] == AUTO and local_day(r["enrolled_at"]) == day)
        if room <= 0:
            continue
        ever = {r["node_id"] for r in rows}
        exits = {x.lower() for x in flow["exit_stages"]}
        start = flow["start_stage"].lower()
        people = db.execute("SELECT n.id, n.stage FROM wingmate_members m JOIN nodes n ON n.id = m.node_id "
                            "WHERE m.campaign_id = ? AND n.type = 'person' ORDER BY n.id", (flow["pipeline"],)).fetchall()
        ts = core.now()
        picked = [p for p in people if p["id"] not in ever and (p["stage"] or "").strip().lower() not in exits
                  and (not start or (p["stage"] or "").strip().lower() == start)][:room]
        for p in picked:
            db.insert("flow_enrollments", {"flow_id": flow["id"], "node_id": p["id"], "status": "active", "step_index": 0,
                                           "due_on": due_after(flow["steps"][0]["wait_days"]), "enrolled_at": ts,
                                           "enrolled_by": AUTO, "in_pipeline": 1})
        if picked:
            core.log(db, "flow", f"Added {len(picked)} contact{'s' if len(picked) != 1 else ''} from Wingmate to the flow {flow['name']}")
            added += len(picked)
    if added:
        db.commit()
    return added


def end(db, enrollment_id, status, reason=""):
    db.execute("UPDATE flow_enrollments SET status = ?, ended_at = ?, ended_reason = ?, due_on = '' WHERE id = ?",
               (status, core.now(), reason or ENDINGS[status], enrollment_id))


def apply_exits(db):
    """Ends enrollments whose contact's stage reached one of the flow's exit stages, or who
    were in the flow's pipeline and aren't any more."""
    flows = {r["id"]: r for r in db.execute("SELECT id, exit_stages, pipeline FROM flows")}
    rows = db.execute("SELECT e.id, e.flow_id, e.node_id, e.in_pipeline, n.stage FROM flow_enrollments e "
                      "JOIN nodes n ON n.id = e.node_id WHERE e.status = 'active'").fetchall()
    names = {p["campaign_id"]: p["name"] for p in pipelines(db)}
    inside = {}
    ended = 0
    for r in rows:
        flow = flows.get(r["flow_id"])
        exits = {s.lower() for s in loads(flow["exit_stages"], [])} if flow else set()
        if r["stage"] and r["stage"].strip().lower() in exits:
            end(db, r["id"], "exited", f"Stage reached: {r['stage']}")
            ended += 1
            continue
        cid = flow["pipeline"] if flow else ""
        if r["in_pipeline"] and cid in names:  # only while that pipeline is still connected
            if cid not in inside:
                inside[cid] = members(db, cid)
            if inside[cid] and r["node_id"] not in inside[cid]:
                end(db, r["id"], "exited", f"Left the {names[cid]} pipeline")
                ended += 1
    if ended:
        db.commit()
    return ended


def payload(db):
    apply_exits(db)
    auto_enroll(db)  # also tops up each day's new contacts when nobody synced since midnight
    flows = [flow_row(r) for r in db.execute("SELECT * FROM flows ORDER BY name")]
    enrollments = [dict(r) for r in db.execute("SELECT * FROM flow_enrollments ORDER BY id")]
    return {"flows": flows, "enrollments": enrollments, "today": today().isoformat(),
            "outcomes": list(CALL_OUTCOMES), "pipelines": pipelines(db), "auto": AUTO}


def admin_check():
    return None if core.is_admin() else core.bad("Admin login required", 403)


# ---------- routes ----------

def list_flows():
    return admin_check() or jsonify(payload(core.get_db()))


def create_flow():
    if (err := admin_check()):
        return err
    db = core.get_db()
    values, problem = clean_flow(request.get_json(silent=True) or {})
    if problem:
        return core.bad(problem)
    ts = core.now()
    values.update(created_at=ts, updated_at=ts, updated_by=core.actor())
    flow_id = db.insert("flows", values)
    core.log(db, "flow", f"Created the flow {values['name']}")
    db.commit()
    return jsonify({**payload(db), "id": flow_id}), 201


def update_flow(flow_id):
    if (err := admin_check()):
        return err
    db = core.get_db()
    if not db.execute("SELECT id FROM flows WHERE id = ?", (flow_id,)).fetchone():
        return core.bad("Not found", 404)
    values, problem = clean_flow(request.get_json(silent=True) or {})
    if problem:
        return core.bad(problem)
    values.update(updated_at=core.now(), updated_by=core.actor())
    assignments = ", ".join(f"{col} = ?" for col in values)
    db.execute(f"UPDATE flows SET {assignments} WHERE id = ?", [*values.values(), flow_id])
    # Contacts past the new last step have finished.
    count = len(json.loads(values["steps"]))
    for r in db.execute("SELECT id FROM flow_enrollments WHERE flow_id = ? AND status = 'active' AND step_index >= ?",
                        (flow_id, count)).fetchall():
        end(db, r["id"], "finished")
    core.log(db, "flow", f"Edited the flow {values['name']}")
    db.commit()
    return jsonify(payload(db))


def delete_flow(flow_id):
    if (err := admin_check()):
        return err
    db = core.get_db()
    row = db.execute("SELECT name FROM flows WHERE id = ?", (flow_id,)).fetchone()
    if not row:
        return core.bad("Not found", 404)
    db.execute("DELETE FROM flow_enrollments WHERE flow_id = ?", (flow_id,))
    db.execute("DELETE FROM flows WHERE id = ?", (flow_id,))
    core.log(db, "flow", f"Deleted the flow {row['name']}")
    db.commit()
    return jsonify(payload(db))


def enroll(flow_id):
    if (err := admin_check()):
        return err
    db = core.get_db()
    row = db.execute("SELECT * FROM flows WHERE id = ?", (flow_id,)).fetchone()
    if not row:
        return core.bad("Not found", 404)
    flow = flow_row(row)
    ids = {core.to_int(i) for i in (request.get_json(silent=True) or {}).get("node_ids") or []} - {None}
    if not ids:
        return core.bad("Pick at least one contact")
    marks = ", ".join("?" for _ in ids)
    people = {r["id"]: r for r in db.execute(f"SELECT id, name, type, stage FROM nodes WHERE id IN ({marks})", tuple(ids))}
    active = {r["node_id"] for r in db.execute(
        "SELECT node_id FROM flow_enrollments WHERE flow_id = ? AND status = 'active'", (flow_id,))}
    exits = {s.lower() for s in flow["exit_stages"]}
    inside = members(db, flow["pipeline"]) if flow["pipeline"] else set()
    added, already, at_exit, not_contacts = [], 0, 0, 0
    ts = core.now()
    for node_id in ids:
        person = people.get(node_id)
        if not person or person["type"] != "person":
            not_contacts += 1
        elif node_id in active:
            already += 1
        elif person["stage"].strip().lower() in exits:
            at_exit += 1
        else:
            db.insert("flow_enrollments", {"flow_id": flow_id, "node_id": node_id, "status": "active", "step_index": 0,
                                           "due_on": due_after(flow["steps"][0]["wait_days"]), "enrolled_at": ts,
                                           "enrolled_by": core.actor(), "in_pipeline": int(node_id in inside)})
            added.append(person["name"])
    if added:
        who = added[0] if len(added) == 1 else f"{len(added)} contacts"
        core.log(db, "flow", f"Added {who} to the flow {flow['name']}")
    db.commit()
    return jsonify({**payload(db), "added": len(added), "already": already, "at_exit": at_exit,
                    "not_contacts": not_contacts})


def act(enrollment_id):
    """Moves an enrollment along: done / skip a step, or end it (replied, meeting, stop)."""
    if (err := admin_check()):
        return err
    db = core.get_db()
    e = db.execute("SELECT * FROM flow_enrollments WHERE id = ?", (enrollment_id,)).fetchone()
    if not e:
        return core.bad("Not found", 404)
    flow = flow_row(db.execute("SELECT * FROM flows WHERE id = ?", (e["flow_id"],)).fetchone())
    node = core.node_row(db, e["node_id"])
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    note = str(data.get("note") or "").strip()[:2000]
    steps = flow["steps"]
    if action == "resume":
        if e["status"] == "active":
            return core.bad("Already in the flow")
        index = min(e["step_index"], len(steps) - 1)
        inside = flow["pipeline"] and e["node_id"] in members(db, flow["pipeline"])
        db.execute("UPDATE flow_enrollments SET status = 'active', step_index = ?, due_on = ?, ended_at = '', "
                   "ended_reason = '', in_pipeline = ? WHERE id = ?",
                   (index, today().isoformat(), int(bool(inside)), enrollment_id))
        core.log(db, "flow", f"Put {node['name']} back in the flow {flow['name']}")
        db.commit()
        return jsonify(payload(db))
    if e["status"] != "active":
        return core.bad("That contact isn't in the flow any more")
    step = steps[min(e["step_index"], len(steps) - 1)]
    label = f"{flow['name']} · step {e['step_index'] + 1} ({step['kind']})"
    if action in ("done", "skip"):
        if action == "done":
            outcome = str(data.get("outcome") or "").strip()[:60]
            what = {"email": "Email sent", "call": f"Called: {outcome or 'logged'}", "linkedin": "LinkedIn done",
                    "task": "Done"}[step["kind"]]
            if step["kind"] == "email" and step["subject"]:
                what += f" (“{str(data.get('subject') or step['subject'])[:200]}”)"
            body = f"Flow {label}: {what}." + (f"\n{note}" if note else "")
            db.insert("notes", {"node_id": node["id"], "body": body, "author": core.actor(), "created_at": core.now()})
        nxt = e["step_index"] + 1
        if nxt >= len(steps):
            db.execute("UPDATE flow_enrollments SET step_index = ?, last_done_at = ? WHERE id = ?",
                       (nxt, core.now(), enrollment_id))
            end(db, enrollment_id, "finished")
        else:
            db.execute("UPDATE flow_enrollments SET step_index = ?, due_on = ?, last_done_at = ? WHERE id = ?",
                       (nxt, due_after(steps[nxt]["wait_days"]), core.now(), enrollment_id))
        if action == "done":
            core.bump_version(db)  # the new note
    elif action in ("replied", "meeting", "stop"):
        status = "stopped" if action == "stop" else action
        end(db, enrollment_id, status)
        if action != "stop":
            db.insert("notes", {"node_id": node["id"], "author": core.actor(), "created_at": core.now(),
                                "body": f"Flow {flow['name']}: {ENDINGS[status]}." + (f"\n{note}" if note else "")})
            core.bump_version(db)
        core.log(db, "flow", f"{node['name']}: {ENDINGS[status].lower()} ({flow['name']})")
    else:
        return core.bad("Unknown action")
    db.commit()
    return jsonify(payload(db))


def install(app, module):
    global core
    core = module
    app.add_url_rule("/api/flows", view_func=list_flows, methods=["GET"])
    app.add_url_rule("/api/flows", "flows_create", create_flow, methods=["POST"])
    app.add_url_rule("/api/flows/<int:flow_id>", view_func=update_flow, methods=["PUT"])
    app.add_url_rule("/api/flows/<int:flow_id>", "flows_delete", delete_flow, methods=["DELETE"])
    app.add_url_rule("/api/flows/<int:flow_id>/enroll", view_func=enroll, methods=["POST"])
    app.add_url_rule("/api/flows/enrollments/<int:enrollment_id>", view_func=act, methods=["POST"])
