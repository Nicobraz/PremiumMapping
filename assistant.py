"""
The AI assistant built into PSS Connect (the "Ask AI" side panel).

Reps chat with Claude inside the app; it uses the same tools as the Claude/ChatGPT
connector (connector.py) and works as the signed-in rep, under the same rules: they
change only their own records and nothing can be deleted. It runs on the team's
Anthropic API key (set by an admin in ⚙, or ANTHROPIC_API_KEY), so reps don't need
their own Claude or ChatGPT account.

Each rep has a running conversation stored in the database. Replies stream to the
browser as server-sent events.
"""

import base64
import hashlib
import json
import os
from datetime import datetime, timezone

import anthropic
from flask import Response, g, jsonify, request, stream_with_context

import connector

core = None  # the app module, set by install()

MODEL = "claude-sonnet-5-5"
EFFORT = "medium"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 64000
MAX_TOOL_ROUNDS = 15
DAILY_LIMIT = 150            # questions per rep per day, to keep the bill predictable
CHATS_KEPT = 10              # per rep
MAX_CHAT_BYTES = 1_500_000   # a conversation this big starts over
# $ per million tokens for Claude Sonnet 5.5 (cache writes are the 5-minute rate).
PRICES = {"input": 2.00, "output": 10.00, "cache_read": 0.20, "cache_write": 2.50}
CONTEXT_PREFIX = "[PSS Connect context]"
IMAGE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")

SYSTEM = connector.INSTRUCTIONS + """

You are the assistant built into the PSS Connect app, shown in a side panel next to the map
(often on a phone). Each message from the rep begins with a context line saying who is signed
in and today's date.

- Keep replies short and phone-friendly: plain sentences and short bullet lists. No tables or headings.
- When you mention a company or contact that is in PSS Connect, link it as [Name](#record-ID)
  using its id, so the rep can tap it to open the card.
- Photos (business cards, signs, whiteboards, screenshots): read them and offer to add the
  people and companies you find. Spreadsheets and lists arrive as text: use bulk_add_contacts
  with a preview first.
- If a request is ambiguous (which Dana? which company?), ask a quick question instead of guessing.
- After adding or changing something, say briefly what you did."""

TOOL_DEFS = [{"name": name, "description": description, "input_schema": schema, "eager_input_streaming": True}
             for name, _title, _hints, _fn, description, schema in connector.TOOLS]
TOOL_TITLES = {name: title for name, title, *_ in connector.TOOLS}
WRITE_TOOLS = {name for name, _t, hints, *_ in connector.TOOLS if not hints["readOnlyHint"]}
# Conversations are tied to the exact system prompt and tools; after an update that changes
# them, a rep's next message starts a fresh conversation.
CHAT_VERSION = hashlib.sha256(json.dumps([MODEL, SYSTEM, TOOL_DEFS], sort_keys=True).encode()).hexdigest()[:16]


# ---------- settings ----------

def api_key(db):
    return os.environ.get("ANTHROPIC_API_KEY", "").strip() or core.get_setting(db, "anthropic_api_key")


def client_for(key):
    return anthropic.Anthropic(api_key=key, max_retries=2, timeout=300)


def month_usage(db):
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    rows = db.execute("SELECT rep_name, input_tokens, output_tokens, cache_read, cache_write FROM assistant_usage "
                      "WHERE ts >= ?", (month + "-01",)).fetchall()
    by_rep, total = {}, 0.0
    for r in rows:
        cost = cost_of(r["input_tokens"], r["output_tokens"], r["cache_read"], r["cache_write"])
        total += cost
        rep = by_rep.setdefault(r["rep_name"], {"questions": 0, "cost": 0.0})
        rep["questions"] += 1
        rep["cost"] += cost
    return {"month": month, "questions": len(rows), "cost": round(total, 2),
            "by_rep": [{"name": k, "questions": v["questions"], "cost": round(v["cost"], 2)}
                       for k, v in sorted(by_rep.items(), key=lambda kv: -kv[1]["cost"])]}


