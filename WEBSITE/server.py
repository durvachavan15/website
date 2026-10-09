import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "durva.sqlite3")).resolve()
SESSION_DAYS = 14
PASSWORD_ITERATIONS = 310_000
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")

VEHICLES = {
    "car-swift": ("Maruti Swift", 1899, "Mumbai"),
    "car-city": ("Honda City", 2599, "Delhi"),
    "car-innova": ("Toyota Innova Crysta", 4299, "Bengaluru"),
    "car-thar": ("Mahindra Thar", 3999, "Jaipur"),
    "car-bmw": ("BMW 3 Series", 8999, "Mumbai"),
    "scooty-activa": ("Honda Activa 6G", 499, "Goa"),
    "scooty-jupiter": ("TVS Jupiter", 449, "Pune"),
    "scooty-ather": ("Ather 450X", 799, "Bengaluru"),
    "scooty-vespa": ("Vespa SXL 150", 899, "Goa"),
    "traveler-12": ("Force Traveller 12", 6499, "Delhi"),
    "traveler-17": ("Force Traveller 17", 7999, "Jaipur"),
    "traveler-volvo": ("Volvo Mini Coach", 12999, "Mumbai"),
}
STATIC_SUFFIXES = {".html", ".css", ".js", ".jpg", ".jpeg", ".png", ".webp", ".svg", ".ico"}

_rate_lock = threading.Lock()
_rate_events = {}


