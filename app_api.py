"""
Accounts and sync for the Python backend.

Mirrors public/lib/{db,accounts,sync}.php exactly - same tables, same JSON, same
conflict rules - so a client cannot tell which backend it is talking to. This
one exists partly so the flow can be exercised without a PHP host.

Standard library only.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time

TOKEN_TTL = 60 * 60 * 24 * 90          # 90 days
MAX_LOGIN_FAILS = 8
LOCKOUT_SECONDS = 900
SYNC_PAGE = 1000
COOKIE_NAME = "pc_token"

# 'invite' | 'open' | 'closed' - who may create an account.
REGISTRATION = os.environ.get("PODCAST_REGISTRATION", "invite")

_local = threading.local()
_db_path: str | None = None
_init_lock = threading.Lock()
_initialised = False


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def now_ms() -> int:
    return int(time.time() * 1000)


def configure(data_dir: str) -> None:
    global _db_path
    os.makedirs(data_dir, exist_ok=True)
    _db_path = os.path.join(data_dir, "podcasts.sqlite")


def db() -> sqlite3.Connection:
    """One connection per thread; ThreadingHTTPServer hands each request its own."""
    global _initialised
    if _db_path is None:
        raise ApiError(500, "Storage is not configured")

    connection = getattr(_local, "connection", None)
    if connection is None:
        connection = sqlite3.connect(_db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        _local.connection = connection

    if not _initialised:
        with _init_lock:
            if not _initialised:
                migrate(connection)
                _initialised = True
    return connection


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until BIGINT NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        device TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        last_used_at BIGINT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS subscriptions (
        user_id INTEGER NOT NULL,
        feed_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        subscribed INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        auto_download INTEGER NOT NULL DEFAULT 0,
        notify INTEGER NOT NULL DEFAULT 1,
        client_updated_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, feed_url)
    )""",
    """CREATE TABLE IF NOT EXISTS episode_state (
        user_id INTEGER NOT NULL,
        guid TEXT NOT NULL,
        feed_url TEXT NOT NULL DEFAULT '',
        position_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        last_played_at BIGINT NOT NULL DEFAULT 0,
        client_updated_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, guid)
    )""",
    """CREATE TABLE IF NOT EXISTS queue_items (
        user_id INTEGER NOT NULL,
        guid TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        client_updated_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, guid)
    )""",
    """CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER NOT NULL PRIMARY KEY,
        payload TEXT NOT NULL,
        client_updated_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_subs_updated ON subscriptions (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_episodes_updated ON episode_state (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_queue_updated ON queue_items (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id)",
]


def migrate(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        connection.execute(statement)
    connection.commit()


# ---- passwords --------------------------------------------------------------
# PBKDF2-HMAC-SHA256 from hashlib. PHP uses bcrypt via password_hash(); the
# formats differ but never meet - each backend owns its own database.

PBKDF2_ROUNDS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, rounds, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


# ---- invite code ------------------------------------------------------------


def invite_code() -> str:
    if _db_path is None:
        return ""
    path = os.path.join(os.path.dirname(_db_path), "invite-code.txt")
    if not os.path.isfile(path):
        with open(path, "w") as handle:
            handle.write(secrets.token_hex(4) + "\n")
        os.chmod(path, 0o600)
    with open(path) as handle:
        return handle.read().strip()


# ---- tokens -----------------------------------------------------------------


def issue_token(user_id: int, device: str) -> str:
    token = secrets.token_hex(32)
    connection = db()
    connection.execute(
        """INSERT INTO tokens (user_id, token_hash, device, created_at, expires_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            user_id,
            hashlib.sha256(token.encode()).hexdigest(),
            device[:64],
            now_ms(),
            now_ms() + TOKEN_TTL * 1000,
            now_ms(),
        ),
    )
    connection.commit()
    return token


