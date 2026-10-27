"""
PSS Connect for Claude and ChatGPT.

A remote MCP server at /mcp, plus the small OAuth 2.1 sign-in that Claude and
ChatGPT need to add it as a connector. A rep adds PSS Connect in their own Claude
or ChatGPT and signs in with their PSS Connect email and password; the assistant
then works as that rep, under the same rules as the app: they change only their
own records, anyone can add notes, tags, connections and priority, and nothing can
be deleted from here. It can also look things up in Wingmate through the team's
saved Wingmate connection (read-only).

Writes go through the app's own API routes (via Flask's test client, as the rep),
so permissions, duplicate checks and the activity feed behave exactly as in the app.
"""

import base64
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

from flask import Response, jsonify, redirect, request, session

import wingmate

core = None  # the app module, set by install() (avoids a circular import)

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SCOPE = "pss"
ACCESS_SECS = 3600
REFRESH_SECS = 90 * 86400
CODE_SECS = 600
SERVER_VERSION = "1.0"

INSTRUCTIONS = """\
PSS Connect is Premium Surface Solutions' relationship map: companies, contacts (people at
companies), connections between records, and notes. You are working as the signed-in rep.

- Search before adding, so you don't create duplicates. Add tools also refuse likely duplicates
  and return the matches; only pass allow_duplicate=true if the rep confirms it's a different one.
- For more than a few contacts at once (a pasted list, spreadsheet, business cards), use
  bulk_add_contacts with confirm=false first, show the rep the preview, and call it again with
  the same rows and confirm=true only after they agree.
- Reps can edit only records assigned to them. On anyone's record they can still add notes,
  company tags, connections and the high-priority flag, or request the lead (request_lead_transfer).
- Nothing can be deleted through this connector; tell the rep to do that in the PSS Connect app.
- Wingmate (the team's field-sales app) syncs into PSS Connect every 15 minutes. The Wingmate
  tools read it live and are read-only.
- Refer to records by name when talking to the rep; ids are for tool calls."""


class ToolError(Exception):
    """A problem to show the assistant (and the rep) as-is."""


# ---------- small helpers ----------

def base_url():
    return (os.environ.get("PUBLIC_URL") or request.url_root).rstrip("/")


def resource_url():
    return base_url() + "/mcp"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def epoch():
    return int(time.time())


def no_store(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Pragma"] = "no-cache"
    return resp


def oauth_error(error, description, status=400):
    return no_store(jsonify({"error": error, "error_description": description})), status


def via_label(client_name):
    """How the activity feed names the assistant: '(via Claude)'."""
    name = (client_name or "").lower()
    if "claude" in name or "anthropic" in name:
        return "Claude"
    if "chatgpt" in name or "openai" in name:
        return "ChatGPT"
    return "AI assistant"


# ---------- OAuth clients (dynamic registration or a client metadata document) ----------

_register_log = deque()
_register_lock = threading.Lock()
_metadata_cache = {}


def redirect_ok(uri):
    try:
        parts = urllib.parse.urlsplit(uri)
    except ValueError:
        return False
    if parts.fragment or not parts.netloc:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1")


def redirect_matches(registered, given):
    """Exact match, except a loopback redirect may use any port (RFC 8252)."""
    if given in registered:
        return True
    g = urllib.parse.urlsplit(given)
    if g.scheme != "http" or g.hostname not in ("localhost", "127.0.0.1", "::1"):
        return False
    for uri in registered:
        r = urllib.parse.urlsplit(uri)
        if (r.scheme, r.hostname, r.path, r.query) == (g.scheme, g.hostname, g.path, g.query):
            return True
    return False


def public_host(host):
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(info[4][0]).is_global for info in infos)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def metadata_client(client_id):
    """A client identified by an https URL that serves its own metadata (CIMD)."""
    cached = _metadata_cache.get(client_id)
    if cached and time.time() - cached["at"] < 600:
        return cached["client"]
    parts = urllib.parse.urlsplit(client_id)
    if parts.scheme != "https" or not parts.hostname or not public_host(parts.hostname):
        return None
    try:
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(client_id, headers={"Accept": "application/json", "User-Agent": "PSS-Connect"})
        with opener.open(req, timeout=8) as resp:
            doc = json.loads(resp.read(65536))
    except (urllib.error.URLError, socket.timeout, ValueError, ConnectionError):
        return None
    uris = doc.get("redirect_uris") if isinstance(doc, dict) else None
    if doc.get("client_id") != client_id or not isinstance(uris, list) \
            or not all(isinstance(u, str) and redirect_ok(u) for u in uris):
        return None
    client = {"client_id": client_id, "client_name": str(doc.get("client_name") or parts.hostname)[:100],
              "redirect_uris": uris, "secret_hash": ""}
    _metadata_cache[client_id] = {"at": time.time(), "client": client}
    return client


def find_client(db, client_id):
    client_id = str(client_id or "")
    if not client_id:
        return None
    if client_id.startswith("https://"):
        return metadata_client(client_id)
    row = db.execute("SELECT * FROM oauth_clients WHERE client_id = ?", (client_id,)).fetchone()
    if not row:
        return None
    client = dict(row)
    client["redirect_uris"] = json.loads(client["redirect_uris"] or "[]")
    return client


