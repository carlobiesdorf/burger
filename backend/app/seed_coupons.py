"""
Seed test coupons. Run inside the container:
    docker exec einb-backend python -m app.seed_coupons
"""
from datetime import datetime, timedelta, timezone

from .db import db, init_db


COUPONS = [
    # (code, partner, pct, cents, valid_until_days, max_uses)
    ("WELCOME10",      "house",       10,   None, 365, None),
    ("PARTNER-MUNICH", "Munich club", 20,   None, 180, 500),
    ("FREEMONTH",      "test",        None, 500,  90,  100),
]


def main() -> None:
    init_db()
    now = datetime.now(timezone.utc)
    with db() as conn:
        for code, partner, pct, cents, days, max_uses in COUPONS:
            valid_until = (now + timedelta(days=days)).isoformat() if days else None
            conn.execute(
                """INSERT OR REPLACE INTO coupons
                   (code, partner, discount_pct, discount_cents, valid_until,
                    max_uses, used_count, active)
                   VALUES (?, ?, ?, ?, ?, ?, COALESCE(
                     (SELECT used_count FROM coupons WHERE code = ?), 0
                   ), 1)""",
                (code, partner, pct, cents, valid_until, max_uses, code),
            )
            print(f"  upserted: {code}")
    print("seed done.")


if __name__ == "__main__":
    main()