def user_for_token(token: str) -> sqlite3.Row | None:
    if not token or not all(c in "0123456789abcdef" for c in token):
        return None
    connection = db()
    row = connection.execute(
        """SELECT u.id, u.username, u.display_name, t.id AS token_id, t.expires_at
           FROM tokens t JOIN users u ON u.id = t.user_id
           WHERE t.token_hash = ?""",
        (hashlib.sha256(token.encode()).hexdigest(),),
    ).fetchone()
    if row is None:
        return None
    if int(row["expires_at"]) < now_ms():
        connection.execute("DELETE FROM tokens WHERE id = ?", (row["token_id"],))
        connection.commit()
        return None
    return row


# ---- account handlers -------------------------------------------------------

USERNAME_OK = set("abcdefghijklmnopqrstuvwxyz0123456789._-")


def register(payload: dict, device: str) -> tuple[dict, str]:
    if REGISTRATION == "closed":
        raise ApiError(403, "This server is not accepting new accounts")

    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))
    display = str(payload.get("displayName") or username)[:120]

    if not (3 <= len(username) <= 32) or not set(username) <= USERNAME_OK:
        raise ApiError(
            400, "Usernames are 3-32 characters: letters, numbers, dot, dash, underscore"
        )
    if len(password) < 8:
        raise ApiError(400, "Password must be at least 8 characters")
    if REGISTRATION == "invite":
        expected = invite_code()
        if not expected or not hmac.compare_digest(
            expected, str(payload.get("inviteCode", ""))
        ):
            raise ApiError(403, "That invite code is not right")

    connection = db()
    if connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
        raise ApiError(409, "That username is taken")

    cursor = connection.execute(
        "INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)",
        (username, display, hash_password(password), now_ms()),
    )
    connection.commit()

    token = issue_token(int(cursor.lastrowid), device)
    return {"user": {"username": username, "displayName": display}, "token": token}, token


def login(payload: dict, device: str) -> tuple[dict, str]:
    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))

    connection = db()
    user = connection.execute(
        """SELECT id, username, display_name, password_hash, failed_attempts, locked_until
           FROM users WHERE username = ?""",
        (username,),
    ).fetchone()

    if user and int(user["locked_until"]) > now_ms():
        wait = -(-(int(user["locked_until"]) - now_ms()) // 60000)
        raise ApiError(429, f"Too many attempts. Try again in {wait} minutes.")

    # Always run the KDF, so response time does not reveal which usernames exist.
    stored = user["password_hash"] if user else hash_password(secrets.token_hex(8))
    ok = verify_password(password, stored) and user is not None

    if not ok:
        if user:
            fails = int(user["failed_attempts"]) + 1
            locked = now_ms() + LOCKOUT_SECONDS * 1000 if fails >= MAX_LOGIN_FAILS else 0
            connection.execute(
                "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
                (0 if locked else fails, locked, user["id"]),
            )
            connection.commit()
        raise ApiError(401, "Wrong username or password")

    connection.execute(
        "UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?", (user["id"],)
    )
    connection.commit()

    token = issue_token(int(user["id"]), device)
    return (
        {
            "user": {"username": user["username"], "displayName": user["display_name"]},
            "token": token,
        },
        token,
    )


def logout(token: str) -> dict:
    if token:
        connection = db()
        connection.execute(
            "DELETE FROM tokens WHERE token_hash = ?",
            (hashlib.sha256(token.encode()).hexdigest(),),
        )
        connection.commit()
    return {"ok": True}


def change_password(user: sqlite3.Row, payload: dict) -> dict:
    current = str(payload.get("currentPassword", ""))
    following = str(payload.get("newPassword", ""))
    if len(following) < 8:
        raise ApiError(400, "Password must be at least 8 characters")

    connection = db()
    row = connection.execute(
        "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
    ).fetchone()
    if row is None or not verify_password(current, row["password_hash"]):
        raise ApiError(401, "Current password is wrong")

    connection.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (hash_password(following), user["id"]),
    )
    # Changing a password should end every other session.
    connection.execute(
        "DELETE FROM tokens WHERE user_id = ? AND id <> ?", (user["id"], user["token_id"])
    )
    connection.commit()
    return {"ok": True}


