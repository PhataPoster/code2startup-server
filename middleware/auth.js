// code2startup_server/middleware/auth.js
//
// JWT verification middleware for the Express server.
//
// The Next.js client (Better Auth + jwtClient plugin) issues a JWT for the
// signed-in user via GET /api/auth/token. The token is signed with an
// asymmetric EdDSA (Ed25519) keypair generated and stored by Better Auth
// itself; the PUBLIC key is published at GET /api/auth/jwks.
//
// We therefore verify tokens against the JWKS endpoint (not against
// BETTER_AUTH_SECRET). BETTER_AUTH_SECRET is only used by Better Auth
// internally to encrypt the private key in the DB — it is not a JWT
// signing secret.
//
// The token is accepted from either:
//   - the Authorization: Bearer <token> header, or
//   - the auth_token cookie (set by the client after login).

const { jwtVerify, createRemoteJWKSet } = require("jose");

// Base URL of the Next.js app that hosts Better Auth.
// Defaults to localhost:3000 in dev; override via BETTER_AUTH_URL on the
// server's .env when deploying.
const AUTH_BASE_URL = (
  process.env.BETTER_AUTH_URL ||
  process.env.CLIENT_URL ||
  "http://localhost:3000"
).replace(/\/+$/, "");

const JWKS_URL = new URL(`${AUTH_BASE_URL}/api/auth/jwks`);

// Allow 'EdDSA' only (Better Auth's default). The endpoint publishes the
// algorithm in each key's `alg` field so this is safe and explicit.
const JWKS = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000, // cache JWKS for 30s to avoid hammering
});

// Better Auth defaults `iss` and `aud` to the auth baseURL when neither is
// overridden. We mirror that here so jwtVerify doesn't reject on iss/aud
// mismatch.
const ISSUER = AUTH_BASE_URL;
const AUDIENCE = AUTH_BASE_URL;

/**
 * Extracts the JWT from the incoming request.
 * Order of precedence: Authorization header -> auth_token cookie.
 */
function extractToken(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (req.cookies) {
    return (
      req.cookies.auth_token ||
      req.cookies["better-auth.session_token"] ||
      req.cookies.session_token ||
      null
    );
  }
  return null;
}

/**
 * requireAuth — verifies the JWT against Better Auth's JWKS and attaches
 * the resolved user to req.user. Returns 401 if the token is missing or
 * invalid.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    // Better Auth's jwtClient signs the session user as the JWT payload.
    // `sub` is the user id (set via setSubject in signJWT). `email` and
    // `role` come from the user record when the user is loaded into
    // ctx.context.session.user.
    req.user = {
      id: payload.sub || payload.userId || payload.id,
      email: payload.email,
      role: payload.role || "collaborator",
      isBlocked: payload.isBlocked === true,
      name: payload.name,
    };
    return next();
  } catch (err) {
    console.warn(
      "[auth] token rejected:",
      err?.code || err?.name,
      err?.message?.slice(0, 120)
    );
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
}

/**
 * requireRole(...allowed) — must be used after requireAuth.
 * 403 if the user role is not in the allowed list.
 */
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: requires one of [${allowed.join(", ")}]`,
      });
    }
    if (req.user.isBlocked) {
      return res
        .status(403)
        .json({ success: false, message: "Account is blocked" });
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
  extractToken,
};