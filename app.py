#!/usr/bin/env python3
"""
PSS Connect web server.
Serves the relationship-map app and a small JSON API backed by Postgres
(when DATABASE_URL is set, e.g. a free Neon database) or a local SQLite file.
Reps sign in with their email (as listed by the admin); the admin signs in
with a password. Every change is recorded in the activity feed.
"""

import contextvars
import csv
import hashlib
import hmac
import io
import json
import math
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, Response, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix

import assistant
import connector
import wingmate

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data", "pss_connect.db"))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))
# On Render the local disk is wiped on every restart, so SQLite there means data loss.
TEMPORARY_STORAGE = bool(os.environ.get("RENDER")) and not USE_POSTGRES
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

NODE_TYPES = ("company", "person")
REL_TYPES = ("knows", "reports_to", "referred", "partner", "vendor", "competitor", "other")
NODE_TEXT_FIELDS = ("name", "title", "email", "phone", "location", "tags", "owner_rep", "notes", "stage")
NODE_COLUMNS = ("id", "type", "company_id", "x", "y", "created_at", "updated_at", "updated_by",
                "wingmate_id", "wingmate_seen", "wingmate_sync", "color", "priority") + NODE_TEXT_FIELDS
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
    updated_by  TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT ''
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
    created_at  TEXT NOT NULL,
    is_admin       INTEGER NOT NULL DEFAULT 0,
    password_hash  TEXT NOT NULL DEFAULT ''
);
-- Wingmate records someone deliberately deleted here, so the sync doesn't bring them back.
CREATE TABLE IF NOT EXISTS wingmate_dismissed (
    ref  TEXT PRIMARY KEY,
    ts   TEXT NOT NULL
);
-- Extra Wingmate leads for a company that's already here (e.g. two reps' leads for one company).
CREATE TABLE IF NOT EXISTS wingmate_aliases (
    ref      TEXT PRIMARY KEY,
    node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    seen     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS transfer_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    from_rep    TEXT NOT NULL DEFAULT '',
    to_rep      TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL,
    decided_at  TEXT NOT NULL DEFAULT '',
    decided_by  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
-- Claude / ChatGPT connector sign-ins (OAuth). Only hashes of codes and tokens are stored.
CREATE TABLE IF NOT EXISTS oauth_clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT NOT NULL UNIQUE,
    client_name   TEXT NOT NULL DEFAULT '',
    redirect_uris TEXT NOT NULL DEFAULT '[]',
    auth_method   TEXT NOT NULL DEFAULT 'none',
    secret_hash   TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash       TEXT NOT NULL UNIQUE,
    client_id       TEXT NOT NULL,
    rep_id          INTEGER NOT NULL,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    resource        TEXT NOT NULL DEFAULT '',
    expires_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    client_name  TEXT NOT NULL DEFAULT '',
    rep_id       INTEGER NOT NULL,
    pw_fp        TEXT NOT NULL DEFAULT '',
    resource     TEXT NOT NULL DEFAULT '',
    family       TEXT NOT NULL,
    granted_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
);
-- The in-app AI assistant: each rep's conversations, and token use for the cost estimate.
CREATE TABLE IF NOT EXISTS assistant_chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rep_id      INTEGER NOT NULL,
    version     TEXT NOT NULL DEFAULT '',
    messages    TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_usage (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             TEXT NOT NULL,
    rep_id         INTEGER NOT NULL,
    rep_name       TEXT NOT NULL DEFAULT '',
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_read     INTEGER NOT NULL DEFAULT 0,
    cache_write    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_nodes_company ON nodes(company_id);
CREATE INDEX IF NOT EXISTS idx_notes_node ON notes(node_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_rep ON oauth_tokens(rep_id);
CREATE INDEX IF NOT EXISTS idx_assistant_chats_rep ON assistant_chats(rep_id);
CREATE INDEX IF NOT EXISTS idx_assistant_usage_rep ON assistant_usage(rep_id, ts);
"""

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
# Render terminates HTTPS in front of the app; trust its forwarded scheme and host.
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),  # Render serves over HTTPS
)

# Sign-ins last for the browser session: closing the browser (or clearing
# cookies) means signing in again. Bumping the version signs everyone out.
SESSION_VERSION = 3  # 3: every rep now signs in with a password


def start_session():
    session.permanent = False
    session["sv"] = SESSION_VERSION


def session_valid():
    return session.get("sv") == SESSION_VERSION


# ---------- database ----------

if USE_POSTGRES:
    import psycopg
    from psycopg.rows import dict_row


def pg_connect():
    """One short-lived connection per request. Neon's pooler URL does the pooling,
    so nothing is held open and a free database can sleep when idle. Prepared
    statements are off because that pooler (PgBouncer) doesn't keep them."""
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, prepare_threshold=None, connect_timeout=10)


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


# Columns added after the first release; existing databases get them on startup.
MIGRATIONS = [  # (table, column, definition, backfill SQL run once when the column is added)
    ("reps", "is_admin", "INTEGER NOT NULL DEFAULT 0", None),
    ("reps", "password_hash", "TEXT NOT NULL DEFAULT ''", None),
    ("edges", "created_by", "TEXT NOT NULL DEFAULT ''", "UPDATE edges SET created_by = updated_by"),
    # Links to Wingmate records ("lead:123" / "contact:456") and the last lead activity seen.
    ("nodes", "wingmate_id", "TEXT NOT NULL DEFAULT ''", None),
    ("nodes", "wingmate_seen", "TEXT NOT NULL DEFAULT ''", None),
    ("notes", "external_id", "TEXT NOT NULL DEFAULT ''", None),
    # The Wingmate values last synced, so PSS edits stick until Wingmate changes that field.
    ("nodes", "wingmate_sync", "TEXT NOT NULL DEFAULT ''", None),
    # Where a contact is in the sales pipeline (from Wingmate's lead status, or set here).
    ("nodes", "stage", "TEXT NOT NULL DEFAULT ''", None),
    # Shared card color (blank = automatic) and the high-priority flag (contacts).
    ("nodes", "color", "TEXT NOT NULL DEFAULT ''", None),
    ("nodes", "priority", "INTEGER NOT NULL DEFAULT 0", None),
]


def table_columns(db, table):
    if USE_POSTGRES:
        rows = db.execute("SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?", (table,))
    else:
        rows = db.execute(f"PRAGMA table_info({table})")
    return {r["name"] for r in rows}


def _init_schema(db):
    """Creates tables and returns the session-signing secret (generated once, kept in the DB)."""
    for stmt in schema_statements():
        db.execute(stmt)
    for table, column, definition, backfill in MIGRATIONS:
        if column not in table_columns(db, table):
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            if backfill:
                db.execute(backfill)
    db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_wingmate ON nodes(wingmate_id)")
    db.execute("INSERT INTO meta (key, value) VALUES ('version', 0) ON CONFLICT (key) DO NOTHING")
    for rep in db.execute("SELECT id, name FROM reps WHERE password_hash = ''").fetchall():
        db.execute("UPDATE reps SET password_hash = ? WHERE id = ?",
                   (hash_password(default_password(rep["name"])), rep["id"]))
    db.execute("INSERT INTO settings (key, value) VALUES ('session_secret', ?) ON CONFLICT (key) DO NOTHING",
               (secrets.token_hex(32),))
    db.execute("INSERT INTO settings (key, value) VALUES ('backup_key', ?) ON CONFLICT (key) DO NOTHING",
               (secrets.token_urlsafe(24),))
    secret = db.execute("SELECT value FROM settings WHERE key = 'session_secret'").fetchone()["value"]
    db.commit()
    return secret


def init_db():
    if USE_POSTGRES:
        with pg_connect() as conn:
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
            g.db = Database(pg_connect())
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
    db.conn.close()  # anything left uncommitted is rolled back


# Open tabs poll every few seconds. Remembering the latest version in memory
# answers "nothing changed" without touching the database, which keeps a free
# Postgres asleep. This relies on a single worker process (see render.yaml).
_version_lock = threading.Lock()
_known = {"version": None, "generation": 0, "at": 0.0}
CACHE_SECS = 30  # also pick up changes made outside the app (e.g. the CLI)


def known_version():
    with _version_lock:
        fresh = time.time() - _known["at"] < CACHE_SECS
        return (_known["version"] if fresh else None), _known["generation"]


def remember_version(version, generation):
    with _version_lock:
        if _known["generation"] == generation:
            _known["version"] = version
            _known["at"] = time.time()


def forget_version():
    with _version_lock:
        _known["generation"] += 1
        _known["version"] = None
        _auth_cache.clear()


# Sign-in is checked on every request, including the 5-second polls, so the rep
# list and admin credential are cached in memory until the next write.
_auth_cache = {}


def auth_info():
    with _version_lock:
        cached, generation = _auth_cache.get("info"), _known["generation"]
    if cached and time.time() - cached["at"] < CACHE_SECS:
        return cached
    db = get_db()
    info = {
        "reps": {r["id"]: {**dict(r), "password_hash": "", "pw_fp": password_fingerprint(r["password_hash"])}
                 for r in db.execute("SELECT id, name, email, active, is_admin, password_hash FROM reps")},
        "admin_fp": admin_fingerprint(db),
        "at": time.time(),
    }
    with _version_lock:
        if _known["generation"] == generation:
            _auth_cache["info"] = info
    return info


def password_fingerprint(password_hash):
    """Changes when the password changes, which signs that person's sessions out."""
    return hashlib.sha256(f"rep|{password_hash}".encode()).hexdigest()[:24] if password_hash else ""


# Set while Claude or ChatGPT is calling in for a rep (see connector.py):
# {"rep_id", "pw_fp", "via"}. The assistant then acts as that rep.
ai_caller = contextvars.ContextVar("ai_caller", default=None)


def current_rep():
    caller = ai_caller.get()
    if caller:
        rep = auth_info()["reps"].get(caller["rep_id"])
        if not rep or not rep["active"] or not hmac.compare_digest(rep["pw_fp"], caller["pw_fp"]):
            return None
        return rep
    rep_id = session.get("rep_id")
    if not isinstance(rep_id, int) or not session_valid():
        return None
    rep = auth_info()["reps"].get(rep_id)
    if not rep or not rep["active"]:
        return None  # deactivated reps are signed out
    # Everyone signs in with a password; a session ends if that password changes.
    token = session.get("rep_pw")
    if not isinstance(token, str) or not rep["pw_fp"] or not hmac.compare_digest(token, rep["pw_fp"]):
        return None
    return rep


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def actor():
    rep = current_rep()
    if rep:
        return rep["name"]
    return "Admin" if is_admin() else "Someone"


def own_name():
    """Owner for leads a rep adds themselves: the signed-in rep."""
    rep = current_rep()
    return rep["name"] if rep else ""


def current_version(db):
    return db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()["value"]


def bump_version(db):
    db.execute("UPDATE meta SET value = value + 1 WHERE key = 'version'")


def log(db, action, summary):
    caller = ai_caller.get()
    if caller:
        summary = f"{summary} (via {caller['via']})"
    db.execute("INSERT INTO activity (ts, actor, action, summary) VALUES (?, ?, ?, ?)",
               (now(), actor(), action, summary))


def bad(message, status=400):
    return jsonify({"error": message}), status


REP_PUBLIC_COLUMNS = "id, name, email, phone, active, is_admin, created_at"


def rep_public(db, rep_id):
    return dict(db.execute(f"SELECT {REP_PUBLIC_COLUMNS} FROM reps WHERE id = ?", (rep_id,)).fetchone())


def snapshot(db):
    return {
        "nodes": [dict(r) for r in db.execute("SELECT * FROM nodes ORDER BY id")],
        "edges": [dict(r) for r in db.execute("SELECT * FROM edges ORDER BY id")],
        "notes": [dict(r) for r in db.execute("SELECT * FROM notes ORDER BY id")],
        "reps": [dict(r) for r in db.execute(f"SELECT {REP_PUBLIC_COLUMNS} FROM reps ORDER BY name")],
        "transfers": [dict(r) for r in db.execute("SELECT * FROM transfer_requests ORDER BY id")],
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


# ---------- duplicate detection ----------

COMPANY_SUFFIXES = {"inc", "llc", "co", "corp", "corporation", "company", "ltd", "limited",
                    "lp", "llp", "pllc", "pc", "the"}


def norm_name(name, is_company=False):
    """'Gold's Gym, LLC' and 'golds gym' compare equal; so do 'Acme Corp' and 'Acme Corporation, Inc.'"""
    text = re.sub(r"['\u2019]", "", str(name or "").lower()).replace("&", " and ")
    words = re.sub(r"[^a-z0-9]+", " ", text).split()
    if is_company:
        trimmed = [w for w in words if w not in COMPANY_SUFFIXES]
        words = trimmed or words
    return " ".join(words)


def find_duplicates(db, node_type, name, company_id=None, email="", exclude_id=None):
    """Companies match on name; people on name within the same company, or on email."""
    target = norm_name(name, node_type == "company")
    email = str(email or "").strip().lower()
    found = []
    for r in db.execute("SELECT id, name, location, company_id, email FROM nodes WHERE type = ?", (node_type,)):
        if r["id"] == exclude_id:
            continue
        same_name = norm_name(r["name"], node_type == "company") == target
        if node_type == "company":
            hit = same_name
        else:
            hit = (same_name and r["company_id"] == company_id) or (email and r["email"].strip().lower() == email)
        if hit:
            found.append({"id": r["id"], "name": r["name"], "location": r["location"],
                          "company": node_name(db, r["company_id"]) if r["company_id"] else ""})
    return found


def duplicate_response(duplicates, node_type):
    what = "company" if node_type == "company" else "person"
    return jsonify({"error": f"This {what} may already be on the map.", "duplicates": duplicates}), 409


# ---------- company tags ----------

def clean_tag(tag):
    return re.sub(r"\s+", " ", str(tag or "").replace(",", " ")).strip()[:40]


def known_tags(db):
    """Every tag in use, keyed by lowercase, keeping the first spelling seen."""
    tags = {}
    for r in db.execute("SELECT tags FROM nodes WHERE type = 'company' AND tags <> '' ORDER BY id"):
        for t in r["tags"].split(","):
            t = t.strip()
            if t:
                tags.setdefault(t.lower(), t)
    return tags


def join_tags(db, raw_tags, existing=None):
    """De-duplicates tags and reuses the spelling already in use ('GYM' -> 'gym')."""
    known = known_tags(db) if existing is None else existing
    out, seen = [], set()
    for raw in raw_tags:
        tag = clean_tag(raw)
        if tag and tag.lower() not in seen:
            seen.add(tag.lower())
            out.append(known.get(tag.lower(), tag))
    return ", ".join(out)


def clean_node_fields(db, data, node_type):
    """Whitelists and normalizes node fields. Returns (values, error)."""
    out = {}
    for field in NODE_TEXT_FIELDS:
        if field in data:
            limit = 5000 if field == "notes" else 300
            out[field] = str(data[field] if data[field] is not None else "").strip()[:limit]
    if "stage" in out and node_type != "person":
        out["stage"] = ""  # stage belongs to contacts
    if "tags" in out:
        # Tags belong to companies only; for companies keep a tidy, de-duplicated list.
        out["tags"] = join_tags(db, out["tags"].split(",")) if node_type == "company" else ""
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
    rep = current_rep()
    if rep and rep["is_admin"]:
        return True
    token = session.get("admin")  # the backup shared admin password
    if not isinstance(token, str) or not session_valid():
        return False
    fingerprint = auth_info()["admin_fp"]
    return bool(fingerprint) and hmac.compare_digest(token, fingerprint)


def dismiss_wingmate(db, ref):
    if ref:
        db.execute("INSERT INTO wingmate_dismissed (ref, ts) VALUES (?, ?) ON CONFLICT (ref) DO NOTHING", (ref, now()))


# Reps may change only their own input: leads assigned to them, connections
# they added and notes they wrote. Admins may change anything.
def can_edit_node(node):
    return is_admin() or bool(own_name()) and node["owner_rep"] == own_name()


def can_edit_edge(edge):
    return is_admin() or bool(own_name()) and edge["created_by"] == own_name()


def not_yours(what):
    return bad(f"You can only change {what}. Ask an admin for anything else.", 403)


def admin_only(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return bad("Admin login required", 403)
        return view(*args, **kwargs)
    return wrapper


OPEN_API = {"/api/me", "/api/login", "/api/logout", "/api/admin/me", "/api/admin/login", "/api/admin/logout",
            "/api/wingmate/cron", "/api/backup/nightly.json"}  # these links check their own keys


@app.before_request
def require_sign_in():
    if not request.path.startswith("/api/") or request.path in OPEN_API:
        return None
    if current_rep() or is_admin():
        return None
    return jsonify({"error": "Please sign in", "signed_out": True}), 401


# ---------- pages ----------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/manifest.webmanifest")
def manifest():
    """Lets phones "Add to Home Screen" and open PSS Connect like an app."""
    return send_from_directory(STATIC_DIR, "manifest.webmanifest", mimetype="application/manifest+json")


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
    return jsonify({"version": version, "temporary_storage": TEMPORARY_STORAGE, **snapshot(db)})


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
    if not data.get("allow_duplicate"):
        duplicates = find_duplicates(db, node_type, values["name"], values.get("company_id"), values.get("email", ""))
        if duplicates:
            return duplicate_response(duplicates, node_type)
    if not is_admin():
        values["owner_rep"] = own_name()  # reps can only assign new leads to themselves
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
    if not can_edit_node(existing):
        return not_yours("leads assigned to you")
    data = request.get_json(silent=True) or {}
    data.pop("x", None)
    data.pop("y", None)
    values, err = clean_node_fields(db, data, existing["type"])
    if err:
        return bad(err)
    if values.get("company_id") == node_id:
        return bad("A node can't belong to itself")
    if "owner_rep" in values and not is_admin():
        if values["owner_rep"] != existing["owner_rep"]:
            return bad("Only an admin can change who a lead is assigned to.", 403)
        del values["owner_rep"]
    identity = ("name", "company_id", "email")
    if not data.get("allow_duplicate") and any(k in values and values[k] != existing[k] for k in identity):
        merged = {**existing, **values}
        duplicates = find_duplicates(db, existing["type"], merged["name"], merged["company_id"],
                                     merged["email"], exclude_id=node_id)
        if duplicates:
            return duplicate_response(duplicates, existing["type"])
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
    if not can_edit_node(existing):
        return not_yours("leads assigned to you")
    dismiss_wingmate(db, existing["wingmate_id"])
    for alias in db.execute("SELECT ref FROM wingmate_aliases WHERE node_id = ?", (node_id,)).fetchall():
        dismiss_wingmate(db, alias["ref"])
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
                  created_at=ts, updated_at=ts, updated_by=actor(), created_by=actor())
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
    if not can_edit_edge(existing):
        return not_yours("connections you added")
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
    if not can_edit_edge(existing):
        return not_yours("connections you added")
    db.execute("DELETE FROM edges WHERE id = ?", (edge_id,))
    log(db, "disconnect", f"Removed connection {node_name(db, existing['source_id'])} – "
                          f"{node_name(db, existing['target_id'])}")
    bump_version(db)
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/nodes/<int:node_id>/tags")
def change_tags(node_id):
    """Anyone signed in can add or remove a company's tags, whoever the lead belongs to."""
    db = get_db()
    node = node_row(db, node_id)
    if not node:
        return bad("Not found", 404)
    if node["type"] != "company":
        return bad("Tags are for companies")
    data = request.get_json(silent=True) or {}
    add, remove = clean_tag(data.get("add")), clean_tag(data.get("remove"))
    current = [t.strip() for t in node["tags"].split(",") if t.strip()]
    if add:
        tags = join_tags(db, current + [add])
        summary = f"Tagged {node['name']} \u201c{known_tags(db).get(add.lower(), add)}\u201d"
    elif remove:
        removed = next((t for t in current if t.lower() == remove.lower()), remove)
        tags = ", ".join(t for t in current if t.lower() != remove.lower())
        summary = f"Removed tag \u201c{removed}\u201d from {node['name']}"
    else:
        return bad("Type a tag")
    if tags != node["tags"]:
        db.execute("UPDATE nodes SET tags = ?, updated_at = ?, updated_by = ? WHERE id = ?",
                   (tags, now(), actor(), node_id))
        log(db, "tag", summary)
        bump_version(db)
        db.commit()
    return jsonify(node_row(db, node_id))


# ---------- lead transfer requests ----------
# A rep can ask for a lead that belongs to someone else. The current owner (or an
# admin; only an admin for unassigned leads) approves or declines. Approving moves
# the lead, and for a company also the previous owner's contacts there.

def transfer_row(db, transfer_id):
    row = db.execute("SELECT * FROM transfer_requests WHERE id = ?", (transfer_id,)).fetchone()
    return dict(row) if row else None


def can_decide(transfer):
    me = own_name()
    return is_admin() or bool(me and transfer["from_rep"] and transfer["from_rep"] == me)


@app.post("/api/nodes/<int:node_id>/transfer-request")
def request_transfer(node_id):
    db = get_db()
    node = node_row(db, node_id)
    if not node:
        return bad("Not found", 404)
    me = own_name()
    if not me:
        return bad("Sign in as a rep to request a lead", 403)
    if node["owner_rep"] == me:
        return bad("This lead is already yours")
    pending = db.execute("SELECT id FROM transfer_requests WHERE node_id = ? AND to_rep = ? AND status = 'pending'",
                         (node_id, me)).fetchone()
    if pending:
        return bad("You've already asked for this lead")
    reason = str((request.get_json(silent=True) or {}).get("reason") or "").strip()[:1000]
    transfer_id = db.insert("transfer_requests", {"node_id": node_id, "from_rep": node["owner_rep"], "to_rep": me,
                                                  "reason": reason, "status": "pending", "created_at": now()})
    owner = node["owner_rep"] or "an admin (unassigned)"
    log(db, "transfer", f"Requested {node['name']} from {owner}")
    bump_version(db)
    db.commit()
    return jsonify(transfer_row(db, transfer_id)), 201


@app.post("/api/transfers/<int:transfer_id>/<action>")
def decide_transfer(transfer_id, action):
    if action not in ("approve", "decline", "cancel"):
        return bad("Not found", 404)
    db = get_db()
    t = transfer_row(db, transfer_id)
    if not t:
        return bad("Not found", 404)
    if t["status"] != "pending":
        return bad(f"This request was already {t['status']}")
    node = node_row(db, t["node_id"])
    if action == "cancel":
        if t["to_rep"] != own_name() and not is_admin():
            return bad("Only the rep who asked can cancel this request", 403)
        status, summary = "cancelled", f"Cancelled their request for {node['name']}"
    else:
        if not can_decide(t):
            return bad("Only the lead's owner or an admin can decide this", 403)
        if node["owner_rep"] != t["from_rep"]:
            status, summary = "cancelled", f"Request for {node['name']} closed: the lead changed hands meanwhile"
        elif action == "approve":
            status = "approved"
            db.execute("UPDATE nodes SET owner_rep = ?, updated_at = ?, updated_by = ? WHERE id = ?",
                       (t["to_rep"], now(), actor(), node["id"]))
            moved = 0
            if node["type"] == "company" and t["from_rep"]:
                cur = db.execute("UPDATE nodes SET owner_rep = ? WHERE company_id = ? AND owner_rep = ?",
                                 (t["to_rep"], node["id"], t["from_rep"]))
                moved = max(cur.rowcount or 0, 0)
            extra = f" with {moved} contact{'s' if moved != 1 else ''}" if moved else ""
            summary = f"Transferred {node['name']}{extra} to {t['to_rep']}"
            # Other pending requests for the same lead are now moot.
            db.execute("UPDATE transfer_requests SET status = 'cancelled', decided_at = ?, decided_by = ? "
                       "WHERE node_id = ? AND status = 'pending' AND id != ?", (now(), actor(), node["id"], t["id"]))
        else:
            status, summary = "declined", f"Declined {t['to_rep']}'s request for {node['name']}"
    db.execute("UPDATE transfer_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?",
               (status, now(), actor(), transfer_id))
    log(db, "transfer", summary)
    bump_version(db)
    db.commit()
    return jsonify(transfer_row(db, transfer_id))


# ---------- card color and priority ----------

@app.post("/api/nodes/<int:node_id>/display")
def change_display(node_id):
    """Anyone signed in can recolor a card or flag a contact as high priority, like tags."""
    db = get_db()
    node = node_row(db, node_id)
    if not node:
        return bad("Not found", 404)
    data = request.get_json(silent=True) or {}
    changes, summary = {}, ""
    if "color" in data:
        color = str(data["color"] or "").strip().lower()
        if color and not re.fullmatch(r"#[0-9a-f]{6}", color):
            return bad("Pick a color from the list")
        changes["color"] = color
        summary = f"Changed the color of {node['name']}" if color else f"Reset the color of {node['name']}"
    if "priority" in data:
        if node["type"] != "person":
            return bad("High priority is for contacts")
        changes["priority"] = 1 if data["priority"] else 0
        summary = (f"Marked {node['name']} high priority" if changes["priority"]
                   else f"Removed high priority from {node['name']}")
    if not changes:
        return bad("Nothing to change")
    if any(node[k] != v for k, v in changes.items()):
        changes.update(updated_at=now(), updated_by=actor())
        assignments = ", ".join(f"{col} = ?" for col in changes)
        db.execute(f"UPDATE nodes SET {assignments} WHERE id = ?", [*changes.values(), node_id])
        log(db, "display", summary)
        bump_version(db)
        db.commit()
    return jsonify(node_row(db, node_id))


# ---------- merging contacts ----------

@app.post("/api/nodes/<int:node_id>/merge")
def merge_contacts(node_id):
    """Folds a duplicate contact into this one: notes and connections move over, blank fields
    are filled from the duplicate, and the duplicate is removed. Wingmate keeps syncing into
    the kept contact."""
    db = get_db()
    keep = node_row(db, node_id)
    other = node_row(db, to_int((request.get_json(silent=True) or {}).get("other_id")))
    if not keep or not other:
        return bad("Not found", 404)
    if keep["id"] == other["id"] or keep["type"] != "person" or other["type"] != "person":
        return bad("Pick two different contacts to merge")
    if not can_edit_node(keep) or not can_edit_node(other):
        return not_yours("contacts assigned to you")

    fills = {f: other[f] for f in ("title", "email", "phone", "location", "stage") if not keep[f] and other[f]}
    if other["notes"] and other["notes"] not in keep["notes"]:
        fills["notes"] = f"{keep['notes']}\n\n{other['notes']}".strip()
    if keep["company_id"] is None and other["company_id"] is not None:
        fills["company_id"] = other["company_id"]
    if other["wingmate_id"]:
        if keep["wingmate_id"]:
            db.execute("INSERT INTO wingmate_aliases (ref, node_id, seen) VALUES (?, ?, '') "
                       "ON CONFLICT (ref) DO UPDATE SET node_id = excluded.node_id", (other["wingmate_id"], keep["id"]))
        else:
            fills.update(wingmate_id=other["wingmate_id"], wingmate_sync=other["wingmate_sync"],
                         wingmate_seen=other["wingmate_seen"])
    db.execute("UPDATE wingmate_aliases SET node_id = ? WHERE node_id = ?", (keep["id"], other["id"]))
    db.execute("UPDATE notes SET node_id = ? WHERE node_id = ?", (keep["id"], other["id"]))

    # Connections: move them over, dropping any that would duplicate one the kept contact has.
    existing = {(e["rel_type"], e["target_id"] if e["source_id"] == keep["id"] else e["source_id"])
                for e in db.execute("SELECT * FROM edges WHERE source_id = ? OR target_id = ?", (keep["id"], keep["id"]))}
    for e in db.execute("SELECT * FROM edges WHERE source_id = ? OR target_id = ?", (other["id"], other["id"])).fetchall():
        far = e["target_id"] if e["source_id"] == other["id"] else e["source_id"]
        if far == keep["id"] or (e["rel_type"], far) in existing:
            db.execute("DELETE FROM edges WHERE id = ?", (e["id"],))
            continue
        column = "source_id" if e["source_id"] == other["id"] else "target_id"
        db.execute(f"UPDATE edges SET {column} = ? WHERE id = ?", (keep["id"], e["id"]))
        existing.add((e["rel_type"], far))

    if other["wingmate_id"]:
        # The duplicate's Wingmate record now feeds the kept contact; don't treat it as deleted.
        db.execute("DELETE FROM wingmate_dismissed WHERE ref = ?", (other["wingmate_id"],))
    db.execute("DELETE FROM nodes WHERE id = ?", (other["id"],))
    fills.update(updated_at=now(), updated_by=actor())
    assignments = ", ".join(f"{col} = ?" for col in fills)
    db.execute(f"UPDATE nodes SET {assignments} WHERE id = ?", [*fills.values(), keep["id"]])
    log(db, "merge", f"Merged {other['name']} into {keep['name']}")
    bump_version(db)
    db.commit()
    return jsonify(node_row(db, keep["id"]))


# ---------- CSV export (admin) ----------

def csv_response(rows, header, filename):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    stamp = datetime.now().strftime("%Y-%m-%d")
    return Response("\ufeff" + buffer.getvalue(), mimetype="text/csv",  # BOM so Excel reads UTF-8
                    headers={"Content-Disposition": f'attachment; filename="pss-connect-{filename}-{stamp}.csv"'})


@app.post("/api/export/<kind>.csv")
@admin_only
def export_csv(kind):
    """Contacts or companies as CSV; optional {"ids": [...]} limits it to what's on screen."""
    if kind not in ("contacts", "companies"):
        return bad("Not found", 404)
    db = get_db()
    ids = (request.get_json(silent=True) or {}).get("ids")
    wanted = {to_int(i) for i in ids} if isinstance(ids, list) else None
    nodes = {r["id"]: dict(r) for r in db.execute("SELECT * FROM nodes")}
    note_counts, last_note = {}, {}
    for r in db.execute("SELECT node_id, body, created_at FROM notes ORDER BY created_at"):
        note_counts[r["node_id"]] = note_counts.get(r["node_id"], 0) + 1
        last_note[r["node_id"]] = r["body"]
    links = {}
    for e in db.execute("SELECT source_id, target_id FROM edges"):
        for end in (e["source_id"], e["target_id"]):
            links[end] = links.get(end, 0) + 1
    picked = [n for n in nodes.values() if n["type"] == ("person" if kind == "contacts" else "company")
              and (wanted is None or n["id"] in wanted)]
    picked.sort(key=lambda n: n["name"].lower())
    source = lambda n: "Wingmate" if n["wingmate_id"] else "PSS Connect"
    if kind == "contacts":
        header = ["Name", "Title", "Company", "High priority", "Stage", "Email", "Phone", "Location", "Owner rep", "Company tags",
                  "Connections", "Notes", "Latest note", "About", "Source", "Created", "Last edited", "Last edited by"]
        rows = []
        for n in picked:
            company = nodes.get(n["company_id"]) or {}
            rows.append([n["name"], n["title"], company.get("name", ""), "Yes" if n["priority"] else "",
                         n["stage"], n["email"], n["phone"],
                         n["location"] or company.get("location", ""), n["owner_rep"], company.get("tags", ""),
                         links.get(n["id"], 0), note_counts.get(n["id"], 0), last_note.get(n["id"], ""), n["notes"],
                         source(n), n["created_at"][:10], n["updated_at"][:10], n["updated_by"]])
    else:
        header = ["Company", "High-priority contacts", "Location", "Tags", "Owner rep", "Contacts", "Contact names", "Stages",
                  "Connections", "Notes", "About", "Source", "Created", "Last edited", "Last edited by"]
        rows = []
        for n in picked:
            staff = sorted((p for p in nodes.values() if p["type"] == "person" and p["company_id"] == n["id"]),
                           key=lambda p: p["name"].lower())
            stages = sorted({p["stage"] for p in staff if p["stage"]})
            rows.append([n["name"], sum(1 for p in staff if p["priority"]), n["location"], n["tags"], n["owner_rep"], len(staff),
                         "; ".join(p["name"] for p in staff), "; ".join(stages), links.get(n["id"], 0),
                         note_counts.get(n["id"], 0), n["notes"], source(n), n["created_at"][:10],
                         n["updated_at"][:10], n["updated_by"]])
    return csv_response(rows, header, kind)


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
    if not is_admin() and row["author"] != own_name():
        return not_yours("notes you wrote")
    dismiss_wingmate(db, row["external_id"])
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


def too_many_failures():
    with _failed_lock:
        failures, since = _failed_logins.get(client_ip(), (0, 0.0))
        return time.time() - since <= LOCKOUT_SECS and failures >= MAX_FAILURES


def note_failure():
    time.sleep(0.5)
    with _failed_lock:
        ip = client_ip()
        failures, since = _failed_logins.get(ip, (0, 0.0))
        if time.time() - since > LOCKOUT_SECS:
            failures, since = 0, 0.0
        _failed_logins[ip] = (failures + 1, since or time.time())


def clear_failures():
    with _failed_lock:
        _failed_logins.pop(client_ip(), None)


def me_payload():
    rep = current_rep()
    return {
        "rep": {"id": rep["id"], "name": rep["name"], "email": rep["email"], "is_admin": bool(rep["is_admin"])} if rep else None,
        "admin": is_admin(),
        "admin_configured": bool(auth_info()["admin_fp"]),
        "env_managed": bool(ADMIN_PASSWORD),
    }


@app.get("/api/me")
def me():
    return jsonify(me_payload())


@app.post("/api/login")
def login():
    if too_many_failures():
        return bad("Too many attempts. Try again in 10 minutes.", 429)
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    if "@" not in email:
        return bad("Enter your work email")
    rep = next((r for r in auth_info()["reps"].values()
                if r["active"] and r["email"].strip().lower() == email), None)
    if not rep:
        note_failure()
        return bad("That email isn't on the team list. Ask your admin to add you.", 400)
    if not password:
        return bad("Enter your password")
    stored = get_db().execute("SELECT password_hash FROM reps WHERE id = ?", (rep["id"],)).fetchone()
    if not stored or not stored["password_hash"] or not check_password_hash(stored["password_hash"], password):
        note_failure()
        return bad("Wrong email or password", 400)
    clear_failures()
    session.clear()
    start_session()
    session["rep_id"] = rep["id"]
    session["rep_pw"] = rep["pw_fp"]
    return jsonify(me_payload())


@app.post("/api/me/password")
def change_my_password():
    rep = current_rep()
    if not rep:
        return bad("Sign in first", 403)
    new_password = str((request.get_json(silent=True) or {}).get("new_password") or "")
    if len(new_password) < 8:
        return bad("Use at least 8 characters")
    db = get_db()
    password_hash = generate_password_hash(new_password, method="pbkdf2:sha256")
    db.execute("UPDATE reps SET password_hash = ? WHERE id = ?", (password_hash, rep["id"]))
    db.commit()
    session["rep_pw"] = password_fingerprint(password_hash)  # keep this browser signed in
    return jsonify({"ok": True})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(me_payload())


@app.get("/api/admin/me")
def admin_me():
    return jsonify({"configured": bool(admin_fingerprint(get_db())), "admin": is_admin(),
                    "env_managed": bool(ADMIN_PASSWORD)})


@app.post("/api/admin/login")
def admin_login():
    db = get_db()
    if not admin_fingerprint(db):
        return bad("No admin password is set yet.", 503)
    if too_many_failures():
        return bad("Too many wrong attempts. Try again in 10 minutes.", 429)
    password = str((request.get_json(silent=True) or {}).get("password") or "")
    if not check_admin_password(db, password):
        note_failure()
        return bad("Wrong password", 400)
    clear_failures()
    if not session_valid():
        session.clear()
    start_session()
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
    if "email" in data:
        email = str(data["email"] or "").strip()[:300]
        if "@" not in email:
            return None, "A work email is required: it's how they sign in"
        clash = db.execute("SELECT name FROM reps WHERE LOWER(email) = LOWER(?) AND id != ?",
                           (email, rep_id or 0)).fetchone()
        if clash:
            return None, f"{clash['name']} already uses that email"
        out["email"] = email
    if "phone" in data:
        out["phone"] = str(data["phone"] or "").strip()[:300]
    if "active" in data:
        out["active"] = 1 if data["active"] else 0
    if "is_admin" in data:
        out["is_admin"] = 1 if data["is_admin"] else 0
    if data.get("password"):
        if len(str(data["password"])) < 6:
            return None, "Passwords need at least 6 characters"
        out["password_hash"] = hash_password(str(data["password"]))
    elif data.get("reset_password"):
        out["password_hash"] = hash_password(default_password(data.get("name") or rep_name(db, rep_id)))
    return out, None


def hash_password(password):
    return generate_password_hash(password, method="pbkdf2:sha256")


def default_password(name):
    """A new rep's starting password: first name, capitalized, + 123 (e.g. "Bryton123")."""
    first = (str(name or "").strip().split() or ["Rep"])[0]
    return first[:1].upper() + first[1:].lower() + "123"


def rep_name(db, rep_id):
    row = db.execute("SELECT name FROM reps WHERE id = ?", (rep_id or 0,)).fetchone()
    return row["name"] if row else ""


@app.post("/api/reps")
@admin_only
def create_rep():
    data = request.get_json(silent=True) or {}
    if not str(data.get("name") or "").strip():
        return bad("Name is required")
    db = get_db()
    values, err = clean_rep_fields(db, {"active": 1, "email": "", **data})
    if err:
        return bad(err)
    if not values.get("password_hash"):
        values["password_hash"] = hash_password(default_password(values["name"]))
    values["created_at"] = now()
    rep_id = db.insert("reps", values)
    log(db, "rep", f"Added rep {values['name']}")
    bump_version(db)
    db.commit()
    return jsonify(rep_public(db, rep_id)), 201


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
    if values.get("is_admin", existing["is_admin"]) and not values.get("password_hash", existing["password_hash"]):
        return bad("Set a password for an admin")
    me_rep = current_rep()
    if me_rep and me_rep["id"] == rep_id and (values.get("is_admin") == 0 or values.get("active") == 0):
        return bad("You can't remove your own admin access", 400)
    if values:
        assignments = ", ".join(f"{col} = ?" for col in values)
        db.execute(f"UPDATE reps SET {assignments} WHERE id = ?", [*values.values(), rep_id])
        if values.get("name", existing["name"]) != existing["name"]:
            # Keep ownership and authorship pointing at the renamed rep.
            renamed = (values["name"], existing["name"])
            db.execute("UPDATE nodes SET owner_rep = ? WHERE owner_rep = ?", renamed)
            db.execute("UPDATE edges SET created_by = ? WHERE created_by = ?", renamed)
            db.execute("UPDATE notes SET author = ? WHERE author = ?", renamed)
        log(db, "rep", f"Updated rep {values.get('name', existing['name'])}")
        bump_version(db)
        db.commit()
    return jsonify(rep_public(db, rep_id))


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
@admin_only
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
    """Restores an uploaded backup file, replacing the whole map."""
    if not is_admin():
        return bad("Only an admin can restore a backup.", 403)
    db = get_db()
    try:
        save_backup(db, "before-restore")  # so a restore can always be undone
        counts = restore_snapshot(db, request.get_json(silent=True))
    except ValueError as e:
        db.conn.rollback()
        return bad(str(e))
    log(db, "restore", f"Restored a backup file ({counts['nodes']} records, {counts['edges']} connections)")
    bump_version(db)
    db.commit()
    return jsonify(counts)


def restore_snapshot(db, data):
    """Replaces the map with a backup's contents. Raises ValueError for a bad backup.
    Settings, the Wingmate connection and passwords are left as they are."""
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list) \
            or not isinstance(data.get("edges"), list):
        raise ValueError("That file doesn't look like a PSS Connect backup")
    nodes = [n for n in data["nodes"] if isinstance(n, dict)]
    edges = [e for e in data["edges"] if isinstance(e, dict)]
    node_types = {to_int(n.get("id")): n.get("type") for n in nodes}
    if None in node_types or any(t not in NODE_TYPES for t in node_types.values()):
        raise ValueError("Backup has invalid records")

    ts = now()
    db.execute("DELETE FROM notes")
    if isinstance(data.get("reps"), list):
        passwords = {r["email"].strip().lower(): r["password_hash"]
                     for r in db.execute("SELECT email, password_hash FROM reps") if r["password_hash"]}
        db.execute("DELETE FROM reps")
        # Rep ids change, so assistants connected to the old list must sign in again.
        db.execute("DELETE FROM oauth_tokens")
        db.execute("DELETE FROM oauth_codes")
        db.execute("DELETE FROM assistant_chats")
        for rep in data["reps"]:
            name = str(rep.get("name") or "").strip()[:100] if isinstance(rep, dict) else ""
            if name:
                email = str(rep.get("email") or "")[:300]
                password_hash = passwords.get(email.strip().lower(), "")
                db.insert("reps", {"name": name, "email": email,
                                   "phone": str(rep.get("phone") or "")[:300],
                                   "active": 1 if rep.get("active", 1) else 0,
                                   "is_admin": 1 if rep.get("is_admin") and password_hash else 0,
                                   "password_hash": password_hash,
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
        row["wingmate_id"] = str(row["wingmate_id"] or "")
        row["wingmate_seen"] = str(row["wingmate_seen"] or "")
        row["wingmate_sync"] = str(row["wingmate_sync"] or "")
        row["color"] = str(row["color"] or "")
        row["priority"] = 1 if row["priority"] else 0
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
                      updated_by=str(e.get("updated_by") or ""),
                      created_by=str(e.get("created_by") or e.get("updated_by") or ""))
        db.insert("edges", values)
        restored_edges += 1
    for note in data.get("notes") or []:
        node_id = to_int(note.get("node_id")) if isinstance(note, dict) else None
        body = str(note.get("body") or "").strip()[:5000] if node_id in node_types else ""
        if body:
            db.insert("notes", {"node_id": node_id, "body": body, "author": str(note.get("author") or ""),
                                "created_at": str(note.get("created_at") or ts),
                                "external_id": str(note.get("external_id") or "")})
    if USE_POSTGRES:
        # Rows were inserted with explicit ids, so move the id sequences past them.
        for table in ("nodes", "edges"):
            db.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                       f"COALESCE(MAX(id), 0) + 1, false) FROM {table}")
    return {"nodes": len(nodes), "edges": restored_edges}


# ---------- backups ----------
# A full copy of the map is kept in the database every night (30 days), plus one
# before every restore. A keyed link lets an outside scheduler (GitHub Actions)
# trigger the nightly copy and store it off-site too.

BACKUP_KEEP = {"nightly": 30, "manual": 20, "before-restore": 10}
NIGHTLY_EVERY_SECS = 23 * 3600


def backup_payload(db):
    return {"app": "pss-connect", "exported_at": now(), "version": current_version(db), **snapshot(db)}


def save_backup(db, kind):
    data = json.dumps(backup_payload(db), separators=(",", ":"))
    backup_id = db.insert("backups", {"created_at": now(), "kind": kind, "size": len(data), "data": data})
    keep = BACKUP_KEEP.get(kind, 10)
    old = db.execute("SELECT id FROM backups WHERE kind = ? ORDER BY id DESC", (kind,)).fetchall()[keep:]
    for row in old:
        db.execute("DELETE FROM backups WHERE id = ?", (row["id"],))
    return backup_id


def nightly_due(db):
    row = db.execute("SELECT created_at FROM backups WHERE kind = 'nightly' ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return True
    last = datetime.fromisoformat(row["created_at"])
    return (datetime.now(timezone.utc) - last).total_seconds() > NIGHTLY_EVERY_SECS


def _backup_loop():
    """Saves the nightly copy whenever the server is awake and one is due."""
    time.sleep(60)
    while True:
        try:
            with app.app_context():
                db = get_db()
                if nightly_due(db):
                    save_backup(db, "nightly")
                    db.commit()
        except Exception:
            app.logger.exception("Nightly backup failed")
        time.sleep(3600)


@app.get("/api/backups")
@admin_only
def list_backups():
    db = get_db()
    rows = [dict(r) for r in db.execute("SELECT id, created_at, kind, size FROM backups ORDER BY id DESC")]
    key = get_setting(db, "backup_key")
    return jsonify({"backups": rows,
                    "offsite_url": f"{request.host_url}api/backup/nightly.json?key={key}" if key else ""})


@app.post("/api/backups")
@admin_only
def backup_now():
    db = get_db()
    backup_id = save_backup(db, "manual")
    log(db, "backup", "Saved a backup")
    db.commit()
    return jsonify({"id": backup_id}), 201


@app.get("/api/backups/<int:backup_id>.json")
@admin_only
def download_backup(backup_id):
    row = get_db().execute("SELECT created_at, data FROM backups WHERE id = ?", (backup_id,)).fetchone()
    if not row:
        return bad("Not found", 404)
    return Response(row["data"], mimetype="application/json", headers={
        "Content-Disposition": f'attachment; filename="pss-connect-backup-{row["created_at"][:10]}.json"'})


@app.post("/api/backups/<int:backup_id>/restore")
@admin_only
def restore_backup(backup_id):
    db = get_db()
    row = db.execute("SELECT created_at, data FROM backups WHERE id = ?", (backup_id,)).fetchone()
    if not row:
        return bad("Not found", 404)
    try:
        save_backup(db, "before-restore")
        counts = restore_snapshot(db, json.loads(row["data"]))
    except ValueError as e:
        db.conn.rollback()
        return bad(str(e))
    log(db, "restore", f"Restored the backup from {row['created_at'][:16].replace('T', ' ')} UTC")
    bump_version(db)
    db.commit()
    return jsonify(counts)


@app.get("/api/backup/nightly.json")
def offsite_backup():
    """For the off-site copy: saves tonight's backup if it's due and returns the newest one."""
    db = get_db()
    key = get_setting(db, "backup_key")
    if not key or not hmac.compare_digest(request.args.get("key", ""), key):
        return bad("Not found", 404)
    if nightly_due(db):
        save_backup(db, "nightly")
        db.commit()
    row = db.execute("SELECT data FROM backups WHERE kind = 'nightly' ORDER BY id DESC LIMIT 1").fetchone()
    return Response(row["data"], mimetype="application/json")


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
    ts, who, admin = now(), actor(), is_admin()
    companies = {norm_name(r["name"], True): r["id"]
                 for r in db.execute("SELECT id, name FROM nodes WHERE type = 'company'")}
    people, emails = set(), set()
    for r in db.execute("SELECT name, company_id, email FROM nodes WHERE type = 'person'"):
        people.add((norm_name(r["name"]), r["company_id"]))
        if r["email"].strip():
            emails.add(r["email"].strip().lower())
    added_companies = added_people = skipped = 0

    for raw_row in reader:
        row = {(k or "").strip().lower().replace(" ", "_"): (v or "").strip() for k, v in raw_row.items()}
        name, company = row.get("name", ""), row.get("company", "")
        company_id = None
        if company:
            company_id = companies.get(norm_name(company, True))
            if company_id is None:
                company_id = companies[norm_name(company, True)] = db.insert("nodes", {
                    "type": "company", "name": company[:300], "owner_rep": "" if admin else own_name(),
                    "created_at": ts, "updated_at": ts, "updated_by": who})
                added_companies += 1
        if not name:
            if not company:
                skipped += 1
            continue
        key = (norm_name(name), company_id)
        email = row.get("email", "").strip().lower()
        if key in people or (email and email in emails):
            skipped += 1
            continue
        values = {f: row.get(f, "")[:5000 if f == "notes" else 300] for f in NODE_TEXT_FIELDS}
        values["tags"] = ""  # tags belong to companies
        if company_id and row.get("tags"):
            company_tags = db.execute("SELECT tags FROM nodes WHERE id = ?", (company_id,)).fetchone()["tags"]
            merged = join_tags(db, company_tags.split(",") + row["tags"].split(","))
            db.execute("UPDATE nodes SET tags = ? WHERE id = ?", (merged, company_id))
        values.update(type="person", company_id=company_id, created_at=ts, updated_at=ts, updated_by=who)
        if not admin:
            values["owner_rep"] = own_name()
        db.insert("nodes", values)
        people.add(key)
        if email:
            emails.add(email)
        added_people += 1

    if added_companies or added_people:
        people_word = "person" if added_people == 1 else "people"
        company_word = "company" if added_companies == 1 else "companies"
        log(db, "import", f"Imported {added_people} {people_word} and {added_companies} {company_word} from CSV")
        bump_version(db)
    db.commit()
    return jsonify({"people": added_people, "companies": added_companies, "skipped": skipped})


# ---------- Wingmate sync ----------

WINGMATE_INTERVAL = int(os.environ.get("WINGMATE_INTERVAL_SECS", 15 * 60))
_wingmate_lock = threading.Lock()
_wingmate_state = {"running": None, "preview": None}  # what's running now; the last preview's counts


def get_setting(db, key):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else ""


def set_setting(db, key, value):
    db.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
               "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, value))


def wingmate_client(db):
    token, campaign_id = get_setting(db, "wingmate_token"), get_setting(db, "wingmate_campaign_id")
    return wingmate.WingmateClient(token, campaign_id) if token and campaign_id else None


SYNC_TOOLS = {"norm_name": lambda name, is_company=False: norm_name(name, is_company),
              "now": lambda: now(), "bump_version": lambda db: bump_version(db)}


def run_wingmate_sync(dry_run=False):
    """Runs one sync with its own database connection. Returns the result dict."""
    if not _wingmate_lock.acquire(blocking=False):
        return {"ok": False, "error": "A Wingmate sync is already running."}
    _wingmate_state["running"] = "preview" if dry_run else "sync"
    try:
        with app.app_context():
            db = get_db()
            client = wingmate_client(db)
            if client is None:
                return {"ok": False, "error": "Wingmate isn't connected yet."}
            started = now()
            try:
                result = {"ok": True, "at": started, **wingmate.run_sync(db, client, SYNC_TOOLS, dry_run)}
            except wingmate.WingmateError as e:
                db.conn.rollback()
                result = {"ok": False, "at": started, "error": str(e)}
            except Exception as e:  # keep the background loop alive whatever happens
                db.conn.rollback()
                app.logger.exception("Wingmate sync failed")
                result = {"ok": False, "at": started, "error": f"Sync failed: {e}"}
            if dry_run:
                _wingmate_state["preview"] = result
            else:
                set_setting(db, "wingmate_last_result", json.dumps(result))
                db.commit()
            return result
    finally:
        _wingmate_state["running"] = None
        _wingmate_lock.release()


def start_wingmate_sync(dry_run=False):
    """Kicks off a sync in the background; False if one is already running."""
    if _wingmate_lock.locked():
        return False
    threading.Thread(target=run_wingmate_sync, args=(dry_run,), daemon=True, name="wingmate-run").start()
    return True


def _wingmate_loop():
    time.sleep(min(30, WINGMATE_INTERVAL))  # let the server finish starting
    while True:
        try:
            with app.app_context():
                connected = wingmate_client(get_db()) is not None
            if connected:
                run_wingmate_sync()
        except Exception:
            app.logger.exception("Wingmate loop")
        time.sleep(WINGMATE_INTERVAL)


def wingmate_status(db):
    token = get_setting(db, "wingmate_token")
    last = get_setting(db, "wingmate_last_result")
    cron_key = get_setting(db, "wingmate_cron_key")
    return {
        "connected": bool(token and get_setting(db, "wingmate_campaign_id")),
        "token_hint": f"…{token[-4:]}" if token else "",
        "campaign_id": get_setting(db, "wingmate_campaign_id"),
        "campaign_name": get_setting(db, "wingmate_campaign_name"),
        "last": json.loads(last) if last else None,
        "preview": _wingmate_state["preview"],
        "running": _wingmate_state["running"],
        "interval_minutes": WINGMATE_INTERVAL // 60,
        "cron_url": f"{request.host_url}api/wingmate/cron?key={cron_key}" if cron_key else "",
    }


@app.get("/api/wingmate/status")
@admin_only
def get_wingmate_status():
    return jsonify(wingmate_status(get_db()))


@app.post("/api/wingmate/settings")
@admin_only
def save_wingmate_settings():
    data = request.get_json(silent=True) or {}
    db = get_db()
    if data.get("disconnect"):
        for key in ("wingmate_token", "wingmate_campaign_id", "wingmate_campaign_name"):
            set_setting(db, key, "")
        log(db, "wingmate", "Disconnected Wingmate")
        db.commit()
        return jsonify(wingmate_status(db))
    token = str(data.get("token") or "").strip() or get_setting(db, "wingmate_token")
    campaign_id = str(data.get("campaign_id") or "").strip()
    if not token or not campaign_id:
        return bad("Enter the Wingmate API token and the campaign (pipeline) ID")
    try:
        campaign = wingmate.WingmateClient(token, campaign_id).campaign()
    except wingmate.WingmateError as e:
        return bad(str(e))
    set_setting(db, "wingmate_token", token)
    set_setting(db, "wingmate_campaign_id", campaign_id)
    set_setting(db, "wingmate_campaign_name", str(campaign.get("name") or ""))
    if not get_setting(db, "wingmate_cron_key"):
        set_setting(db, "wingmate_cron_key", secrets.token_urlsafe(24))
    log(db, "wingmate", f"Connected Wingmate pipeline {campaign.get('name') or campaign_id}")
    db.commit()
    return jsonify(wingmate_status(db))


@app.post("/api/wingmate/sync")
@admin_only
def trigger_wingmate_sync():
    dry_run = bool((request.get_json(silent=True) or {}).get("dry_run"))
    if wingmate_client(get_db()) is None:
        return bad("Connect Wingmate first")
    if not start_wingmate_sync(dry_run):
        return bad("A Wingmate sync is already running", 409)
    return jsonify({"started": True}), 202


@app.route("/api/wingmate/cron", methods=["GET", "POST"])
def wingmate_cron():
    """For a free scheduler (e.g. cron-job.org) to trigger syncs and keep the site awake."""
    key = get_setting(get_db(), "wingmate_cron_key")
    if not key or not hmac.compare_digest(request.args.get("key", ""), key):
        return bad("Not found", 404)
    return jsonify({"started": start_wingmate_sync()}), 202


# Any signed-in rep can pull in what's new in Wingmate right away instead of waiting for
# the 15-minute sync. A sync that finished in the last minute counts as fresh.
REFRESH_COOLDOWN_SECS = 60


def wingmate_refresh_status(db):
    last = get_setting(db, "wingmate_last_result")
    return {"connected": wingmate_client(db) is not None, "running": _wingmate_state["running"] == "sync",
            "last": json.loads(last) if last else None}


@app.get("/api/wingmate/refresh")
def get_wingmate_refresh():
    return jsonify(wingmate_refresh_status(get_db()))


@app.post("/api/wingmate/refresh")
def wingmate_refresh():
    db = get_db()
    status = wingmate_refresh_status(db)
    if not status["connected"]:
        return bad("Wingmate isn't connected yet. Ask an admin to connect it in \u2699.")
    last = status["last"] or {}
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(last["at"])).total_seconds() if last.get("ok") else None
    except (KeyError, TypeError, ValueError):
        age = None
    if status["running"] or (age is not None and age < REFRESH_COOLDOWN_SECS):
        return jsonify({**status, "started": False})
    if not start_wingmate_sync():
        return jsonify({**status, "started": False, "busy": True})
    return jsonify({**status, "started": True, "running": True}), 202


app.secret_key = os.environ.get("SECRET_KEY") or init_db()
connector.install(app, sys.modules[__name__])  # Claude / ChatGPT connector at /mcp
assistant.install(app, sys.modules[__name__])  # the in-app "Ask AI" side panel

# One background sync loop per server process (the app runs a single worker).
_CLI_COMMANDS = ("add-admin", "set-admin-password")
if os.environ.get("WINGMATE_AUTOSYNC", "1") == "1" and sys.argv[1:2] not in [[c] for c in _CLI_COMMANDS]:
    threading.Thread(target=_wingmate_loop, daemon=True, name="wingmate-loop").start()
if os.environ.get("BACKUP_AUTOSAVE", "1") == "1" and sys.argv[1:2] not in [[c] for c in _CLI_COMMANDS]:
    threading.Thread(target=_backup_loop, daemon=True, name="backup-loop").start()

if __name__ == "__main__":
    if sys.argv[1:2] == ["add-admin"]:
        # Usage: DATABASE_URL=... python app.py add-admin 'Full Name' email@company.com 'password'
        if len(sys.argv) != 5 or "@" not in sys.argv[3] or len(sys.argv[4]) < 8:
            sys.exit("Usage: python app.py add-admin '<name>' <email> '<password, 8+ characters>'")
        name, email, password = sys.argv[2].strip(), sys.argv[3].strip(), sys.argv[4]
        with app.app_context():
            db = get_db()
            password_hash = generate_password_hash(password, method="pbkdf2:sha256")
            row = db.execute("SELECT id FROM reps WHERE LOWER(email) = LOWER(?)", (email,)).fetchone()
            if row:
                db.execute("UPDATE reps SET name = ?, active = 1, is_admin = 1, password_hash = ? WHERE id = ?",
                           (name, password_hash, row["id"]))
            else:
                db.insert("reps", {"name": name, "email": email, "active": 1, "is_admin": 1,
                                   "password_hash": password_hash, "created_at": now()})
            bump_version(db)
            db.commit()
        print(f"{name} <{email}> is an admin.")
    elif sys.argv[1:2] == ["set-admin-password"]:
        # Usage: DATABASE_URL=... python app.py set-admin-password 'new password'
        if len(sys.argv) != 3 or len(sys.argv[2]) < 8:
            sys.exit("Usage: python app.py set-admin-password '<at least 8 characters>'")
        with app.app_context():
            save_admin_password(get_db(), sys.argv[2])
        print("Admin password saved.")
    else:
        port = int(os.environ.get("PORT", 8000))
        app.run(host="0.0.0.0", port=port)
