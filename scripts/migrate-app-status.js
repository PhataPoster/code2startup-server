// scripts/migrate-app-status.js
// Idempotent backfill: normalize all application statuses to lowercase so the
// dashboard's filters (pending / reviewing / accepted / rejected) match.
// Safe to re-run. New docs are written lowercase by the API.

const { MongoClient } = require("mongodb");

const MONGO_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://code2startup:A79c13Uh3GeiSwqL@cluster0.emrrkcd.mongodb.net/?appName=Cluster0";
const DB_NAME = process.env.MONGODB_DB || "code2startup";

(async () => {
  const c = new MongoClient(MONGO_URI);
  await c.connect();
  const apps = c.db(DB_NAME).collection("applications");
  const all = await apps.find({}, { projection: { _id: 1, status: 1 } }).toArray();
  let updated = 0;
  for (const a of all) {
    const normalized = (a.status || "").toString().trim().toLowerCase();
    if (normalized !== a.status) {
      await apps.updateOne({ _id: a._id }, { $set: { status: normalized } });
      updated++;
    }
  }
  console.log(`migrated ${updated}/${all.length} application docs to lowercase status`);
  await c.close();
})();