def register_client():
    """RFC 7591 dynamic client registration, which Claude and ChatGPT use to sign up once."""
    with _register_lock:
        cutoff = time.time() - 3600
        while _register_log and _register_log[0] < cutoff:
            _register_log.popleft()
        if len(_register_log) >= 60:
            return oauth_error("invalid_client_metadata", "Too many registrations. Try again later.", 429)
        _register_log.append(time.time())
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return oauth_error("invalid_client_metadata", "Send the client metadata as JSON.")
    uris = data.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > 10 \
            or not all(isinstance(u, str) and len(u) <= 500 and redirect_ok(u) for u in uris):
        return oauth_error("invalid_redirect_uri", "redirect_uris must be https (or loopback http) URLs.")
    method = data.get("token_endpoint_auth_method") or "client_secret_basic"
    if method not in ("none", "client_secret_basic", "client_secret_post"):
        return oauth_error("invalid_client_metadata", f"Unsupported token_endpoint_auth_method {method}.")
    db = core.get_db()
    # Tidy up registrations that never finished signing in.
    db.execute("DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN "
               "(SELECT DISTINCT client_id FROM oauth_tokens)", (epoch() - 7 * 86400,))
    client_id = "pssc_" + secrets.token_urlsafe(18)
    secret = secrets.token_urlsafe(32) if method != "none" else ""
    name = str(data.get("client_name") or "AI assistant").strip()[:100]
    db.insert("oauth_clients", {"client_id": client_id, "client_name": name, "redirect_uris": json.dumps(uris),
                                "auth_method": method, "secret_hash": digest(secret) if secret else "",
                                "created_at": epoch()})
    db.conn.commit()
    body = {"client_id": client_id, "client_id_issued_at": epoch(), "client_name": name, "redirect_uris": uris,
            "token_endpoint_auth_method": method, "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "scope": SCOPE}
    if secret:
        body.update(client_secret=secret, client_secret_expires_at=0)
    return no_store(jsonify(body)), 201


# ---------- discovery ----------

def protected_resource_metadata():
    resp = jsonify({"resource": resource_url(), "authorization_servers": [base_url()],
                    "scopes_supported": [SCOPE], "bearer_methods_supported": ["header"],
                    "resource_name": "PSS Connect"})
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


def authorization_server_metadata():
    root = base_url()
    resp = jsonify({
        "issuer": root,
        "authorization_endpoint": root + "/oauth/authorize",
        "token_endpoint": root + "/oauth/token",
        "registration_endpoint": root + "/oauth/register",
        "revocation_endpoint": root + "/oauth/revoke",
        "scopes_supported": [SCOPE],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    })
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


# ---------- the sign-in page ----------

AUTH_FIELDS = ("response_type", "client_id", "redirect_uri", "state", "scope",
               "code_challenge", "code_challenge_method", "resource")

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to PSS Connect</title>
<link rel="icon" href="/static/favicon-64.png">
<style>
:root { --bg:#f4f6f9; --card:#fff; --ink:#14213d; --muted:#5b6475; --line:#d9dee7; --brand:#144579; --err:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1520; --card:#182131; --ink:#e7ecf4; --muted:#9aa6b8; --line:#2b3648; --brand:#6ea8ff; --err:#ff8a80; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--ink);
       font:16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.card { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 24px; }
.logo { display:block; height:40px; margin:0 auto 18px; }
h1 { font-size:20px; margin:0 0 6px; text-align:center; }
p { margin:0 0 14px; color:var(--muted); text-align:center; }
ul { margin:0 0 18px; padding-left:20px; color:var(--muted); font-size:14px; }
label { display:block; font-size:14px; font-weight:600; margin:12px 0 4px; }
input[type=email], input[type=password] { width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:9px;
       background:transparent; color:var(--ink); font-size:16px; }
button { width:100%; padding:12px; margin-top:16px; border:0; border-radius:9px; background:var(--brand); color:#fff;
         font-size:16px; font-weight:600; cursor:pointer; }
button.link { background:none; color:var(--muted); margin-top:8px; font-weight:500; text-decoration:underline; }
.err { color:var(--err); text-align:center; margin:12px 0 0; font-size:14px; }
.who { text-align:center; font-weight:600; color:var(--ink); }
</style></head>
<body><main class="card">
<img class="logo" src="/static/pss-connect-logo.svg" alt="PSS Connect">
<h1>Connect {client} to PSS Connect</h1>
<p>{client} will work in PSS Connect as you.</p>
<ul>
<li>Look up companies, contacts, notes and connections, and read Wingmate</li>
<li>Add contacts, companies, notes, tags and connections, and edit your own records</li>
<li>It can't delete anything</li>
</ul>
{body}
</main></body></html>"""


def render_page(client, params, error="", fresh_login=False):
    csrf = session.get("oauth_csrf") or secrets.token_urlsafe(24)
    session["oauth_csrf"] = csrf
    hidden = "".join(f'<input type="hidden" name="{k}" value="{html.escape(str(params.get(k) or ""))}">'
                     for k in AUTH_FIELDS)
    hidden += f'<input type="hidden" name="csrf" value="{csrf}">'
    rep = None if fresh_login else core.current_rep()
    err = f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ""
    if rep:
        body = (f'<form method="post">{hidden}<p class="who">Signed in as {html.escape(rep["name"])}</p>'
                f'<button name="action" value="allow">Allow</button>'
                f'<button class="link" name="action" value="switch">Use a different account</button>'
                f'<button class="link" name="action" value="deny">Cancel</button></form>{err}')
    else:
        body = (f'<form method="post">{hidden}'
                f'<label for="email">Work email</label>'
                f'<input id="email" name="email" type="email" autocomplete="username" required autofocus>'
                f'<label for="password">PSS Connect password</label>'
                f'<input id="password" name="password" type="password" autocomplete="current-password" required>'
                f'<button name="action" value="login">Sign in and allow</button>'
                f'<button class="link" name="action" value="deny" formnovalidate>Cancel</button></form>{err}')
    page = PAGE.replace("{client}", html.escape(client["client_name"] if client else "AI assistant")).replace("{body}", body)
    resp = Response(page, mimetype="text/html")
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return no_store(resp)


def error_page(message, status=400):
    page = PAGE.replace("{client}", "your assistant").replace(
        "{body}", f'<p class="err" role="alert">{html.escape(message)}</p>')
    return no_store(Response(page, status=status, mimetype="text/html"))


def back_to_client(params, **values):
    values = {k: v for k, v in values.items() if v}
    if params.get("state"):
        values["state"] = params["state"]
    values["iss"] = base_url()
    uri = params["redirect_uri"]
    return no_store(redirect(uri + ("&" if "?" in uri else "?") + urllib.parse.urlencode(values), 302))


def authorize():
    params = {k: (request.values.get(k) or "").strip() for k in AUTH_FIELDS}
    db = core.get_db()
    client = find_client(db, params["client_id"])
    if not client:
        return error_page("This assistant isn't registered with PSS Connect. Remove the connector and add it again.")
    if not params["redirect_uri"] and len(client["redirect_uris"]) == 1:
        params["redirect_uri"] = client["redirect_uris"][0]
    if not redirect_matches(client["redirect_uris"], params["redirect_uri"]):
        return error_page("The sign-in link doesn't match this assistant. Remove the connector and add it again.")
    if params["response_type"] != "code":
        return back_to_client(params, error="unsupported_response_type")
    if not params["code_challenge"] or params["code_challenge_method"] != "S256":
        return back_to_client(params, error="invalid_request", error_description="PKCE (S256) is required")
    if request.method == "GET":
        return render_page(client, params)

    sent_csrf, csrf = request.form.get("csrf", ""), session.get("oauth_csrf", "")
    if not csrf or not hmac.compare_digest(sent_csrf, csrf):
        return render_page(client, params, "That page expired. Please try again.")
    action = request.form.get("action")
    if action == "deny":
        return back_to_client(params, error="access_denied", error_description="The rep cancelled")
    if action == "switch":
        return render_page(client, params, fresh_login=True)
    rep = core.current_rep() if action == "allow" else None
    if action == "login":
        if core.too_many_failures():
            return render_page(client, params, "Too many attempts. Try again in 10 minutes.", fresh_login=True)
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        candidate = next((r for r in core.auth_info()["reps"].values()
                          if r["active"] and r["email"].strip().lower() == email), None)
        stored = db.execute("SELECT password_hash FROM reps WHERE id = ?", (candidate["id"],)).fetchone() \
            if candidate else None
        if not stored or not stored["password_hash"] or not core.check_password_hash(stored["password_hash"], password):
            core.note_failure()
            return render_page(client, params, "Wrong email or password.", fresh_login=True)
        core.clear_failures()
        rep = candidate
    if not rep:
        return render_page(client, params, "Please sign in.", fresh_login=True)

    code = secrets.token_urlsafe(32)
    db.execute("DELETE FROM oauth_codes WHERE expires_at < ?", (epoch(),))
    db.insert("oauth_codes", {"code_hash": digest(code), "client_id": client["client_id"], "rep_id": rep["id"],
                              "redirect_uri": params["redirect_uri"], "code_challenge": params["code_challenge"],
                              "resource": params["resource"], "expires_at": epoch() + CODE_SECS})
    db.conn.commit()
    session.pop("oauth_csrf", None)
    return back_to_client(params, code=code)


# ---------- tokens ----------

def client_credentials():
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("basic "):
        try:
            raw = base64.b64decode(header[6:]).decode()
            cid, _, secret = raw.partition(":")
            return urllib.parse.unquote(cid), urllib.parse.unquote(secret)
        except (ValueError, UnicodeDecodeError):
            return "", ""
    return request.values.get("client_id", ""), request.values.get("client_secret", "")


def authenticate_client(db):
    cid, secret = client_credentials()
    client = find_client(db, cid)
    if not client:
        return None
    if client["secret_hash"] and not hmac.compare_digest(digest(secret or ""), client["secret_hash"]):
        return None
    return client


def issue_tokens(db, client, rep_id, resource, granted_at=None):
    rep = core.auth_info()["reps"].get(rep_id)
    if not rep or not rep["active"]:
        return oauth_error("invalid_grant", "This rep can no longer sign in.")
    family = secrets.token_hex(12)
    access, refresh = "pssa_" + secrets.token_urlsafe(32), "pssr_" + secrets.token_urlsafe(32)
    common = {"client_id": client["client_id"], "client_name": client["client_name"], "rep_id": rep_id,
              "pw_fp": rep["pw_fp"], "resource": resource, "family": family,
              "granted_at": granted_at or epoch(), "created_at": epoch()}
    db.insert("oauth_tokens", {**common, "token_hash": digest(access), "kind": "access",
                               "expires_at": epoch() + ACCESS_SECS})
    db.insert("oauth_tokens", {**common, "token_hash": digest(refresh), "kind": "refresh",
                               "expires_at": epoch() + REFRESH_SECS})
    db.execute("DELETE FROM oauth_tokens WHERE expires_at < ?", (epoch(),))
    db.conn.commit()
    return no_store(jsonify({"access_token": access, "token_type": "Bearer", "expires_in": ACCESS_SECS,
                             "refresh_token": refresh, "scope": SCOPE}))


def token():
    db = core.get_db()
    client = authenticate_client(db)
    if not client:
        return oauth_error("invalid_client", "Unknown client or wrong client secret.", 401)
    grant = request.values.get("grant_type")
    if grant == "authorization_code":
        code = request.values.get("code", "")
        row = db.execute("SELECT * FROM oauth_codes WHERE code_hash = ?", (digest(code),)).fetchone()
        if row:
            db.execute("DELETE FROM oauth_codes WHERE code_hash = ?", (row["code_hash"],))  # one use only
            db.conn.commit()
        if not row or row["expires_at"] < epoch() or row["client_id"] != client["client_id"]:
            return oauth_error("invalid_grant", "That sign-in code is invalid or expired.")
        if request.values.get("redirect_uri") and request.values["redirect_uri"] != row["redirect_uri"]:
            return oauth_error("invalid_grant", "redirect_uri doesn't match.")
        verifier = request.values.get("code_verifier", "")
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        if not 43 <= len(verifier) <= 128 or not hmac.compare_digest(expected, row["code_challenge"]):
            return oauth_error("invalid_grant", "PKCE check failed.")
        return issue_tokens(db, client, row["rep_id"], row["resource"] or request.values.get("resource", ""))
    if grant == "refresh_token":
        presented = request.values.get("refresh_token", "")
        row = db.execute("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'",
                         (digest(presented),)).fetchone()
        if not row or row["expires_at"] < epoch() or row["client_id"] != client["client_id"]:
            return oauth_error("invalid_grant", "Please sign in to PSS Connect again.")
        rep = core.auth_info()["reps"].get(row["rep_id"])
        db.execute("DELETE FROM oauth_tokens WHERE family = ?", (row["family"],))  # rotate
        db.conn.commit()
        if not rep or not rep["active"] or rep["pw_fp"] != row["pw_fp"]:
            return oauth_error("invalid_grant", "Your PSS Connect password changed. Please sign in again.")
        return issue_tokens(db, client, row["rep_id"], row["resource"], granted_at=row["granted_at"])
    return oauth_error("unsupported_grant_type", "Use authorization_code or refresh_token.")


def revoke():
    db = core.get_db()
    if authenticate_client(db):
        row = db.execute("SELECT family FROM oauth_tokens WHERE token_hash = ?",
                         (digest(request.values.get("token", "")),)).fetchone()
        if row:
            db.execute("DELETE FROM oauth_tokens WHERE family = ?", (row["family"],))
            db.conn.commit()
    return no_store(Response(status=200))


def bearer_caller():
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    db = core.get_db()
    row = db.execute("SELECT rep_id, pw_fp, client_name, expires_at FROM oauth_tokens "
                     "WHERE token_hash = ? AND kind = 'access'", (digest(header[7:].strip()),)).fetchone()
    db.conn.commit()  # don't hold a transaction open while the tools run
    if not row or row["expires_at"] < epoch():
        return None
    rep = core.auth_info()["reps"].get(row["rep_id"])
    if not rep or not rep["active"] or rep["pw_fp"] != row["pw_fp"]:
        return None  # deactivated, or the password changed: sign in again
    return {"rep_id": rep["id"], "pw_fp": rep["pw_fp"], "via": via_label(row["client_name"])}


def unauthorized(error=""):
    meta = base_url() + "/.well-known/oauth-protected-resource/mcp"
    challenge = f'Bearer resource_metadata="{meta}", scope="{SCOPE}"'
    if error:
        challenge += f', error="{error}"'
    resp = jsonify({"error": "Sign in to PSS Connect first."})
    resp.headers["WWW-Authenticate"] = challenge
    return resp, 401


# ---------- calling the app's own API as the rep ----------

def api(method, path, body=None):
    """Runs one of the app's API routes as the signed-in rep. Returns (status, json)."""
    with core.app.test_client() as client:
        resp = client.open(path, method=method, json=body)
        try:
            data = json.loads(resp.get_data(as_text=True) or "null")
        except ValueError:
            data = None
    return resp.status_code, data


def api_ok(method, path, body=None):
    status, data = api(method, path, body)
    if status >= 400:
        message = (data or {}).get("error") if isinstance(data, dict) else ""
        raise ToolError(message or f"PSS Connect returned an error ({status}).")
    return data


# ---------- reading the map ----------

def load_map(db):
    nodes = {r["id"]: dict(r) for r in db.execute(
        "SELECT id, type, name, title, company_id, email, phone, location, tags, owner_rep, notes, stage, "
        "priority, wingmate_id, created_at, updated_at, updated_by FROM nodes")}
    return nodes


def brief(n, nodes):
    out = {"id": n["id"], "type": "contact" if n["type"] == "person" else "company", "name": n["name"]}
    company = nodes.get(n["company_id"]) if n["company_id"] else None
    if n["type"] == "person":
        if n["title"]:
            out["title"] = n["title"]
        if company:
            out["company"], out["company_id"] = company["name"], company["id"]
        if n["stage"]:
            out["stage"] = n["stage"]
        if n["priority"]:
            out["high_priority"] = True
    for field in ("email", "phone", "location"):
        if n[field]:
            out[field] = n[field]
    if n["type"] == "company" and n["tags"]:
        out["tags"] = [t.strip() for t in n["tags"].split(",") if t.strip()]
    if n.get("off_map"):
        out["on_map"] = False
    out["owner"] = n["owner_rep"] or "unassigned"
    if n["wingmate_id"]:
        out["from_wingmate"] = True
    return out


def me():
    rep = core.current_rep()
    if not rep:
        raise ToolError("Not signed in.")
    return rep


def resolve_rep(db, name):
    """An owner name as the assistant gave it -> the rep's exact name ('' = unassigned)."""
    name = str(name or "").strip()
    if name.lower() in ("", "unassigned", "none", "nobody"):
        return ""
    if name.lower() in ("me", "myself"):
        return me()["name"]
    reps = [r["name"] for r in db.execute("SELECT name FROM reps WHERE active = 1")]
    exact = [r for r in reps if r.lower() == name.lower()]
    loose = exact or [r for r in reps if r.lower().startswith(name.lower()) or name.lower() in r.lower().split()]
    if len(loose) != 1:
        raise ToolError(f"No single rep matches “{name}”. Reps: {', '.join(sorted(reps))}.")
    return loose[0]


def tool_overview(args):
    db = core.get_db()
    rep = me()
    nodes = load_map(db)
    companies = [n for n in nodes.values() if n["type"] == "company"]
    people = [n for n in nodes.values() if n["type"] == "person"]
    stages = {}
    for p in people:
        if p["stage"].strip():
            stages[p["stage"].strip()] = stages.get(p["stage"].strip(), 0) + 1
    transfers = [dict(r) for r in db.execute("SELECT * FROM transfer_requests WHERE status = 'pending'")]
    mine_in = [t for t in transfers if t["from_rep"] == rep["name"] or (rep["is_admin"] and not t["from_rep"])]
    mine_out = [t for t in transfers if t["to_rep"] == rep["name"]]
    pipelines = core.wingmate_pipelines(db)
    return {
        "you": {"name": rep["name"], "email": rep["email"], "admin": bool(rep["is_admin"])},
        "totals": {"companies": len(companies), "contacts": len(people),
                   "your_companies": sum(1 for n in companies if n["owner_rep"] == rep["name"]),
                   "your_contacts": sum(1 for n in people if n["owner_rep"] == rep["name"]),
                   "unassigned": sum(1 for n in nodes.values() if not n["owner_rep"]),
                   "connections": db.execute("SELECT COUNT(*) AS c FROM edges").fetchone()["c"]},
        "reps": [r["name"] for r in db.execute("SELECT name FROM reps WHERE active = 1 ORDER BY name")],
        "company_tags_in_use": sorted(core.known_tags(db).values(), key=str.lower),
        "stages_in_use": dict(sorted(stages.items(), key=lambda kv: -kv[1])),
        "relationship_types": list(core.REL_TYPES),
        "transfer_requests_waiting_for_you": [
            {"id": t["id"], "lead": nodes.get(t["node_id"], {}).get("name", "?"), "lead_id": t["node_id"],
             "requested_by": t["to_rep"], "reason": t["reason"]} for t in mine_in],
        "your_pending_requests": [{"id": t["id"], "lead": nodes.get(t["node_id"], {}).get("name", "?"),
                                   "owner": t["from_rep"] or "unassigned"} for t in mine_out],
        "wingmate": {"connected": bool(pipelines),
                     "pipelines": [(p.get("name") or p["campaign_id"]) + (f" (all contacts; on the map from {p['from_stage']} on)" if p.get("from_stage") else "")
                                   for p, _ in pipelines]},
        "app_url": base_url(),
    }


def tool_search(args):
    db = core.get_db()
    nodes = load_map(db)
    words = str(args.get("query") or "").lower().split()
    kind = {"contact": "person", "person": "person", "company": "company"}.get(str(args.get("type") or "").lower())
    owner = args.get("owner")
    owner = resolve_rep(db, owner) if owner not in (None, "") else None
    tag, city = str(args.get("tag") or "").strip().lower(), str(args.get("city") or "").strip().lower()
    stage = str(args.get("stage") or "").strip().lower()
    company_id = core.to_int(args.get("company_id"))
    limit = min(100, max(1, core.to_int(args.get("limit")) or 25))
    hits = []
    for n in nodes.values():
        company = nodes.get(n["company_id"]) if n["company_id"] else None
        if kind and n["type"] != kind:
            continue
        if owner is not None and n["owner_rep"] != owner:
            continue
        if company_id and n["company_id"] != company_id and n["id"] != company_id:
            continue
        tags = (n["tags"] if n["type"] == "company" else (company or {}).get("tags", "")).lower()
        if tag and tag not in [t.strip() for t in tags.split(",")]:
            continue
        if city and city not in (n["location"] + " " + (company or {}).get("location", "")).lower():
            continue
        if stage and n["stage"].strip().lower() != stage:
            continue
        if args.get("high_priority") and not n["priority"]:
            continue
        hay = " ".join([n["name"], n["title"], n["email"], n["phone"], n["location"], n["stage"], n["notes"],
                        n["owner_rep"], tags, (company or {}).get("name", "")]).lower()
        if all(w in hay for w in words):
            hits.append(n)
    # Name matches first, then the most recently edited.
    hits.sort(key=lambda n: n["updated_at"], reverse=True)
    hits.sort(key=lambda n: not (words and all(w in n["name"].lower() for w in words)))
    return {"total": len(hits), "showing": min(limit, len(hits)), "results": [brief(n, nodes) for n in hits[:limit]]}


def edges_of(db, node_id):
    return [dict(e) for e in db.execute("SELECT * FROM edges WHERE source_id = ? OR target_id = ?", (node_id, node_id))]


def tool_get_record(args):
    db = core.get_db()
    rep = me()
    nodes = load_map(db)
    n = nodes.get(core.to_int(args.get("id")))
    if not n:
        raise ToolError("No record with that id. Use search_records to find it.")
    out = brief(n, nodes)
    if n["notes"]:
        out["about"] = n["notes"]
    out["you_can_edit"] = bool(rep["is_admin"]) or n["owner_rep"] == rep["name"]
    out["last_edited"] = f"{n['updated_at'][:10]} by {n['updated_by'] or '?'}"
    if n["type"] == "company":
        staff = sorted((p for p in nodes.values() if p["type"] == "person" and p["company_id"] == n["id"]),
                       key=lambda p: p["name"].lower())
        out["contacts"] = [brief(p, nodes) for p in staff]
    connections = []
    for e in edges_of(db, n["id"]):
        other = nodes.get(e["target_id"] if e["source_id"] == n["id"] else e["source_id"])
        if not other:
            continue
        rel = e["rel_type"].replace("_", " ")
        if e["rel_type"] in ("reports_to", "referred"):
            rel = f"{rel} →" if e["source_id"] == n["id"] else f"← {rel}"
        item = {"connection_id": e["id"], "relationship": rel, "strength": e["strength"],
                "with": brief(other, nodes), "added_by": e["created_by"]}
        if e["notes"]:
            item["notes"] = e["notes"]
        connections.append(item)
    out["connections"] = connections
    notes = db.execute("SELECT body, author, created_at FROM notes WHERE node_id = ? ORDER BY created_at DESC LIMIT 50",
                       (n["id"],)).fetchall()
    out["notes"] = [{"date": r["created_at"][:10], "author": r["author"], "text": r["body"]} for r in notes]
    pending = db.execute("SELECT to_rep, reason FROM transfer_requests WHERE node_id = ? AND status = 'pending'",
                         (n["id"],)).fetchall()
    if pending:
        out["pending_transfer_requests"] = [dict(r) for r in pending]
    return out


def tool_path(args):
    db = core.get_db()
    nodes = load_map(db)
    start, goal = core.to_int(args.get("from_id")), core.to_int(args.get("to_id"))
    if start not in nodes or goal not in nodes:
        raise ToolError("Both ids must be records in PSS Connect.")
    links = {}

    def link(a, b, label):
        links.setdefault(a, []).append((b, label))
        links.setdefault(b, []).append((a, label))
    for e in db.execute("SELECT source_id, target_id, rel_type FROM edges"):
        link(e["source_id"], e["target_id"], e["rel_type"].replace("_", " "))
    for n in nodes.values():
        if n["type"] == "person" and n["company_id"] in nodes:
            link(n["id"], n["company_id"], "works at")
    previous, queue = {start: None}, deque([start])
    while queue and goal not in previous:
        here = queue.popleft()
        for there, label in links.get(here, []):
            if there not in previous:
                previous[there] = (here, label)
                queue.append(there)
    if goal not in previous:
        return {"connected": False, "message": f"No chain of connections links {nodes[start]['name']} "
                                               f"and {nodes[goal]['name']} yet."}
    steps, at = [], goal
    while previous[at]:
        before, label = previous[at]
        steps.append({"from": nodes[before]["name"], "relationship": label, "to": nodes[at]["name"]})
        at = before
    steps.reverse()
    return {"connected": True, "hops": len(steps), "path": steps}


def tool_activity(args):
    limit = min(100, max(1, core.to_int(args.get("limit")) or 20))
    rows = core.get_db().execute("SELECT ts, actor, summary FROM activity ORDER BY id DESC LIMIT ?", (limit,))
    return {"activity": [{"when": r["ts"][:16].replace("T", " ") + " UTC", "who": r["actor"], "what": r["summary"]}
                         for r in rows]}


# ---------- adding and editing ----------

def find_company(db, name):
    target = core.norm_name(name, True)
    for r in db.execute("SELECT id, name FROM nodes WHERE type = 'company' ORDER BY id"):
        if core.norm_name(r["name"], True) == target:
            return dict(r)
    return None


def created(db, record, message=None):
    nodes = load_map(db)
    out = {"ok": True, "record": brief(nodes[record["id"]], nodes)}
    if message:
        out["note"] = message
    return out


def duplicate_result(data, what):
    return {"ok": False, "possible_duplicates": data.get("duplicates", []),
            "message": f"This {what} may already be in PSS Connect. Check with the rep; use the existing record, "
                       f"or call again with allow_duplicate=true if it's genuinely a different {what}."}


def owner_value(db, args):
    """Admins may assign an owner; reps' new records are always their own."""
    if "owner" not in args or args.get("owner") is None:
        return me()["name"]
    return resolve_rep(db, args["owner"])


def tool_add_company(args):
    db = core.get_db()
    body = {"type": "company", "name": args.get("name"), "location": args.get("location") or "",
            "notes": args.get("about") or "", "tags": ", ".join(as_list(args.get("tags"))),
            "allow_duplicate": bool(args.get("allow_duplicate"))}
    if me()["is_admin"]:
        body["owner_rep"] = owner_value(db, args)
    status, data = api("POST", "/api/nodes", body)
    if status == 409:
        return duplicate_result(data, "company")
    if status >= 400:
        raise ToolError((data or {}).get("error") or "Couldn't add the company.")
    return created(db, data)


def tool_add_contact(args):
    db = core.get_db()
    notes = []
    company_id = core.to_int(args.get("company_id"))
    company_name = str(args.get("company") or "").strip()
    if company_id is None and company_name:
        company = find_company(db, company_name)
        if company:
            company_id = company["id"]
        else:
            body = {"type": "company", "name": company_name, "allow_duplicate": True}
            if me()["is_admin"]:
                body["owner_rep"] = owner_value(db, args)
            company_id = api_ok("POST", "/api/nodes", body)["id"]
            notes.append(f"Also added the company {company_name}.")
    body = {"type": "person", "name": args.get("name"), "company_id": company_id,
            "allow_duplicate": bool(args.get("allow_duplicate"))}
    for field, column in (("title", "title"), ("email", "email"), ("phone", "phone"),
                          ("location", "location"), ("stage", "stage"), ("about", "notes")):
        if args.get(field):
            body[column] = args[field]
    if me()["is_admin"]:
        body["owner_rep"] = owner_value(db, args)
    status, data = api("POST", "/api/nodes", body)
    if status == 409:
        return duplicate_result(data, "contact")
    if status >= 400:
        raise ToolError((data or {}).get("error") or "Couldn't add the contact.")
    if args.get("high_priority"):
        api_ok("POST", f"/api/nodes/{data['id']}/display", {"priority": True})
    return created(db, data, " ".join(notes) or None)


def tool_update(args):
    db = core.get_db()
    node_id = core.to_int(args.get("id"))
    body = {}
    for field, column in (("name", "name"), ("title", "title"), ("email", "email"), ("phone", "phone"),
                          ("location", "location"), ("stage", "stage"), ("about", "notes")):
        if args.get(field) is not None:
            body[column] = args[field]
    if args.get("owner") is not None:
        body["owner_rep"] = resolve_rep(db, args["owner"])
    if args.get("allow_duplicate"):
        body["allow_duplicate"] = True
    move = None
    if args.get("company_id") is not None:
        move = {"company_id": args["company_id"]}
    elif args.get("company") is not None:
        name = str(args["company"]).strip()
        move = {"company_name": name} if name and name.lower() not in ("none", "no company") else {"remove": True}
    if args.get("on_map") is not None:
        data = api_ok("POST", f"/api/nodes/{node_id}/display", {"on_map": bool(args["on_map"])})
        if not body and move is None:
            return created(db, data)
    if not body and move is None:
        raise ToolError("Nothing to change.")
    data = None
    if move is not None:
        # Moves go through their own route so the contact keeps a note of where they were.
        data = api_ok("POST", f"/api/nodes/{node_id}/company", move)
    if not body:
        return created(db, data)
    status, data = api("PATCH", f"/api/nodes/{node_id}", body)
    if status == 409:
        return duplicate_result(data, "record")
    if status >= 400:
        raise ToolError((data or {}).get("error") or "Couldn't update that record.")
    return created(db, data)


def tool_add_note(args):
    node_id = core.to_int(args.get("id"))
    api_ok("POST", f"/api/nodes/{node_id}/notes", {"body": args.get("text")})
    return {"ok": True, "added_note_to": core.node_name(core.get_db(), node_id)}


def as_list(value):
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(v).strip() for v in value or [] if str(v).strip()]


def tool_tags(args):
    node_id = core.to_int(args.get("id"))
    data = None
    for tag in as_list(args.get("add")):
        data = api_ok("POST", f"/api/nodes/{node_id}/tags", {"add": tag})
    for tag in as_list(args.get("remove")):
        data = api_ok("POST", f"/api/nodes/{node_id}/tags", {"remove": tag})
    if data is None:
        raise ToolError("Give tags to add or remove.")
    return {"ok": True, "company": data["name"], "tags": as_list(data["tags"])}


def tool_connect(args):
    db = core.get_db()
    source, target = core.to_int(args.get("from_id")), core.to_int(args.get("to_id"))
    rel = str(args.get("relationship") or "knows").strip().lower().replace(" ", "_")
    for e in edges_of(db, source or 0):
        if {e["source_id"], e["target_id"]} == {source, target} and e["rel_type"] == rel:
            return {"ok": True, "already_connected": True, "connection_id": e["id"]}
    body = {"source_id": source, "target_id": target, "rel_type": rel}
    if args.get("strength") is not None:
        body["strength"] = args["strength"]
    if args.get("notes"):
        body["notes"] = args["notes"]
    edge = api_ok("POST", "/api/edges", body)
    return {"ok": True, "connection_id": edge["id"],
            "connected": f"{core.node_name(db, source)} → {core.node_name(db, target)} ({rel.replace('_', ' ')})"}


def tool_priority(args):
    node_id = core.to_int(args.get("id"))
    data = api_ok("POST", f"/api/nodes/{node_id}/display", {"priority": bool(args.get("high_priority", True))})
    return {"ok": True, "contact": data["name"], "high_priority": bool(data["priority"])}


def tool_transfer(args):
    node_id = core.to_int(args.get("id"))
    data = api_ok("POST", f"/api/nodes/{node_id}/transfer-request", {"reason": args.get("reason") or ""})
    owner = data["from_rep"] or "an admin"
    return {"ok": True, "message": f"Asked {owner} for {core.node_name(core.get_db(), node_id)}. "
                                   f"They'll see it under Requests in PSS Connect."}


# ---------- bulk add ----------

BULK_MAX = 500


def plan_bulk(db, rows):
    rep = me()
    nodes = load_map(db)
    companies = {}
    for n in sorted(nodes.values(), key=lambda n: n["id"]):
        if n["type"] == "company":
            companies.setdefault(core.norm_name(n["name"], True), n)
    people, emails = {}, {}
    for n in nodes.values():
        if n["type"] == "person":
            company = nodes.get(n["company_id"]) if n["company_id"] else None
            key = (core.norm_name(n["name"]), core.norm_name(company["name"], True) if company else "")
            people.setdefault(key, n)
            if n["email"].strip():
                emails.setdefault(n["email"].strip().lower(), n)
    plan, new_companies, batch_keys, batch_emails = [], {}, set(), set()
    for i, row in enumerate(rows, 1):
        row = row if isinstance(row, dict) else {}
        name = " ".join(str(row.get("name") or "").split())[:300]
        company = " ".join(str(row.get("company") or "").split())[:300]
        email = str(row.get("email") or "").strip()[:300]
        entry = {"row": i, "name": name or "(no name)"}
        if company:
            entry["company"] = company
        if not name:
            plan.append({**entry, "action": "problem", "reason": "No name"})
            continue
        ckey = core.norm_name(company, True) if company else ""
        key = (core.norm_name(name), ckey)
        existing = people.get(key) or (emails.get(email.lower()) if email else None)
        if existing:
            plan.append({**entry, "action": "skip", "reason": f"Already in PSS Connect (id {existing['id']}, "
                                                             f"owner {existing['owner_rep'] or 'unassigned'})"})
            continue
        if key in batch_keys or (email and email.lower() in batch_emails):
            plan.append({**entry, "action": "skip", "reason": "Listed twice in this upload"})
            continue
        owner = rep["name"]
        if row.get("owner") not in (None, "") and rep["is_admin"]:
            try:
                owner = resolve_rep(db, row["owner"])
            except ToolError as e:
                plan.append({**entry, "action": "problem", "reason": str(e)})
                continue
        batch_keys.add(key)
        if email:
            batch_emails.add(email.lower())
        if ckey and ckey not in companies and ckey not in new_companies:
            new_companies[ckey] = {"name": company, "owner": owner}
            entry["new_company"] = True
        plan.append({**entry, "action": "add", "owner": owner or "unassigned", "_row": row, "_ckey": ckey})
    return plan, companies, new_companies


def tool_bulk(args):
    rows = args.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ToolError("Send the contacts as a list of rows.")
    if len(rows) > BULK_MAX:
        raise ToolError(f"That's {len(rows)} rows; send at most {BULK_MAX} at a time.")
    db = core.get_db()
    plan, companies, new_companies = plan_bulk(db, rows)
    adds = [p for p in plan if p["action"] == "add"]
    public = [{k: v for k, v in p.items() if not k.startswith("_")} for p in plan]
    summary = {"will_add" if not args.get("confirm") else "added": len(adds),
               "new_companies": [c["name"] for c in new_companies.values()],
               "skipped_duplicates": sum(1 for p in plan if p["action"] == "skip"),
               "problems": sum(1 for p in plan if p["action"] == "problem")}
    if not args.get("confirm"):
        return {"preview": True, **summary, "rows": public[:200],
                "next_step": "Nothing was saved. Show the rep this preview; if they agree, call bulk_add_contacts "
                             "again with the same rows and confirm=true."}

    ts, who = core.now(), core.actor()
    company_ids = {k: v["id"] for k, v in companies.items()}
    for ckey, c in new_companies.items():
        company_ids[ckey] = db.insert("nodes", {"type": "company", "name": c["name"], "owner_rep": c["owner"],
                                                "created_at": ts, "updated_at": ts, "updated_by": who})
    known = core.known_tags(db)
    for p in adds:
        row = p["_row"]
        values, err = core.clean_node_fields(db, {
            "name": p["name"], "title": row.get("title") or "", "email": row.get("email") or "",
            "phone": row.get("phone") or "", "location": row.get("location") or "",
            "stage": row.get("stage") or "", "notes": row.get("about") or ""}, "person")
        if err:
            p.update(action="problem", reason=err)
            continue
        cid = company_ids.get(p["_ckey"]) if p["_ckey"] else None
        values.update(type="person", company_id=cid, owner_rep="" if p["owner"] == "unassigned" else p["owner"],
                      priority=1 if row.get("high_priority") else 0, created_at=ts, updated_at=ts, updated_by=who)
        p["id"] = db.insert("nodes", values)
        tags = as_list(row.get("tags"))
        if cid and tags:
            current = db.execute("SELECT tags FROM nodes WHERE id = ?", (cid,)).fetchone()["tags"]
            db.execute("UPDATE nodes SET tags = ? WHERE id = ?",
                       (core.join_tags(db, as_list(current) + tags, known), cid))
    added = sum(1 for p in adds if "id" in p)
    if added or new_companies:
        people_word = "contact" if added == 1 else "contacts"
        company_word = "company" if len(new_companies) == 1 else "companies"
        core.log(db, "import", f"Added {added} {people_word} and {len(new_companies)} {company_word} in bulk")
        core.bump_version(db)
    db.commit()
    summary["added"] = added
    return {"ok": True, **summary,
            "rows": [{k: v for k, v in p.items() if not k.startswith("_")} for p in plan][:200]}


# ---------- Wingmate (read-only, live) ----------

_wm_cache = {"key": None, "at": 0.0, "data": None}
_wm_lock = threading.Lock()
WM_CACHE_SECS = 300


def wingmate_data(db):
    """Leads, contacts and users from every connected pipeline. Returns (client for each
    lead id, data); each lead is tagged with its pipeline's name."""
    pipelines = core.wingmate_pipelines(db)
    if not pipelines:
        raise ToolError("Wingmate isn't connected to PSS Connect. An admin connects it under ⚙ → Wingmate.")
    key = tuple(sorted(c.campaign_id for _, c in pipelines))
    with _wm_lock:
        cached = _wm_cache["data"] if _wm_cache["key"] == key and time.time() - _wm_cache["at"] < WM_CACHE_SECS else None
    if cached:
        return cached
    users, leads, contacts, client_for_lead = {}, [], [], {}
    for settings, client in pipelines:
        cid = client.campaign_id
        try:
            users.update({str(u.get("id")): u for u in client.get_all(f"/campaigns/{cid}/users")})
            batch = client.get_all(f"/campaigns/{cid}/leads")
            contacts += client.get_all(f"/campaigns/{cid}/contacts")
        except wingmate.WingmateError as e:
            raise ToolError(str(e)) from None
        for lead in batch:
            lead["_pipeline"] = settings.get("name") or cid
            client_for_lead[str(lead.get("id"))] = client
            for user in (lead.get("owners") or []) + [lead.get("worker")]:
                if isinstance(user, dict) and user.get("id") is not None:
                    users.setdefault(str(user["id"]), user)
        leads += batch
    result = (client_for_lead, {"users": users, "leads": leads, "contacts": contacts})
    with _wm_lock:
        _wm_cache.update(key=key, at=time.time(), data=result)
    return result


def wm_user(data, user_id):
    user = data["users"].get(user_id) or {}
    return wingmate.text(user.get("full_name") or user.get("name")) or ""


def wm_owners(data, lead):
    ids = lead.get("owner_ids") if isinstance(lead.get("owner_ids"), list) else [lead.get("owner_ids")]
    names = [wm_user(data, wingmate.first_id(i)) for i in ids if wingmate.first_id(i)]
    if not names and wingmate.first_id(lead.get("worker_id")):
        names = [wm_user(data, wingmate.first_id(lead.get("worker_id")))]
    return [n for n in names if n]


def wm_contact(contact):
    out = {"name": wingmate.text(contact.get("name"))}
    email = wingmate.text(contact.get("email"))
    phone = wingmate.text(contact.get("phone") or contact.get("phone_number")) \
        or wingmate.custom_value(contact, "phone", "mobile", "cell")
    if email:
        out["email"] = email
    if phone:
        out["phone"] = phone
    if contact.get("primary_contact"):
        out["primary"] = True
    return out


def pss_links(db):
    links = {r["wingmate_id"]: r["id"] for r in db.execute("SELECT id, wingmate_id FROM nodes WHERE wingmate_id <> ''")}
    for r in db.execute("SELECT ref, node_id FROM wingmate_aliases"):
        links.setdefault(r["ref"], r["node_id"])
    return links


def wm_lead_brief(db, data, lead, contacts, links):
    lead_id = str(lead.get("id"))
    _, address = wingmate.address_parts(lead)
    out = {"lead_id": lead_id, "name": wingmate.text(lead.get("name")), "pipeline": lead.get("_pipeline", ""),
           "status": wingmate.text(lead.get("status_string")), "address": address,
           "owners": wm_owners(data, lead), "contacts": [wm_contact(c) for c in contacts],
           "last_activity": wingmate.text(lead.get("actioned_at"))[:10],
           "created": wingmate.text(lead.get("created_at"))[:10]}
    description = wingmate.text(lead.get("description"), 500)
    if description:
        out["description"] = description
    if links.get(f"lead:{lead_id}"):
        out["pss_connect_id"] = links[f"lead:{lead_id}"]
    return {k: v for k, v in out.items() if v not in ("", [], None)}


def contacts_by_lead(data):
    grouped = {}
    for c in data["contacts"]:
        grouped.setdefault(str(c.get("lead_id")), []).append(c)
    return grouped


def tool_wm_search(args):
    db = core.get_db()
    _, data = wingmate_data(db)
    words = str(args.get("query") or "").lower().split()
    status = str(args.get("status") or "").strip().lower()
    owner = str(args.get("owner") or "").strip().lower()
    limit = min(50, max(1, core.to_int(args.get("limit")) or 20))
    grouped, links = contacts_by_lead(data), pss_links(db)
    hits = []
    for lead in data["leads"]:
        contacts = grouped.get(str(lead.get("id")), [])
        if status and status not in wingmate.text(lead.get("status_string")).lower():
            continue
        if owner and not any(owner in o.lower() for o in wm_owners(data, lead)):
            continue
        hay = " ".join([wingmate.text(lead.get("name")), wingmate.address_parts(lead)[1],
                        wingmate.text(lead.get("description"), 2000), wingmate.text(lead.get("status_string"))]
                       + [" ".join(str(v) for v in wm_contact(c).values()) for c in contacts]).lower()
        if all(w in hay for w in words):
            hits.append((wingmate.text(lead.get("actioned_at")), lead, contacts))
    hits.sort(key=lambda h: h[0], reverse=True)
    statuses = {}
    for lead in data["leads"]:
        s = wingmate.text(lead.get("status_string"))
        if s:
            statuses[s] = statuses.get(s, 0) + 1
    return {"pipeline": core.get_setting(db, "wingmate_campaign_name"), "total": len(hits),
            "showing": min(limit, len(hits)), "statuses_in_pipeline": statuses,
            "results": [wm_lead_brief(db, data, lead, contacts, links) for _, lead, contacts in hits[:limit]]}


def tool_wm_lead(args):
    db = core.get_db()
    clients, data = wingmate_data(db)
    lead_id = str(args.get("lead_id") or "").strip()
    lead = next((l for l in data["leads"] if str(l.get("id")) == lead_id), None)
    if not lead:
        raise ToolError("No lead with that id in the connected Wingmate pipelines. Use search_wingmate.")
    client = clients[lead_id]
    out = wm_lead_brief(db, data, lead, contacts_by_lead(data).get(lead_id, []), pss_links(db))
    try:
        comments = client.get_all(f"/leads/{lead_id}/comments")
    except wingmate.WingmateError as e:
        comments, out["comments_error"] = [], str(e)
    notes = []
    for c in comments:
        body = wingmate.text(c.get("text") or c.get("body") or c.get("comment"), 3000)
        if not body:
            continue
        user = c.get("user") if isinstance(c.get("user"), dict) else {}
        author = wingmate.text(user.get("full_name") or user.get("name")) \
            or wm_user(data, wingmate.first_id(c.get("user_id")))
        notes.append({"date": wingmate.as_iso(c.get("created_at"))[:10], "author": author,
                      "kind": wingmate.comment_label(c), "text": body})
    notes.sort(key=lambda n: n["date"], reverse=True)
    out["comments"] = [{k: v for k, v in n.items() if v} for n in notes[:50]]
    return out


# ---------- tool catalog ----------

def schema(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


S = {"type": "string"}
INT = {"type": "integer"}
ID = {"type": "integer", "description": "PSS Connect record id (from search_records)."}
TAGS = {"type": "array", "items": {"type": "string"}}
OWNER = {"type": "string", "description": "Admins only: rep to assign it to (a rep's name, or 'unassigned'). "
                                          "Reps' new records are always their own."}
CONTACT_FIELDS = {
    "title": S, "email": S, "phone": S, "location": {"type": "string", "description": "City, ST"},
    "stage": {"type": "string", "description": "Pipeline stage, e.g. 'Meeting Set'. See pss_overview for stages in use."},
    "about": {"type": "string", "description": "Background about this contact (the card's About field). "
                                               "For dated updates use add_note instead."},
}

READ = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
WRITE = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}
WRITE_SAME = {**WRITE, "idempotentHint": True}
WINGMATE = {**READ, "openWorldHint": True}
REL_TYPES = ("knows", "reports_to", "referred", "partner", "vendor", "competitor", "other")  # as in app.py

TOOLS = [
    ("pss_overview", "Overview", READ, tool_overview,
     "Who the signed-in rep is, team totals, the rep list, company tags and pipeline stages in use, "
     "relationship types, lead transfer requests waiting, and whether Wingmate is connected. "
     "Call this first in a conversation.", schema({})),
    ("search_records", "Search companies and contacts", READ, tool_search,
     "Search PSS Connect's companies and contacts. All filters are optional and combine. "
     "Matches words in name, title, email, phone, city, stage, About, owner, company name and tags.",
     schema({"query": S,
             "type": {"type": "string", "enum": ["company", "contact"]},
             "owner": {"type": "string", "description": "A rep's name, 'me', or 'unassigned'."},
             "tag": {"type": "string", "description": "Company tag; contacts match through their company."},
             "city": S, "stage": S,
             "high_priority": {"type": "boolean", "description": "Only high-priority contacts."},
             "company_id": {"type": "integer", "description": "Only this company and its contacts."},
             "limit": {"type": "integer", "minimum": 1, "maximum": 100}})),
    ("get_record", "Get a record", READ, tool_get_record,
     "Full card for one company or contact: details, About, the company's contacts, connections, "
     "notes (newest first), and whether the rep can edit it.", schema({"id": ID}, ["id"])),
    ("find_connection_path", "How are these connected?", READ, tool_path,
     "Shortest chain of connections (and who-works-where) linking two records, e.g. to find a warm intro.",
     schema({"from_id": ID, "to_id": ID}, ["from_id", "to_id"])),
    ("recent_activity", "Recent activity", READ, tool_activity,
     "The team's latest changes in PSS Connect (who added, edited, noted or connected what).",
     schema({"limit": {"type": "integer", "minimum": 1, "maximum": 100}})),
    ("add_company", "Add a company", WRITE, tool_add_company,
     "Add a company (account). Refuses likely duplicates and returns the matches.",
     schema({"name": S, "location": {"type": "string", "description": "City, ST"}, "tags": TAGS,
             "about": S, "owner": OWNER, "allow_duplicate": {"type": "boolean"}}, ["name"])),
    ("add_contact", "Add a contact", WRITE, tool_add_contact,
     "Add one contact (person). Give company_id, or a company name: an existing company with that name is "
     "used, otherwise the company is added too. Refuses likely duplicates and returns the matches. "
     "For several contacts at once use bulk_add_contacts.",
     schema({"name": S, "company": {"type": "string", "description": "Company name."},
             "company_id": {"type": "integer"}, **CONTACT_FIELDS,
             "high_priority": {"type": "boolean"}, "owner": OWNER, "allow_duplicate": {"type": "boolean"}},
            ["name"])),
    ("update_record", "Edit a record", WRITE, tool_update,
     "Change fields on a company or contact the rep owns (admins: any record, and the owner). "
     "Only the fields given change. For tags use update_company_tags; for dated updates use add_note.",
     schema({"id": ID, "name": S, **CONTACT_FIELDS,
             "company": {"type": "string", "description": "Move a contact to this company (e.g. they changed jobs). "
                                                         "An existing company with that name is used, otherwise it's added. "
                                                         "'none' takes them off their company. A note records the move."},
             "company_id": {"type": "integer"},
             "owner": {"type": "string", "description": "Admins only: reassign to this rep, or 'unassigned'."},
             "on_map": {"type": "boolean", "description": "Put the record on the map (true) or keep it saved but off "
                                                          "the map (false). Anyone can. A company takes its contacts with it."},
             "allow_duplicate": {"type": "boolean"}}, ["id"])),
    ("add_note", "Add a note", WRITE, tool_add_note,
     "Add a dated note to any company or contact (meeting recap, call summary, next steps). Anyone can.",
     schema({"id": ID, "text": S}, ["id", "text"])),
    ("update_company_tags", "Tag a company", WRITE_SAME, tool_tags,
     "Add or remove tags on any company (tags are for companies only). New tags join the shared tag list.",
     schema({"id": ID, "add": TAGS, "remove": TAGS}, ["id"])),
    ("connect_records", "Connect two records", WRITE, tool_connect,
     "Record a relationship between two records (any rep can connect anyone's records). "
     "reports_to and referred are directional: from_id reports to / referred to_id.",
     schema({"from_id": ID, "to_id": ID, "relationship": {"type": "string", "enum": list(REL_TYPES)},
             "strength": {"type": "integer", "minimum": 1, "maximum": 3, "description": "1 weak, 2 normal, 3 strong"},
             "notes": S}, ["from_id", "to_id"])),
    ("set_high_priority", "Flag high priority", WRITE_SAME, tool_priority,
     "Flag (or unflag) a contact as high priority. Anyone can.",
     schema({"id": ID, "high_priority": {"type": "boolean", "default": True}}, ["id"])),
    ("request_lead_transfer", "Request a lead", WRITE, tool_transfer,
     "Ask for a company or contact that belongs to another rep (or is unassigned). The owner or an admin "
     "approves it in PSS Connect.", schema({"id": ID, "reason": S}, ["id"])),
    ("bulk_add_contacts", "Add many contacts", WRITE, tool_bulk,
     "Add up to 500 contacts at once (from a pasted list, spreadsheet, CSV or business cards). Companies are "
     "matched by name or added. Duplicates already in PSS Connect are skipped. ALWAYS call with confirm=false "
     "first, show the rep the preview, and only call again with the same rows and confirm=true once they agree.",
     schema({"rows": {"type": "array", "maxItems": BULK_MAX, "items": schema({
         "name": S, "company": S, **CONTACT_FIELDS,
         "tags": {"type": "array", "items": {"type": "string"}, "description": "Tags for the contact's company."},
         "high_priority": {"type": "boolean"}, "owner": OWNER}, ["name"])},
             "confirm": {"type": "boolean", "description": "false = preview only (nothing saved); true = save."}},
            ["rows", "confirm"])),
    ("search_wingmate", "Search Wingmate", WINGMATE, tool_wm_search,
     "Search leads in the team's connected Wingmate pipeline, live (read-only): status, address, owners, "
     "contacts, last activity, and the matching PSS Connect record id if synced.",
     schema({"query": S, "status": S, "owner": {"type": "string", "description": "Wingmate user name."},
             "limit": {"type": "integer", "minimum": 1, "maximum": 50}})),
    ("get_wingmate_lead", "Wingmate lead details", WINGMATE, tool_wm_lead,
     "One Wingmate lead with its contacts and comments (newest first), live from Wingmate.",
     schema({"lead_id": S}, ["lead_id"])),
]
TOOL_BY_NAME = {t[0]: t for t in TOOLS}


def tool_list():
    return [{"name": name, "title": title, "description": description, "inputSchema": input_schema,
             "annotations": {"title": title, **hints}}
            for name, title, hints, _, description, input_schema in TOOLS]


def call_tool(name, args):
    tool = TOOL_BY_NAME.get(name)
    if not tool:
        return {"content": [{"type": "text", "text": f"Unknown tool {name}"}], "isError": True}
    try:
        result = tool[3](args if isinstance(args, dict) else {})
    except ToolError as e:
        return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    except Exception:
        core.app.logger.exception("Connector tool %s failed", name)
        core.get_db().conn.rollback()
        return {"content": [{"type": "text", "text": "Something went wrong in PSS Connect. Try again."}],
                "isError": True}
    return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=1)}],
            "structuredContent": result, "isError": False}


