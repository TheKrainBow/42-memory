import crypto from "crypto";
import db from "./db.js";

const FT_AUTHORIZE_URL = "https://api.intra.42.fr/oauth/authorize";
const FT_TOKEN_URL = "https://api.intra.42.fr/oauth/token";
const FT_API_URL = "https://api.intra.42.fr/v2";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export const FT_CLIENT_ID = process.env.FT_CLIENT_ID || "";
const FT_CLIENT_SECRET = process.env.FT_CLIENT_SECRET || "";

export const COALITIONS = ["HORDE", "ALLIANCE"];

function nowIso() {
  return new Date().toISOString();
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name) {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function isSecureRequest(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

export function setCookie(res, req, name, value, maxAgeSeconds) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // SameSite=None keeps the session usable when the pages run inside an
  // iframe, but browsers only accept it with Secure — fall back to Lax on http.
  if (isSecureRequest(req)) {
    attrs.push("SameSite=None", "Secure");
  } else {
    attrs.push("SameSite=Lax");
  }
  const previous = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", previous ? [].concat(previous, attrs.join("; ")) : attrs.join("; "));
}

function redirectUri(req) {
  if (process.env.FT_REDIRECT_URI) {
    return process.env.FT_REDIRECT_URI;
  }
  const proto = isSecureRequest(req) ? "https" : "http";
  return `${proto}://${req.headers.host}/auth/42/callback`;
}

export function buildAuthorizeUrl(req, state) {
  const params = new URLSearchParams({
    client_id: FT_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "public",
    state,
  });
  return `${FT_AUTHORIZE_URL}?${params}`;
}

export async function exchangeCode(req, code) {
  const response = await fetch(FT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: FT_CLIENT_ID,
      client_secret: FT_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(req),
    }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status})`);
  }
  return response.json();
}

async function fetchIntra(path, accessToken) {
  const response = await fetch(`${FT_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Intra call ${path} failed (${response.status})`);
  }
  return response.json();
}

// A user can belong to up to two coalitions (Horde/Alliance and
// Harkonnen/Corrino/Atreides); only Horde/Alliance matters for the games.
function pickCoalition(coalitions) {
  for (const item of coalitions ?? []) {
    const name = String(item?.name || "").toLowerCase();
    if (name.includes("horde")) {
      return "HORDE";
    }
    if (name.includes("alliance")) {
      return "ALLIANCE";
    }
  }
  return null;
}

export async function fetchIntraProfile(accessToken) {
  const me = await fetchIntra("/me", accessToken);
  let coalition = null;
  try {
    coalition = pickCoalition(await fetchIntra(`/users/${me.id}/coalitions`, accessToken));
  } catch {
    // Coalition stays null: the user will pick one manually.
  }
  return {
    id: me.id,
    login: me.login,
    displayName: me.usual_full_name || me.displayname || me.login,
    imageUrl: me.image?.versions?.small || me.image?.link || "",
    coalition,
  };
}

export function upsertUser(profile) {
  const existing = db.prepare(`SELECT * FROM users WHERE id = ?`).get(profile.id);
  if (existing) {
    // An intra coalition always wins; otherwise keep a previous manual choice.
    const coalition = profile.coalition || existing.coalition;
    const source = profile.coalition ? "intra" : existing.coalition_source;
    db.prepare(`
      UPDATE users
      SET login = ?, display_name = ?, image_url = ?, coalition = ?, coalition_source = ?, updated_at = ?
      WHERE id = ?
    `).run(profile.login, profile.displayName, profile.imageUrl, coalition, source, nowIso(), profile.id);
  } else {
    db.prepare(`
      INSERT INTO users (id, login, display_name, image_url, coalition, coalition_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.id,
      profile.login,
      profile.displayName,
      profile.imageUrl,
      profile.coalition,
      profile.coalition ? "intra" : null,
      nowIso(),
      nowIso()
    );
  }
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(profile.id);
}

export function setUserCoalition(userId, coalition) {
  db.prepare(`
    UPDATE users
    SET coalition = ?, coalition_source = 'choice', updated_at = ?
    WHERE id = ?
  `).run(coalition, nowIso(), userId);
}

export function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, userId, nowIso());
  setCookie(res, req, "sid", token, SESSION_MAX_AGE_S);
}

export function getSessionUser(req) {
  const token = parseCookies(req).sid;
  if (!token) {
    return null;
  }
  return db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token) || null;
}

export function destroySession(req, res) {
  const token = parseCookies(req).sid;
  if (token) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  }
  setCookie(res, req, "sid", "", 0);
}

export function publicUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
    imageUrl: user.image_url,
    coalition: user.coalition,
    coalitionLocked: user.coalition_source === "intra",
    needsCoalition: !user.coalition,
  };
}
