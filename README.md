# StartupForge — Server (Express + MongoDB)

The **API server** for StartupForge. Exposes REST endpoints for auth,
startups, opportunities, applications, payments (Stripe), and admin
moderation.

> Companion client: [`../code2startup`](../code2startup) (Next.js 16).

## Stack

| Layer       | Tech                                        |
| ----------- | ------------------------------------------- |
| Runtime     | Node.js 18+ (Express 4.21)                  |
| Database    | MongoDB Atlas (official `mongodb` driver 6) |
| Auth        | Better Auth shared secret + JWT (`jose` 5)  |
| Payments    | Stripe 17 (Checkout Sessions + webhooks)    |
| Misc        | cookie-parser, cors, dotenv                 |

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create `.env` at the project root:

```bash
PORT=5000

# MongoDB
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/code2startup

# Shared with the client — Better Auth + JWT
BETTER_AUTH_SECRET=<long random string — paste the SAME value in the client .env.local>

# Public URL of the Next.js client — used to fetch Better Auth's JWKS for
# JWT verification. Defaults to http://localhost:3000.
BETTER_AUTH_URL=http://localhost:3000

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# CORS (comma-separated, optional)
CLIENT_ORIGIN=http://localhost:3000
```

### 3. Run

```bash
# Dev (auto-restart on file change)
npm run dev

# Prod
npm start
```

Server listens on `http://localhost:5000` by default.

### 4. Stripe webhook (local dev)

In a second terminal:

```bash
stripe listen --forward-to http://localhost:5000/payments/webhook
```

Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` and restart the server.

## Available scripts

| Script        | Purpose                                  |
| ------------- | ---------------------------------------- |
| `npm start`   | Run with `node index.js`.                |
| `npm run dev` | Run with `nodemon` (auto-restart).       |

## API surface

All routes return JSON. Protected routes require `Authorization: Bearer <jwt>`
where the JWT is the one issued by Better Auth on the client.

### Auth
- `POST /api/auth/*` — proxied via Next.js `/api/auth/[...all]` on the client.
- `GET  /verify-token` — JWT sanity-check, returns the decoded claims.

### Startups
- `GET    /startups` — public list (supports `?industry=&funding_stage=&page=&limit=`)
- `GET    /startups/:id` — public detail
- `POST   /startups` — **founder** — create
- `PUT    /startups/:id` — **founder (owner)** — update
- `DELETE /startups/:id` — **founder (owner) | admin** — delete
- `POST   /startups/:id/approve` — **admin** — approve
- `POST   /startups/:id/block` — **admin** — block
- `GET    /startups/founder/:email` — **founder (owner)** — own startups

### Opportunities
- `GET    /opportunities` — public list
- `GET    /opportunities/:id` — public detail
- `POST   /opportunities` — **founder (premium)** — create
- `PUT    /opportunities/:id` — **founder (owner)** — update
- `DELETE /opportunities/:id` — **founder (owner) | admin** — delete

### Applications
- `POST   /applications` — **collaborator** — apply
- `GET    /applications/founder` — **founder** — apps for my opps
- `GET    /applications/user/:email` — **collaborator** — my apps
- `PUT    /applications/:id/status` — **founder (owner)** — accept/reject

### Payments (Stripe)
- `POST   /payments/create-checkout-session` — **founder** — returns Stripe URL
- `POST   /payments/webhook` — Stripe → updates `payment_status`
- `GET    /payments/status/:userId` — **owner | admin** — current status
- `GET    /payments` — **admin** — paginated list

### Admin
- `GET    /users` — **admin** — paginated list (supports `?q=&page=&limit=`)
- `POST   /users/:email/block` — **admin** — block user
- `POST   /users/:email/unblock` — **admin** — unblock user

### Utility
- `GET    /` — health probe
- `GET    /stats` — **admin** — top-line stats

## Project structure

```
code2startup_server/
  index.js                Express app, routes, middleware
  middleware/
    auth.js               requireAuth + requireRole(...)
  package.json
```

## Deployment

- **Render / Railway / Fly.io** — point at the repo, set `build: npm install`,
  `start: npm start`, expose `PORT` from env.
- **MongoDB Atlas** — paste the connection string into `MONGODB_URI`.
- **Stripe webhook** — register the deployed URL with
  `stripe listen` (local) or the Stripe Dashboard → Webhooks (prod).

Make sure `BETTER_AUTH_SECRET` matches the value used by the client.