def load_dotenv():
    for env_file in (ROOT / ".env", ROOT / "razorpay.env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def razorpay_credentials_ready():
    key_id = RAZORPAY_KEY_ID
    key_secret = RAZORPAY_KEY_SECRET
    return (
        key_id.startswith(("rzp_test_", "rzp_live_"))
        and "..." not in key_id
        and bool(key_secret)
        and "..." not in key_secret
        and not key_secret.startswith(("rzp_test_", "rzp_live_"))
    )


def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_db():
    with connect_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bookings (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                vehicle_id TEXT NOT NULL,
                vehicle_name TEXT NOT NULL,
                city TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                days INTEGER NOT NULL,
                driver INTEGER NOT NULL,
                helmet INTEGER NOT NULL,
                total INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                booking_id TEXT NOT NULL REFERENCES bookings(id),
                gateway_order_id TEXT NOT NULL UNIQUE,
                gateway_payment_id TEXT UNIQUE,
                amount INTEGER NOT NULL,
                currency TEXT NOT NULL DEFAULT 'INR',
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                paid_at TEXT
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS bookings_user_dates ON bookings(user_id, end_date);
            CREATE INDEX IF NOT EXISTS payments_user_date ON payments(user_id, created_at);
        """)


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def password_hash(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def password_matches(password, encoded):
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def razorpay_request(method, endpoint, payload=None):
    if not razorpay_credentials_ready():
        raise RuntimeError("Razorpay credentials are missing or still placeholders. Add the real Key ID and separate Key Secret from Razorpay API Keys to .env or razorpay.env, then restart the server.")
    credentials = base64.b64encode(f"{RAZORPAY_KEY_ID}:{RAZORPAY_KEY_SECRET}".encode()).decode()
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        "https://api.razorpay.com/v1/" + endpoint,
        data=body,
        method=method,
        headers={"Authorization": "Basic " + credentials, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError("Payment provider rejected the request: " + detail[:300]) from error


class DurvaHandler(BaseHTTPRequestHandler):
    server_version = "DurvaServer"

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 64_000:
            raise ValueError("Invalid request size.")
        return json.loads(self.rfile.read(length))

    def check_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return
        parsed = urlparse(origin)
        allowed = os.environ.get("PUBLIC_ORIGIN", "")
        if allowed:
            valid = origin.rstrip("/") == allowed.rstrip("/")
        else:
            valid = parsed.netloc == self.headers.get("Host") and parsed.scheme in ("http", "https")
        if not valid:
            raise PermissionError("Cross-origin requests are not allowed.")

    def rate_limited(self):
        now = time.monotonic()
        address = self.client_address[0]
        with _rate_lock:
            events = [stamp for stamp in _rate_events.get(address, []) if now - stamp < 900]
            if len(events) >= 60:
                _rate_events[address] = events
                return True
            events.append(now)
            _rate_events[address] = events
        return False

    def session_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("durva_session")
        if not morsel:
            return None
        token_hash = hashlib.sha256(morsel.value.encode()).hexdigest()
        with connect_db() as db:
            row = db.execute("""
                SELECT users.id, users.name, users.email FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """, (token_hash, utc_now())).fetchone()
        return dict(row) if row else None

    def require_user(self):
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in is required."})
        return user

    def set_session(self, user_id):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        with connect_db() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (utc_now(),))
            db.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                       (token_hash, user_id, expires.isoformat()))
        cookie = f"durva_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DAYS * 86400}"
        if COOKIE_SECURE:
            cookie += "; Secure"
        return {"Set-Cookie": cookie}

    def clear_session(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("durva_session")
        if morsel:
            token_hash = hashlib.sha256(morsel.value.encode()).hexdigest()
            with connect_db() as db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        value = "durva_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        if COOKIE_SECURE:
            value += "; Secure"
        return {"Set-Cookie": value}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/me":
            user = self.session_user()
            return self.send_json(200, {"user": user})
        if path == "/api/account":
            user = self.session_user()
            if not user:
                return self.send_json(401, {"error": "Sign in is required."})
            with connect_db() as db:
                bookings = db.execute("""
                    SELECT id, vehicle_id AS vehicleId, vehicle_name AS name, city,
                           start_date AS start, end_date AS end, days, total, status
                    FROM bookings WHERE user_id = ? AND status = 'confirmed'
                    ORDER BY start_date DESC
                """, (user["id"],)).fetchall()
                payments = db.execute("""
                    SELECT booking_id AS bookingId, gateway_payment_id AS paymentId,
                           amount AS total, currency, status, created_at AS createdAt, paid_at AS paidAt
                    FROM payments WHERE user_id = ? ORDER BY created_at DESC
                """, (user["id"],)).fetchall()
            return self.send_json(200, {"bookings": [dict(row) for row in bookings],
                                        "payments": [dict(row) for row in payments]})
        return self.serve_static(path)

    def serve_static(self, path):
        relative = unquote(path).lstrip("/") or "index.html"
        target = (ROOT / relative).resolve()
        if (ROOT not in target.parents or not target.is_file() or target.name.startswith(".")
            or target.suffix.lower() not in STATIC_SUFFIXES):
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/razorpay-webhook":
            return self.handle_webhook()
        try:
            self.check_origin()
            if self.rate_limited():
                return self.send_json(429, {"error": "Too many requests. Try again shortly."})
            data = self.read_json()
            if path == "/api/register":
                return self.register(data)
            if path == "/api/login":
                return self.login(data)
            if path == "/api/logout":
                return self.send_json(200, {"ok": True}, self.clear_session())
            if path == "/api/checkout":
                return self.create_checkout(data)
            if path == "/api/payment/verify":
                return self.verify_payment(data)
            return self.send_json(404, {"error": "Not found."})
        except PermissionError as error:
            self.send_json(403, {"error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error) or "Invalid request."})
        except RuntimeError as error:
            self.send_json(503, {"error": str(error)})
        except Exception:
            self.send_json(500, {"error": "The request could not be completed."})

    def register(self, data):
        name = str(data.get("name", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        if not 2 <= len(name) <= 100 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            return self.send_json(400, {"error": "Enter a valid name and email address."})
        if not 10 <= len(password) <= 128:
            return self.send_json(400, {"error": "Password must be between 10 and 128 characters."})
        with connect_db() as db:
            try:
                result = db.execute("INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                                    (name, email, password_hash(password), utc_now()))
            except sqlite3.IntegrityError:
                return self.send_json(409, {"error": "That email is already registered."})
        headers = self.set_session(result.lastrowid)
        return self.send_json(201, {"user": {"name": name, "email": email}}, headers)

    def login(self, data):
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        with connect_db() as db:
            user = db.execute("SELECT id, name, email, password_hash FROM users WHERE email = ?", (email,)).fetchone()
        if not user or not password_matches(password, user["password_hash"]):
            return self.send_json(401, {"error": "Email or password is incorrect."})
        headers = self.set_session(user["id"])
        return self.send_json(200, {"user": {"name": user["name"], "email": user["email"]}}, headers)

    def create_checkout(self, data):
        user = self.session_user()
        if not user:
            return self.send_json(401, {"error": "Sign in before paying."})
        vehicle_id = str(data.get("vehicleId", ""))
        if vehicle_id not in VEHICLES:
            return self.send_json(400, {"error": "Choose a valid vehicle."})
        try:
            start = date.fromisoformat(str(data.get("start", "")))
            end = date.fromisoformat(str(data.get("end", "")))
        except ValueError:
            return self.send_json(400, {"error": "Enter valid pickup and return dates."})
        days = (end - start).days
        if start < date.today() or not 1 <= days <= 30:
            return self.send_json(400, {"error": "Rental dates must be in the future and between 1 and 30 days apart."})
        driver = bool(data.get("driver"))
        helmet = bool(data.get("helmet"))
        name, daily_price, city = VEHICLES[vehicle_id]
        extras = (1200 * days if driver else 0) + (99 if helmet else 0)
        subtotal = daily_price * days + 299 * days + extras
        gst = (subtotal * 18 + 50) // 100
        total = subtotal + gst
        booking_id = "DV" + secrets.token_hex(5).upper()
        order = razorpay_request("POST", "orders", {
            "amount": total * 100,
            "currency": "INR",
            "receipt": booking_id,
            "notes": {"booking_id": booking_id, "user_id": str(user["id"])},
        })
        with connect_db() as db:
            db.execute("""
                INSERT INTO bookings (id, user_id, vehicle_id, vehicle_name, city, start_date,
                    end_date, days, driver, helmet, total, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            """, (booking_id, user["id"], vehicle_id, name, city,
                  start.isoformat(), end.isoformat(), days, int(driver), int(helmet), total, utc_now()))
            db.execute("""
                INSERT INTO payments (user_id, booking_id, gateway_order_id, amount, status, created_at)
                VALUES (?, ?, ?, ?, 'pending', ?)
            """, (user["id"], booking_id, order["id"], total, utc_now()))
        return self.send_json(200, {"keyId": RAZORPAY_KEY_ID, "orderId": order["id"],
                                    "amount": order["amount"], "currency": order["currency"],
                                    "bookingId": booking_id, "name": name,
                                    "email": user["email"], "customerName": user["name"]})

    def verify_payment(self, data):
        user = self.session_user()
        if not user:
            return self.send_json(401, {"error": "Sign in is required."})
        order_id = str(data.get("razorpay_order_id", ""))
        payment_id = str(data.get("razorpay_payment_id", ""))
        signature = str(data.get("razorpay_signature", ""))
        if (not re.fullmatch(r"order_[A-Za-z0-9]+", order_id)
                or not re.fullmatch(r"pay_[A-Za-z0-9]+", payment_id)
                or not re.fullmatch(r"[a-fA-F0-9]{64}", signature)):
            return self.send_json(400, {"error": "Invalid payment verification details."})
        expected = hmac.new(RAZORPAY_KEY_SECRET.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
        if not RAZORPAY_KEY_SECRET or not hmac.compare_digest(expected, signature):
            return self.send_json(400, {"error": "Payment signature could not be verified."})
        with connect_db() as db:
            payment = db.execute("SELECT * FROM payments WHERE gateway_order_id = ? AND user_id = ?",
                                 (order_id, user["id"])).fetchone()
        if not payment:
            return self.send_json(404, {"error": "Payment order not found."})
        provider_payment = razorpay_request("GET", "payments/" + payment_id)
        if (provider_payment.get("order_id") != order_id or provider_payment.get("status") != "captured"
                or provider_payment.get("amount") != payment["amount"] * 100
                or provider_payment.get("currency") != "INR"):
            return self.send_json(400, {"error": "Payment is not captured for this booking."})
        self.mark_paid(order_id, payment_id)
        return self.send_json(200, {"ok": True, "bookingId": payment["booking_id"]})

    def mark_paid(self, order_id, payment_id, amount=None, currency="INR"):
        paid_at = utc_now()
        with connect_db() as db:
            row = db.execute("SELECT booking_id, amount, currency, status FROM payments WHERE gateway_order_id = ?",
                             (order_id,)).fetchone()
            if not row:
                return
            if row["status"] == "paid":
                return
            if currency != row["currency"] or (amount is not None and amount != row["amount"] * 100):
                return
            db.execute("UPDATE payments SET gateway_payment_id = ?, status = 'paid', paid_at = ? WHERE gateway_order_id = ?",
                       (payment_id, paid_at, order_id))
            db.execute("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'pending'",
                       (row["booking_id"],))

    def mark_failed(self, order_id, payment_id):
        with connect_db() as db:
            row = db.execute("SELECT booking_id, status FROM payments WHERE gateway_order_id = ?",
                             (order_id,)).fetchone()
            if not row or row["status"] != "pending":
                return
            db.execute("UPDATE payments SET gateway_payment_id = ?, status = 'failed' WHERE gateway_order_id = ?",
                       (payment_id, order_id))
            db.execute("UPDATE bookings SET status = 'failed' WHERE id = ? AND status = 'pending'",
                       (row["booking_id"],))

    def handle_webhook(self):
        if not RAZORPAY_WEBHOOK_SECRET:
            return self.send_json(503, {"error": "Webhook secret is not configured."})
        length = int(self.headers.get("Content-Length", "0"))
        if not 1 <= length <= 64_000:
            return self.send_json(400, {"error": "Invalid webhook size."})
        body = self.rfile.read(length)
        signature = self.headers.get("X-Razorpay-Signature", "")
        expected = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return self.send_json(400, {"error": "Invalid webhook signature."})
        event = json.loads(body)
        if event.get("event") == "payment.captured":
            payment = event.get("payload", {}).get("payment", {}).get("entity", {})
            if payment.get("id") and payment.get("order_id"):
                self.mark_paid(payment["order_id"], payment["id"], payment.get("amount"), payment.get("currency"))
        elif event.get("event") == "payment.failed":
            payment = event.get("payload", {}).get("payment", {}).get("entity", {})
            if payment.get("id") and payment.get("order_id"):
                self.mark_failed(payment["order_id"], payment["id"])
        return self.send_json(200, {"ok": True})


def main():
    load_dotenv()
    global RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, COOKIE_SECURE
    RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
    RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
    RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")
    COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
    initialize_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print(f"Durva site running at http://{host}:{port}")
    ThreadingHTTPServer((host, port), DurvaHandler).serve_forever()


if __name__ == "__main__":
    main()