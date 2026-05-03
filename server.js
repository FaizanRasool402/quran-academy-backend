const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const cors = require("cors");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");
const multer = require("multer");
const { MongoClient, ObjectId } = require("mongodb");
const dns = require("dns");

dotenv.config();

// Bohat dafa local PC / ISP ka DNS mongodb+srv resolve nahi karta (ESERVFAIL).
// Google DNS se Node ki DNS lookups theek ho jati hain — is liye pehle yeh set karte hain.
if (process.env.MONGODB_SKIP_GOOGLE_DNS !== "1") {
  try {
    dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
  } catch {
    /* ignore */
  }
}

const app = express();

const PORT = process.env.PORT || 5001;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "quranacademy";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "aizaquranacademy@gmail.com";
const EMAIL_USER = process.env.EMAIL_USER || "aizaquranacademy@gmail.com";
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;

let mongoClient = null;
let contactsCollection;
let blogsCollection;
let mailTransporter;

/** Har dafa jab DB chahiye ho — pehli baar fail ho to dubara try ho sakta hai (DNS / net theek hone par). */
async function connectMongo() {
  if (!MONGODB_URI) {
    return false;
  }
  if (blogsCollection && mongoClient) {
    return true;
  }
  try {
    if (mongoClient) {
      try {
        await mongoClient.close();
      } catch {
        /* ignore */
      }
      mongoClient = null;
    }
    contactsCollection = null;
    blogsCollection = null;

    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 15_000,
    });
    await mongoClient.connect();
    const db = mongoClient.db(MONGODB_DB);
    contactsCollection = db.collection("contacts");
    blogsCollection = db.collection("blog_posts");
    try {
      // Query: { published: true }.sort({ createdAt: -1 }) — yahi index use hota hai.
      // (Aap ne jo `db.blogs` + `status` likha: yahan collection `blog_posts`, field `published` hai.)
      await blogsCollection.createIndex({ published: 1, createdAt: -1 }, { background: true });
    } catch (idxErr) {
      console.warn("blog_posts index ensure:", idxErr?.message || idxErr);
    }
    console.log("Connected to MongoDB:", MONGODB_DB);
    return true;
  } catch (err) {
    console.error("MongoDB connect failed:", err?.message || err);
    mongoClient = null;
    contactsCollection = null;
    blogsCollection = null;
    return false;
  }
}

let blogUploadDir = path.join(__dirname, "uploads", "blog-images");
let useDiskStorage = true;

try {
  fs.mkdirSync(blogUploadDir, { recursive: true });
  const writeProbePath = path.join(blogUploadDir, ".write-test");
  fs.writeFileSync(writeProbePath, "ok");
  fs.unlinkSync(writeProbePath);
} catch {
  // Read-only/serverless filesystems cannot write under /var/task.
  // Fall back to in-memory uploads and save data URLs in MongoDB.
  useDiskStorage = false;
  blogUploadDir = path.join(os.tmpdir(), "blog-images");
  try {
    fs.mkdirSync(blogUploadDir, { recursive: true });
  } catch {
    /* ignore */
  }
}

const blogStorage = useDiskStorage
  ? multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, blogUploadDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "") || ".jpg";
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
      },
    })
  : multer.memoryStorage();

const blogUpload = multer({
  storage: blogStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error("Only JPEG, PNG or WebP images are allowed."), ok);
  },
});

// CORS - must be before all routes (dynamic origin; PATCH = admin blog publish)
const allowedOrigins = [
  "https://aizaquranacademy.com",
  "https://www.aizaquranacademy.com",
  "http://localhost:3000",
  "http://localhost:3001",
];

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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

    await connectMongo();
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

app.post("/api/blogs", (req, res, next) => {
  blogUpload.single("featuredImage")(req, res, (err) => {
    if (err) {
      const msg = err.message || "Image upload failed";
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).json({
        error:
          "Database not available. MongoDB connect nahi ho raha — .env me MONGODB_URI sahi lagao, internet check karo, ya Atlas se Standard (mongodb://) string use karo. Backend terminal ki error bhi dekho.",
      });
    }

    const mainHeading = (req.body.mainHeading || "").trim();
    if (!mainHeading) {
      return res.status(400).json({ error: "Main heading is required." });
    }

    const introContent = (req.body.introContent || "").trim();
    const conclusion = (req.body.conclusion || "").trim();
    const imageAltText = (req.body.imageAltText || "").trim();
    let subheadings = [];
    if (req.body.subheadings) {
      try {
        const parsed = JSON.parse(req.body.subheadings);
        if (Array.isArray(parsed)) {
          subheadings = parsed
            .slice(0, 10)
            .map((item) => ({
              title: String(item?.title || "").trim(),
              content: String(item?.content || "").trim(),
            }))
            .filter((item) => item.title || item.content);
        }
      } catch {
        subheadings = [];
      }
    }

    let imageUrl = null;
    if (req.file) {
      if (useDiskStorage && req.file.filename) {
        imageUrl = `/uploads/blog-images/${req.file.filename}`;
      } else if (req.file.buffer) {
        imageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      }
    }

    const doc = {
      mainHeading,
      introContent,
      subheadings,
      conclusion,
      imageAltText,
      imageUrl,
      published: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await blogsCollection.insertOne(doc);
    return res.json({ success: true, id: result.insertedId.toString(), imageUrl });
  } catch (err) {
    console.error("Blog save error:", err);
    return res.status(500).json({ error: "Failed to save blog." });
  }
});

app.get("/api/blogs", async (req, res) => {
  try {
    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).json({
        error:
          "Database not available. MongoDB connect nahi ho raha — pehle backend terminal me connection error fix karo.",
      });
    }
    const list = await blogsCollection.find({}).sort({ createdAt: -1 }).toArray();
    const out = list.map((b) => ({
      id: b._id.toString(),
      mainHeading: b.mainHeading,
      imageUrl: b.imageUrl || null,
      published: !!b.published,
      createdAt: b.createdAt,
    }));
    return res.json(out);
  } catch (err) {
    console.error("Blog list error:", err);
    return res.status(500).json({ error: "Failed to load blogs." });
  }
});

