// code2startup_server/index.js
// Express + MongoDB API for StartupForge.
// All routes return JSON in the shape { success: true, data, ... }.

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

const { requireAuth, requireRole } = require("./middleware/auth");

dotenv.config();

// Fail fast on misconfiguration so the process never silently exits later.
if (!process.env.BETTER_AUTH_SECRET) {
  console.error(
    "BETTER_AUTH_SECRET is missing. Add it to code2startup_server/.env (must match the client)."
  );
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 5000;
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

// Surface async errors instead of dying silently.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ===== CORS (allow client + cookies) =====
app.use(
  cors({
    origin: (origin, cb) => cb(null, true), // reflect request origin
    credentials: true,
  })
);
// Stripe webhook needs the raw body — register BEFORE express.json()
app.post(
  "/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(503).send("Stripe not configured");
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { user_email, amount } = session.metadata || {};
      try {
        await paymentsCollection.insertOne({
          user_email,
          amount: Number(amount),
          transaction_id: session.id,
          payment_status: "Paid",
          paid_at: new Date(),
        });
      } catch (e) {
        console.error("Failed to record payment:", e);
      }
    }
    res.json({ received: true });
  }
);

app.use(express.json());
app.use(cookieParser());

// ===== Pagination helper =====
// Reads `page` / `limit` from req.query, clamps to safe bounds, and returns
// { page, limit, skip } so route handlers can stay one-liners.
function parsePagination(req, { defaultLimit = 10, maxLimit = 100 } = {}) {
  const rawPage = parseInt(req.query.page, 10);
  const rawLimit = parseInt(req.query.limit, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  let limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  return { page, limit, skip: (page - 1) * limit };
}

// Attaches `opportunity` (with embedded `startup`) to each application row so
// clients can render titles without a second round-trip. Tolerates missing
// opportunity / startup so a deleted entity doesn't blow up the list.
async function enrichApplicationsWithOpportunity(apps) {
  if (!apps?.length) return apps || [];
  const oppIds = [
    ...new Set(
      apps
        .map((a) => a.opportunity_id)
        .filter((id) => id && ObjectId.isValid(id))
        .map((id) => id.toString())
    ),
  ].map((id) => new ObjectId(id));
  if (!oppIds.length) return apps;
  const opps = await opportunitiesCollection
    .find({ _id: { $in: oppIds } })
    .toArray();
  const oppById = new Map(opps.map((o) => [o._id.toString(), o]));
  const startupIds = [
    ...new Set(
      opps
        .map((o) => o.startup_id)
        .filter((id) => id && ObjectId.isValid(id))
        .map((id) => id.toString())
    ),
  ].map((id) => new ObjectId(id));
  const startups = startupIds.length
    ? await startupsCollection.find({ _id: { $in: startupIds } }).toArray()
    : [];
  const startupById = new Map(startups.map((s) => [s._id.toString(), s]));
  return apps.map((a) => {
    const opp = oppById.get(a.opportunity_id?.toString());
    const startup = opp
      ? startupById.get(opp.startup_id?.toString())
      : null;
    return {
      ...a,
      opportunity: opp
        ? {
            _id: opp._id,
            role_title: opp.role_title,
            work_type: opp.work_type,
            industry: opp.industry,
            startup: startup
              ? {
                  _id: startup._id,
                  startup_name: startup.startup_name,
                  logo_url: startup.logo_url,
                }
              : null,
          }
        : null,
    };
  });
}

// ===== MongoDB =====
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "code2startup";
if (!uri) {
  console.error("MONGODB_URI is missing. Set it in .env");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let db, usersCollection, startupsCollection, opportunitiesCollection, applicationsCollection, paymentsCollection;

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB");

    db = client.db(dbName);
    // Better Auth writes to "user" (singular). Mirror it so lookups by email hit.
    usersCollection = db.collection("user");
    startupsCollection = db.collection("startups");
    opportunitiesCollection = db.collection("opportunities");
    applicationsCollection = db.collection("applications");
    paymentsCollection = db.collection("payments");

    // Ensure useful indexes
    await startupsCollection.createIndex({ founder_email: 1 });
    await opportunitiesCollection.createIndex({ startup_id: 1 });
    await applicationsCollection.createIndex({ opportunity_id: 1 });
    await applicationsCollection.createIndex({ applicant_email: 1 });
    await paymentsCollection.createIndex({ user_email: 1 });
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  }
}

