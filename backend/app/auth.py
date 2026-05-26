import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt

from .db import db

SESSION_TTL_DAYS = int(os.environ.get("SESSION_TTL_DAYS", "30"))


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_session(user_id: int, user_agent: str | None, ip: str | None) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    with db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)",
            (token, user_id, user_agent, ip, expires_at.isoformat()),
        )
    return token, expires_at


def get_user_by_session(token: str) -> dict | None:
    if not token:
        return None
    with db() as conn:
        row = conn.execute(
            """SELECT u.* FROM sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP""",
            (token,),
        ).fetchone()
        return dict(row) if row else None


def delete_session(token: str) -> None:
    if not token:
        return
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def purge_expired_sessions() -> int:
    with db() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP")
        return cur.rowcount
