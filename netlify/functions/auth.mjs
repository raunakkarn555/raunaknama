// netlify/functions/auth.mjs
//
// Site-wide password gate.
//
// The password itself is NEVER hardcoded here or shipped to the browser —
// it lives only in the server's environment variables (SITE_PASSWORD, set
// in Netlify's dashboard or a local .env for `netlify dev`, see
// .env.example). The frontend only ever sends what the visitor typed and
// gets back a yes/no plus, on success, a signed session cookie.
//
// GET  /api/auth  -> { authenticated: boolean } based on the session cookie.
// POST /api/auth  -> { password } in the body. On match, sets an HttpOnly
//                     session cookie (signed, 7-day expiry) and returns
//                     { authenticated: true }. On mismatch, 401.
//
// The cookie holds only an expiry timestamp plus an HMAC signature (using
// a second secret, SITE_AUTH_SECRET) — never the password itself — so it
// can't be forged or reversed into the password, but a browser that
// already has a valid cookie won't be asked again until it expires. A
// browser with no cookie (e.g. a new device) always gets asked.

import crypto from "node:crypto";

const SESSION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const COOKIE_NAME = "rn_auth";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw Object.assign(new Error(`${name} is not set on the server`), {
      status: 500,
    });
  }
  return value;
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Constant-time string compare, used both for the password check and the
// cookie signature check so neither leaks timing information.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length buffers so the time taken
    // doesn't reveal the length mismatch either.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueToken(secret) {
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  const payload = String(expiresAt);
  return `${payload}.${sign(payload, secret)}`;
}

function isTokenValid(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return false;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) {
    return false;
  }
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  // HttpOnly: JavaScript can't read it (nothing to leak client-side).
  // Secure: only sent over HTTPS.
  // SameSite=Lax: sent on normal same-site navigation, not cross-site.
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${SESSION_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: {}, body: "" };
  }

  let authSecret;
  try {
    authSecret = requireEnv("SITE_AUTH_SECRET");
  } catch (err) {
    console.error("[auth] misconfigured:", err.message);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Auth is not configured on the server" }),
    };
  }

  if (event.httpMethod === "GET") {
    const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
    const authenticated = isTokenValid(cookies[COOKIE_NAME], authSecret);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ authenticated }),
    };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Invalid request body" }),
      };
    }

    let sitePassword;
    try {
      sitePassword = requireEnv("SITE_PASSWORD");
    } catch (err) {
      console.error("[auth] misconfigured:", err.message);
      return {
        statusCode: 500,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Auth is not configured on the server" }),
      };
    }

    const { password } = body;
    if (typeof password !== "string" || !password || !safeEqual(password, sitePassword)) {
      return {
        statusCode: 401,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Incorrect password. Try again." }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...JSON_HEADERS,
        "Set-Cookie": sessionCookie(issueToken(authSecret)),
      },
      body: JSON.stringify({ authenticated: true }),
    };
  }

  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};