# ---------- the MCP endpoint (streamable HTTP, JSON responses, stateless) ----------

def rpc_result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def rpc_error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle(message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return rpc_error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid request")
    method, params = message["method"], message.get("params") or {}
    if "id" not in message:
        return None  # a notification
    msg_id = message["id"]
    if method == "initialize":
        asked = params.get("protocolVersion") if isinstance(params, dict) else None
        return rpc_result(msg_id, {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "pss-connect", "title": "PSS Connect", "version": SERVER_VERSION,
                           "websiteUrl": base_url()},
            "instructions": INSTRUCTIONS,
        })
    if method == "ping":
        return rpc_result(msg_id, {})
    if method == "tools/list":
        return rpc_result(msg_id, {"tools": tool_list()})
    if method == "tools/call":
        if not isinstance(params, dict) or not isinstance(params.get("name"), str):
            return rpc_error(msg_id, -32602, "Missing tool name")
        return rpc_result(msg_id, call_tool(params["name"], params.get("arguments") or {}))
    if method in ("resources/list", "prompts/list"):
        return rpc_result(msg_id, {method.split("/")[0]: []})
    return rpc_error(msg_id, -32601, f"Method not found: {method}")


def mcp():
    if request.method != "POST":
        return Response(status=405, headers={"Allow": "POST"})
    caller = bearer_caller()
    if not caller:
        return unauthorized("invalid_token" if request.headers.get("Authorization") else "")
    message = request.get_json(silent=True, force=True)
    if message is None:
        return jsonify(rpc_error(None, -32700, "Parse error")), 400
    token = core.ai_caller.set(caller)
    try:
        if isinstance(message, list):
            replies = [r for r in (handle(m) for m in message) if r is not None]
            return jsonify(replies) if replies else Response(status=202)
        reply = handle(message)
        return jsonify(reply) if reply is not None else Response(status=202)
    finally:
        core.ai_caller.reset(token)


