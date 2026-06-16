/**
 * HALLO AMRIKA — Auth & Sync Server
 * Node.js / Express  ·  connects to MongoDB Atlas
 */
const dotenv = require('dotenv');
dotenv.config();
const express    = require('express');
const cors       = require('cors');
const { MongoClient } = require('mongodb');

const MONGO_URI  = process.env.MONGO_URI;
const DB_NAME    = process.env.DB_NAME;
const COLL_NAME  = process.env.COLL_NAME;

if (!MONGO_URI || !DB_NAME || !COLL_NAME) {
  console.error("❌ ERROR: Missing required environment variables in your .env file!");
  process.exit(1);
}

const ALLOWED_PROFILES = [
  'استاذ احمد فؤاد',
  'المعلم عجينة',
  'الريس بلبول',
  'الاوسطا عجلاوي',
  'بينيصة',
  'دكتور بروستيتس',
  'عسكري اللوليبوب',
];

const app    = express();
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

let db;
async function getDb() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✓ Connected to MongoDB:', DB_NAME);
  return db;
}

function col(database) {
  return database.collection(COLL_NAME);
}

// Look up a profile by name
app.post('/api/profile', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const database = await getDb();
    const doc = await col(database).findOne(
      { name },
      { projection: { _id: 0, name: 1, password: 1, squads: 1, accounts: 1, marks: 1, transfers: 1 } }
    );
    if (!doc) return res.json({ found: false });
    return res.json({ found: true, doc });
  } catch (e) {
    console.error('/api/profile error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Register a new profile
app.post('/api/signup', async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'name and password required' });
  if (!ALLOWED_PROFILES.includes(name))
    return res.status(400).json({ error: 'Unknown profile name' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const database = await getDb();
    const existing = await col(database).findOne({ name });
    if (existing) return res.status(409).json({ error: 'Profile already registered' });

    await col(database).insertOne({ name, password, accounts: [], squads: [], transfers: {} });
    console.log('✓ Registered profile:', name);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/signup error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Save/Sync entries back down to MongoDB
app.post('/api/save-squads', async (req, res) => {
  const { name, accounts, squads } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Profile name required' });

  try {
    const database = await getDb();
    await col(database).updateOne(
      { name },
      { $set: { accounts: accounts || [], squads: squads || [], lastFetched: new Date() } }
    );
    console.log(`✓ Synchronized data cache down for profile: ${name}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/save-squads error:', e.message);
    return res.status(500).json({ error: 'Failed to write cache entries to MongoDB' });
  }
});

// Fetch combined cache groups for all profiles
app.get('/api/all-profiles-data', async (req, res) => {
  try {
    const database = await getDb();
    const docs = await col(database).find({}, { projection: { _id: 0, name: 1, accounts: 1, squads: 1 } }).toArray();
    return res.json({ profiles: docs });
  } catch (e) {
    console.error('/api/all-profiles-data error:', e.message);
    return res.status(500).json({ error: 'Database read error' });
  }
});

// Save/replace the marks array for a profile
app.post('/api/save-marks', async (req, res) => {
  const { name, marks } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Profile name required' });
  if (!ALLOWED_PROFILES.includes(name))
    return res.status(403).json({ error: 'Unknown profile' });

  try {
    const database = await getDb();
    await col(database).updateOne(
      { name },
      { $set: { marks: Array.isArray(marks) ? marks : [] } },
      { upsert: false }
    );
    console.log(`✓ Saved marks for profile: ${name} (${(marks||[]).length} marked)`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/save-marks error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// ──────────────────────────────────────────────────────
// TRANSFER PLAN ENDPOINTS
// Transfers are stored per profile, keyed by uid.
// Supabase is never written — this is the only storage.
// ──────────────────────────────────────────────────────

// Save (or update) a transfer plan for a specific uid under a profile
// Body: { name: string, uid: string, transfers: Array<{out: playerObj, in: playerObj}> }
app.post('/api/save-transfers', async (req, res) => {
  const { name, uid, transfers } = req.body || {};
  if (!name || !uid) return res.status(400).json({ error: 'name and uid required' });
  if (!ALLOWED_PROFILES.includes(name))
    return res.status(403).json({ error: 'Unknown profile' });

  try {
    const database = await getDb();
    // Store under transfers.<uid> so each squad's plan is independently addressable
    await col(database).updateOne(
      { name },
      { $set: { [`transfers.${uid}`]: Array.isArray(transfers) ? transfers : [] } },
      { upsert: false }
    );
    const count = Array.isArray(transfers) ? transfers.length : 0;
    console.log(`✓ Saved transfer plan for profile: ${name}, uid: ${uid} (${count} swap(s))`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/save-transfers error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get all transfer plans saved for a profile (keyed by uid)
// Returns: { transfers: { [uid]: [{out, in}, ...], ... } }
app.get('/api/get-transfers/:name', async (req, res) => {
  const { name } = req.params;
  if (!ALLOWED_PROFILES.includes(decodeURIComponent(name)))
    return res.status(403).json({ error: 'Unknown profile' });

  try {
    const database = await getDb();
    const doc = await col(database).findOne(
      { name: decodeURIComponent(name) },
      { projection: { _id: 0, transfers: 1 } }
    );
    return res.json({ transfers: doc?.transfers || {} });
  } catch (e) {
    console.error('/api/get-transfers error:', e.message);
    return res.status(500).json({ error: 'Database read error' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🏆 HALLO AMRIKA auth server running on http://localhost:${PORT}`);
});