def cost_of(inp, out, cache_read, cache_write):
    return (inp * PRICES["input"] + out * PRICES["output"] + cache_read * PRICES["cache_read"]
            + cache_write * PRICES["cache_write"]) / 1_000_000


def settings_payload(db):
    env_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    key = api_key(db)
    return {"configured": bool(key), "env_managed": bool(env_key), "key_hint": f"…{key[-4:]}" if key else "",
            "model": "Claude Sonnet 5.5", "daily_limit": DAILY_LIMIT, "usage": month_usage(db)}


def get_settings():
    if not core.is_admin():
        return core.bad("Admin login required", 403)
    return jsonify(settings_payload(core.get_db()))


def save_settings():
    if not core.is_admin():
        return core.bad("Admin login required", 403)
    db = core.get_db()
    data = request.get_json(silent=True) or {}
    if data.get("disconnect"):
        core.set_setting(db, "anthropic_api_key", "")
        core.log(db, "ai", "Turned off the AI assistant")
        db.commit()
        return jsonify(settings_payload(db))
    key = str(data.get("api_key") or "").strip()
    if not key.startswith("sk-ant-"):
        return core.bad("Paste an Anthropic API key (it starts with sk-ant-).")
    try:
        client_for(key).models.retrieve(MODEL)  # checks the key without spending anything
    except anthropic.AuthenticationError:
        return core.bad("Anthropic didn't accept that key. Check it and try again.")
    except anthropic.PermissionDeniedError:
        return core.bad("That key can't use Claude Sonnet 5.5. Check the key's workspace in the Anthropic Console.")
    except anthropic.APIConnectionError:
        return core.bad("Couldn't reach Anthropic. Try again in a minute.")
    except anthropic.APIStatusError as e:
        return core.bad(f"Anthropic returned an error ({e.status_code}).")
    core.set_setting(db, "anthropic_api_key", key)
    core.log(db, "ai", "Turned on the AI assistant")
    db.commit()
    return jsonify(settings_payload(db))


# ---------- conversations ----------

def latest_chat(db, rep_id):
    row = db.execute("SELECT * FROM assistant_chats WHERE rep_id = ? ORDER BY id DESC LIMIT 1", (rep_id,)).fetchone()
    return dict(row) if row else None


def new_chat(db, rep_id):
    ts = core.now()
    chat_id = db.insert("assistant_chats", {"rep_id": rep_id, "version": CHAT_VERSION, "messages": "[]",
                                            "created_at": ts, "updated_at": ts})
    old = db.execute("SELECT id FROM assistant_chats WHERE rep_id = ? ORDER BY id DESC", (rep_id,)).fetchall()[CHATS_KEPT:]
    for row in old:
        db.execute("DELETE FROM assistant_chats WHERE id = ?", (row["id"],))
    db.commit()
    return {"id": chat_id, "messages": "[]", "version": CHAT_VERSION}


def save_chat(db, chat_id, messages):
    db.execute("UPDATE assistant_chats SET messages = ?, updated_at = ? WHERE id = ?",
               (json.dumps(messages, separators=(",", ":")), core.now(), chat_id))
    db.conn.commit()


def display_messages(messages):
    """What the side panel shows: the rep's words and Claude's replies, with tool chips."""
    out = []
    for m in messages:
        content = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
        if m["role"] == "user":
            if any(b.get("type") == "tool_result" for b in content):
                continue
            texts = [b["text"] for b in content if b.get("type") == "text"]
            files = [t[len("Attached file: "):].split("\n", 1)[0] for t in texts if t.startswith("Attached file: ")]
            said = [t for t in texts if not t.startswith(CONTEXT_PREFIX) and not t.startswith("Attached file: ")]
            out.append({"role": "user", "text": said[-1] if said else "", "files": files})
        else:
            if not out or out[-1]["role"] != "assistant":
                out.append({"role": "assistant", "text": "", "tools": []})
            for b in content:
                if b.get("type") == "text" and b.get("text"):
                    out[-1]["text"] = (out[-1]["text"] + "\n\n" + b["text"]).strip()
                elif b.get("type") == "tool_use":
                    out[-1]["tools"].append(TOOL_TITLES.get(b.get("name"), b.get("name")))
    return out


