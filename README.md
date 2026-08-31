# AutoWorth V1.5 — GitHub / Render ready

AutoWorth is a web-based SaaS that interprets business workflows, quantifies automation economics, and produces a Full Automation Economics Report.

## Included
- AI workflow interpreter with structured JSON
- deterministic economics engine
- account/login flow
- saved reports
- Stripe Checkout + signed webhook fulfillment
- Full Report PDF generation
- conversion tracking hooks
- production-oriented landing page
- Render deployment configuration

## Render
This repository is intended for a Render **Web Service**. Render's Node/Express deployment flow uses the repository, runs the build command, then starts the service; pushes to the connected branch can trigger automatic redeploys. See the official Render docs: https://render.com/docs/web-services

Recommended settings if entered manually:
- Language: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Branch: `main`

Set the environment variables shown in `.env.example` in Render before enabling real AI/Stripe payments.

## Important production notes
- Never commit `.env` or secret keys.
- Set a long random `JWT_SECRET` in Render.
- Set `OPENAI_API_KEY` to enable live AI; without it, the app uses the built-in fallback interpreter.
- Stripe values must be Test Mode values during testing.
- `DB_PATH=./autoworth.db` is suitable for an initial functional test, but a persistent/managed database should be used before serious production traffic because a normal instance filesystem should not be treated as durable storage.
- Replace legal/contact placeholders on the website before public advertising.
