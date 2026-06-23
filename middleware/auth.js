// code2startup_server/middleware/auth.js
// JWT verification middleware for the Express server.
//
// The Next.js client signs the user in with Better Auth, then we issue a
// short JWT that is sent as an HTTPOnly cookie (set by the client after login)
// OR via the Authorization: Bearer <token> header.
//
// This middleware verifies the token using the SAME Better Auth secret
// (BETTER_AUTH_SECRET) — jose is configured with HS256 to match.

const { jwtVerify } = require("jose");

const secret = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || "fallback-dev-secret-change-me"
);

/**
 * Extracts the JWT from the incoming request.
 * Order of precedence: Authorization header -> auth_token cookie.
 */
function extractToken(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  // cookie-parser puts cookies on req.cookies
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
 * requireAuth — verifies the JWT and attaches the payload to req.user.
 * Returns 401 if the token is missing or invalid.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  }

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role || "collaborator",
      isBlocked: payload.isBlocked === true,
    };
    return next();
  } catch (err) {
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

module.exports = { requireAuth, requireRole, extractToken };