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
// Optional dep — agar `compression` install na ho to bhi server crash na ho
let compression = null;
try {
  compression = require("compression");
} catch {
  /* npm install compression chalao to enable ho jayega */
}

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
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
    });
    await mongoClient.connect();
    const db = mongoClient.db(MONGODB_DB);
    contactsCollection = db.collection("contacts");
    blogsCollection = db.collection("blog_posts");
    // Index alag tick pe — pehla request jaldi; list query phir bhi chalti hai bina index ke
    setImmediate(() => {
      if (!blogsCollection) return;
      blogsCollection
        .createIndex({ published: 1, createdAt: -1 }, { background: true })
        .catch((idxErr) => console.warn("blog_posts index ensure:", idxErr?.message || idxErr));
    });
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
      callback(null, false);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

if (compression) {
  app.use(compression());
}

app.use(express.json());
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    maxAge: "30d",
    immutable: true,
    etag: true,
  })
);

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
    invalidatePublicCaches();
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
    invalidatePublicCaches();
    publicDetailCache.delete(id);
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
    invalidatePublicCaches();
    publicDetailCache.delete(id);
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
 *
 * Speed:
 *  - Aggregation $project se base64 imageUrl kabhi network/RAM tak nahi aata —
 *    sirf check hota hai prefix "data:" hai ya nahi. Image bytes alag endpoint
 *    `/api/public/blogs/:id/image` se long-cache headers ke saath aate hain.
 *  - Chhota in-memory cache (TTL ~60s) MongoDB roundtrip aur cold-start latency
 *    bachata hai jab same page baar baar khulta hai.
 *  - Cache-Control: CDN/browser dono cache karein.
 */
const PUBLIC_LIST_TTL_MS = 60 * 1000;
const publicListCache = new Map(); // key -> { exp, body }

function getCachedList(key) {
  const hit = publicListCache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    publicListCache.delete(key);
    return null;
  }
  return hit.body;
}

function setCachedList(key, body) {
  if (publicListCache.size > 64) {
    const oldestKey = publicListCache.keys().next().value;
    if (oldestKey) publicListCache.delete(oldestKey);
  }
  publicListCache.set(key, { exp: Date.now() + PUBLIC_LIST_TTL_MS, body });
}

function invalidatePublicCaches() {
  publicListCache.clear();
}

app.get("/api/public/blogs", async (req, res) => {
  try {
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "9"), 10) || 9));
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const skip = (page - 1) * pageSize;

    const cacheKey = `list:p=${page}:s=${pageSize}`;
    const cached = getCachedList(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.json({ items: [], page, pageSize, hasMore: false });
    }

    const fetchLimit = pageSize + 1;

    /**
     * Aggregation: imageUrl kabhi serialize ho ke client ya Node memory tak nahi aata
     * agar wo data URL hai. Sirf "isInline" boolean aur (non-inline) URL aata hai.
     */
    const list = await blogsCollection
      .aggregate(
        [
          { $match: { published: true } },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: fetchLimit },
          {
            $project: {
              mainHeading: 1,
              createdAt: 1,
              slug: 1,
              isInlineImage: {
                $eq: [
                  { $substrCP: [{ $ifNull: ["$imageUrl", ""] }, 0, 5] },
                  "data:",
                ],
              },
              imageUrlPlain: {
                $cond: [
                  {
                    $eq: [
                      { $substrCP: [{ $ifNull: ["$imageUrl", ""] }, 0, 5] },
                      "data:",
                    ],
                  },
                  null,
                  { $ifNull: ["$imageUrl", null] },
                ],
              },
            },
          },
        ],
        { allowDiskUse: false }
      )
      .toArray();

    const hasMore = list.length > pageSize;
    const slice = hasMore ? list.slice(0, pageSize) : list;

    const items = slice.map((b) => {
      const id = b._id.toString();
      // Inline image -> alag endpoint URL (browser independently load karega + long cache)
      const imageUrl = b.isInlineImage
        ? `/api/public/blogs/${id}/image`
        : b.imageUrlPlain || null;
      return {
        id,
        slug: b.slug != null ? String(b.slug) : null,
        title: b.mainHeading,
        excerpt: listCardExcerptFromHeading(b.mainHeading),
        imageUrl,
        createdAt: b.createdAt,
        readTime: listReadTimeFromHeading(b.mainHeading),
      };
    });

    const body = { items, page, pageSize, hasMore };
    setCachedList(cacheKey, body);

    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "MISS");
    return res.json(body);
  } catch (err) {
    console.error("Public blogs list error:", err);
    return res.status(500).json({ error: "Failed to load blogs." });
  }
});

