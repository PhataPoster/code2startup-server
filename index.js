const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const dotenv = require('dotenv');
const { jwtVerify, createRemoteJWKSet } = require('jose-cjs');

dotenv.config();
const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "code2startup";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });

    const db = client.db(dbName);
    const usersCollection = db.collection("users");
    const startupsCollection = db.collection("startups");
    const opportunitiesCollection = db.collection("opportunities");
    const applicationsCollection = db.collection("applications");
    const paymentsCollection = db.collection("payments");

    // ===== STARTUPS API =====
    app.get('/startups', async (req, res) => {
      try {
        const startups = await startupsCollection.find({}).toArray();
        res.json({ success: true, data: startups });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/featured-startups', async (req, res) => {
      try {
        const startups = await startupsCollection
          .find({})
          .sort({ _id: -1 })
          .limit(4)
          .toArray();
        res.json({ success: true, data: startups });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/startups/:id', async (req, res) => {
      try {
        const startup = await startupsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!startup) return res.status(404).json({ success: false, message: "Startup not found" });
        res.json({ success: true, data: startup });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/startups', async (req, res) => {
      try {
        const { startup_name, logoURL, industry, description, funding_stage, founder_email } = req.body;
        if (!startup_name || !founder_email) return res.status(400).json({ success: false, message: "Missing required fields" });
        const result = await startupsCollection.insertOne({
          startup_name,
          logoURL: logoURL || "",
          industry: industry || "General",
          description: description || "",
          funding_stage: funding_stage || "Idea",
          founder_email,
          status: "Active",
          created_at: new Date(),
        });
        res.json({ success: true, data: { _id: result.insertedId } });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.put('/startups/:id', async (req, res) => {
      try {
        await startupsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body });
        res.json({ success: true, message: "Startup updated" });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.delete('/startups/:id', async (req, res) => {
      try {
        await startupsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true, message: "Startup deleted" });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // ===== OPPORTUNITIES API =====
    app.get('/opportunities', async (req, res) => {
      try {
        const { role_title, required_skills, work_type, industry, page = 1, limit = 10 } = req.query;
        const query = {};
        if (role_title) query.role_title = { $regex: role_title, $options: 'i' };
        if (required_skills) query.required_skills = { $regex: required_skills, $options: 'i' };
        if (work_type) query.work_type = { $in: Array.isArray(work_type) ? work_type : [work_type] };
        if (industry) query.industry = { $in: Array.isArray(industry) ? industry : [industry] };
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;
        const total = await opportunitiesCollection.countDocuments(query);
        const opportunities = await opportunitiesCollection
          .find(query)
          .sort({ _id: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray();
        res.json({ success: true, data: opportunities, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/featured-opportunities', async (req, res) => {
      try {
        const opportunities = await opportunitiesCollection.find({}).sort({ _id: -1 }).limit(4).toArray();
        res.json({ success: true, data: opportunities });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/opportunities/:id', async (req, res) => {
      try {
        const opportunity = await opportunitiesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!opportunity) return res.status(404).json({ success: false, message: "Opportunity not found" });
        res.json({ success: true, data: opportunity });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/opportunities', async (req, res) => {
      try {
        const { startup_id, role_title, required_skills, work_type, commitment_level, deadline } = req.body;
        if (!startup_id || !role_title) return res.status(400).json({ success: false, message: "Missing required fields" });
        const result = await opportunitiesCollection.insertOne({
          startup_id: new ObjectId(startup_id),
          role_title,
          required_skills: required_skills || "",
          work_type: work_type || "Full-time",
          commitment_level: commitment_level || "Full-time",
          deadline: deadline || new Date(),
          created_at: new Date(),
        });
        res.json({ success: true, data: { _id: result.insertedId } });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.put('/opportunities/:id', async (req, res) => {
      try {
        await opportunitiesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body });
        res.json({ success: true, message: "Opportunity updated" });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.delete('/opportunities/:id', async (req, res) => {
      try {
        await opportunitiesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true, message: "Opportunity deleted" });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // ===== APPLICATIONS API =====
    app.get('/opportunities/:opportunityId/applications', async (req, res) => {
      try {
        const applications = await applicationsCollection.find({ opportunity_id: new ObjectId(req.params.opportunityId) }).toArray();
        res.json({ success: true, data: applications });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/applications/user/:email', async (req, res) => {
      try {
        const applications = await applicationsCollection.find({ applicant_email: req.params.email }).sort({ applied_at: -1 }).toArray();
        res.json({ success: true, data: applications });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/applications', async (req, res) => {
      try {
        const { opportunity_id, applicant_email, portfolio_link, motivation } = req.body;
        if (!opportunity_id || !applicant_email) return res.status(400).json({ success: false, message: "Missing required fields" });
        const result = await applicationsCollection.insertOne({
          opportunity_id: new ObjectId(opportunity_id),
          applicant_email,
          portfolio_link: portfolio_link || "",
          motivation: motivation || "",
          status: "Pending",
          applied_at: new Date(),
        });
        res.json({ success: true, data: { _id: result.insertedId } });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.put('/applications/:id/status', async (req, res) => {
      try {
        const { status } = req.body;
        if (!['Pending', 'Accepted', 'Rejected'].includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });
        await applicationsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
        res.json({ success: true, message: `Application ${status.toLowerCase()}` });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // ===== USERS API =====
    app.get('/users', async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        res.json({ success: true, data: users });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.put('/users/:email/block', async (req, res) => {
      try {
        const { isBlocked } = req.body;
        await usersCollection.updateOne({ email: req.params.email }, { $set: { isBlocked } });
        res.json({ success: true, message: `User ${isBlocked ? 'blocked' : 'unblocked'}` });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // ===== PAYMENTS API =====
    app.post('/payments', async (req, res) => {
      try {
        const { user_email, amount, transaction_id, payment_status } = req.body;
        const result = await paymentsCollection.insertOne({
          user_email,
          amount,
          transaction_id,
          payment_status,
          paid_at: new Date(),
        });
        res.json({ success: true, data: { _id: result.insertedId } });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/payments', async (req, res) => {
      try {
        const payments = await paymentsCollection.find({}).sort({ paid_at: -1 }).toArray();
        res.json({ success: true, data: payments });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get('/health', (req, res) => {
      res.json({ success: true, message: 'Server is running' });
    });

    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

