# AutoWorth V2.0.0

Premium workflow automation analysis SaaS. The app provides AI workflow interpretation, deterministic economics, risk-aware decisions, saved reports, PDF export and Stripe Full Report checkout.

## Required environment
- `NODE_ENV=production`
- `JWT_SECRET` — long random secret
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-5.4`)
- `PUBLIC_APP_URL`
- `DB_PATH` — point this to a persistent mounted disk path in production
- `RESEND_API_KEY` — Resend API key for verification and password reset email
- `EMAIL_FROM` — sender address on a domain verified in Resend
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` — keep Test/Sandbox values until end-to-end QA is complete

## Email setup
Create a Resend account, verify a sending domain, then add `RESEND_API_KEY` and `EMAIL_FROM` in Render. `EMAIL_FROM` should be a verified sender, e.g. `AutoWorth <accounts@your-verified-domain>`.

Registration intentionally does not create an authenticated session until the user verifies their email. Verification links expire after 24 hours. Password reset links expire after one hour and are single-use. The API stores only SHA-256 hashes of the random tokens.

## Local development
```bash
npm install
npm run dev
```

## Deployment notes
The included Render blueprint lists the required environment variables but does not provision persistent disk storage on the Free plan. Before accepting real customer accounts/payments, configure durable storage or migrate SQLite to a managed database. Never use Stripe Live keys until checkout, webhook fulfillment, report recovery, and refund/support flows have passed QA.