/**
 * Image bytes endpoint — list me bheji gayi `/api/public/blogs/:id/image` URL.
 * Data URL ko parse kar ke binary bhejta hai with long immutable cache —
 * blog content rarely change hota hai, isliye 1 saal cache safe hai.
 */
app.get("/api/public/blogs/:id/image", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).end();
    }
    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).end();
    }
    const b = await blogsCollection.findOne(
      { _id: new ObjectId(id), published: true },
      { projection: { imageUrl: 1 } }
    );
    if (!b || !b.imageUrl) {
      return res.status(404).end();
    }

    const m = /^data:([^;]+);base64,(.+)$/.exec(b.imageUrl);
    if (!m) {
      // Disk-stored ya external URL — wahi follow karne do
      const target = /^https?:\/\//i.test(b.imageUrl)
        ? b.imageUrl
        : b.imageUrl.startsWith("/")
          ? b.imageUrl
          : `/${b.imageUrl}`;
      return res.redirect(302, target);
    }

    const mime = m[1] || "image/jpeg";
    const buf = Buffer.from(m[2], "base64");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.end(buf);
  } catch (err) {
    console.error("Blog image error:", err);
    return res.status(500).end();
  }
});

/** Single published post (public detail page) */
const PUBLIC_DETAIL_TTL_MS = 5 * 60 * 1000;
const publicDetailCache = new Map();

function getCachedDetail(id) {
  const hit = publicDetailCache.get(id);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    publicDetailCache.delete(id);
    return null;
  }
  return hit.body;
}
function setCachedDetail(id, body) {
  if (publicDetailCache.size > 128) {
    const oldestKey = publicDetailCache.keys().next().value;
    if (oldestKey) publicDetailCache.delete(oldestKey);
  }
  publicDetailCache.set(id, { exp: Date.now() + PUBLIC_DETAIL_TTL_MS, body });
}

app.get("/api/public/blogs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id." });
    }

    const cached = getCachedDetail(id);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    const dbOk = await connectMongo();
    if (!dbOk || !blogsCollection) {
      return res.status(503).json({ error: "Database not available." });
    }

    /**
     * Aggregation: detail mein full base64 imageUrl wapas bhejne ki zarurat nahi —
     * frontend image ko alag URL se load kar sakta hai (lazy + cache).
     */
    const docs = await blogsCollection
      .aggregate([
        { $match: { _id: new ObjectId(id), published: true } },
        { $limit: 1 },
        {
          $project: {
            mainHeading: 1,
            introContent: 1,
            subheadings: 1,
            conclusion: 1,
            imageAltText: 1,
            createdAt: 1,
            heading2First: 1,
            paragraphFirst: 1,
            heading2Second: 1,
            paragraphSecond: 1,
            isInlineImage: {
              $eq: [
                { $substrCP: [{ $ifNull: ["$imageUrl", ""] }, 0, 5] },
                "data:",
              ],
            },
            imageUrlPlain: {
              $cond: [
                {
                  $eq: [
                    { $substrCP: [{ $ifNull: ["$imageUrl", ""] }, 0, 5] },
                    "data:",
                  ],
                },
                null,
                { $ifNull: ["$imageUrl", null] },
              ],
            },
          },
        },
      ])
      .toArray();

    const b = docs[0];
    if (!b) {
      return res.status(404).json({ error: "Not found." });
    }

    const fallbackSubheadings = [
      { title: b.heading2First || "", content: b.paragraphFirst || "" },
      { title: b.heading2Second || "", content: b.paragraphSecond || "" },
    ].filter((item) => item.title || item.content);

    const imageUrl = b.isInlineImage
      ? `/api/public/blogs/${b._id.toString()}/image`
      : b.imageUrlPlain || null;

    const body = {
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
      imageUrl,
      createdAt: b.createdAt,
    };

    setCachedDetail(id, body);

    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    res.setHeader("X-Cache", "MISS");
    return res.json(body);
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
    setImmediate(async () => {
      try {
        await mailTransporter.verify();
        console.log("Email configured and verified for:", ADMIN_EMAIL);
      } catch (verifyErr) {
        console.error("Email verify failed (check App Password):", verifyErr.message);
      }
    });
  } else {
    console.warn("EMAIL_APP_PASSWORD not set, email notifications disabled.");
  }

  /** Pehle port bind — Hostinger/nginx timeout / "Failed to fetch" se bacho (Mongo await mat karo). */
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  if (!MONGODB_URI) {
    console.warn("MONGODB_URI not set, running without database connection.");
  } else {
    setImmediate(() => {
      connectMongo().then((ok) => {
        if (!ok) {
          console.error(
            "Initial MongoDB connect failed — API routes will retry. Check MONGODB_URI, Atlas IPs, DNS."
          );
        }
      });
    });
  }
}

start();

