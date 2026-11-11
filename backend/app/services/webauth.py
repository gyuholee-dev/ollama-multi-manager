"""Password and session helpers of the web access port (see services/external.py).

The password is stored only as a salted PBKDF2 hash. A session is a cookie holding its expiry time and an HMAC of it,
keyed with the stored hash: nothing is kept on the server, and changing the password ends every session.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from html import escape

ITERATIONS = 200_000
COOKIE_NAME = "omm_session"
DEFAULT_SESSION_HOURS = 12
MIN_PASSWORD_LENGTH = 4
MIN_API_KEY_LENGTH = 16   # every API key (an instance's, the metrics one): the least a person may type; generated ones are 32
MAX_FAILURES = 5          # wrong passwords in a row from one address ...
LOCK_SECONDS = 60         # ... lock that address out for this long


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt, digest = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        got = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(got.hex(), digest)
    except (ValueError, TypeError):
        return False


def verify_token(token: str, stored: str) -> bool:
    """The metrics token is kept as it is (the settings window shows it again to be copied), so this is a plain constant-time compare."""
    return bool(stored) and hmac.compare_digest(token.encode(), stored.encode())


def _mac(stored: str, expires: int) -> str:
    return hmac.new(stored.encode(), str(expires).encode(), hashlib.sha256).hexdigest()


def make_session(stored: str, hours: float, now: float | None = None) -> tuple[str, int]:
    """(cookie value, lifetime in seconds)."""
    seconds = int(hours * 3600)
    expires = int((now if now is not None else time.time()) + seconds)
    return f"{expires}.{_mac(stored, expires)}", seconds


def session_valid(value: str, stored: str, now: float | None = None) -> bool:
    try:
        expires_text, mac = value.split(".", 1)
        expires = int(expires_text)
    except ValueError:
        return False
    if expires <= (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(mac, _mac(stored, expires))


class LoginLimiter:
    """Counts wrong passwords per client address; after MAX_FAILURES in a row the address waits LOCK_SECONDS."""

    def __init__(self) -> None:
        self._state: dict[str, tuple[int, float]] = {}  # address -> (failures, locked until)

    def locked(self, who: str, now: float | None = None) -> bool:
        fails, until = self._state.get(who, (0, 0.0))
        return fails >= MAX_FAILURES and (now if now is not None else time.time()) < until

    def failed(self, who: str, now: float | None = None) -> None:
        now = now if now is not None else time.time()
        fails, until = self._state.get(who, (0, 0.0))
        if fails >= MAX_FAILURES and now >= until:  # the lock ran out: start counting again
            fails = 0
        fails += 1
        self._state[who] = (fails, now + LOCK_SECONDS if fails >= MAX_FAILURES else 0.0)
        if len(self._state) > 1000:  # never grow without bound
            self._state = {k: v for k, v in self._state.items() if v[1] > now}

    def ok(self, who: str) -> None:
        self._state.pop(who, None)


_TEXT = {
    "ko": {"title": "웹 관리 로그인", "label": "패스워드", "button": "로그인", "bad": "패스워드가 맞지 않습니다.",
           "locked": "실패가 너무 많습니다. 잠시 후 다시 시도하세요."},
    "en": {"title": "Web admin sign-in", "label": "Password", "button": "Sign in", "bad": "Wrong password.",
           "locked": "Too many failures. Try again in a moment."},
}


def login_page(lang: str | None, error: str | None = None) -> str:
    """The sign-in page: one form, no script (the content policy allows none)."""
    t = _TEXT.get((lang or "en")[:2].lower(), _TEXT["en"])
    msg = f'<p class="e">{escape(t[error])}</p>' if error else ""
    form = (
        f'<form method="post" action="/login"><label for="p">{escape(t["label"])}</label>'
        f'<input id="p" name="password" type="password" autocomplete="current-password" autofocus required>'
        f'<button>{escape(t["button"])}</button></form>')
    return (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{escape(t["title"])}</title><style>'
        ':root{color-scheme:light dark;--bg:#f2f2f2;--card:#fff;--text:#1c1c1c;--line:#cfcfcf;--accent:#4c7cf3}'
        '@media(prefers-color-scheme:dark){:root{--bg:#1c1c1c;--card:#262626;--text:#f0f0f0;--line:#3a3a3a}}'
        'body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px system-ui,sans-serif}'
        'main{width:min(320px,calc(100vw - 32px));padding:24px;border-radius:12px;background:var(--card)}'
        'h1{margin:0 0 16px;font-size:1rem;font-weight:500}form{display:grid;gap:8px}'
        'input,button{font:inherit;color:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:none}'
        'button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}.e{margin:0 0 12px;color:#d0453b;font-size:.875rem}'
        f'</style></head><body><main><h1>{escape(t["title"])}</h1>{msg}{form}</main></body></html>'
    )
