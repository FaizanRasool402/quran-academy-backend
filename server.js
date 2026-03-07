const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "quranacademy";

let contactsCollection;

app.use(
  cors({
    origin: CLIENT_ORIGIN,
  })
);

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Quran Academy backend is running" });
});

app.post("/api/contact", async (req, res) => {
  const { name, phone, email, subject, message, source } = req.body || {};

  if (!name || !message) {
    return res.status(400).json({ error: "Name and message are required." });
  }

  try {
    const doc = {
      name,
      phone: phone || null,
      email: email || null,
      subject: subject || null,
      message,
      source: source || "unknown",
      createdAt: new Date(),
    };

    if (contactsCollection) {
      await contactsCollection.insertOne(doc);
    } else {
      console.warn("contactsCollection not initialized, skipping DB save");
    }

    console.log("New contact submission:", doc);

    return res.json({ success: true });
  } catch (err) {
    console.error("Failed to save contact:", err);
    return res.status(500).json({ error: "Failed to save contact, please try again later." });
  }
});

async function start() {
  if (!MONGODB_URI) {
    console.warn("MONGODB_URI not set, running without database connection.");
  } else {
    try {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      const db = client.db(MONGODB_DB);
      contactsCollection = db.collection("contacts");
      console.log("Connected to MongoDB:", MONGODB_DB);
    } catch (err) {
      console.error("Failed to connect to MongoDB, continuing without DB:", err);
    }
  }

  app.listen(PORT, () => {
    console.log(`Backend server listening on http://localhost:${PORT}`);
  });
}

start();

