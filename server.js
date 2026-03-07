const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");
const { MongoClient } = require("mongodb");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "quranacademy";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "aizaquranacademy@gmail.com";
const EMAIL_USER = process.env.EMAIL_USER || "aizaquranacademy@gmail.com";
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;

let contactsCollection;
let mailTransporter;

app.use(
  cors({
    origin: CLIENT_ORIGIN,
  })
);

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Quran Academy backend is running" });
});

async function sendAdminEmail(doc) {
  if (!mailTransporter) return;
  await mailTransporter.sendMail({
    from: `"Aiza Quran Academy" <${EMAIL_USER}>`,
    to: ADMIN_EMAIL,
    subject: `New Contact: ${doc.name} - ${doc.subject || "General"}`,
    text: `Name: ${doc.name}\nEmail: ${doc.email || "N/A"}\nPhone: ${doc.phone || "N/A"}\nSubject: ${doc.subject || "N/A"}\nSource: ${doc.source}\n\nMessage:\n${doc.message}`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #182b68;">New Contact Form</h2><p><strong>Name:</strong> ${doc.name}</p><p><strong>Email:</strong> ${doc.email || "N/A"}</p><p><strong>Phone:</strong> ${doc.phone || "N/A"}</p><p><strong>Subject:</strong> ${doc.subject || "N/A"}</p><p><strong>Message:</strong></p><p style="background: #f5f5f5; padding: 12px; border-radius: 6px;">${doc.message.replace(/\n/g, "<br>")}</p></div>`,
  });
}

async function sendConfirmationEmail(toEmail, name) {
  if (!mailTransporter || !toEmail) return;
  await mailTransporter.sendMail({
    from: `"Aiza Quran Academy" <${EMAIL_USER}>`,
    to: toEmail,
    subject: "Thank You for Contacting Aiza Quran Academy",
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;"><p>Assalamu Alaikum ${name},</p><p>JazakAllah Khair for reaching out to <strong>Aiza Quran Academy</strong>.</p><p>We have received your message and will get back to you within 24 hours, In sha Allah.</p><p>Best regards,<br><strong>Aiza Quran Academy Team</strong></p></div>`,
  });
}

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

    if (mailTransporter) {
      try {
        await sendAdminEmail(doc);
        console.log("Admin email sent to:", ADMIN_EMAIL);
        if (email) {
          await sendConfirmationEmail(email, name);
          console.log("Confirmation email sent to:", email);
        }
      } catch (emailErr) {
        console.error("Email send failed:", emailErr.message || emailErr);
      }
    } else {
      console.warn("Email not configured (EMAIL_APP_PASSWORD missing?), skipping email send");
    }

    console.log("New contact submission:", doc);

    return res.json({ success: true });
  } catch (err) {
    console.error("Failed to save contact:", err);
    return res.status(500).json({ error: "Failed to save contact, please try again later." });
  }
});

async function start() {
  if (EMAIL_APP_PASSWORD) {
    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    });
    try {
      await mailTransporter.verify();
      console.log("Email configured and verified for:", ADMIN_EMAIL);
    } catch (verifyErr) {
      console.error("Email verify failed (check App Password):", verifyErr.message);
    }
  } else {
    console.warn("EMAIL_APP_PASSWORD not set, email notifications disabled.");
  }

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