# ---------- the rep's own view of connected assistants (account menu) ----------

def my_connections():
    rep = core.current_rep()
    if not rep:
        return core.bad("Sign in first", 403)
    db = core.get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM oauth_tokens WHERE rep_id = ?", (rep["id"],))
        core.log(db, "ai", "Disconnected their AI assistants")
        db.commit()
    rows = db.execute("SELECT client_name, MIN(granted_at) AS since FROM oauth_tokens WHERE rep_id = ? "
                      "AND kind = 'refresh' AND expires_at > ? GROUP BY client_name", (rep["id"], epoch())).fetchall()
    return jsonify({"url": resource_url(),
                    "connections": [{"name": via_label(r["client_name"]), "since": r["since"]} for r in rows]})


def install(app, module):
    global core
    core = module
    app.add_url_rule("/.well-known/oauth-protected-resource", view_func=protected_resource_metadata)
    app.add_url_rule("/.well-known/oauth-protected-resource/mcp", "protected_resource_metadata_mcp",
                     protected_resource_metadata)
    app.add_url_rule("/.well-known/oauth-authorization-server", view_func=authorization_server_metadata)
    app.add_url_rule("/.well-known/oauth-authorization-server/mcp", "authorization_server_metadata_mcp",
                     authorization_server_metadata)
    app.add_url_rule("/oauth/register", view_func=register_client, methods=["POST"])
    app.add_url_rule("/oauth/authorize", view_func=authorize, methods=["GET", "POST"])
    app.add_url_rule("/oauth/token", view_func=token, methods=["POST"])
    app.add_url_rule("/oauth/revoke", view_func=revoke, methods=["POST"])
    app.add_url_rule("/mcp", view_func=mcp, methods=["GET", "POST", "DELETE"])
    app.add_url_rule("/api/me/ai-connections", view_func=my_connections, methods=["GET", "DELETE"])
