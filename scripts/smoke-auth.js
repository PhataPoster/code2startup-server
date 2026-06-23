// scripts/smoke-auth.js
// End-to-end smoke test for the auth flow:
//  1) Sign up a fresh test user via Better Auth (assign role=founder in DB)
//  2) Mint a JWT via /api/auth/token (with the session cookie)
//  3) POST /api/opportunities with Authorization: Bearer <jwt>
//
// Re-runnable: each run uses a unique email like smoke+founder+<ts>@test.local.

const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const API = process.env.SMOKE_API || "http://localhost:5000";
const MONGO_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://code2startup:A79c13Uh3GeiSwqL@cluster0.emrrkcd.mongodb.net/?appName=Cluster0";
const DB_NAME = process.env.MONGODB_DB || "code2startup";

const PASSWORD = "Smoke1234!";
const EMAIL = `smoke+founder+${Date.now()}@test.local`;
const NAME = "Smoke Founder";

const jar = {};

function getCookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}
function captureCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

async function step(label, fn) {
  console.log(`\n=== ${label} ===`);
  const out = await fn();
  console.log(JSON.stringify(out, null, 2));
  return out;
}

(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCol = db.collection("user");

  try {
    // 1) sign up
    const signup = await step("signup", async () => {
      const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          referer: BASE + "/",
        },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME }),
      });
      captureCookies(res);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    });
    if (signup.status !== 200) {
      console.error("Signup failed.");
      process.exit(1);
    }

    // 2) promote to founder in DB (Better Auth has no role on signup form)
    await step("promote-to-founder", async () => {
      const r = await usersCol.updateOne(
        { email: EMAIL },
        { $set: { role: "founder" } }
      );
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });

    // 3) mint a JWT
    const tok = await step("token", async () => {
      const res = await fetch(`${BASE}/api/auth/token`, {
        method: "GET",
        headers: { cookie: getCookieHeader() },
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    });
    if (tok.status !== 200 || !tok.body?.token) {
      console.error("Token mint failed.");
      process.exit(1);
    }
    const jwt = tok.body.token;
    const [, payload] = jwt.split(".");
    console.log("\n=== jwt payload (decoded) ===");
    console.log(
      JSON.stringify(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        null,
        2
      )
    );

    // 4) create a startup first (the route requires startup_id as ObjectId)
    const startup = await step("POST /startups", async () => {
      const res = await fetch(`${API}/startups`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          startup_name: `Smoke Startup ${Date.now()}`,
          industry: "AI",
          stage: "Idea",
          description: "Created by scripts/smoke-auth.js",
        }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    });
    const startupId = startup.body?.data?._id || startup.body?.startup?._id || startup.body?._id;
    if (!startupId) {
      console.error("Could not create a startup; aborting.");
      process.exit(1);
    }

    // 5) post an opportunity bound to that startup
    const post = await step("POST /opportunities", async () => {
      const res = await fetch(`${API}/opportunities`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          startup_id: startupId,
          role_title: "Smoke test role",
          description: "Created by scripts/smoke-auth.js",
          type: "Internship",
          location: "Remote",
        }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    });

    console.log("\nFinal:", post.status);

    // best-effort cleanup of test data
    try {
      if (startupId) {
        await db.collection("opportunities").deleteMany({ startup_id: new (require("mongodb").ObjectId)(startupId) });
        await db.collection("startups").deleteOne({ _id: new (require("mongodb").ObjectId)(startupId) });
      }
    } catch {}

    process.exit(post.status === 200 || post.status === 201 ? 0 : 1);
  } finally {
    // best-effort cleanup of the test user
    try { await usersCol.deleteOne({ email: EMAIL }); } catch {}
    await client.close();
  }
})().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(2);
});