def asked_today(db, rep_id):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return db.execute("SELECT COUNT(*) AS c FROM assistant_usage WHERE rep_id = ? AND ts >= ?",
                      (rep_id, today)).fetchone()["c"]


def get_chat():
    rep = core.current_rep()
    db = core.get_db()
    if not rep:
        return jsonify({"enabled": False, "reason": "Sign in as a rep to use the assistant."})
    if not api_key(db):
        return jsonify({"enabled": False,
                        "reason": "The AI assistant isn't turned on yet. An admin adds an Anthropic API key "
                                  "in ⚙ Admin → AI assistant."})
    chat = latest_chat(db, rep["id"])
    messages = json.loads(chat["messages"]) if chat and chat["version"] == CHAT_VERSION else []
    return jsonify({"enabled": True, "messages": display_messages(messages),
                    "left_today": max(0, DAILY_LIMIT - asked_today(db, rep["id"]))})


def reset_chat():
    rep = core.current_rep()
    if not rep:
        return core.bad("Sign in first", 403)
    new_chat(core.get_db(), rep["id"])
    return jsonify({"ok": True, "messages": []})


# ---------- building the rep's message ----------

def user_content(rep, text, attachments):
    """Returns (content blocks, error)."""
    today = datetime.now(timezone.utc).strftime("%A, %B %-d, %Y")
    role = " (admin)" if rep["is_admin"] else ""
    blocks = [{"type": "text", "text": f"{CONTEXT_PREFIX} Signed in as {rep['name']}{role}. Today is {today} (UTC)."}]
    if not isinstance(attachments, list) or len(attachments) > 5:
        return None, "Attach up to 5 files at a time."
    for a in attachments:
        if not isinstance(a, dict):
            return None, "That attachment couldn't be read."
        name = " ".join(str(a.get("name") or "file").split())[:120]
        kind, media = a.get("kind"), str(a.get("media_type") or "")
        if kind == "text":
            body = str(a.get("text") or "")
            if len(body) > 300_000:
                return None, f"{name} is too long. Split it into smaller files."
            blocks.append({"type": "text", "text": f"Attached file: {name}\n\n{body}"})
            continue
        data = str(a.get("data") or "")
        try:
            size = len(base64.b64decode(data, validate=True))
        except ValueError:
            return None, f"{name} couldn't be read."
        if kind == "image" and media in IMAGE_TYPES and size <= 5_000_000:
            source = {"type": "base64", "media_type": media, "data": data}
            blocks += [{"type": "text", "text": f"Attached file: {name}"}, {"type": "image", "source": source}]
        elif kind == "pdf" and media == "application/pdf" and size <= 15_000_000:
            source = {"type": "base64", "media_type": media, "data": data}
            blocks += [{"type": "text", "text": f"Attached file: {name}"}, {"type": "document", "source": source}]
        else:
            return None, f"{name} isn't a supported file. Use a photo, PDF, CSV or text file (Excel: save as CSV)."
    blocks.append({"type": "text", "text": text or "(See the attached file.)"})
    return blocks, None


# ---------- tool calls ----------

JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}


def schema_error(schema, value, where="input"):
    """A small JSON Schema check for the shapes our tools use. Returns a message or None."""
    expected = schema.get("type")
    if expected:
        ok = isinstance(value, JSON_TYPES[expected])
        if expected in ("integer", "number") and isinstance(value, bool):
            ok = False
        if not ok:
            return f"{where} should be a {expected}"
    if "enum" in schema and value not in schema["enum"]:
        return f"{where} must be one of {', '.join(map(str, schema['enum']))}"
    if expected == "object":
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                return f"{where} is missing {key}"
        for key, item in value.items():
            if key not in props:
                if schema.get("additionalProperties") is False:
                    return f"{where} has an unknown field {key}"
                continue
            if item is None:
                continue
            err = schema_error(props[key], item, key)
            if err:
                return err
    if expected == "array":
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            return f"{where} has more than {schema['maxItems']} items"
        for i, item in enumerate(value):
            err = schema_error(schema.get("items", {}), item, f"{where}[{i}]")
            if err:
                return err
    return None


