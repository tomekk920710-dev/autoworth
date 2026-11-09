# AutoWorth V1.5.9 — GitHub / Render ready

AutoWorth is a web-based SaaS that interprets business workflows, quantifies automation economics, and produces a Full Automation Economics Report.

## V1.5.9 fixes
- Preserves the original workflow analysis and economics assumptions across Stripe Checkout using a browser session snapshot.
- After a confirmed Stripe payment, restores the original analysis and automatically saves the Full Report.
- Makes automatic report saving idempotent per paid Stripe Checkout Session, so repeated return checks do not create duplicate reports.
- Adds a database migration for the payment-session reference on existing reports.
- Keeps ordinary invoice-manager approval as a human step without forcing the entire invoice workflow into `KEEP_HUMAN`; high-stakes loan/credit, medical, legal, safety, and employment decisions remain human-gated.
- Preserves economics assumptions entered before the first analysis instead of clearing them at the start of the analysis.

## Included
- AI workflow interpreter with structured JSON
- deterministic economics engine
- account/login flow
- saved reports
- Stripe Checkout + signed webhook fulfillment
- Full Report PDF generation
- conversion tracking hooks
- Render deployment configuration

## Render
This repository is intended for a Render **Web Service**.

Recommended settings:
- Language: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Branch: `main`

Set the environment variables shown in `env.example` in Render before enabling AI/Stripe payments.

## Important production notes
- Never commit `.env` or secret keys.
- Set a long random `JWT_SECRET` in Render.
- Set `OPENAI_API_KEY` to enable live AI; without it, the app uses the built-in fallback interpreter.
- Keep Stripe values in Test/Sandbox mode until the complete end-to-end QA passes.
- `DB_PATH=./autoworth.db` is suitable only for an initial functional test. Configure a persistent disk or managed database before public launch; a normal instance filesystem should not be treated as durable storage.
- Review `npm audit` findings and update vulnerable dependencies before public launch.
- Replace legal/contact placeholders on the website before public advertising.


## V1.5.9 QA fixes

- Preserves user-edited economics assumptions when Analyze is run; workflow parsing no longer overwrites manually entered task volume or minutes per task.
- Requires explicit workload values or values parsed from the workflow before showing economics; avoids presenting defaults as verified workload data.
- Restricts workflow-level KEEP_HUMAN gating to explicitly high-stakes contexts; ordinary invoice manager approval remains a human control step without making the entire workflow human-only.
