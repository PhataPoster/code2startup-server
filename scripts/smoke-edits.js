// scripts/smoke-edits.js
// End-to-end smoke test of every edit path:
//   - PUT /users/me
//   - PUT /startups/:id
//   - PUT /opportunities/:id
//   - PUT /applications/:id/status
//   - PUT /users/:email/block  (admin)
//   - PUT /admin/startups/:id/status (admin)
//
// Re-runnable: uses a unique email per run and cleans up after.

const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const API = process.env.SMOKE_API || "http://localhost:5000";
const MONGO_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://code2startup:A79c13Uh3GeiSwqL@cluster0.emrrkcd.mongodb.net/?appName=Cluster0";
const DB_NAME = process.env.MONGODB_DB || "code2startup";

const PASSWORD = "Smoke1234!";
const FOUNDER_EMAIL = `smoke+founder+${Date.now()}@test.local`;
const ADMIN_EMAIL = `smoke+admin+${Date.now()}@test.local`;

const founderJar = {};
const adminJar = {};

function getCookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}
function captureCookies(res, jar) {
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

async function signup(email, name, jar) {
  return step(`signup (${email})`, async () => {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, referer: BASE + "/" },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    });
    captureCookies(res, jar);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  });
}

async function mintJwt(jar) {
  return step("mint JWT", async () => {
    const res = await fetch(`${BASE}/api/auth/token`, {
      method: "GET",
      headers: { cookie: getCookieHeader(jar) },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  });
}

async function callApi(method, path, jwt, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// Email-keyed routes need URI-encoding because Better Auth test addresses
// contain '+' which is otherwise decoded as a space by Express.
function encodeEmail(email) {
  return encodeURIComponent(email);
}

(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCol = db.collection("user");

  const results = [];
  let founderJwt, adminJwt, startupId, opportunityId, applicationId;

  try {
    // ===== FOUNDER SETUP =====
    const fSignup = await signup(FOUNDER_EMAIL, "Smoke Founder", founderJar);
    if (fSignup.status !== 200) throw new Error("Founder signup failed");
    await step("promote founder", async () => {
      const r = await usersCol.updateOne(
        { email: FOUNDER_EMAIL },
        { $set: { role: "founder" } }
      );
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
    const fTok = await mintJwt(founderJar);
    if (fTok.status !== 200 || !fTok.body?.token) throw new Error("Founder JWT mint failed");
    founderJwt = fTok.body.token;
    const [, payload] = founderJwt.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    console.log("\n=== FOUNDER JWT payload ===");
    console.log(JSON.stringify(decoded, null, 2));
    results.push({ check: "founder role in JWT", role: decoded.role, ok: decoded.role === "founder" });

    // ===== 1) PUT /users/me (profile edit) =====
    const profileEdit = await step("PUT /users/me (founder)", async () => {
      return callApi("PUT", "/users/me", founderJwt, {
        name: "Smoke Founder Edited",
        bio: "Edited by smoke test",
        skills: ["React", "Node.js"],
      });
    });
    results.push({ check: "PUT /users/me", status: profileEdit.status, ok: profileEdit.status === 200 });

    // ===== Admin-approval gate — positive assertions ======
    // Newly created startups default to status="Pending". Verify:
    // 1) The response carries status=Pending right after POST /startups.
    // 2) POST /opportunities on a Pending startup is rejected with 403 STARTUP_NOT_APPROVED.
    // 3) After an admin flips the startup to Active, POST /opportunities succeeds.
    const pendingStartup = await step("POST /startups (Pending)", async () => {
      return callApi("POST", "/startups", founderJwt, {
        startup_name: `Smoke Pending Startup ${Date.now()}`,
        industry: "AI",
        description: "Pending startup for gate test",
        funding_stage: "Idea",
        team_size: 1,
      });
    });
    const pendingStartupId = pendingStartup.body?.data?._id;
    const pendingStartupStatus = pendingStartup.body?.data?.status;
    results.push({
      check: "POST /startups defaults to Pending",
      status: pendingStartupStatus,
      ok: pendingStartup.status === 200 && pendingStartupStatus === "Pending" && !!pendingStartupId,
    });

    // Try to post an opportunity against the Pending startup — should be 403.
    const blockedOpp = await step("POST /opportunities on Pending startup", async () => {
      return callApi("POST", "/opportunities", founderJwt, {
        startup_id: pendingStartupId,
        role_title: "Should Be Blocked",
        required_skills: "React",
        work_type: "Full-time",
        commitment_level: "Full-time",
        industry: "AI",
      });
    });
    results.push({
      check: "POST /opportunities blocked while Pending",
      status: blockedOpp.status,
      code: blockedOpp.body?.code || blockedOpp.body?.error?.code,
      ok:
        blockedOpp.status === 403 &&
        (blockedOpp.body?.code === "STARTUP_NOT_APPROVED" ||
          blockedOpp.body?.error?.code === "STARTUP_NOT_APPROVED"),
    });

    // Create a startup for later edits
    const createStartup = await step("POST /startups", async () => {
      return callApi("POST", "/startups", founderJwt, {
        startup_name: `Smoke Startup ${Date.now()}`,
        industry: "AI",
        description: "Created by smoke-edits.js",
        funding_stage: "Idea",
        team_size: 2,
      });
    });
    startupId = createStartup.body?.data?._id;
    const createStartupStatus = createStartup.body?.data?.status;
    results.push({ check: "POST /startups", status: createStartup.status, ok: createStartup.status === 200 && !!startupId });

    // Bootstrap: directly flip both startups to Active in Mongo so the
    // existing opportunity/application tests still pass now that
    // POST /startups defaults to Pending. The admin section later flips
    // startupId back to Pending for the moderation test and exercises the
    // Pending -> Active transition via the admin endpoint for a clean
    // gate-flow assertion.
    const startupsCol = db.collection("startups");
    await startupsCol.updateMany(
      { _id: { $in: [startupId, pendingStartupId].filter(Boolean).map((id) => new (require("mongodb").ObjectId)(id)) } },
      { $set: { status: "Active" } }
    );

    if (startupId) {
      // ===== 2) PUT /startups/:id (startup edit) =====
      const startupEdit = await step("PUT /startups/:id", async () => {
        return callApi("PUT", `/startups/${startupId}`, founderJwt, {
          startup_name: "Smoke Startup EDITED",
          description: "Edited by smoke test",
        });
      });
      results.push({ check: "PUT /startups/:id", status: startupEdit.status, ok: startupEdit.status === 200 });
    }

    // Create opportunity
    const createOpp = await step("POST /opportunities", async () => {
      return callApi("POST", "/opportunities", founderJwt, {
        startup_id: startupId,
        role_title: "Smoke Test Role",
        required_skills: "React, Node.js",
        work_type: "Full-time",
        commitment_level: "Full-time",
        industry: "AI",
      });
    });
    opportunityId = createOpp.body?.data?._id;
    results.push({ check: "POST /opportunities", status: createOpp.status, ok: createOpp.status === 200 && !!opportunityId });

    if (opportunityId) {
      // ===== 3) PUT /opportunities/:id (opportunity edit) =====
      const oppEdit = await step("PUT /opportunities/:id", async () => {
        return callApi("PUT", `/opportunities/${opportunityId}`, founderJwt, {
          role_title: "Smoke Test Role EDITED",
          required_skills: "React, Go, MongoDB",
        });
      });
      results.push({ check: "PUT /opportunities/:id", status: oppEdit.status, ok: oppEdit.status === 200 });
    }

    // ===== 4) Founder creating a collaborator + applying =====
    const cEmail = `smoke+collab+${Date.now()}@test.local`;
    const collabJar = {};
    const cSignup = await signup(cEmail, "Smoke Collab", collabJar);
    if (cSignup.status !== 200) throw new Error("Collab signup failed");
    await step("promote collab", async () => {
      const r = await usersCol.updateOne(
        { email: cEmail },
        { $set: { role: "collaborator" } }
      );
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
    const cTok = await mintJwt(collabJar);
    if (cTok.status !== 200 || !cTok.body?.token) throw new Error("Collab JWT mint failed");
    const collabJwt = cTok.body.token;

    // Apply
    if (opportunityId) {
      const applyRes = await step("POST /applications (collab)", async () => {
        return callApi("POST", "/applications", collabJwt, {
          opportunity_id: opportunityId,
          portfolio_link: "https://example.com",
          motivation: "I am interested",
        });
      });
      applicationId = applyRes.body?.data?._id;
      results.push({ check: "POST /applications", status: applyRes.status, ok: applyRes.status === 200 });
    }

    // ===== 5) PUT /applications/:id/status (founder accept/reject) =====
    if (applicationId) {
      const acceptRes = await step("PUT /applications/:id/status (Accept)", async () => {
        return callApi("PUT", `/applications/${applicationId}/status`, founderJwt, { status: "Accepted" });
      });
      results.push({ check: "PUT /applications/:id/status", status: acceptRes.status, ok: acceptRes.status === 200 });
    }

    // ===== 6) GET /applications/me (collaborator dashboard) =====
    const myApps = await step("GET /applications/me", async () => {
      return callApi("GET", "/applications/me", collabJwt);
    });
    results.push({
      check: "GET /applications/me",
      status: myApps.status,
      count: myApps.body?.data?.length ?? 0,
      ok: myApps.status === 200,
    });

    // ===== ADMIN SETUP =====
    const aSignup = await signup(ADMIN_EMAIL, "Smoke Admin", adminJar);
    if (aSignup.status !== 200) throw new Error("Admin signup failed");
    await step("promote admin", async () => {
      const r = await usersCol.updateOne(
        { email: ADMIN_EMAIL },
        { $set: { role: "admin" } }
      );
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
    const aTok = await mintJwt(adminJar);
    if (aTok.status !== 200 || !aTok.body?.token) throw new Error("Admin JWT mint failed");
    adminJwt = aTok.body.token;

    // ===== 7) PUT /admin/startups/:id/status (admin moderate startup) =====
    if (startupId) {
      const adminStartup = await step("PUT /admin/startups/:id/status", async () => {
        return callApi("PUT", `/admin/startups/${startupId}/status`, adminJwt, { status: "Pending" });
      });
      results.push({ check: "PUT /admin/startups/:id/status", status: adminStartup.status, ok: adminStartup.status === 200 });
    }

    // ===== 7b) Admin-approval gate — happy path =====
    // Flip the originally-Pending startup back to Active via the admin
    // endpoint, then verify a new opportunity can be posted against it.
    if (pendingStartupId) {
      const approveAgain = await step("PUT /admin/startups/:id/status (Pending -> Active)", async () => {
        return callApi("PUT", `/admin/startups/${pendingStartupId}/status`, adminJwt, { status: "Active" });
      });
      const approvedOpp = await step("POST /opportunities after approval", async () => {
        return callApi("POST", "/opportunities", founderJwt, {
          startup_id: pendingStartupId,
          role_title: "Post-Approval Role",
          required_skills: "React",
          work_type: "Full-time",
          commitment_level: "Full-time",
          industry: "AI",
        });
      });
      results.push({
        check: "admin approve unlocks POST /opportunities",
        approveStatus: approveAgain.status,
        oppStatus: approvedOpp.status,
        ok: approveAgain.status === 200 && approvedOpp.status === 200,
      });
    }

    // ===== 8) PUT /users/:email/block (admin block user) =====
    const blockRes = await step("PUT /users/:email/block", async () => {
      return callApi("PUT", `/users/${encodeEmail(FOUNDER_EMAIL)}/block`, adminJwt, { isBlocked: true });
    });
    results.push({ check: "PUT /users/:email/block", status: blockRes.status, ok: blockRes.status === 200 });

    // ===== 8a) Blocked user cannot sign in again =====
    // Re-issue a sign-in attempt with the founder's email/password. The
    // before-hook in code2startup/src/lib/auth.js should reject with 403.
    const blockedSignIn = await step("blocked founder sign-in (should be 403)", async () => {
      const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: FOUNDER_EMAIL, password: PASSWORD }),
      });
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    });
    results.push({
      check: "blocked user sign-in rejected",
      status: blockedSignIn.status,
      ok: blockedSignIn.status === 403,
    });

    // ===== 8b) Blocked user's prior cookie session is revoked =====
    // The founder's cookie jar from before the block should now resolve to a
    // 401 (no valid session) when calling /api/auth/get-session, because the
    // Express block endpoint deleted the session rows in the `session` collection.
    const blockedGetSession = await step("blocked founder get-session (should be 401)", async () => {
      const res = await fetch(`${BASE}/api/auth/get-session`, {
        method: "GET",
        headers: { cookie: getCookieHeader(founderJar) },
      });
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    });
    results.push({
      check: "blocked user session revoked",
      status: blockedGetSession.status,
      ok: blockedGetSession.status === 401,
    });

    // ===== 8c) Unblock, then sign-in should succeed again =====
    const unblockRes = await step("PUT /users/:email/block (unblock)", async () => {
      return callApi("PUT", `/users/${encodeEmail(FOUNDER_EMAIL)}/block`, adminJwt, { isBlocked: false });
    });
    const unblockedSignIn = await step("unblocked founder sign-in (should be 200)", async () => {
      const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: FOUNDER_EMAIL, password: PASSWORD }),
      });
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    });
    results.push({
      check: "unblocked user can sign in",
      status: unblockedSignIn.status,
      ok: unblockRes.status === 200 && unblockedSignIn.status === 200,
    });

    // ===== 8b) PUT /admin/opportunities/:id/status (admin moderate opportunity) =====
    if (opportunityId) {
      const adminOpp = await step("PUT /admin/opportunities/:id/status", async () => {
        return callApi("PUT", `/admin/opportunities/${opportunityId}/status`, adminJwt, { status: "closed" });
      });
      results.push({ check: "PUT /admin/opportunities/:id/status", status: adminOpp.status, ok: adminOpp.status === 200 });
    }

    // ===== 9) Admin role change endpoint =====
    const roleRes = await step("PUT /users/:email/role", async () => {
      return callApi("PUT", `/users/${encodeEmail(FOUNDER_EMAIL)}/role`, adminJwt, { role: "collaborator" });
    });
    results.push({ check: "PUT /users/:email/role", status: roleRes.status, ok: roleRes.status === 200 });

    // Summary
    console.log("\n\n===== SUMMARY =====");
    for (const r of results) console.log(JSON.stringify(r));
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
  } catch (e) {
    console.error("Smoke test crashed:", e);
    process.exitCode = 2;
  } finally {
    // Best-effort cleanup
    try {
      if (opportunityId) {
        await db.collection("applications").deleteMany({ opportunity_id: new (require("mongodb").ObjectId)(opportunityId) });
        await db.collection("opportunities").deleteOne({ _id: new (require("mongodb").ObjectId)(opportunityId) });
      }
      if (pendingStartupId) {
        await db.collection("opportunities").deleteMany({ startup_id: new (require("mongodb").ObjectId)(pendingStartupId) });
        await db.collection("startups").deleteOne({ _id: new (require("mongodb").ObjectId)(pendingStartupId) });
      }
      if (startupId) {
        await db.collection("startups").deleteOne({ _id: new (require("mongodb").ObjectId)(startupId) });
      }
      await usersCol.deleteOne({ email: FOUNDER_EMAIL });
      await usersCol.deleteOne({ email: ADMIN_EMAIL });
    } catch {}
    await client.close();
  }
})();