# ---- sync -------------------------------------------------------------------
#
# Two clocks per row. `updated_at` is the server's and drives the pull cursor,
# so a device with a wrong clock cannot hide its rows from other devices.
# `client_updated_at` is the device's and decides conflicts: last write wins.


def _int(value, fallback: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return int(value)
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _bool(value) -> int:
    return 1 if value not in (None, False, 0, "", "false", "0") else 0


def _text(value, limit: int) -> str:
    return str(value)[:limit] if value is not None else ""


def _push(connection, table, key_column, key_field, rows, user_id, server_now, columns):
    """
    Upsert rows whose device clock is at least as new as what is stored.

    key_column is the database column; key_field is what the JSON calls it.
    They differ for subscriptions (feed_url vs feedUrl), and conflating them
    silently drops every row.
    """
    written = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = _text(row.get(key_field), 500)
        if not key:
            continue
        client_at = _int(row.get("updatedAt"))

        existing = connection.execute(
            f"SELECT client_updated_at FROM {table} WHERE user_id = ? AND {key_column} = ?",
            (user_id, key),
        ).fetchone()
        if existing and int(existing["client_updated_at"]) > client_at:
            continue

        values = [user_id, key] + [build(row) for build in columns] + [client_at, server_now]
        placeholders = ",".join("?" * len(values))
        names = ",".join(
            ["user_id", key_column] + COLUMN_NAMES[table] + ["client_updated_at", "updated_at"]
        )
        connection.execute(
            f"INSERT OR REPLACE INTO {table} ({names}) VALUES ({placeholders})", values
        )
        written += 1
    return written


COLUMN_NAMES = {
    "subscriptions": [
        "title", "author", "image_url", "subscribed", "deleted", "auto_download", "notify",
    ],
    "episode_state": [
        "feed_url", "position_ms", "duration_ms", "completed", "archived", "last_played_at",
    ],
    "queue_items": ["position", "removed"],
}

COLUMN_BUILDERS = {
    "subscriptions": [
        lambda r: _text(r.get("title"), 300),
        lambda r: _text(r.get("author"), 300),
        lambda r: _text(r.get("imageUrl"), 500),
        lambda r: _bool(r.get("isSubscribed")),
        lambda r: _bool(r.get("deleted")),
        lambda r: _bool(r.get("autoDownload")),
        # Absent means "not specified", and a new subscription notifies by
        # default - matching push_subscriptions() in the PHP backend.
        lambda r: _bool(r.get("notifyNewEpisodes", True)),
    ],
    "episode_state": [
        lambda r: _text(r.get("feedUrl"), 500),
        lambda r: max(0, _int(r.get("positionMs"))),
        lambda r: max(0, _int(r.get("durationMs"))),
        lambda r: _bool(r.get("isCompleted")),
        lambda r: _bool(r.get("isArchived")),
        lambda r: _int(r.get("lastPlayedAt")),
    ],
    "queue_items": [
        lambda r: _int(r.get("position")),
        lambda r: _bool(r.get("removed")),
    ],
}


def push_settings(connection, user_id: int, settings, server_now: int) -> None:
    if not isinstance(settings, dict) or "payload" not in settings:
        return
    client_at = _int(settings.get("updatedAt"))
    existing = connection.execute(
        "SELECT client_updated_at FROM user_settings WHERE user_id = ?", (user_id,)
    ).fetchone()
    if existing and int(existing["client_updated_at"]) > client_at:
        return

    payload = json.dumps(settings["payload"])
    if len(payload) > 65535:
        return
    connection.execute(
        """INSERT OR REPLACE INTO user_settings (user_id, payload, client_updated_at, updated_at)
           VALUES (?, ?, ?, ?)""",
        (user_id, payload, client_at, server_now),
    )


def pull(connection, user_id: int, since: int) -> dict:
    truncated = False

    def rows(sql):
        nonlocal truncated
        found = connection.execute(sql, (user_id, since)).fetchall()
        if len(found) >= SYNC_PAGE:
            truncated = True
        return found

    subs = rows(
        """SELECT feed_url, title, author, image_url, subscribed, deleted, auto_download,
                  notify, client_updated_at
           FROM subscriptions WHERE user_id = ? AND updated_at > ?
           ORDER BY updated_at ASC LIMIT %d""" % SYNC_PAGE
    )
    episodes = rows(
        """SELECT guid, feed_url, position_ms, duration_ms, completed, archived,
                  last_played_at, client_updated_at
           FROM episode_state WHERE user_id = ? AND updated_at > ?
           ORDER BY updated_at ASC LIMIT %d""" % SYNC_PAGE
    )
    queue = rows(
        """SELECT guid, position, removed, client_updated_at
           FROM queue_items WHERE user_id = ? AND updated_at > ?
           ORDER BY updated_at ASC LIMIT %d""" % SYNC_PAGE
    )
    settings_row = connection.execute(
        "SELECT payload, client_updated_at FROM user_settings WHERE user_id = ? AND updated_at > ?",
        (user_id, since),
    ).fetchone()

    return {
        "subscriptions": [
            {
                "feedUrl": r["feed_url"],
                "title": r["title"],
                "author": r["author"],
                "imageUrl": r["image_url"],
                "isSubscribed": bool(r["subscribed"]),
                "deleted": bool(r["deleted"]),
                "autoDownload": bool(r["auto_download"]),
                "notifyNewEpisodes": bool(r["notify"]),
                "updatedAt": int(r["client_updated_at"]),
            }
            for r in subs
        ],
        "episodes": [
            {
                "guid": r["guid"],
                "feedUrl": r["feed_url"],
                "positionMs": int(r["position_ms"]),
                "durationMs": int(r["duration_ms"]),
                "isCompleted": bool(r["completed"]),
                "isArchived": bool(r["archived"]),
                "lastPlayedAt": int(r["last_played_at"]),
                "updatedAt": int(r["client_updated_at"]),
            }
            for r in episodes
        ],
        "queue": [
            {
                "guid": r["guid"],
                "position": int(r["position"]),
                "removed": bool(r["removed"]),
                "updatedAt": int(r["client_updated_at"]),
            }
            for r in queue
        ],
        "settings": (
            {
                "payload": json.loads(settings_row["payload"]),
                "updatedAt": int(settings_row["client_updated_at"]),
            }
            if settings_row
            else None
        ),
        "truncated": truncated,
    }


def sync(user: sqlite3.Row, payload: dict, since_query: int | None) -> dict:
    user_id = int(user["id"])
    connection = db()
    server_now = now_ms()
    written = 0

    if payload:
        since = _int(payload.get("since"), 0)
        try:
            for table, key_column, key_field, json_key in (
                ("subscriptions", "feed_url", "feedUrl", "subscriptions"),
                ("episode_state", "guid", "guid", "episodes"),
                ("queue_items", "guid", "guid", "queue"),
            ):
                incoming = payload.get(json_key)
                if isinstance(incoming, list) and incoming:
                    written += _push(
                        connection, table, key_column, key_field, incoming, user_id,
                        server_now, COLUMN_BUILDERS[table],
                    )
            if "settings" in payload:
                push_settings(connection, user_id, payload["settings"], server_now)
            connection.commit()
        except sqlite3.Error:
            connection.rollback()
            raise ApiError(500, "Could not save your changes")
    else:
        since = since_query or 0

    # Pull with the caller's original cursor. Rows just pushed come back too,
    # which is harmless - merging is idempotent - and confirms what was stored.
    changes = pull(connection, user_id, since)
    changes["written"] = written
    changes["serverTime"] = now_ms()
    return changes
