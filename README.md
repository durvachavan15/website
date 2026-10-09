# Durva Travels

## Run locally

Install Python 3.10 or newer, copy `.env.example` to `.env`, and run:

```powershell
python server.py
```

Open `http://127.0.0.1:8000`. SQLite creates `durva.sqlite3` on first start. Accounts, sessions, bookings, and payment records are stored there; passwords are hashed and session tokens are kept in HttpOnly cookies.

## Deploy to Netlify

The local Python/SQLite server is not used by Netlify. Netlify builds the static pages and runs the API as serverless functions; persistent records are stored in Supabase Postgres.

1. Create a Supabase project. In its SQL Editor, run `supabase/schema.sql`.
2. Push this project to a Git repository and import it into Netlify. Netlify uses `netlify.toml` and runs `npm run build`; the publish folder is `dist`.
3. In Netlify **Site configuration → Environment variables**, add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase **Project Settings → API**. Keep the service-role key server-side; never put it in frontend files.
4. Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` as Netlify environment variables. Start with test-mode credentials. Do not upload `razorpay.env` or commit secrets.
5. Redeploy after adding or changing environment variables.

Netlify provides HTTPS, which the login session cookie requires. For Razorpay webhooks, set `RAZORPAY_WEBHOOK_SECRET` in Netlify, then configure the Razorpay endpoint as `https://YOUR-SITE/api/razorpay-webhook` with `payment.captured` and `payment.failed` events. Use the webhook secret generated in Razorpay, not the API Key Secret. Rotate any Razorpay key that was exposed in a local file or chat before using it.

## Enable payments

Create a Razorpay account and open **Account & Settings → API Keys**. Generate a **Test Mode** key; Razorpay shows a Key ID (starts with `rzp_test_`) and a separate Key Secret. For local development, put both in `.env` or `razorpay.env`. For Netlify, set them in Netlify environment variables. Never put the Key Secret in an HTML or JavaScript file or share it in chat. Checkout uses Razorpay's hosted payment window; this site does not receive card numbers. Only a captured payment with a valid signature and matching server-side amount confirms a booking.

Without valid Razorpay keys, checkout is intentionally unavailable. Do not use test keys for live charges or commit `.env`.

## Deployment

The Python server and SQLite database are for local development only. On Netlify, use Supabase for persistent data and Netlify's encrypted environment variables for credentials. Before accepting real payments, configure a custom HTTPS domain, switch to live Razorpay credentials, set the production webhook URL and secret, and test the complete booking/payment flow.