run()
  .catch((err) => {
    console.error("Fatal: server failed to start:", err);
    process.exit(1);
  });

// ===== Health =====
app.get("/health", (req, res) =>
  res.json({ success: true, message: "Server is running" })
);

// ============================================================
//  STARTUPS
// ============================================================

// Public: list all
app.get("/startups", async (req, res) => {
  try {
    const { search, industry, funding_stage, sort, page = 1, limit = 12 } = req.query;
    const query = {};
    // Hide Pending (awaiting admin review) and Removed startups from public lists.
    // Active is the only status a public visitor should ever see.
    query.status = "Active";
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { startup_name: { $regex: safe, $options: "i" } },
        { description: { $regex: safe, $options: "i" } },
        { industry: { $regex: safe, $options: "i" } },
      ];
    }
    if (industry)
      query.industry = {
        $in: Array.isArray(industry) ? industry : [industry],
      };
    if (funding_stage)
      query.funding_stage = {
        $in: Array.isArray(funding_stage) ? funding_stage : [funding_stage],
      };

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, parseInt(limit) || 12);
    const skip = (pageNum - 1) * limitNum;

    const sortMap = {
      newest: { _id: -1 },
      oldest: { _id: 1 },
      "name-asc": { startup_name: 1 },
      "name-desc": { startup_name: -1 },
    };
    const sortSpec = sortMap[sort] || sortMap.newest;

    const total = await startupsCollection.countDocuments(query);
    const startups = await startupsCollection
      .find(query)
      .sort(sortSpec)
      .skip(skip)
      .limit(limitNum)
      .toArray();
    res.json({
      success: true,
      data: startups,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Public: featured (latest 4) — only show approved (Active) startups.
app.get("/featured-startups", async (req, res) => {
  try {
    const startups = await startupsCollection
      .find({ status: "Active" })
      .sort({ _id: -1 })
      .limit(4)
      .toArray();
    res.json({ success: true, data: startups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Public: get one — only approved (Active) startups are publicly viewable.
// Pending + Removed return 404 to avoid leaking the existence of unapproved docs.
app.get("/startups/:id", async (req, res) => {
  try {
    const startup = await startupsCollection.findOne({
      _id: new ObjectId(req.params.id),
      status: "Active",
    });
    if (!startup)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: startup });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Founder: create
app.post("/startups", requireAuth, requireRole("founder"), async (req, res) => {
  try {
    const {
      startup_name,
      logo,
      logoURL,
      industry,
      description,
      funding_stage,
      team_size,
    } = req.body;
    if (!startup_name)
      return res
        .status(400)
        .json({ success: false, message: "startup_name is required" });

    const doc = {
      startup_name,
      logo: logo || logoURL || "",
      logoURL: logoURL || logo || "",
      industry: industry || "General",
      description: description || "",
      funding_stage: funding_stage || "Idea",
      team_size: Number(team_size) || 1,
      founder_email: req.user.email,
      // Every new startup enters the moderation queue. An admin must approve
      // it (PUT /admin/startups/:id/status -> "Active") before the founder
      // can post opportunities against it.
      status: "Pending",
      created_at: new Date(),
    };
    const result = await startupsCollection.insertOne(doc);
    res.json({ success: true, data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Founder: update own startup
app.put(
  "/startups/:id",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const existing = await startupsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!existing)
        return res
          .status(404)
          .json({ success: false, message: "Startup not found" });
      if (existing.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your startup" });

      const allowed = [
        "startup_name",
        "logo",
        "logoURL",
        "industry",
        "description",
        "funding_stage",
        "team_size",
        "status",
      ];
      const update = {};
      for (const k of allowed) if (k in req.body) update[k] = req.body[k];
      await startupsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: update }
      );
      res.json({ success: true, message: "Startup updated" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Founder: delete own
app.delete(
  "/startups/:id",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const existing = await startupsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!existing)
        return res
          .status(404)
          .json({ success: false, message: "Startup not found" });
      if (existing.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your startup" });
      await startupsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.json({ success: true, message: "Startup deleted" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Admin: approve / set status
app.put(
  "/admin/startups/:id/status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { status } = req.body; // "Active" | "Removed" | "Pending"
      if (!["Active", "Removed", "Pending"].includes(status))
        return res
          .status(400)
          .json({ success: false, message: "Invalid status" });
      await startupsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );
      res.json({ success: true, message: `Startup ${status}` });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Admin: set opportunity status (open / closed / pending)
app.put(
  "/admin/opportunities/:id/status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { status } = req.body;
      const allowed = ["open", "closed", "pending", "Active", "Closed", "Pending"];
      if (!allowed.includes(status))
        return res
          .status(400)
          .json({ success: false, message: "Invalid status" });
      await opportunitiesCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );
      res.json({ success: true, message: `Opportunity ${status}` });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Admin: change a user's role
app.put(
  "/users/:email/role",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { role } = req.body;
      if (!["founder", "collaborator", "admin"].includes(role))
        return res
          .status(400)
          .json({ success: false, message: "Invalid role" });
      // Don't let an admin demote themselves into a footgun
      if (req.user.email === req.params.email && role !== "admin")
        return res.status(400).json({
          success: false,
          message: "You cannot remove your own admin role.",
        });
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { role } }
      );
      if (!result.matchedCount)
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      res.json({ success: true, message: `Role set to ${role}` });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// ============================================================
//  OPPORTUNITIES
// ============================================================

// Public: list with search + filter + pagination
app.get("/opportunities", async (req, res) => {
  try {
    const {
      role_title,
      required_skills,
      work_type,
      industry,
      startup_id,
      sort,
      page = 1,
      limit = 10,
    } = req.query;
    const query = {};
    if (role_title) query.role_title = { $regex: role_title, $options: "i" };
    if (required_skills)
      query.required_skills = { $regex: required_skills, $options: "i" };
    if (work_type)
      query.work_type = {
        $in: Array.isArray(work_type) ? work_type : [work_type],
      };
    if (industry)
      query.industry = {
        $in: Array.isArray(industry) ? industry : [industry],
      };
    if (startup_id) query.startup_id = new ObjectId(startup_id);

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, parseInt(limit) || 10);
    const skip = (pageNum - 1) * limitNum;

    const sortMap = {
      newest: { _id: -1 },
      oldest: { _id: 1 },
      "title-asc": { role_title: 1 },
      "title-desc": { role_title: -1 },
    };
    const sortSpec = sortMap[sort] || sortMap.newest;

    // Exclude opportunities whose parent startup is Pending (awaiting admin
    // review) or Removed. The POST gate already blocks creation in that
    // state, but we filter on read too as defense-in-depth.
    const allStartupIds = await startupsCollection
      .find({}, { projection: { _id: 1, status: 1 } })
      .toArray();
    const blockedStartupIds = allStartupIds
      .filter((s) => s.status !== "Active")
      .map((s) => s._id);
    if (blockedStartupIds.length) {
      query.startup_id = query.startup_id
        ? { $eq: query.startup_id, $nin: blockedStartupIds }
        : { $nin: blockedStartupIds };
    }

    const total = await opportunitiesCollection.countDocuments(query);
    const items = await opportunitiesCollection
      .find(query)
      .sort(sortSpec)
      .skip(skip)
      .limit(limitNum)
      .toArray();
    res.json({
      success: true,
      data: items,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/featured-opportunities", async (req, res) => {
  try {
    // Same defense-in-depth: hide opps whose parent is Pending/Removed.
    const blockedStartupIds = (
      await startupsCollection
        .find({ status: { $ne: "Active" } }, { projection: { _id: 1 } })
        .toArray()
    ).map((s) => s._id);
    const items = await opportunitiesCollection
      .find(
        blockedStartupIds.length
          ? { startup_id: { $nin: blockedStartupIds } }
          : {}
      )
      .sort({ _id: -1 })
      .limit(4)
      .toArray();
    res.json({ success: true, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/opportunities/:id", async (req, res) => {
  try {
    const item = await opportunitiesCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Opportunity not found" });
    // Hide the opportunity publicly if its parent startup is no longer
    // approved (Pending or Removed).
    if (item.startup_id) {
      const parent = await startupsCollection.findOne(
        { _id: new ObjectId(item.startup_id) },
        { projection: { status: 1 } }
      );
      if (parent && parent.status !== "Active") {
        return res
          .status(404)
          .json({ success: false, message: "Not found" });
      }
    }
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Premium gate helper
async function isPremiumFounder(email) {
  const paid = await paymentsCollection.findOne({
    user_email: email,
    payment_status: "Paid",
  });
  return !!paid;
}

app.post(
  "/opportunities",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const {
        startup_id,
        role_title,
        required_skills,
        work_type,
        commitment_level,
        deadline,
        industry,
      } = req.body;
      if (!startup_id || !role_title)
        return res
          .status(400)
          .json({ success: false, message: "startup_id and role_title required" });

      // Make sure the startup belongs to this founder
      const startup = await startupsCollection.findOne({
        _id: new ObjectId(startup_id),
      });
      if (!startup)
        return res
          .status(404)
          .json({ success: false, message: "Startup not found" });
      if (startup.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your startup" });

      // Admin-approval gate: founders can only post opportunities against
      // startups an admin has explicitly approved (status === "Active").
      // New startups default to "Pending" and stay locked until an admin
      // flips them via PUT /admin/startups/:id/status.
      if (startup.status !== "Active") {
        return res.status(403).json({
          success: false,
          code: "STARTUP_NOT_APPROVED",
          message:
            "Your startup is awaiting admin review. You can post opportunities once it has been approved.",
        });
      }

      // Premium gate: more than 3 opportunities requires a paid plan
      const count = await opportunitiesCollection.countDocuments({
        startup_id: new ObjectId(startup_id),
      });
      if (count >= 3) {
        const premium = await isPremiumFounder(req.user.email);
        if (!premium)
          return res.status(402).json({
            success: false,
            code: "PREMIUM_REQUIRED",
            message:
              "Free plan is limited to 3 opportunities. Please upgrade to Premium.",
          });
      }

      const doc = {
        startup_id: new ObjectId(startup_id),
        role_title,
        required_skills: required_skills || "",
        work_type: work_type || "Full-time",
        commitment_level: commitment_level || "Full-time",
        industry: industry || startup.industry || "General",
        deadline: deadline ? new Date(deadline) : new Date(),
        created_at: new Date(),
      };
      const result = await opportunitiesCollection.insertOne(doc);
      res.json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

app.put(
  "/opportunities/:id",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const opp = await opportunitiesCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!opp)
        return res
          .status(404)
          .json({ success: false, message: "Opportunity not found" });
      const startup = await startupsCollection.findOne({
        _id: opp.startup_id,
      });
      if (!startup || startup.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your opportunity" });
      const allowed = [
        "role_title",
        "required_skills",
        "work_type",
        "commitment_level",
        "deadline",
        "industry",
      ];
      const update = {};
      for (const k of allowed) if (k in req.body) update[k] = req.body[k];
      await opportunitiesCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: update }
      );
      res.json({ success: true, message: "Opportunity updated" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

app.delete(
  "/opportunities/:id",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const opp = await opportunitiesCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!opp)
        return res
          .status(404)
          .json({ success: false, message: "Opportunity not found" });
      const startup = await startupsCollection.findOne({ _id: opp.startup_id });
      if (!startup || startup.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your opportunity" });
      await opportunitiesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.json({ success: true, message: "Opportunity deleted" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// ============================================================
//  APPLICATIONS
// ============================================================

// Founder: list applications for an opportunity
app.get(
  "/opportunities/:opportunityId/applications",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const opp = await opportunitiesCollection.findOne({
        _id: new ObjectId(req.params.opportunityId),
      });
      if (!opp)
        return res
          .status(404)
          .json({ success: false, message: "Opportunity not found" });
      const startup = await startupsCollection.findOne({ _id: opp.startup_id });
      if (!startup || startup.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your opportunity" });
      const apps = await applicationsCollection
        .find({ opportunity_id: new ObjectId(req.params.opportunityId) })
        .toArray();
      res.json({ success: true, data: apps });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Founder: all applications for all my opportunities
app.get(
  "/applications/founder",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const { page, limit, skip } = parsePagination(req, { defaultLimit: 10 });
      const status = (req.query.status || "").toString();
      const myStartups = await startupsCollection
        .find({ founder_email: req.user.email })
        .project({ _id: 1 })
        .toArray();
      const startupIds = myStartups.map((s) => s._id);
      const opps = await opportunitiesCollection
        .find({ startup_id: { $in: startupIds } })
        .project({ _id: 1 })
        .toArray();
      const oppIds = opps.map((o) => o._id);
      const filter = { opportunity_id: { $in: oppIds } };
      if (status) filter.status = status;
      const total = await applicationsCollection.countDocuments(filter);
      const apps = await applicationsCollection
        .find(filter)
        .sort({ applied_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      res.json({
        success: true,
        data: apps,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Collaborator: my applications (uses auth context, no email param)
app.get(
  "/applications/me",
  requireAuth,
  async (req, res) => {
    try {
      const { page, limit, skip } = parsePagination(req, { defaultLimit: 10 });
      const status = (req.query.status || "").toString();
      const filter = { applicant_email: req.user.email };
      if (status) filter.status = status;
      const total = await applicationsCollection.countDocuments(filter);
      const apps = await applicationsCollection
        .find(filter)
        .sort({ applied_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      const data = await enrichApplicationsWithOpportunity(apps);
      res.json({
        success: true,
        data,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Collaborator: my applications (legacy email-scoped — kept for back-compat)
app.get(
  "/applications/user/:email",
  requireAuth,
  async (req, res) => {
    try {
      if (req.user.email !== req.params.email && req.user.role !== "admin")
        return res
          .status(403)
          .json({ success: false, message: "Not your applications" });
      const { page, limit, skip } = parsePagination(req, { defaultLimit: 10 });
      const status = (req.query.status || "").toString();
      const filter = { applicant_email: req.params.email };
      if (status) filter.status = status;
      const total = await applicationsCollection.countDocuments(filter);
      const apps = await applicationsCollection
        .find(filter)
        .sort({ applied_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      const data = await enrichApplicationsWithOpportunity(apps);
      res.json({
        success: true,
        data,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Collaborator: apply
app.post(
  "/applications",
  requireAuth,
  requireRole("collaborator"),
  async (req, res) => {
    try {
      const { opportunity_id, portfolio_link, motivation } = req.body;
      if (!opportunity_id)
        return res
          .status(400)
          .json({ success: false, message: "opportunity_id is required" });
      // Prevent duplicate
      const existing = await applicationsCollection.findOne({
        opportunity_id: new ObjectId(opportunity_id),
        applicant_email: req.user.email,
      });
      if (existing)
        return res
          .status(409)
          .json({ success: false, message: "Already applied" });
      const result = await applicationsCollection.insertOne({
        opportunity_id: new ObjectId(opportunity_id),
        applicant_email: req.user.email,
        portfolio_link: portfolio_link || "",
        motivation: motivation || "",
        status: "pending",
        applied_at: new Date(),
      });
      res.json({ success: true, data: { _id: result.insertedId } });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Founder: accept / reject
app.put(
  "/applications/:id/status",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    try {
      const raw = (req.body.status || "").toString().trim().toLowerCase();
      if (!["accepted", "rejected"].includes(raw))
        return res
          .status(400)
          .json({ success: false, message: "Invalid status" });
      const app = await applicationsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!app)
        return res
          .status(404)
          .json({ success: false, message: "Application not found" });
      const opp = await opportunitiesCollection.findOne({
        _id: app.opportunity_id,
      });
      const startup = await startupsCollection.findOne({
        _id: opp?.startup_id,
      });
      if (!startup || startup.founder_email !== req.user.email)
        return res
          .status(403)
          .json({ success: false, message: "Not your application" });
      await applicationsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: raw, updated_at: new Date() } }
      );
      res.json({ success: true, message: `Application ${raw}` });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Collaborator: withdraw own application
app.delete("/applications/:id", requireAuth, async (req, res) => {
  try {
    const app = await applicationsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!app)
      return res
        .status(404)
        .json({ success: false, message: "Application not found" });
    if (app.applicant_email !== req.user.email)
      return res
        .status(403)
        .json({ success: false, message: "Not your application" });
    if (app.status !== "Pending")
      return res
        .status(400)
        .json({ success: false, message: "Cannot withdraw after decision" });
    await applicationsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.json({ success: true, message: "Application withdrawn" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
//  USERS  (admin only for listing; self for own profile)
// ============================================================

// Self profile
app.get("/users/me", requireAuth, async (req, res) => {
  try {
    const u = await usersCollection.findOne({ email: req.user.email });
    if (!u)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    res.json({ success: true, data: u });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put(
  "/users/me",
  requireAuth,
  requireRole("collaborator", "founder", "admin"),
  async (req, res) => {
    try {
      const allowed = ["name", "image", "bio", "skills"];
      const update = {};
      for (const k of allowed) if (k in req.body) update[k] = req.body[k];
      await usersCollection.updateOne(
        { email: req.user.email },
        { $set: update }
      );
      res.json({ success: true, message: "Profile updated" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Admin: list all
app.get(
  "/users",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { page, limit, skip } = parsePagination(req, { defaultLimit: 10 });
      const q = (req.query.q || "").toString().trim();
      const filter = {};
      if (q) {
        const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
          { name: { $regex: safe, $options: "i" } },
          { email: { $regex: safe, $options: "i" } },
          { role: { $regex: safe, $options: "i" } },
        ];
      }
      const total = await usersCollection.countDocuments(filter);
      const users = await usersCollection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      res.json({
        success: true,
        data: users,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Admin: block / unblock
app.put(
  "/users/:email/block",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { isBlocked } = req.body;
      await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { isBlocked: !!isBlocked } }
      );
      res.json({
        success: true,
        message: `User ${isBlocked ? "blocked" : "unblocked"}`,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// ============================================================
//  PAYMENTS / STRIPE
// ============================================================

// Premium status for current user
app.get("/payments/status", requireAuth, async (req, res) => {
  try {
    const paid = await isPremiumFounder(req.user.email);
    const last = await paymentsCollection
      .find({ user_email: req.user.email })
      .sort({ paid_at: -1 })
      .limit(1)
      .toArray();
    res.json({
      success: true,
      data: { isPremium: paid, lastPayment: last[0] || null },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create Stripe checkout session
app.post(
  "/payments/create-checkout-session",
  requireAuth,
  requireRole("founder"),
  async (req, res) => {
    if (!stripe)
      return res
        .status(503)
        .json({ success: false, message: "Stripe is not configured" });
    try {
      const amount = Number(req.body.amount) || 1900; // $19.00 default
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "StartupForge Premium" },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.CLIENT_URL || "http://localhost:3000"}/dashboard/founder?payment=success`,
        cancel_url: `${process.env.CLIENT_URL || "http://localhost:3000"}/dashboard/founder?payment=cancel`,
        metadata: {
          user_email: req.user.email,
          amount: String(amount),
        },
      });
      res.json({ success: true, url: session.url, sessionId: session.id });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Admin: list all payments
app.get(
  "/payments",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { page, limit, skip } = parsePagination(req, { defaultLimit: 10 });
      const total = await paymentsCollection.countDocuments({});
      const payments = await paymentsCollection
        .find({})
        .sort({ paid_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      res.json({
        success: true,
        data: payments,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// ===== Start =====
app.listen(port, () =>
  console.log(`Server is running on port ${port}`)
);