app.patch("/api/blogs/:id/publish", async (req, res) => {
  try {
    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).json({ error: "Database not available." });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog id." });
    }
    const r = await blogsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { published: true, updatedAt: new Date() } }
    );
    if (r.matchedCount === 0) {
      return res.status(404).json({ error: "Blog not found." });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("Blog publish error:", err);
    return res.status(500).json({ error: "Failed to publish." });
  }
});

app.delete("/api/blogs/:id", async (req, res) => {
  try {
    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).json({ error: "Database not available." });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog id." });
    }
    const blog = await blogsCollection.findOne({ _id: new ObjectId(id) });
    if (!blog) {
      return res.status(404).json({ error: "Blog not found." });
    }
    if (useDiskStorage && blog.imageUrl && typeof blog.imageUrl === "string" && !blog.imageUrl.startsWith("data:")) {
      const base = path.basename(blog.imageUrl);
      const fp = path.join(blogUploadDir, base);
      try {
        await fs.promises.unlink(fp);
      } catch {
        /* file may already be gone */
      }
    }
    await blogsCollection.deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (err) {
    console.error("Blog delete error:", err);
    return res.status(500).json({ error: "Failed to delete blog." });
  }
});

/** Public list: heading-only excerpt/readTime — DB se body fields load nahi. */
function listCardExcerptFromHeading(mainHeading) {
  const t = String(mainHeading || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

function listReadTimeFromHeading(mainHeading) {
  const plain = String(mainHeading || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = plain.split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.ceil(words / 200))} min read`;
}

/**
 * Website list — native `mongodb` driver (Mongoose nahi). `.toArray()` plain objects;
 * `.lean()` sirf Mongoose par hota hai — yahan zarurat nahi.
 */
app.get("/api/public/blogs", async (req, res) => {
  try {
    const dbOk = await connectMongo();
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "9"), 10) || 9));
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const skip = (page - 1) * pageSize;

    if (!dbOk || !blogsCollection) {
      return res.json({ items: [], page, pageSize, hasMore: false });
    }

    const filter = { published: true };
    const projection = {
      mainHeading: 1,
      imageUrl: 1,
      createdAt: 1,
      slug: 1,
    };

    const fetchLimit = pageSize + 1;
    const list = await blogsCollection
      .find(filter, { projection })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(fetchLimit)
      .toArray();

    const hasMore = list.length > pageSize;
    const slice = hasMore ? list.slice(0, pageSize) : list;

    const items = slice.map((b) => ({
      id: b._id.toString(),
      slug: b.slug != null ? String(b.slug) : null,
      title: b.mainHeading,
      excerpt: listCardExcerptFromHeading(b.mainHeading),
      imageUrl: b.imageUrl || null,
      createdAt: b.createdAt,
      readTime: listReadTimeFromHeading(b.mainHeading),
    }));

    return res.json({ items, page, pageSize, hasMore });
  } catch (err) {
    console.error("Public blogs list error:", err);
    return res.status(500).json({ error: "Failed to load blogs." });
  }
});

/** Single published post (public detail page) */
app.get("/api/public/blogs/:id", async (req, res) => {
  try {
    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).json({ error: "Database not available." });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id." });
    }
    const b = await blogsCollection.findOne({ _id: new ObjectId(id), published: true });
    if (!b) {
      return res.status(404).json({ error: "Not found." });
    }
    const fallbackSubheadings = [
      { title: b.heading2First || "", content: b.paragraphFirst || "" },
      { title: b.heading2Second || "", content: b.paragraphSecond || "" },
    ].filter((item) => item.title || item.content);

    return res.json({
      id: b._id.toString(),
      mainHeading: b.mainHeading,
      introContent: b.introContent || b.paragraphFirst || "",
      subheadings: Array.isArray(b.subheadings)
        ? b.subheadings
            .slice(0, 10)
            .map((item) => ({
              title: String(item?.title || ""),
              content: String(item?.content || ""),
            }))
            .filter((item) => item.title || item.content)
        : fallbackSubheadings,
      conclusion: b.conclusion || b.paragraphSecond || "",
      imageAltText: b.imageAltText || "",
      imageUrl: b.imageUrl || null,
      createdAt: b.createdAt,
    });
  } catch (err) {
    console.error("Public blog get error:", err);
    return res.status(500).json({ error: "Failed to load blog." });
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
    const ok = await connectMongo();
    if (!ok) {
      console.error(
        "\n--- Pehli dafa MongoDB connect fail — jab blog add karoge tab dubara try hoga. Fix ke liye: ---\n" +
          "1) Internet / Wi-Fi, VPN band.\n" +
          "2) ipconfig /flushdns\n" +
          "3) Atlas se Standard connection string (mongodb://...) .env me MONGODB_URI me.\n" +
          "4) Atlas → Network Access → IP allow (0.0.0.0/0 ya apna IP).\n"
      );
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();