def run_tool(block):
    schema = next(t["input_schema"] for t in TOOL_DEFS if t["name"] == block.name) \
        if block.name in TOOL_TITLES else None
    if schema is None:
        return f"Unknown tool {block.name}", True
    err = schema_error(schema, block.input)
    if err:
        return json.dumps({"INVALID_INPUT": err}), True
    result = connector.call_tool(block.name, block.input)
    return result["content"][0]["text"], bool(result["isError"])


def stored_block(block):
    """An assistant content block as it must be sent back on the next request."""
    kind = block.type
    if kind == "text":
        out = {"type": "text", "text": block.text}
        if getattr(block, "citations", None):
            out["citations"] = [c.model_dump(mode="json", by_alias=True, exclude_none=True) for c in block.citations]
        return out
    if kind == "thinking":
        return {"type": "thinking", "thinking": block.thinking, "signature": block.signature}
    if kind == "redacted_thinking":
        return {"type": "redacted_thinking", "data": block.data}
    if kind == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    return block.model_dump(mode="json", by_alias=True, exclude_none=True)


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ---------- the conversation loop ----------

def chat():
    rep = core.current_rep()
    if not rep:
        return core.bad("Sign in as a rep to use the assistant.", 403)
    db = core.get_db()
    key = api_key(db)
    if not key:
        return core.bad("The AI assistant isn't turned on yet. Ask an admin to add an Anthropic API key in ⚙.", 409)
    if asked_today(db, rep["id"]) >= DAILY_LIMIT:
        return core.bad(f"You've reached today's limit of {DAILY_LIMIT} questions. It resets at midnight UTC.", 429)
    data = request.get_json(silent=True) or {}
    text = str(data.get("message") or "").strip()[:20000]
    attachments = data.get("attachments") or []
    if not text and not attachments:
        return core.bad("Type a message first.")
    content, err = user_content(rep, text, attachments)
    if err:
        return core.bad(err)

    chat_row = latest_chat(db, rep["id"])
    notice = ""
    if not chat_row or chat_row["version"] != CHAT_VERSION:
        notice = "Started a new chat after an update." if chat_row and chat_row["messages"] != "[]" else ""
        chat_row = new_chat(db, rep["id"])
    elif len(chat_row["messages"]) > MAX_CHAT_BYTES:
        notice = "That chat got long, so this starts a new one."
        chat_row = new_chat(db, rep["id"])
    messages = json.loads(chat_row["messages"])
    messages.append({"role": "user", "content": content})
    save_chat(db, chat_row["id"], messages)
    caller = {"rep_id": rep["id"], "pw_fp": rep["pw_fp"], "via": "AI chat"}

    def generate():
        # The request's own connection is closed once the view returns, so the stream
        # opens (and closes) its own.
        g.pop("db", None)
        core.ai_caller.set(caller)
        try:
            if notice:
                yield sse("notice", {"text": notice})
            yield from converse(core.get_db(), client_for(key), rep, chat_row["id"], messages)
        finally:
            core.ai_caller.set(None)
            stream_db = g.pop("db", None)
            if stream_db is not None:
                stream_db.conn.close()

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def converse(db, client, rep, chat_id, messages):
    used = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    changed = False
    json_retries = 0
    rounds = 0
    try:
        while True:
            rounds += 1
            if rounds > MAX_TOOL_ROUNDS:
                yield sse("error", {"text": "That took too many steps. Try breaking it into smaller requests."})
                break
            try:
                with client.beta.messages.stream(
                    model=MODEL, max_tokens=MAX_TOKENS, system=SYSTEM, tools=TOOL_DEFS, messages=messages,
                    output_config={"effort": EFFORT}, cache_control={"type": "ephemeral"},
                    betas=[FALLBACK_BETA], fallbacks="default",
                ) as stream:
                    for event in stream:
                        if event.type == "text":
                            yield sse("text", {"text": event.text})
                        elif event.type == "content_block_start" and event.content_block.type == "tool_use":
                            name = event.content_block.name
                            yield sse("tool", {"name": name, "label": TOOL_TITLES.get(name, name)})
                    response = stream.get_final_message()
                json_retries = 0
            except ValueError:
                # A tool input the SDK couldn't parse at all: no tool_use id to answer, so ask again.
                json_retries += 1
                if json_retries > 2:
                    yield sse("error", {"text": "Claude sent something garbled. Please try again."})
                    break
                yield sse("discard", {})
                continue

            u = response.usage
            used["input"] += u.input_tokens or 0
            used["output"] += u.output_tokens or 0
            used["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0
            used["cache_write"] += getattr(u, "cache_creation_input_tokens", 0) or 0

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if response.stop_reason == "refusal":
                yield sse("discard", {})
                yield sse("error", {"text": "Claude couldn't help with that request. Try rephrasing it."})
                break
            if response.stop_reason == "max_tokens" and tool_uses:
                yield sse("error", {"text": "That request was too big to finish. Try fewer contacts at a time."})
                break
            blocks = [stored_block(b) for b in response.content]
            if blocks:
                messages.append({"role": "assistant", "content": blocks})
            if response.stop_reason == "pause_turn":
                save_chat(db, chat_id, messages)
                continue
            if not tool_uses:
                save_chat(db, chat_id, messages)
                break

            results = []
            for block in tool_uses:
                content, is_error = run_tool(block)
                result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
                if is_error:
                    result["is_error"] = True
                results.append(result)
                if block.name in WRITE_TOOLS and not is_error:
                    changed = True
                yield sse("tool_done", {"name": block.name, "ok": not is_error})
            messages.append({"role": "user", "content": results})
            save_chat(db, chat_id, messages)
    except anthropic.RateLimitError:
        yield sse("error", {"text": "The assistant is busy right now. Try again in a minute."})
    except anthropic.AuthenticationError:
        yield sse("error", {"text": "The team's Anthropic API key stopped working. Ask an admin to check ⚙ → AI assistant."})
    except anthropic.BadRequestError as e:
        core.app.logger.warning("Assistant request rejected: %s", e)
        yield sse("error", {"text": "Claude couldn't read this conversation. Tap New chat and try again."})
    except anthropic.APIStatusError as e:
        core.app.logger.warning("Assistant API error %s", e.status_code)
        yield sse("error", {"text": "Claude is having trouble right now. Try again shortly."})
    except anthropic.APIConnectionError:
        yield sse("error", {"text": "Couldn't reach Claude. Check your connection and try again."})
    finally:
        db.insert("assistant_usage", {"ts": core.now(), "rep_id": rep["id"], "rep_name": rep["name"],
                                      "input_tokens": used["input"], "output_tokens": used["output"],
                                      "cache_read": used["cache_read"], "cache_write": used["cache_write"]})
        db.conn.commit()
    yield sse("done", {"changed": changed,
                       "left_today": max(0, DAILY_LIMIT - asked_today(db, rep["id"]))})


def install(app, module):
    global core
    core = module
    app.add_url_rule("/api/assistant", view_func=get_chat, methods=["GET"])
    app.add_url_rule("/api/assistant", "assistant_reset", reset_chat, methods=["DELETE"])
    app.add_url_rule("/api/assistant/chat", view_func=chat, methods=["POST"])
    app.add_url_rule("/api/assistant/settings", view_func=get_settings, methods=["GET"])
    app.add_url_rule("/api/assistant/settings", "assistant_save_settings", save_settings, methods=["POST"])
