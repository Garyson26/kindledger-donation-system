const express = require("express");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const connectDB = require("./config/db");

// Load environment variables
require("dotenv").config();

// Import Routes
const authRoutes = require("./routes/auth");
const categoryRoutes = require("./routes/categories");
const donationRoutes = require("./routes/donations");
const adminRoutes = require("./routes/admin");
const userRoutes = require("./routes/users");
const paymentRoutes = require("./routes/payment");

// Phase 2 data layer and runtime (SPEC-2). Additive: config/db.js and the
// Mongoose models are untouched and still serve every existing consumer.
const healthRoutes = require("./routes/health");
const { registerShutdownHandlers } = require("./config/prisma");
const { initializeScheduler } = require("./services/scheduler");

const app = express();

// SEC-04: trust exactly one proxy hop. Without this, `req.ip` behind Vercel
// (or any reverse proxy) is the proxy's own address, so express-rate-limit
// keys every client into a single shared bucket - which both fails to isolate
// an attacker and lets one noisy client lock everyone else out.
//
// THIS VALUE IS AN ASSUMPTION ABOUT THE DEPLOYMENT, NOT A CONSTANT.
// `1` is correct only because exactly one proxy that we control sits in front
// of this app and overwrites X-Forwarded-For: Vercel's edge. The number must
// equal the count of trusted proxies in the chain.
//
//   - Too low, and req.ip is a proxy address: one shared rate limit bucket.
//   - Too high, and the app reads a hop the client can write: an attacker
//     spoofs X-Forwarded-For and gets a fresh bucket per request, which
//     silently disables every per-IP limit.
//
// Nothing here validates that assumption at runtime. If this app is ever run
// with no proxy in front, or reached directly on its port, X-Forwarded-For is
// wholly client-supplied and `1` is wrong and unsafe.
//
// REVISIT IN PHASE 2, when the backend moves behind Nginx. If Nginx is the
// only hop, `1` stays correct - but it must also be configured with
// set_real_ip_from for the Docker network so it overwrites rather than
// appends. If a CDN is added in front of Nginx, this becomes 2.
app.set('trust proxy', 1);

// Security headers (BE-HIGH-05)
app.use(helmet({
  contentSecurityPolicy: false, // CSP is handled via Vercel headers on the frontend
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Body size limits (BE-HIGH-09)
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' })); // For PayU form data
app.use(morgan("dev"));
app.use(cookieParser());

// CORS — allow only configured origins (BE-HIGH-04)
// In development, localhost ports are allowed automatically.
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const localhostPattern = /^http:\/\/localhost(:\d+)?$/;

const restrictiveCors = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow same-origin / server-to-server
    if (configuredOrigins.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== 'production' && localhostPattern.test(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// Payment callbacks are browser-redirects from PayU (Origin = payu.in domain) and are
// secured by hash verification — open CORS is safe and required here.
const openCors = cors();

// Routes
// Health first. No CORS wrapper: the compose healthcheck and any external
// monitor are not browsers and send no Origin, and restrictiveCors would
// otherwise be one more thing between the platform and a liveness answer.
app.use("/api/health", healthRoutes);

app.use("/api/auth", restrictiveCors, authRoutes);
app.use("/api/categories", restrictiveCors, categoryRoutes);
app.use("/api/donations", restrictiveCors, donationRoutes);
app.use("/api/admin", restrictiveCors, adminRoutes);
app.use("/api/users", restrictiveCors, userRoutes);
app.use("/api/payment", openCors, paymentRoutes);

// Connect Database
connectDB();

// services/dataCleanupService.js is GONE as of package 3.3. It targeted
// MongoDB, it was never initialised here (it also assumed a long-lived process,
// which Vercel does not provide - BE-MED-02), and its one reachable caller was
// POST /api/admin/cleanup/trigger, which now runs the scheduler instead.
//
// ADR-053 is why "not initialised" was not the same as "does not execute": that
// was a statement about ONE caller being read as a statement about all of them,
// and it let BUG-10 sit unnoticed behind BUG-04.
//
// The Phase 2 scheduler targets MySQL, carries all three retention rules, is
// guarded by SCHEDULER_ENABLED, and is inert until Phase 4 loads data
// (SPEC-2 section 7.2).
initializeScheduler();

// Close the Prisma pool on SIGTERM/SIGINT. Registered here rather than on
// import so that requiring config/prisma.js from a test does not install
// signal handlers.
registerShutdownHandlers();

// Generic error handler — never expose raw error messages to clients (BE-MED-08)
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// Server
const PORT = process.env.PORT || 5000;

// Only start server if not in Vercel serverless environment
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
