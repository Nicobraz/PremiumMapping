#!/usr/bin/env python3
"""
PSS Connect web server.
Serves the relationship-map app and a small JSON API backed by Postgres
(when DATABASE_URL is set, e.g. a free Neon database) or a local SQLite file.
There are no logins: anyone with the link can edit, and every change is
recorded in the activity feed. Set EDIT_KEY to require a shared passcode.
"""

import csv
import hashlib
import hmac
import io
import math
import os
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import unquote

from flask import Flask, Response, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data", "pss_connect.db"))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))
EDIT_KEY = os.environ.get("EDIT_KEY", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

NODE_TYPES = ("company", "person")
REL_TYPES = ("knows", "reports_to", "referred", "partner", "vendor", "competitor", "other")
NODE_TEXT_FIELDS = ("name", "title", "email", "phone", "location", "tags", "owner_rep", "notes")
NODE_COLUMNS = ("id", "type", "company_id", "x", "y", "created_at", "updated_at", "updated_by") + NODE_TEXT_FIELDS
EDGE_COLUMNS = ("id", "source_id", "target_id", "rel_type", "strength", "notes",
                "created_at", "updated_at", "updated_by")

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK (type IN ('company', 'person')),
    name        TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    company_id  INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    email       TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    owner_rep   TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    x           REAL,
    y           REAL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    rel_type    TEXT NOT NULL DEFAULT 'knows',
    strength    INTEGER NOT NULL DEFAULT 2,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS activity (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    summary  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    author      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_nodes_company ON nodes(company_id);
CREATE INDEX IF NOT EXISTS idx_notes_node ON notes(node_id);
"""

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),  # Render serves over HTTPS
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


# ---------- database ----------

if USE_POSTGRES:
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    # min_size=0 and max_idle let idle connections close, so a free Neon
    # database can auto-suspend when nobody is using the map. Prepared
    # statements are off so Neon's pooled (PgBouncer) URL works too.
    _pool = ConnectionPool(DATABASE_URL, min_size=0, max_size=4, max_idle=60,
                           kwargs={"row_factory": dict_row, "prepare_threshold": None},
                           check=ConnectionPool.check_connection, open=True)


class Database:
    """Lets the routes write one dialect ('?' placeholders) for SQLite and Postgres."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=()):
        if USE_POSTGRES:
            sql = sql.replace("?", "%s")
        return self.conn.execute(sql, params)

    def executemany(self, sql, rows):
        if USE_POSTGRES:
            with self.conn.cursor() as cur:
                cur.executemany(sql.replace("?", "%s"), rows)
        else:
            self.conn.executemany(sql, rows)

    def insert(self, table, values):
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        sql = f"INSERT INTO {table} ({cols}) VALUES ({marks}) RETURNING id"
        return self.execute(sql, list(values.values())).fetchone()["id"]

    def commit(self):
        self.conn.commit()
        forget_version()


def schema_statements():
    sql = SCHEMA
    if USE_POSTGRES:
        sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        sql = sql.replace(" REAL,", " DOUBLE PRECISION,")
    return [stmt.strip() for stmt in sql.split(";") if stmt.strip()]


def _init_schema(db):
    """Creates tables and returns the session-signing secret (generated once, kept in the DB)."""
    for stmt in schema_statements():
        db.execute(stmt)
    db.execute("INSERT INTO meta (key, value) VALUES ('version', 0) ON CONFLICT (key) DO NOTHING")
    db.execute("INSERT INTO settings (key, value) VALUES ('session_secret', ?) ON CONFLICT (key) DO NOTHING",
               (secrets.token_hex(32),))
    secret = db.execute("SELECT value FROM settings WHERE key = 'session_secret'").fetchone()["value"]
    db.commit()
    return secret


def init_db():
    if USE_POSTGRES:
        with _pool.connection() as conn:
            return _init_schema(Database(conn))
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        return _init_schema(Database(conn))
    finally:
        conn.close()


def get_db():
    if "db" not in g:
        if USE_POSTGRES:
            g.db = Database(_pool.getconn())
        else:
            conn = sqlite3.connect(DB_PATH, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            g.db = Database(conn)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is None:
        return
    if USE_POSTGRES:
        _pool.putconn(db.conn)  # rolls back anything left uncommitted
    else:
        db.conn.close()


# Open tabs poll every few seconds. Remembering the latest version in memory
# answers "nothing changed" without touching the database, which keeps a free
# Postgres asleep. This relies on a single worker process (see render.yaml).
_version_lock = threading.Lock()
_known = {"version": None, "generation": 0}


def known_version():
    with _version_lock:
        return _known["version"], _known["generation"]


def remember_version(version, generation):
    with _version_lock:
        if _known["generation"] == generation:
            _known["version"] = version


def forget_version():
    with _version_lock:
        _known["generation"] += 1
        _known["version"] = None


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def actor():
    name = unquote(request.headers.get("X-Actor", "")).strip()[:60]
    return name or "Someone"


def current_version(db):
    return db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()["value"]


def bump_version(db):
    db.execute("UPDATE meta SET value = value + 1 WHERE key = 'version'")


def log(db, action, summary):
    db.execute("INSERT INTO activity (ts, actor, action, summary) VALUES (?, ?, ?, ?)",
               (now(), actor(), action, summary))


def bad(message, status=400):
    return jsonify({"error": message}), status


def snapshot(db):
    return {
        "nodes": [dict(r) for r in db.execute("SELECT * FROM nodes ORDER BY id")],
        "edges": [dict(r) for r in db.execute("SELECT * FROM edges ORDER BY id")],
        "notes": [dict(r) for r in db.execute("SELECT * FROM notes ORDER BY id")],
        "reps": [dict(r) for r in db.execute("SELECT * FROM reps ORDER BY name")],
    }


def node_row(db, node_id):
    row = db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    return dict(row) if row else None


def edge_row(db, edge_id):
    row = db.execute("SELECT * FROM edges WHERE id = ?", (edge_id,)).fetchone()
    return dict(row) if row else None


def node_name(db, node_id):
    row = db.execute("SELECT name FROM nodes WHERE id = ?", (node_id,)).fetchone()
    return row["name"] if row else "?"


# ---------- validation ----------

def to_float(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def clean_node_fields(db, data, node_type):
    """Whitelists and normalizes node fields. Returns (values, error)."""
    out = {}
    for field in NODE_TEXT_FIELDS:
        if field in data:
            limit = 5000 if field == "notes" else 300
            out[field] = str(data[field] if data[field] is not None else "").strip()[:limit]
    if "name" in out and not out["name"]:
        return None, "Name is required"
    for field in ("x", "y"):
        if field in data:
            out[field] = to_float(data[field])
    if "company_id" in data:
        cid = data["company_id"]
        if node_type != "person" or cid in (None, ""):
            out["company_id"] = None
        else:
            cid = to_int(cid)
            row = db.execute("SELECT type FROM nodes WHERE id = ?", (cid,)).fetchone() if cid else None
            if not row or row["type"] != "company":
                return None, "Company not found"
            out["company_id"] = cid
    return out, None


def clean_edge_fields(data):
    out = {}
    if "rel_type" in data:
        if data["rel_type"] not in REL_TYPES:
            return None, "Unknown relationship type"
        out["rel_type"] = data["rel_type"]
    if "strength" in data:
        strength = to_int(data["strength"])
        if strength is None:
            return None, "Strength must be 1, 2 or 3"
        out["strength"] = min(3, max(1, strength))
    if "notes" in data:
        out["notes"] = str(data["notes"] or "").strip()[:5000]
    return out, None


# ---------- access ----------

# The admin password comes from the ADMIN_PASSWORD env var if set, otherwise
# from a hash stored in the settings table (set from the admin panel or CLI).
def stored_admin_hash(db):
    row = db.execute("SELECT value FROM settings WHERE key = 'admin_password_hash'").fetchone()
    return row["value"] if row else ""


def save_admin_password(db, password):
    db.execute("INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?) "
               "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
               (generate_password_hash(password, method="pbkdf2:sha256"),))
    db.commit()


def admin_fingerprint(db):
    """Changes whenever the password changes, which signs existing admin sessions out."""
    credential = ADMIN_PASSWORD or stored_admin_hash(db)
    return hashlib.sha256(f"admin|{credential}".encode()).hexdigest()[:24] if credential else ""


def check_admin_password(db, password):
    if ADMIN_PASSWORD:
        return hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode())
    stored = stored_admin_hash(db)
    return bool(stored) and check_password_hash(stored, password)


def is_admin():
    token = session.get("admin")
    if not isinstance(token, str):
        return False
    fingerprint = admin_fingerprint(get_db())
    return bool(fingerprint) and hmac.compare_digest(token, fingerprint)


def admin_only(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return bad("Admin login required", 403)
        return view(*args, **kwargs)
    return wrapper


@app.before_request
def require_edit_key():
    if not EDIT_KEY or not request.path.startswith("/api/"):
        return None
    if request.path.startswith("/api/admin/") or is_admin():
        return None
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if not hmac.compare_digest(request.headers.get("X-Edit-Key", ""), EDIT_KEY):
        return bad("Edit key required", 401)
    return None


# ---------- pages ----------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/healthz")
def healthz():
    return "ok"


# ---------- graph ----------

@app.get("/api/graph")
def get_graph():
    since = request.args.get("since", type=int)
    cached, generation = known_version()
    if since is not None and since == cached:
        return jsonify({"version": cached, "unchanged": True})
    db = get_db()
    version = current_version(db)
    remember_version(version, generation)
    if since is not None and since == version:
        return jsonify({"version": version, "unchanged": True})
    return jsonify({"version": version, **snapshot(db)})


# ---------- nodes ----------

@app.post("/api/nodes")
def create_node():
    data = request.get_json(silent=True) or {}
    node_type = data.get("type")
    if node_type not in NODE_TYPES:
        return bad("type must be 'company' or 'person'")
    if not str(data.get("name") or "").strip():
        return bad("Name is required")
    db = get_db()
    values, err = clean_node_fields(db, data, node_type)
    if err:
        return bad(err)
    ts = now()
    values.update(type=node_type, created_at=ts, updated_at=ts, updated_by=actor())
    node_id = db.insert("nodes", values)
    log(db, "add", f"Added {node_type} {values['name']}")
    bump_version(db)
    db.commit()
    return jsonify(node_row(db, node_id)), 201


@app.patch("/api/nodes/<int:node_id>")
def update_node(node_id):
    db = get_db()
    existing = node_row(db, node_id)
    if not existing:
        return bad("Not found", 404)
    data = request.get_json(silent=True) or {}
    data.pop("x", None)
    data.pop("y", None)
    values, err = clean_node_fields(db, data, existing["type"])
    if err:
        return bad(err)
    if values.get("company_id") == node_id:
        return bad("A node can't belong to itself")
    if values:
        values.update(updated_at=now(), updated_by=actor())
        assignments = ", ".join(f"{col} = ?" for col in values)
        db.execute(f"UPDATE nodes SET {assignments} WHERE id = ?", [*values.values(), node_id])
        log(db, "edit", f"Edited {values.get('name', existing['name'])}")
        bump_version(db)
        db.commit()
    return jsonify(node_row(db, node_id))


@app.delete("/api/nodes/<int:node_id>")
def delete_node(node_id):
    db = get_db()
    existing = node_row(db, node_id)
    if not existing:
        return bad("Not found", 404)
    db.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
    log(db, "delete", f"Deleted {existing['type']} {existing['name']}")
    bump_version(db)
    db.commit()
    return jsonify({"ok": True})


@app.patch("/api/nodes/positions")
def save_positions():
    data = request.get_json(silent=True) or {}
    rows = []
    for item in data.get("positions") or []:
        node_id, x, y = to_int(item.get("id")), to_float(item.get("x")), to_float(item.get("y"))
        if node_id is not None and x is not None and y is not None:
            rows.append((x, y, node_id))
    if not rows:
        return jsonify({"updated": 0})
    db = get_db()
    db.executemany("UPDATE nodes SET x = ?, y = ? WHERE id = ?", rows)
    bump_version(db)
    db.commit()
    return jsonify({"updated": len(rows)})


# ---------- edges ----------

@app.post("/api/edges")
def create_edge():
    data = request.get_json(silent=True) or {}
    db = get_db()
    source_id, target_id = to_int(data.get("source_id")), to_int(data.get("target_id"))
    if source_id is None or target_id is None or source_id == target_id:
        return bad("Pick two different people or companies")
    if not node_row(db, source_id) or not node_row(db, target_id):
        return bad("One of those no longer exists", 404)
    values, err = clean_edge_fields({"rel_type": "knows", "strength": 2, **data})
    if err:
        return bad(err)
    ts = now()
    values.update(source_id=source_id, target_id=target_id,
                  created_at=ts, updated_at=ts, updated_by=actor())
    edge_id = db.insert("edges", values)
    log(db, "connect", f"Connected {node_name(db, source_id)} → {node_name(db, target_id)} "
                       f"({values['rel_type'].replace('_', ' ')})")
    bump_version(db)
    db.commit()
    return jsonify(edge_row(db, edge_id)), 201


@app.patch("/api/edges/<int:edge_id>")
def update_edge(edge_id):
    db = get_db()
    existing = edge_row(db, edge_id)
    if not existing:
        return bad("Not found", 404)
    data = request.get_json(silent=True) or {}
    values, err = clean_edge_fields(data)
    if err:
        return bad(err)
    if data.get("swap"):
        values.update(source_id=existing["target_id"], target_id=existing["source_id"])
    if values:
        values.update(updated_at=now(), updated_by=actor())
        assignments = ", ".join(f"{col} = ?" for col in values)
        db.execute(f"UPDATE edges SET {assignments} WHERE id = ?", [*values.values(), edge_id])
        log(db, "edit", f"Edited connection {node_name(db, existing['source_id'])} – "
                        f"{node_name(db, existing['target_id'])}")
        bump_version(db)
        db.commit()
    return jsonify(edge_row(db, edge_id))


@app.delete("/api/edges/<int:edge_id>")
def delete_edge(edge_id):
    db = get_db()
    existing = edge_row(db, edge_id)
    if not existing:
        return bad("Not found", 404)
    db.execute("DELETE FROM edges WHERE id = ?", (edge_id,))
    log(db, "disconnect", f"Removed connection {node_name(db, existing['source_id'])} – "
                          f"{node_name(db, existing['target_id'])}")
    bump_version(db)
    db.commit()
    return jsonify({"ok": True})


# ---------- notes ----------

@app.post("/api/nodes/<int:node_id>/notes")
def add_note(node_id):
    db = get_db()
    node = node_row(db, node_id)
    if not node:
        return bad("Not found", 404)
    data = request.get_json(silent=True) or {}
    body = str(data.get("body") or "").strip()[:5000]
    if not body:
        return bad("Write something first")
    note_id = db.insert("notes", {"node_id": node_id, "body": body, "author": actor(), "created_at": now()})
    log(db, "note", f"Added a note to {node['name']}")
    bump_version(db)
    db.commit()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return jsonify(dict(row)), 201


@app.delete("/api/notes/<int:note_id>")
def delete_note(note_id):
    db = get_db()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if not row:
        return bad("Not found", 404)
    db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    log(db, "note", f"Deleted a note on {node_name(db, row['node_id'])}")
    bump_version(db)
    db.commit()
    return jsonify({"ok": True})


# ---------- admin ----------

_failed_logins = {}  # ip -> (failures, first failure time)
_failed_lock = threading.Lock()
MAX_FAILURES, LOCKOUT_SECS = 8, 600


def client_ip():
    return (request.access_route or [request.remote_addr or "?"])[0]


@app.get("/api/admin/me")
def admin_me():
    return jsonify({"configured": bool(admin_fingerprint(get_db())), "admin": is_admin(),
                    "env_managed": bool(ADMIN_PASSWORD)})


@app.post("/api/admin/login")
def admin_login():
    db = get_db()
    if not admin_fingerprint(db):
        return bad("No admin password is set yet.", 503)
    ip = client_ip()
    with _failed_lock:
        failures, since = _failed_logins.get(ip, (0, 0.0))
        if time.time() - since > LOCKOUT_SECS:
            failures, since = 0, 0.0
        if failures >= MAX_FAILURES:
            return bad("Too many wrong attempts. Try again in 10 minutes.", 429)
    password = str((request.get_json(silent=True) or {}).get("password") or "")
    if not check_admin_password(db, password):
        time.sleep(0.5)
        with _failed_lock:
            _failed_logins[ip] = (failures + 1, since or time.time())
        return bad("Wrong password", 400)
    with _failed_lock:
        _failed_logins.pop(ip, None)
    session.permanent = True
    session["admin"] = admin_fingerprint(db)
    return jsonify({"admin": True})


@app.post("/api/admin/password")
@admin_only
def change_admin_password():
    if ADMIN_PASSWORD:
        return bad("This password is set in Render (ADMIN_PASSWORD). Change it there.", 409)
    new_password = str((request.get_json(silent=True) or {}).get("new_password") or "")
    if len(new_password) < 8:
        return bad("Use at least 8 characters")
    db = get_db()
    save_admin_password(db, new_password)
    session["admin"] = admin_fingerprint(db)  # keep this browser signed in
    return jsonify({"ok": True})


@app.post("/api/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return jsonify({"admin": False})


def clean_rep_fields(db, data, rep_id=None):
    out = {}
    if "name" in data:
        name = str(data["name"] or "").strip()[:100]
        if not name:
            return None, "Name is required"
        clash = db.execute("SELECT id FROM reps WHERE LOWER(name) = LOWER(?) AND id != ?",
                           (name, rep_id or 0)).fetchone()
        if clash:
            return None, f"There's already a rep named {name}"
        out["name"] = name
    for field in ("email", "phone"):
        if field in data:
            out[field] = str(data[field] or "").strip()[:300]
    if "active" in data:
        out["active"] = 1 if data["active"] else 0
    return out, None


@app.post("/api/reps")
@admin_only
def create_rep():
    data = request.get_json(silent=True) or {}
    if not str(data.get("name") or "").strip():
        return bad("Name is required")
    db = get_db()
    values, err = clean_rep_fields(db, {"active": 1, **data})
    if err:
        return bad(err)
    values["created_at"] = now()
    rep_id = db.insert("reps", values)
    log(db, "rep", f"Added rep {values['name']}")
    bump_version(db)
    db.commit()
    return jsonify(dict(db.execute("SELECT * FROM reps WHERE id = ?", (rep_id,)).fetchone())), 201


@app.patch("/api/reps/<int:rep_id>")
@admin_only
def update_rep(rep_id):
    db = get_db()
    existing = db.execute("SELECT * FROM reps WHERE id = ?", (rep_id,)).fetchone()
    if not existing:
        return bad("Not found", 404)
    values, err = clean_rep_fields(db, request.get_json(silent=True) or {}, rep_id)
    if err:
        return bad(err)
    if values:
        assignments = ", ".join(f"{col} = ?" for col in values)
        db.execute(f"UPDATE reps SET {assignments} WHERE id = ?", [*values.values(), rep_id])
        if values.get("name", existing["name"]) != existing["name"]:
            # Keep ownership pointing at the renamed rep.
            db.execute("UPDATE nodes SET owner_rep = ? WHERE owner_rep = ?", (values["name"], existing["name"]))
        log(db, "rep", f"Updated rep {values.get('name', existing['name'])}")
        bump_version(db)
        db.commit()
    return jsonify(dict(db.execute("SELECT * FROM reps WHERE id = ?", (rep_id,)).fetchone()))


@app.delete("/api/reps/<int:rep_id>")
@admin_only
def delete_rep(rep_id):
    db = get_db()
    existing = db.execute("SELECT * FROM reps WHERE id = ?", (rep_id,)).fetchone()
    if not existing:
        return bad("Not found", 404)
    db.execute("DELETE FROM reps WHERE id = ?", (rep_id,))
    log(db, "rep", f"Removed rep {existing['name']}")
    bump_version(db)
    db.commit()
    return jsonify({"ok": True})


# ---------- activity ----------

@app.get("/api/activity")
def get_activity():
    limit = min(200, max(1, request.args.get("limit", 50, type=int)))
    rows = get_db().execute("SELECT * FROM activity ORDER BY id DESC LIMIT ?", (limit,))
    return jsonify([dict(r) for r in rows])


# ---------- import / export ----------

@app.get("/api/export.json")
def export_json():
    db = get_db()
    payload = {"app": "pss-connect", "exported_at": now(), "version": current_version(db), **snapshot(db)}
    stamp = datetime.now().strftime("%Y-%m-%d")
    return Response(
        jsonify(payload).get_data(),
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="pss-connect-backup-{stamp}.json"'},
    )


@app.post("/api/import.json")
def import_json():
    """Restores a backup, replacing the whole map."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list) \
            or not isinstance(data.get("edges"), list):
        return bad("That file doesn't look like a PSS Connect backup")
    nodes = [n for n in data["nodes"] if isinstance(n, dict)]
    edges = [e for e in data["edges"] if isinstance(e, dict)]
    node_types = {to_int(n.get("id")): n.get("type") for n in nodes}
    if None in node_types or any(t not in NODE_TYPES for t in node_types.values()):
        return bad("Backup has invalid nodes")

    db = get_db()
    ts = now()
    db.execute("DELETE FROM notes")
    if isinstance(data.get("reps"), list):
        db.execute("DELETE FROM reps")
        for rep in data["reps"]:
            name = str(rep.get("name") or "").strip()[:100] if isinstance(rep, dict) else ""
            if name:
                db.insert("reps", {"name": name, "email": str(rep.get("email") or "")[:300],
                                   "phone": str(rep.get("phone") or "")[:300],
                                   "active": 1 if rep.get("active", 1) else 0,
                                   "created_at": str(rep.get("created_at") or ts)})
    db.execute("DELETE FROM edges")
    db.execute("DELETE FROM nodes")
    # Companies first so people's company_id references already exist.
    for n in sorted(nodes, key=lambda n: 0 if n.get("type") == "company" else 1):
        row = {col: n.get(col) for col in NODE_COLUMNS}
        row["id"] = to_int(row["id"])
        row["name"] = str(row["name"] or "").strip() or "Unnamed"
        for field in NODE_TEXT_FIELDS:
            row[field] = str(row[field] if row[field] is not None else "")
        row["x"], row["y"] = to_float(row["x"]), to_float(row["y"])
        cid = to_int(row["company_id"])
        row["company_id"] = cid if row["type"] == "person" and node_types.get(cid) == "company" else None
        row["created_at"] = str(row["created_at"] or ts)
        row["updated_at"] = str(row["updated_at"] or ts)
        row["updated_by"] = str(row["updated_by"] or "")
        db.insert("nodes", row)
    restored_edges = 0
    for e in edges:
        source_id, target_id = to_int(e.get("source_id")), to_int(e.get("target_id"))
        if source_id not in node_types or target_id not in node_types or source_id == target_id:
            continue
        values, err = clean_edge_fields({"rel_type": "knows", "strength": 2, **e})
        if err:
            continue
        values.update(source_id=source_id, target_id=target_id,
                      created_at=str(e.get("created_at") or ts), updated_at=str(e.get("updated_at") or ts),
                      updated_by=str(e.get("updated_by") or ""))
        db.insert("edges", values)
        restored_edges += 1
    for note in data.get("notes") or []:
        node_id = to_int(note.get("node_id")) if isinstance(note, dict) else None
        body = str(note.get("body") or "").strip()[:5000] if node_id in node_types else ""
        if body:
            db.insert("notes", {"node_id": node_id, "body": body, "author": str(note.get("author") or ""),
                                "created_at": str(note.get("created_at") or ts)})
    if USE_POSTGRES:
        # Rows were inserted with explicit ids, so move the id sequences past them.
        for table in ("nodes", "edges"):
            db.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                       f"COALESCE(MAX(id), 0) + 1, false) FROM {table}")
    log(db, "restore", f"Restored backup ({len(nodes)} nodes, {restored_edges} connections)")
    bump_version(db)
    db.commit()
    return jsonify({"nodes": len(nodes), "edges": restored_edges})


@app.post("/api/import.csv")
def import_csv():
    """Adds people (and their companies) from a CSV. Existing records are left alone."""
    upload = request.files.get("file")
    raw = upload.read() if upload else request.get_data()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return bad("The CSV is empty")

    db = get_db()
    ts, who = now(), actor()
    companies = {r["name"].strip().lower(): r["id"]
                 for r in db.execute("SELECT id, name FROM nodes WHERE type = 'company'")}
    people = {(r["name"].strip().lower(), r["company_id"])
              for r in db.execute("SELECT name, company_id FROM nodes WHERE type = 'person'")}
    added_companies = added_people = skipped = 0

    for raw_row in reader:
        row = {(k or "").strip().lower().replace(" ", "_"): (v or "").strip() for k, v in raw_row.items()}
        name, company = row.get("name", ""), row.get("company", "")
        company_id = None
        if company:
            company_id = companies.get(company.lower())
            if company_id is None:
                company_id = companies[company.lower()] = db.insert("nodes", {
                    "type": "company", "name": company[:300],
                    "created_at": ts, "updated_at": ts, "updated_by": who})
                added_companies += 1
        if not name:
            if not company:
                skipped += 1
            continue
        key = (name.lower(), company_id)
        if key in people:
            skipped += 1
            continue
        values = {f: row.get(f, "")[:5000 if f == "notes" else 300] for f in NODE_TEXT_FIELDS}
        values.update(type="person", company_id=company_id, created_at=ts, updated_at=ts, updated_by=who)
        db.insert("nodes", values)
        people.add(key)
        added_people += 1

    if added_companies or added_people:
        people_word = "person" if added_people == 1 else "people"
        company_word = "company" if added_companies == 1 else "companies"
        log(db, "import", f"Imported {added_people} {people_word} and {added_companies} {company_word} from CSV")
        bump_version(db)
    db.commit()
    return jsonify({"people": added_people, "companies": added_companies, "skipped": skipped})


app.secret_key = os.environ.get("SECRET_KEY") or init_db()

if __name__ == "__main__":
    if sys.argv[1:2] == ["set-admin-password"]:
        # Usage: DATABASE_URL=... python app.py set-admin-password 'new password'
        if len(sys.argv) != 3 or len(sys.argv[2]) < 8:
            sys.exit("Usage: python app.py set-admin-password '<at least 8 characters>'")
        with app.app_context():
            save_admin_password(get_db(), sys.argv[2])
        print("Admin password saved.")
    else:
        port = int(os.environ.get("PORT", 8000))
        app.run(host="0.0.0.0", port=port)
