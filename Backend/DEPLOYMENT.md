> **SUPERSEDED — this document describes the MongoDB/Vercel deployment.**
>
> The system runs on **MySQL 8.4 via Prisma** and is deployed with Docker
> Compose. Every `MONGODB_URI` instruction below is wrong, and the MongoDB
> Atlas guidance describes a datastore this project no longer uses.
>
> Use the root `README.md` and `docker-compose.yml`. This file is kept only
> until the Vercel deployment notes are rewritten, and is not a guide to follow
> today.
>
> Found by BK2's sweep for documents that summarise a decision the code has
> moved past — the same class as the second `.env.example`.

# Backend Deployment Guide for Vercel

## Prerequisites
1. Install Vercel CLI: `npm install -g vercel`
2. Sign up at [vercel.com](https://vercel.com)

## Deployment Steps

### 1. Login to Vercel
```bash
cd Backend
vercel login
```

### 2. Configure Environment Variables
Before deploying, set up your environment variables in Vercel:

**Required Variables:**
- `MONGODB_URI` - Your MongoDB connection string
- `JWT_SECRET` - JWT secret key
- `JWT_EXPIRE` - JWT expiration time (e.g., "7d")
- `EMAIL_USER` - Email for nodemailer
- `EMAIL_PASS` - Email password
- `PAYU_MERCHANT_KEY` - PayU merchant key
- `PAYU_MERCHANT_SALT` - PayU merchant salt
- `PAYU_MODE` - "test" or "production"
- `FRONTEND_URL` - Your frontend URL (e.g., https://yourfrontend.vercel.app)

**Set via CLI:**
```bash
vercel env add MONGODB_URI
vercel env add JWT_SECRET
vercel env add JWT_EXPIRE
vercel env add EMAIL_USER
vercel env add EMAIL_PASS
vercel env add PAYU_MERCHANT_KEY
vercel env add PAYU_MERCHANT_SALT
vercel env add PAYU_MODE
vercel env add FRONTEND_URL
```

Or set them in the Vercel dashboard: Project Settings → Environment Variables

### 3. Deploy
```bash
# First deployment (will ask questions)
vercel

# Production deployment
vercel --prod
```

### 4. Update Frontend API URL
After deployment, update your frontend's API URL in:
`Frontend/src/config/constants.js`

Replace with your Vercel backend URL (e.g., `https://your-backend.vercel.app`)

## Important Notes

### Database Connection
- Vercel uses **serverless functions** - each request creates a new connection
- MongoDB connection is created on each cold start
- Consider using MongoDB Atlas with connection pooling
- Add your Vercel IPs to MongoDB Atlas whitelist (or use 0.0.0.0/0)

### CORS Configuration
Update your CORS settings in `app.js`:
```javascript
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
```

### Limitations
- **Max execution time**: 10 seconds (Hobby plan) or 60 seconds (Pro)
- **No persistent storage** - don't store files locally
- **Cold starts** - first request after idle may be slow
- **Serverless functions** - not suitable for WebSockets or long-polling

### Why Deployment Takes 11+ Minutes
If you're experiencing long deployments:
1. **Large dependencies** - Vercel installs all npm packages
2. **No build cache** - First deployment is always slower
3. **Multiple regions** - Vercel deploys to multiple edge locations
4. **Free tier limits** - Hobby plan has slower build times

**To speed up:**
- Remove unused dependencies from `package.json`
- Use `--prod` flag for production deployments
- Upgrade to Pro plan for faster builds
- Enable build caching (automatic after first deployment)

## Testing Locally
```bash
# Install Vercel CLI
npm install -g vercel

# Run locally with Vercel environment
vercel dev
```

## Monitoring
- View logs: `vercel logs <deployment-url>`
- Dashboard: https://vercel.com/dashboard
- Analytics available in Pro plan

## Alternative: Backend on Railway/Render
If you prefer traditional hosting (not serverless):
- **Railway**: Better for long-running processes, WebSockets
- **Render**: Free tier with persistent connections
- Both support regular Express apps without modifications
