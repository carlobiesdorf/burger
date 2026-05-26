"""Lightweight Telegram bot notifier.

Used by main.py / stripe_handler.py to ping the admin when something
important happens (signup, payment, refund, contact form, errors).

Design choices:
- **Fail silently**: if Telegram is down, never break the user flow.
- **Short timeout** (5s): don't block requests waiting for Telegram.
- **HTTP only (urllib)**: no extra dependency.
- Uses HTML parse mode for inline formatting.
- **Mirror every notification to a log file** so the admin keeps a
  searchable trail even if Telegram delivery fails or the chat history
  is lost. Default file: /var/log/einb/telegram.log (configurable via
  TELEGRAM_LOG_FILE env var). Path expected to be a volume-mounted
  host directory so logs survive container rebuilds.
"""
import json
import logging
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from typing import Optional

logger = logging.getLogger("einb.telegram")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
ENABLED = bool(TOKEN and CHAT_ID)

# --- file logging (mirror every notify_* call to disk) ---
LOG_FILE = os.environ.get("TELEGRAM_LOG_FILE", "/var/log/einb/telegram.log")
_TAG_RE = re.compile(r"<[^>]+>")  # strip simple HTML tags so the log file is readable
_msg_logger: Optional[logging.Logger] = None


def _get_msg_logger() -> Optional[logging.Logger]:
    """Initialize on first use. Returns None if the log file can't be opened."""
    global _msg_logger
    if _msg_logger is not None:
        return _msg_logger if _msg_logger.handlers else None
    lg = logging.getLogger("einb.telegram.messages")
    lg.setLevel(logging.INFO)
    lg.propagate = False
    try:
        os.makedirs(os.path.dirname(LOG_FILE) or ".", exist_ok=True)
        # Rotate at 5 MB, keep 5 backups (~25 MB total)
        h = RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=5, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S%z"))
        lg.addHandler(h)
        _msg_logger = lg
        return lg
    except Exception as e:
        logger.warning("telegram_log_init_failed file=%s err=%s", LOG_FILE, e)
        _msg_logger = lg  # cache the failed attempt (no handlers attached)
        return None


def _log_to_file(text: str, delivered: bool) -> None:
    lg = _get_msg_logger()
    if not lg:
        return
    flat = _TAG_RE.sub("", text).replace("\n", " | ")
    status = "OK" if delivered else "FAILED"
    try:
        lg.info("[%s] %s", status, flat[:2000])
    except Exception as e:
        logger.warning("telegram_log_write_failed err=%s", e)


def send(text: str, parse_mode: str = "HTML", disable_preview: bool = True) -> bool:
    """Send a message to the configured chat. Returns True on success.
    Never raises — Telegram failures shouldn't break the app.

    Mirrors every outgoing message to the file log regardless of delivery,
    so Carlos has a searchable audit trail."""
    if not ENABLED:
        _log_to_file(text, delivered=False)
        return False
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": text[:4000],  # Telegram max msg = 4096
        "parse_mode": parse_mode,
        "disable_web_page_preview": disable_preview,
    }
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(payload).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    delivered = False
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
            if not data.get("ok"):
                logger.warning("telegram_api_error: %s", data.get("description"))
            else:
                delivered = True
    except Exception as e:
        logger.warning("telegram_send_failed: %s", e)
    _log_to_file(text, delivered=delivered)
    return delivered


def html_escape(s: str) -> str:
    """Telegram HTML mode requires escaping < > &."""
    return (str(s or "").replace("&", "&amp;")
                          .replace("<", "&lt;")
                          .replace(">", "&gt;"))


# ---------- Pre-formatted messages for common events ----------

def notify_signup(user: dict, ip: str = "") -> None:
    text = (
        "🆕 <b>Novo cadastro</b>\n"
        f"📧 <code>{html_escape(user.get('email'))}</code>\n"
        f"👤 {html_escape(user.get('nationality') or '—')} · "
        f"{user.get('age') or '?'} anos · "
        f"{html_escape(user.get('sex') or '—')}\n"
        f"🎟️ Cupom: <code>{html_escape(user.get('coupon_code') or 'nenhum')}</code>\n"
        f"🌐 IP: <code>{html_escape(ip[:32])}</code>\n"
        f"🔢 ID: {user.get('id')}"
    )
    send(text)


def notify_payment(user_email: str, amount_cents: int, currency: str = "EUR",
                   session_id: str = "") -> None:
    amount_str = f"{amount_cents/100:.2f} {currency}"
    is_live = session_id.startswith("cs_live_")
    mode = "🟢 LIVE" if is_live else "🟡 TEST"
    text = (
        f"💰 <b>Pagamento confirmado</b> {mode}\n"
        f"📧 <code>{html_escape(user_email)}</code>\n"
        f"💵 <b>{amount_str}</b>\n"
        f"🔗 <code>{html_escape(session_id[:30])}…</code>"
    )
    send(text)


def notify_refund(user_email: str, payment_intent: str,
                  refund_cents: int, total_cents: int, currency: str = "EUR") -> None:
    is_full = refund_cents >= total_cents
    head = "🔁 <b>Refund total</b>" if is_full else "🟠 <b>Refund parcial</b>"
    text = (
        f"{head}\n"
        f"📧 <code>{html_escape(user_email)}</code>\n"
        f"💸 {refund_cents/100:.2f} / {total_cents/100:.2f} {currency}\n"
        f"🔗 <code>{html_escape(payment_intent[:30])}…</code>\n"
        + ("⚠️ Conta foi desativada (status=expired)." if is_full
           else "✅ Conta continua ativa (refund parcial).")
    )
    send(text)


CONTACT_CATEGORY_LABELS = {
    "bug": "🐛 Bug",
    "problem": "⚠️ Problema",
    "suggestion": "💡 Sugestão",
    "missing_language": "🌍 Falta meu idioma",
    "other": "❓ Outro",
}


def notify_contact(name: str, email: str, category: str = "other",
                   message: str = "", ip: str = "") -> None:
    cat_label = CONTACT_CATEGORY_LABELS.get(category, category)
    text = (
        "📩 <b>Nova mensagem de contato</b>\n"
        f"👤 <b>{html_escape(name)}</b>\n"
        f"📧 <code>{html_escape(email)}</code>\n"
        f"🏷 {html_escape(cat_label)}\n"
        f"🌐 IP: <code>{html_escape(ip[:32])}</code>\n\n"
        f"💬 <i>{html_escape(message[:1500])}</i>"
    )
    send(text)


def notify_error(title: str, detail: str = "") -> None:
    text = f"🚨 <b>{html_escape(title)}</b>\n<code>{html_escape(detail[:500])}</code>"
    send(text)
