const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { createClient } = require("@supabase/supabase-js");

const pbkdf2 = promisify(crypto.pbkdf2);
const iterations = 310000;
const sessionDays = 14;
const vehicles = {
  "car-swift": ["Maruti Swift", 1899, "Mumbai"],
  "car-city": ["Honda City", 2599, "Delhi"],
  "car-innova": ["Toyota Innova Crysta", 4299, "Bengaluru"],
  "car-thar": ["Mahindra Thar", 3999, "Jaipur"],
  "car-bmw": ["BMW 3 Series", 8999, "Mumbai"],
  "scooty-activa": ["Honda Activa 6G", 499, "Goa"],
  "scooty-jupiter": ["TVS Jupiter", 449, "Pune"],
  "scooty-ather": ["Ather 450X", 799, "Bengaluru"],
  "scooty-vespa": ["Vespa SXL 150", 899, "Goa"],
  "traveler-12": ["Force Traveller 12", 6499, "Delhi"],
  "traveler-17": ["Force Traveller 17", 7999, "Jaipur"],
  "traveler-volvo": ["Volvo Mini Coach", 12999, "Mumbai"]
};

function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify environment variables."), { status: 503 });
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function response(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders },
    body: JSON.stringify(data)
  };
}

function fail(error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const message = status === 500 ? "The request could not be completed." : error.message;
  return response(status, { error: message });
}

function readBody(event) {
  if (!event.body) throw Object.assign(new Error("Request body is required."), { status: 400 });
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(raw) > 64000) throw Object.assign(new Error("Request is too large."), { status: 413 });
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("Request must contain valid JSON."), { status: 400 }); }
}

function assertSameOrigin(event) {
  const origin = event.headers?.origin;
  if (!origin) return;
  const configured = process.env.PUBLIC_ORIGIN;
  const host = event.headers?.["x-forwarded-host"] || event.headers?.host;
  try {
    const allowed = configured ? new URL(configured).origin : (host ? `https://${host}` : null);
    if (!allowed || new URL(origin).origin !== allowed) throw new Error();
  } catch {
    throw Object.assign(new Error("Cross-origin request denied."), { status: 403 });
  }
}

function cookieValue(event, name) {
  const cookies = event.headers?.cookie || event.headers?.Cookie || "";
  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `durva_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function createSession(client, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 86400000).toISOString();
  const { error } = await client.from("sessions").insert({
    token_hash: crypto.createHash("sha256").update(token).digest("hex"),
    user_id: userId,
    expires_at: expiresAt
  });
  if (error) throw error;
  return sessionCookie(token, sessionDays * 86400);
}

async function currentUser(event, client = db()) {
  const token = cookieValue(event, "durva_session");
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const { data: session, error: sessionError } = await client.from("sessions")
    .select("user_id").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;
  const { data: user, error } = await client.from("users").select("id,name,email").eq("id", session.user_id).maybeSingle();
  if (error) throw error;
  return user || null;
}

async function requireUser(event, client) {
  const user = await currentUser(event, client);
  if (!user) throw Object.assign(new Error("Sign in is required."), { status: 401 });
  return user;
}

async function passwordHash(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = await pbkdf2(password, actualSalt, iterations, 32, "sha256");
  return { salt: actualSalt, hash: hash.toString("hex") };
}

function razorpayReady() {
  const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: secret } = process.env;
  return Boolean(keyId && secret && /^(rzp_test_|rzp_live_)/.test(keyId) && !keyId.includes("...") && !secret.includes("...") && !/^(rzp_test_|rzp_live_)/.test(secret));
}

async function razorpayRequest(method, endpoint, body) {
  if (!razorpayReady()) throw Object.assign(new Error("Razorpay keys are missing or placeholders. Add the real Key ID and separate Key Secret in Netlify environment variables."), { status: 503 });
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const result = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error("Razorpay could not complete the request. Check the server-side API keys and Razorpay mode."), { status: 502 });
  return data;
}

function nowIso() { return new Date().toISOString(); }

module.exports = {
  assertSameOrigin, cookieValue, createSession, currentUser, db, fail, nowIso, passwordHash,
  razorpayReady, razorpayRequest, readBody, requireUser, response, sessionCookie, vehicles
};