const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://kiromanoska.github.io,http://localhost:3000").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); return cb(new Error("Origin not allowed by CORS")); } }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
}) : null;
const cache = new Map();
function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return loader().then(value => { cache.set(key, { value, expires: Date.now() + ttlMs }); return value; });
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: "database_unconfigured", message: "Account storage is not configured. DATABASE_URL is required." });
  if (!JWT_SECRET) return res.status(503).json({ error: "auth_unconfigured", message: "Authentication is not configured. JWT_SECRET is required." });
  next();
}
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try { if (!token || !JWT_SECRET) throw new Error("missing token"); req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "unauthorized", message: "Please sign in again." }); }
}
app.get("/health", (req, res) => res.json({ status: "ok", service: "live-earth-api", time: new Date().toISOString(), database: pool ? "configured" : "not_configured" }));
app.get("/api/status", (req, res) => res.json({
  service: "LIVE EARTH API",
  status: "online",
  features: {
    weather: { available: true, source: "Open-Meteo" },
    satellites: { available: true, source: "CelesTrak public GP/TLE data; propagated server-side" },
    ais: { available: Boolean(process.env.AIS_API_URL && process.env.AIS_API_KEY), source: process.env.AIS_API_URL ? "Configured AIS provider" : null, status: process.env.AIS_API_URL && process.env.AIS_API_KEY ? "configured" : "not_configured" },
    geography: { available: true, source: "Natural Earth GeoJSON via public geoBoundaries dataset" },
    accounts: { available: Boolean(pool && JWT_SECRET), status: pool && JWT_SECRET ? "configured" : "not_configured" }
  }
}));
app.get("/api/weather", asyncRoute(async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return res.status(400).json({ error: "invalid_coordinates", message: "Provide valid lat and lon." });
  const data = await cached("weather:" + lat.toFixed(2) + ":" + lon.toFixed(2), 10 * 60_000, async () => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m", daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max", forecast_days: "3", timezone: "auto" }).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error("Weather provider returned HTTP " + r.status);
    return r.json();
  });
  res.json({ source: "Open-Meteo", fetchedAt: new Date().toISOString(), coordinates: { lat, lon }, data });
}));
app.get("/api/satellites", asyncRoute(async (req, res) => {
  const group = String(req.query.group || "stations");
  const allowed = new Set(["stations", "starlink", "active", "weather", "gps"]);
  if (!allowed.has(group)) return res.status(400).json({ error: "invalid_group", allowed: [...allowed] });
  const data = await cached("satellites:" + group, 5 * 60_000, async () => {
    const url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=" + encodeURIComponent(group) + "&FORMAT=JSON";
    const r = await fetch(url, { headers: { "User-Agent": "LIVE-EARTH/0.2 contact: project repository" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("CelesTrak returned HTTP " + r.status);
    const json = await r.json();
    return json.slice(0, 500).map(s => ({ name: s.OBJECT_NAME, noradId: s.NORAD_CAT_ID, epoch: s.EPOCH, meanMotion: s.MEAN_MOTION, inclination: s.INCLINATION, eccentricity: s.ECCENTRICITY, tle: null }));
  });
  res.json({ source: "CelesTrak GP data", fetchedAt: new Date().toISOString(), group, count: data.length, note: "These are orbital elements, not live latitude/longitude. Position propagation is not yet enabled in this release.", satellites: data });
}));
app.get("/api/ships", asyncRoute(async (req, res) => {
  if (!process.env.AIS_API_URL || !process.env.AIS_API_KEY) return res.status(503).json({
    error: "ais_provider_not_configured",
    status: "unavailable",
    message: "Live AIS is not configured. Set AIS_API_URL and AIS_API_KEY for a licensed provider. No simulated ship positions are returned."
  });
  const u = new URL(process.env.AIS_API_URL);
  for (const key of ["lat", "lon", "radius"]) if (req.query[key] !== undefined) u.searchParams.set(key, String(req.query[key]));
  const r = await fetch(u, { headers: { Authorization: "Bearer " + process.env.AIS_API_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("AIS provider returned HTTP " + r.status);
  res.json({ source: "Configured AIS provider", fetchedAt: new Date().toISOString(), data: await r.json() });
}));
app.get("/api/geography/countries", asyncRoute(async (req, res) => {
  const url = "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
  const data = await cached("geo:countries", 24 * 60 * 60_000, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("Country boundary source returned HTTP " + r.status);
    return r.json();
  });
  res.json({ source: "datasets/geo-countries (Natural Earth-derived)", fetchedAt: new Date().toISOString(), type: data.type, features: data.features });
}));
app.post("/api/auth/register", requireDb, asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "invalid_email" });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: "invalid_password", message: "Password must be 10–128 characters." });
  await pool.query("CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email,created_at", [email, hash]);
    const token = jwt.sign({ sub: String(rows[0].id), email: rows[0].email }, JWT_SECRET, { expiresIn: "7d", issuer: "live-earth-api", audience: "live-earth" });
    res.status(201).json({ user: rows[0], token });
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "email_already_registered" }); throw e; }
}));
app.post("/api/auth/login", requireDb, asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const { rows } = await pool.query("SELECT id,email,password_hash,created_at FROM users WHERE email=$1", [email]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: "invalid_credentials" });
  const user = { id: rows[0].id, email: rows[0].email, created_at: rows[0].created_at };
  const token = jwt.sign({ sub: String(user.id), email: user.email }, JWT_SECRET, { expiresIn: "7d", issuer: "live-earth-api", audience: "live-earth" });
  res.json({ user, token });
}));
app.get("/api/me", requireDb, auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query("SELECT id,email,created_at FROM users WHERE id=$1", [req.user.sub]);
  if (!rows.length) return res.status(404).json({ error: "user_not_found" });
  res.json({ user: rows[0] });
}));
app.get("/", (req, res) => res.json({ name: "LIVE EARTH API", docs: "See /health and /api/status", version: "0.2.0" }));
app.use((err, req, res, next) => {
  console.error("[api-error]", err.message);
  if (res.headersSent) return next(err);
  res.status(err.name === "AbortError" || err.name === "TimeoutError" ? 504 : 502).json({ error: "upstream_or_server_error", message: "The request could not be completed. Try again later." });
});
app.listen(PORT, () => console.log("LIVE EARTH API listening on " + PORT));
