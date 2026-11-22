import express from "express";
import OpenAI from "openai";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import PDFDocument from "pdfkit";
import path from "path";
import {existsSync,mkdirSync} from "fs";
import {fileURLToPath} from "url";
import {randomBytes,createHash} from "crypto";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express(), PORT=process.env.PORT||3000;
const JWT_SECRET=process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-only-change-me");
if(process.env.NODE_ENV === "production" && !process.env.JWT_SECRET){ console.error("FATAL: JWT_SECRET is required in production."); process.exit(1); }
const MODEL=process.env.OPENAI_MODEL||"gpt-5.4";
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
app.post("/api/stripe/webhook", express.raw({type:"application/json"}), async (req,res)=>{
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe not configured");
  const sig=req.headers["stripe-signature"];
  let event;
  try{ event=stripe.webhooks.constructEvent(req.body,sig,process.env.STRIPE_WEBHOOK_SECRET); }
  catch(e){ console.error("Stripe webhook signature error:",e.message); return res.status(400).send("Webhook signature verification failed"); }
  if(q.eventExists.get(event.id)) return res.json({received:true,duplicate:true});
  try{
    if(event.type==="checkout.session.completed" || event.type==="checkout.session.async_payment_succeeded"){
      const session=event.data.object;
      fulfillPaidSession(session);
    }
    q.insertEvent.run(event.id);
    return res.json({received:true});
  }catch(e){ console.error("Stripe fulfillment error:",e); return res.status(500).send("Webhook processing failed"); }
});
app.use(express.json({limit:"100kb"}));
app.use(cookieParser());

const rateBuckets=new Map();
function rateLimit({windowMs,max,keyPrefix}){return (req,res,next)=>{const key=keyPrefix+":"+(req.ip||req.socket.remoteAddress||"unknown"),now=Date.now(),b=rateBuckets.get(key);if(!b||now-b.start>=windowMs){rateBuckets.set(key,{start:now,count:1});return next()}b.count++;if(b.count>max)return res.status(429).json({error:"Too many requests. Please try again later."});next()}}
setInterval(()=>{const cutoff=Date.now()-3600000;for(const [k,v] of rateBuckets)if(v.start<cutoff)rateBuckets.delete(k)},600000).unref();

app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

const configuredDbPath=process.env.DB_PATH||path.join(__dirname,"autoworth.db");
const resolvedDbPath=path.resolve(configuredDbPath);
mkdirSync(path.dirname(resolvedDbPath),{recursive:true});
const legacyDbPath=path.join(__dirname,"autoworth.db");
// One-time safe copy from the old ephemeral SQLite location to the persistent disk.
// better-sqlite3's backup API also accounts for committed WAL data.
if(resolvedDbPath!==path.resolve(legacyDbPath) && !existsSync(resolvedDbPath) && existsSync(legacyDbPath)){
  const legacyDb=new Database(legacyDbPath);
  await legacyDb.backup(resolvedDbPath);
  legacyDb.close();
  console.log("[DB] Existing SQLite data copied to persistent storage:",resolvedDbPath);
}
const db=new Database(resolvedDbPath);
console.log("[DB] SQLite database opened:", db.name, "| DB_PATH configured:", Boolean(process.env.DB_PATH));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,plan TEXT DEFAULT "free",report_credits INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,workflow TEXT NOT NULL,analysis_json TEXT NOT NULL,economics_json TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS stripe_events(id TEXT PRIMARY KEY,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS checkout_sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT "created",created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS auth_tokens(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token_hash TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));`);
const userColumns=db.pragma("table_info(users)");
if(!userColumns.some(c=>c.name==="email_verified_at")){db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");db.exec("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP WHERE email_verified_at IS NULL");}
const reportColumns=db.pragma("table_info(reports)");
if(!reportColumns.some(c=>c.name==="payment_session_id")) db.exec("ALTER TABLE reports ADD COLUMN payment_session_id TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_payment_session ON reports(user_id,payment_session_id) WHERE payment_session_id IS NOT NULL");
const q={userByEmail:db.prepare("SELECT * FROM users WHERE email=?"),userById:db.prepare("SELECT id,email FROM users WHERE id=?"),
insertUser:db.prepare("INSERT INTO users(email,password_hash,email_verified_at) VALUES(?,?,NULL)"),insertReport:db.prepare("INSERT INTO reports(user_id,title,workflow,analysis_json,economics_json) VALUES(?,?,?,?,?)"),
insertPaidReport:db.prepare("INSERT INTO reports(user_id,title,workflow,analysis_json,economics_json,payment_session_id) VALUES(?,?,?,?,?,?)"),
paidCheckout:db.prepare("SELECT id FROM checkout_sessions WHERE id=? AND user_id=? AND status='paid'"),
reportByPaymentSession:db.prepare("SELECT id FROM reports WHERE user_id=? AND payment_session_id=?"),
reports:db.prepare("SELECT id,title,created_at FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 50"),report:db.prepare("SELECT * FROM reports WHERE id=? AND user_id=?"),deleteReport:db.prepare("DELETE FROM reports WHERE id=? AND user_id=?"),
insertCheckout:db.prepare("INSERT OR REPLACE INTO checkout_sessions(id,user_id,status) VALUES(?,?,?)"),
checkout:db.prepare("SELECT * FROM checkout_sessions WHERE id=?"),
eventExists:db.prepare("SELECT id FROM stripe_events WHERE id=?"),
insertEvent:db.prepare("INSERT INTO stripe_events(id) VALUES(?)"),
insertAuthToken:db.prepare("INSERT INTO auth_tokens(user_id,token_hash,kind,expires_at) VALUES(?,?,?,?)"),
authToken:db.prepare("SELECT * FROM auth_tokens WHERE token_hash=? AND kind=? AND used_at IS NULL AND expires_at>?"),
consumeAuthToken:db.prepare("UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL"),
verifyUser:db.prepare("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP WHERE id=?"),
updatePassword:db.prepare("UPDATE users SET password_hash=? WHERE id=?")
};

function token(user){return jwt.sign({id:user.id,email:user.email},JWT_SECRET,{expiresIn:"7d"})}
function auth(req,res,next){try{const t=req.cookies.autoworth_token;if(!t)return res.status(401).json({error:"Login required"});req.user=jwt.verify(t,JWT_SECRET);next()}catch{return res.status(401).json({error:"Session expired. Please log in again."})}}

const schema={type:"object",additionalProperties:false,properties:{
workflow_summary:{type:"string"},confidence:{type:"number",minimum:0,maximum:100},assumptions:{type:"array",items:{type:"string"}},flags:{type:"array",items:{type:"string"}},
economics:{type:"object",additionalProperties:false,properties:{
 tasks:{type:"number",minimum:0},minutes_per_task:{type:"number",minimum:0},labor_usd_hour:{type:"number",minimum:0},ai_usd_task:{type:"number",minimum:0},human_review_minutes:{type:"number",minimum:0},human_review_rate_pct:{type:"number",minimum:0,maximum:100},ai_error_rate_pct:{type:"number",minimum:0,maximum:100},implementation_cost_usd:{type:"number",minimum:0},
 fields_basis:{type:"object",additionalProperties:false,properties:{tasks:{type:"string",enum:["explicit","estimated"]},minutes_per_task:{type:"string",enum:["explicit","estimated"]},labor_usd_hour:{type:"string",enum:["explicit","estimated"]},ai_usd_task:{type:"string",enum:["explicit","estimated"]},human_review_minutes:{type:"string",enum:["explicit","estimated"]},human_review_rate_pct:{type:"string",enum:["explicit","estimated"]},ai_error_rate_pct:{type:"string",enum:["explicit","estimated"]},implementation_cost_usd:{type:"string",enum:["explicit","estimated"]}},required:["tasks","minutes_per_task","labor_usd_hour","ai_usd_task","human_review_minutes","human_review_rate_pct","ai_error_rate_pct","implementation_cost_usd"]},
 notes:{type:"array",items:{type:"string"}}},required:["tasks","minutes_per_task","labor_usd_hour","ai_usd_task","human_review_minutes","human_review_rate_pct","ai_error_rate_pct","implementation_cost_usd","fields_basis","notes"]},
steps:{type:"array",minItems:1,maxItems:12,items:{type:"object",additionalProperties:false,properties:{
id:{type:"integer"},name:{type:"string"},description:{type:"string"},type:{type:"string",enum:["input","data","decision","calculation","language","workflow","control","high_risk","judgement","unknown"]},
automation_potential:{type:"number",minimum:0,maximum:100},risk:{type:"string",enum:["Low","Medium","High","Unknown"]},recommended_mode:{type:"string",enum:["AUTOMATE","AUGMENT","SIMPLIFY","BUY","KEEP_HUMAN"]},human_required:{type:"boolean"},estimated_time_share_pct:{type:"number",minimum:0,maximum:100},rationale:{type:"string"}},
required:["id","name","description","type","automation_potential","risk","recommended_mode","human_required","estimated_time_share_pct","rationale"]}},
recommended_architecture:{type:"array",minItems:2,maxItems:12,items:{type:"string"}},
build_plan:{type:"array",minItems:3,maxItems:8,items:{type:"object",additionalProperties:false,properties:{step:{type:"integer"},action:{type:"string"},purpose:{type:"string"},success_metric:{type:"string"}},required:["step","action","purpose","success_metric"]}},
ai_tasks:{type:"array",minItems:1,maxItems:8,items:{type:"object",additionalProperties:false,properties:{task:{type:"string"},input:{type:"string"},output:{type:"string"},guardrail:{type:"string"}},required:["task","input","output","guardrail"]}}
},required:["workflow_summary","confidence","assumptions","flags","economics","steps","recommended_architecture","build_plan","ai_tasks"]};

const instructions=`You are AutoWorth. Interpret a business workflow into structured JSON for a deterministic economics engine.
Never present an estimate as a confirmed fact. In economics, extract any explicit workload or cost values from the user's text exactly. For every missing value, provide a conservative, clearly labeled estimate based on the described workflow and common small-business operations; use fields_basis="estimated" and explain the estimate in notes. Do not copy values from prior analyses. tasks is monthly task volume (convert daily to 22 working days/month and weekly to 4.33 weeks/month); minutes_per_task is active employee time per task before automation; labor_usd_hour is fully loaded labor cost; ai_usd_task is expected AI/software variable cost per task; human_review_minutes is time per reviewed task; human_review_rate_pct is share of tasks reviewed by a human; ai_error_rate_pct is expected AI error rate; implementation_cost_usd is one-time setup cost. If a field genuinely cannot be reasonably estimated, use a conservative small-business estimate and label it estimated rather than leaving it blank. Human review rate is NOT the same as AI error rate. Keep estimates internally consistent and use USD. Recommend AUTOMATE only for repeatable structured low-risk work; AUGMENT for AI first-pass + human exceptions; SIMPLIFY for deterministic rules; BUY for clearly common software categories; KEEP_HUMAN for high-stakes or judgement-dominant work. Mark human_required for high-risk/judgement work. State assumptions. Return only schema JSON.

CONFIDENCE CALIBRATION: confidence is a 0-100 percentage, NOT a 0-10 score. For a concrete workflow with clear steps, normally use 80-100. Use 60-79 when some important details are missing, 40-59 when several assumptions are required, and below 40 only when the workflow is genuinely ambiguous. Never output 1, 5, 10 etc. merely as a shorthand for a low-confidence score.

AUTOMATION POTENTIAL CALIBRATION: automation_potential is a 0-100 percentage for that specific step, NOT a 0-10 score. Repeatable structured low-risk steps such as receiving emails, downloading attachments, extracting standard fields, writing rows to a spreadsheet, and filing documents can often be 80-100. Judgement-heavy or high-stakes steps should be low and KEEP_HUMAN. Do not use 1% as a generic placeholder.

For the workflow itself, infer the actual operational steps from the user's text. Do not replace a concrete workflow with a generic template.`;

function fallbackEconomics(t){
 const text=String(t||'');
 const monthly=text.match(/\b([0-9][0-9,]*)\s+(?:supplier\s+|customer\s+)?(?:invoices?|emails?|requests?|tickets?|orders?|tasks?)\s+(?:per|each)\s+month\b/i);
 const daily=text.match(/\b([0-9][0-9,]*)\s+(?:supplier\s+|customer\s+)?(?:invoices?|emails?|requests?|tickets?|orders?|tasks?)\s+(?:per|each)\s+day\b/i);
 const count=monthly?Number(monthly[1].replace(/,/g,'')):daily?Number(daily[1].replace(/,/g,''))*22:500;
 const time=text.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:minutes?|mins?)\s+(?:per|each)\s+(?:invoice|email|request|ticket|order|task)\b/i);
 const mins=time?Number(time[1]):8;
 const fields_basis={tasks:monthly||daily?'explicit':'estimated',minutes_per_task:time?'explicit':'estimated',labor_usd_hour:'estimated',ai_usd_task:'estimated',human_review_minutes:'estimated',human_review_rate_pct:'estimated',ai_error_rate_pct:'estimated',implementation_cost_usd:'estimated'};
 return {tasks:Math.max(1,count),minutes_per_task:Math.max(.1,mins),labor_usd_hour:30,ai_usd_task:.05,human_review_minutes:3,human_review_rate_pct:100,ai_error_rate_pct:3,implementation_cost_usd:500,fields_basis,notes:['Fallback estimates are conservative placeholders; verify labor, AI pricing, review policy and implementation cost before using the forecast.']};
}
function fallback(t){let s=[];const rules=[[/email|request|form|message|ticket/,"Receive / read input","input",88,"Low","AUTOMATE"],[/copy|paste|extract|crm|spreadsheet|database|enter/,"Extract / store data","data",94,"Low","AUTOMATE"],[/categor|classif|triage|sort|route/,"Classify / route","decision",82,"Medium","AUTOMATE"],[/price|pricing|quote|calculate/,"Calculate / quote","calculation",76,"Medium","AUGMENT"],[/reply|respond|answer|draft|send/,"Draft / send response","language",78,"Medium","AUGMENT"],[/schedule|calendar|follow.?up|reminder/,"Schedule / follow up","workflow",90,"Low","AUTOMATE"],[/complaint|refund|payment|financial|legal|medical|safety/,"Sensitive decision","high_risk",25,"High","KEEP_HUMAN"],[/negotiat|sales call|close|escalat/,"Judgement / negotiation","judgement",35,"High","KEEP_HUMAN"]];for(const[r,n,type,p,risk,m]of rules)if(r.test(t.toLowerCase()))s.push({id:s.length+1,name:n,description:"Fallback detection.",type,automation_potential:p,risk,recommended_mode:m,human_required:m!=="AUTOMATE",estimated_time_share_pct:Math.round(100/Math.max(1,s.length+1)),rationale:"Fallback mode."});if(!s.length)s=[{id:1,name:"Process / output",description:"More detail needed.",type:"unknown",automation_potential:50,risk:"Unknown",recommended_mode:"AUGMENT",human_required:true,estimated_time_share_pct:100,rationale:"More detail needed."}];return{workflow_summary:"Fallback interpretation",confidence:55,assumptions:["Configure OPENAI_API_KEY for live AI"],flags:[],economics:fallbackEconomics(t),steps:s,recommended_architecture:["Trigger","AI / rules","Validation","Human exception queue","Output","Monitoring"],build_plan:[{step:1,action:"Run shadow pilot",purpose:"Measure actual performance",success_metric:"Target exception rate met"},{step:2,action:"Add validation",purpose:"Protect outputs",success_metric:"No critical errors"},{step:3,action:"Recalculate economics",purpose:"Validate case",success_metric:"Actual savings beat target"}],ai_tasks:[{task:"Extract fields",input:"Workflow data",output:"Structured fields",guardrail:"Reject low-confidence values"}]};}

app.get("/api/health",(req,res)=>res.json({ok:true,ai_enabled:Boolean(process.env.OPENAI_API_KEY),email_enabled:Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM),db:true,model:MODEL}));
async function sendAuthEmail(to,subject,html){
  if(!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.error("[AUTH_EMAIL] Not configured: RESEND_API_KEY or EMAIL_FROM is missing.");
    throw new Error("EMAIL_NOT_CONFIGURED");
  }
  console.log("[AUTH_EMAIL] Sending:", subject);
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[to],subject,html})});
  const body=await response.text();
  if(!response.ok){console.error("[AUTH_EMAIL] Resend rejected request. HTTP",response.status,body);throw new Error("EMAIL_SEND_FAILED");}
  let result={};
  try{result=JSON.parse(body)}catch{}
  console.log("[AUTH_EMAIL] Resend accepted message. id:", result.id || "not-returned");
  return result;
}
function issueAuthToken(userId,kind,ttlSeconds){const raw=randomBytes(32).toString("hex"),hash=createHash("sha256").update(raw).digest("hex");q.insertAuthToken.run(userId,hash,kind,Math.floor(Date.now()/1000)+ttlSeconds);return raw;}
function appOrigin(req){return String(process.env.PUBLIC_APP_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");}
app.post("/api/auth/register",rateLimit({windowMs:900000,max:10,keyPrefix:"register"}),async(req,res)=>{try{
 const email=String(req.body.email||"").trim().toLowerCase(),pw=String(req.body.password||"");
 if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||pw.length<10)return res.status(400).json({error:"Enter a valid email and a password with at least 10 characters."});
 const hash=await bcrypt.hash(pw,12),info=q.insertUser.run(email,hash),uid=Number(info.lastInsertRowid),raw=issueAuthToken(uid,"verify",86400),link=`${appOrigin(req)}/?verify=${encodeURIComponent(raw)}`;
 try{await sendAuthEmail(email,"Confirm your AutoWorth email",`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033"><h1>Welcome to AutoWorth</h1><p>Your next efficiency improvement starts here.</p><p>Confirm your email address to activate your account and save your workflow reports.</p><p><a href="${link}" style="display:inline-block;background:#172033;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none">Verify email address</a></p><p>This link expires in 24 hours. If you did not create this account, you can ignore this message.</p></div>`);}
 catch(e){db.prepare("DELETE FROM auth_tokens WHERE user_id=? AND kind='verify'").run(uid);db.prepare("DELETE FROM users WHERE id=?").run(uid);if(e.message==="EMAIL_NOT_CONFIGURED")return res.status(503).json({error:"Email delivery is not configured yet. Please contact support; account creation is temporarily unavailable."});return res.status(502).json({error:"We could not send the verification email. Please try again shortly."});}
 res.json({verificationRequired:true,message:"Check your inbox to verify your email address."});
 }catch(e){if(String(e).includes("UNIQUE"))return res.status(409).json({error:"An account with this email already exists. Try signing in instead."});console.error(e);res.status(500).json({error:"Registration failed."})}});
app.post("/api/auth/verify",rateLimit({windowMs:900000,max:20,keyPrefix:"verify"}),(req,res)=>{const raw=String(req.body.token||""),hash=createHash("sha256").update(raw).digest("hex"),row=q.authToken.get(hash,"verify",Math.floor(Date.now()/1000));if(!row)return res.status(400).json({error:"This verification link is invalid or has expired. Request a new one."});db.transaction(()=>{q.consumeAuthToken.run(Math.floor(Date.now()/1000),row.id);q.verifyUser.run(row.user_id)})();const u=q.userById.get(row.user_id);res.cookie("autoworth_token",token(u),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:604800000});res.json({user:u,message:"Email verified. Welcome to AutoWorth."})});
app.post("/api/auth/resend-verification",rateLimit({windowMs:900000,max:5,keyPrefix:"resendverify"}),async(req,res)=>{const email=String(req.body.email||"").trim().toLowerCase(),u=q.userByEmail.get(email);if(u&&!u.email_verified_at){const raw=issueAuthToken(u.id,"verify",86400),link=`${appOrigin(req)}/?verify=${encodeURIComponent(raw)}`;try{await sendAuthEmail(email,"Your AutoWorth verification link",`<p>Confirm your email:</p><p><a href="${link}">Verify email address</a></p><p>This link expires in 24 hours.</p>`)}catch(e){return res.status(503).json({error:"We could not send the email. Please try again later."})}}res.json({message:"If this address has an unverified account, a new verification email has been sent."})});
app.post("/api/auth/forgot-password",rateLimit({windowMs:900000,max:5,keyPrefix:"forgot"}),async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase();
 const u=q.userByEmail.get(email);
 console.log("[AUTH_FORGOT] Account lookup:", u ? "FOUND" : "NOT_FOUND");
 if(u){
  const raw=issueAuthToken(u.id,"reset",3600),link=`${appOrigin(req)}/?reset=${encodeURIComponent(raw)}`;
  try{
   await sendAuthEmail(email,"Reset your AutoWorth password",`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h1>Password reset</h1><p>We received a request to reset your AutoWorth password.</p><p><a href="${link}">Choose a new password</a></p><p>This one-time link expires in one hour. If you did not request this, ignore this email.</p></div>`);
  }catch(e){
   console.error("[AUTH_FORGOT] Email delivery failed:",e.message);
   return res.status(503).json({error:"Password reset email could not be sent. Please try again later."});
  }
 }
 res.json({message:"If an account exists for that email, a password reset link has been sent."});
});
app.post("/api/auth/reset-password",rateLimit({windowMs:900000,max:10,keyPrefix:"reset"}),async(req,res)=>{const raw=String(req.body.token||""),pw=String(req.body.password||"");if(pw.length<10)return res.status(400).json({error:"Use a password with at least 10 characters."});const hash=createHash("sha256").update(raw).digest("hex"),row=q.authToken.get(hash,"reset",Math.floor(Date.now()/1000));if(!row)return res.status(400).json({error:"This reset link is invalid, expired or already used."});const pwHash=await bcrypt.hash(pw,12);db.transaction(()=>{q.updatePassword.run(pwHash,row.user_id);q.consumeAuthToken.run(Math.floor(Date.now()/1000),row.id);db.prepare("UPDATE auth_tokens SET used_at=? WHERE user_id=? AND kind='reset' AND used_at IS NULL").run(Math.floor(Date.now()/1000),row.user_id)})();res.clearCookie("autoworth_token");res.json({message:"Password updated. You can now sign in with your new password."})});
app.post("/api/auth/login",rateLimit({windowMs:900000,max:15,keyPrefix:"login"}),async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase(),pw=String(req.body.password||""),u=q.userByEmail.get(email);
 if(!u){console.warn("[AUTH_LOGIN] Account lookup: NOT_FOUND");return res.status(401).json({error:"Invalid email or password."});}
 const passwordMatches=await bcrypt.compare(pw,u.password_hash);
 console.log("[AUTH_LOGIN] Account lookup: FOUND | Password match:",passwordMatches,"| Email verified:",Boolean(u.email_verified_at));
 if(!passwordMatches)return res.status(401).json({error:"Invalid email or password."});
 if(!u.email_verified_at)return res.status(403).json({error:"Please verify your email before signing in. You can request a new verification email."});
 res.cookie("autoworth_token",token(u),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:604800000});
 res.json({user:{id:u.id,email:u.email}});
});
app.post("/api/auth/logout",(req,res)=>{res.clearCookie("autoworth_token");res.json({ok:true})});
app.get("/api/auth/me",auth,(req,res)=>res.json({user:q.userById.get(req.user.id)}));
function fulfillPaidSession(session){
  if(session.mode!=="payment" || session.payment_status!=="paid") return false;
  if(String(session.metadata?.product||"")!=="autoworth_full_report") return false;
  const userId=Number(session.metadata?.user_id||session.client_reference_id||0);
  if(!Number.isInteger(userId)||userId<1) return false;
  const u=db.prepare("SELECT id FROM users WHERE id=?").get(userId);
  if(!u) return false;
  db.transaction(()=>{
    db.prepare("UPDATE users SET plan='pro',report_credits=MAX(report_credits,1) WHERE id=?").run(userId);
    q.insertCheckout.run(session.id,userId,"paid");
  })();
  return true;
}

app.get("/api/billing/checkout-status",auth,async(req,res)=>{
  const id=String(req.query.session_id||"");
  if(!stripe || !id)return res.status(400).json({error:"Missing checkout session."});
  try{
    const s=await stripe.checkout.sessions.retrieve(id);
    const owner=String(s.client_reference_id||s.metadata?.user_id||"");
    if(owner!==String(req.user.id))return res.status(403).json({error:"Not your checkout session."});
    const paid=fulfillPaidSession(s);
    res.json({status:s.status,paymentStatus:s.payment_status,paid});
  }catch(e){console.error("Checkout verification error:",e.message);res.status(400).json({error:"Could not verify checkout session."})}
});
app.get("/api/billing/status",auth,(req,res)=>{
 const u=db.prepare("SELECT id,email,plan,report_credits FROM users WHERE id=?").get(req.user.id);
 res.json({plan:u.plan,reportCredits:u.report_credits});
});
app.post("/api/billing/create-checkout-session",auth,async(req,res)=>{
  if(!stripe || !process.env.STRIPE_PRICE_ID) return res.status(503).json({error:"Stripe is not configured yet."});
  const u=db.prepare("SELECT id,email FROM users WHERE id=?").get(req.user.id);
  const origin=String(process.env.PUBLIC_APP_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");
  try{
    const session=await stripe.checkout.sessions.create({
      mode:"payment",
      line_items:[{price:process.env.STRIPE_PRICE_ID,quantity:1}],
      customer_email:u.email,
      client_reference_id:String(u.id),
      metadata:{user_id:String(u.id),product:"autoworth_full_report"},
      success_url:`${origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${origin}/?payment=cancelled`,
      allow_promotion_codes:true
    });
    q.insertCheckout.run(session.id,u.id,"created");
    res.json({url:session.url,id:session.id});
  }catch(e){console.error(e);res.status(502).json({error:"Could not create Stripe Checkout session."})}
});


app.post("/api/analyze",rateLimit({windowMs:600000,max:30,keyPrefix:"analyze"}),async(req,res)=>{const workflow=String(req.body.workflow||"").trim();if(workflow.length<20)return res.status(400).json({error:"Please describe a real workflow in a few sentences."});if(workflow.length>12000)return res.status(400).json({error:"Workflow is too long."});if(!process.env.OPENAI_API_KEY)return res.json({source:"fallback",analysis:fallback(workflow)});try{const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});const r=await client.responses.create({model:MODEL,instructions,input:workflow,store:false,reasoning:{effort:"none"},temperature:.2,text:{format:{type:"json_schema",name:"autoworth_workflow",strict:true,schema},verbosity:"low"}});let parsed=JSON.parse(r.output_text);
    if(Number.isFinite(parsed.confidence)&&parsed.confidence>0&&parsed.confidence<=10) parsed.confidence*=10;
    if(Array.isArray(parsed.steps)){
      parsed.steps=parsed.steps.map(s=>{if(Number.isFinite(s.automation_potential)&&s.automation_potential>0&&s.automation_potential<=10)s.automation_potential*=10;return s});
    }
    res.json({source:"openai",analysis:parsed,usage:r.usage||null})}catch(e){console.error(e);res.status(502).json({error:"AI analysis failed. Please try again."})}});

app.post("/api/reports",auth,(req,res)=>{
 const title=String(req.body.title||"Untitled workflow").slice(0,120),workflow=String(req.body.workflow||"").slice(0,12000),analysis=req.body.analysis,economics=req.body.economics,paymentSessionId=String(req.body.paymentSessionId||"").trim();
 if(!workflow||!analysis)return res.status(400).json({error:"Missing report data"});
 try{
   if(paymentSessionId){
     const paid=q.paidCheckout.get(paymentSessionId,req.user.id);
     if(!paid)return res.status(403).json({error:"A confirmed payment is required to auto-save this report."});
     const existing=q.reportByPaymentSession.get(req.user.id,paymentSessionId);
     if(existing)return res.json({id:existing.id,alreadySaved:true});
     const saved=q.insertPaidReport.run(req.user.id,title,workflow,JSON.stringify(analysis),JSON.stringify(economics??null),paymentSessionId);
     return res.json({id:saved.lastInsertRowid,alreadySaved:false});
   }
   const tx=db.transaction(()=>{
     const u=db.prepare("SELECT plan,report_credits FROM users WHERE id=?").get(req.user.id);
     if(!u)throw Object.assign(new Error("USER_NOT_FOUND"),{code:"USER_NOT_FOUND"});
     if(u.plan!=="pro"){
       const debit=db.prepare("UPDATE users SET report_credits=report_credits-1 WHERE id=? AND report_credits>0").run(req.user.id);
       if(debit.changes!==1)throw Object.assign(new Error("PAYWALL"),{code:"PAYWALL"});
     }
     return q.insertReport.run(req.user.id,title,workflow,JSON.stringify(analysis),JSON.stringify(economics??null));
   });
   const r=tx();res.json({id:r.lastInsertRowid});
 }catch(e){
   if(e.code==="PAYWALL")return res.status(402).json({error:"Full Report unlock required.",code:"PAYWALL"});
   if(paymentSessionId){
     const existing=q.reportByPaymentSession.get(req.user.id,paymentSessionId);
     if(existing)return res.json({id:existing.id,alreadySaved:true});
   }
   console.error("Report save error:",e.message);
   res.status(500).json({error:"Could not save report."});
 }
});

app.put("/api/reports/:id",auth,(req,res)=>{
 const id=Number(req.params.id);
 const workflow=String(req.body.workflow||"").slice(0,12000),analysis=req.body.analysis,economics=req.body.economics;
 if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"Invalid report ID."});
 if(!workflow||!analysis||!economics||economics.available===false)return res.status(400).json({error:"Valid workflow and economics data are required."});
 const result=db.prepare("UPDATE reports SET workflow=?,analysis_json=?,economics_json=? WHERE id=? AND user_id=?").run(workflow,JSON.stringify(analysis),JSON.stringify(economics),id,req.user.id);
 if(result.changes!==1)return res.status(404).json({error:"Saved report not found."});
 res.json({id,updated:true});
});
app.get("/api/reports",auth,(req,res)=>res.json({reports:q.reports.all(req.user.id)}));
app.get("/api/reports/:id",auth,(req,res)=>{const r=q.report.get(Number(req.params.id),req.user.id);if(!r)return res.status(404).json({error:"Report not found"});res.json({...r,analysis:JSON.parse(r.analysis_json),economics:JSON.parse(r.economics_json)})});

app.patch("/api/reports/:id/title",auth,(req,res)=>{
 const id=Number(req.params.id),title=String(req.body.title||"").trim();
 if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"Invalid report ID."});
 if(!title||title.length>80)return res.status(400).json({error:"Report name must be between 1 and 80 characters."});
 const result=db.prepare("UPDATE reports SET title=? WHERE id=? AND user_id=?").run(title,id,req.user.id);
 if(result.changes!==1)return res.status(404).json({error:"Saved report not found."});
 res.json({id,title,updated:true});
});

app.get("/api/reports/:id/pdf",auth,(req,res)=>{
  const r=q.report.get(Number(req.params.id),req.user.id);
  if(!r)return res.status(404).json({error:"Report not found"});
  const a=JSON.parse(r.analysis_json)||{}, e=JSON.parse(r.economics_json)||{};
  const steps=Array.isArray(a.steps)?a.steps:[], architecture=Array.isArray(a.recommended_architecture)?a.recommended_architecture:[], plan=Array.isArray(a.build_plan)?a.build_plan:[];
  const safe=(v,fallback="Not provided")=>typeof v==="string"&&v.trim()?v.trim():fallback;
  const money=v=>Number.isFinite(Number(v))?`$${Number(v).toLocaleString("en-US",{maximumFractionDigits:0})}`:"—";
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="AutoWorth-${r.id}-Full-Report.pdf"`);
  const doc=new PDFDocument({size:"A4",margin:54,bufferPages:true,info:{Title:`AutoWorth — ${r.title}`,Author:"AutoWorth",Subject:"Workflow automation economics and implementation report"}});
  doc.pipe(res);
  const ink="#172033",muted="#64748b",blue="#315cf5",mint="#d9f7eb",line="#e3e9f1";
  const heading=(label)=>{doc.moveDown(.55);doc.font("Helvetica-Bold").fontSize(13).fillColor(ink).text(label,{continued:false});doc.moveTo(54,doc.y+5).lineTo(541,doc.y+5).strokeColor(line).lineWidth(.7).stroke();doc.moveDown(.65);};
  const paragraph=(value,opts={})=>{doc.font(opts.bold?"Helvetica-Bold":"Helvetica").fontSize(opts.size||9.5).fillColor(opts.color||ink).text(safe(value),{width:487,lineGap:3,paragraphGap:4});};
  const bullet=(value)=>{doc.font("Helvetica").fontSize(9.3).fillColor(ink).text("•  "+safe(value),{width:475,indent:0,lineGap:2,paragraphGap:3});};
  const labelValue=(label,value)=>{doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text(label.toUpperCase(),{continued:true});doc.font("Helvetica").fontSize(9.5).fillColor(ink).text("   "+safe(String(value)));};

  // Cover-style report header
  doc.roundedRect(54,48,487,78,12).fill("#101b31");
  doc.font("Helvetica-Bold").fontSize(21).fillColor("#ffffff").text("AutoWorth",72,64);
  doc.font("Helvetica").fontSize(9).fillColor("#cbd5e1").text("WORKFLOW AUTOMATION DECISION REPORT",72,94);
  doc.moveDown(5.1);
  doc.font("Helvetica-Bold").fontSize(19).fillColor(ink).text(safe(r.title,"Untitled workflow"),{width:487});
  doc.moveDown(.25);
  doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(`Prepared ${new Date(r.created_at).toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"})}  •  Report #${r.id}`);
  doc.moveDown(1.1);

  // Executive decision panel
  const panelY=doc.y;
  doc.roundedRect(54,panelY,487,105,12).fill("#f1f5ff");
  doc.font("Helvetica-Bold").fontSize(8).fillColor(blue).text("EXECUTIVE DECISION",72,panelY+14);
  doc.font("Helvetica-Bold").fontSize(23).fillColor(ink).text(`${Number.isFinite(Number(e.score))?Number(e.score):"—"}/100  —  ${safe(e.mode,"NOT AVAILABLE")}`,72,panelY+31,{width:445});
  doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(`Risk-adjusted monthly saving: ${money(e.saving)}     •     Payback: ${e.payback===null||e.payback===undefined?"—":`${Number(e.payback).toFixed(1)} months`}`,72,panelY+72,{width:445});
  doc.y=panelY+121;

  heading("Workflow summary");
  paragraph(a.workflow_summary,{size:9.5});

  heading("Economics overview");
  if(Number.isFinite(Number(e.current))){
    const rows=[['Current monthly cost',money(e.current)],['Automation + human review',money(e.automation)],['Risk-adjusted monthly saving',money(e.saving)],['Assumed AI error rate',`${(Number(e.errorRate||0)*100).toFixed(1)}%`],['Estimated payback',e.payback===null||e.payback===undefined?'—':`${Number(e.payback).toFixed(1)} months`]];
    rows.forEach(([k,v])=>labelValue(k,v));
  }else paragraph("Economics could not be calculated from the saved assumptions. Add workload volume and time-per-task data to estimate ROI.");

  if(Array.isArray(e.notes)&&e.notes.length){heading("Economics assumptions and notes");e.notes.forEach(bullet)}
  if(Array.isArray(a.assumptions)&&a.assumptions.length){heading("Analysis assumptions");a.assumptions.forEach(bullet)}
  if(Array.isArray(a.flags)&&a.flags.length){heading("Important flags");a.flags.forEach(bullet)}

  heading("Workflow steps");
  steps.forEach((step,i)=>{
    doc.moveDown(.35);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(ink).text(`${i+1}. ${safe(step.name,"Workflow step")}  —  ${safe(step.recommended_mode,"REVIEW")}  —  ${safe(step.risk,"Unknown")} risk`,{width:487});
    if(step.description)paragraph(step.description,{size:8.8,color:muted});
    const potential=Number.isFinite(Number(step.automation_potential))?`${Math.round(Number(step.automation_potential))}%`:"—";
    paragraph(`Automation potential: ${potential}. ${safe(step.rationale)}`,{size:8.8});
    if(step.human_required===true)paragraph("Human oversight required for this step.",{size:8.5,bold:true,color:"#8a5a00"});
  });

  if(architecture.length){heading("Recommended architecture");architecture.forEach((item,i)=>{doc.font("Helvetica-Bold").fontSize(8).fillColor(blue).text(`STEP ${i+1}`,{continued:false});paragraph(item,{size:9});doc.moveDown(.2)})}
  if(plan.length){heading("Implementation build plan");plan.forEach((item,i)=>{
    doc.moveDown(.35);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ink).text(`${i+1}. ${safe(item.action,"Implementation step")}`,{width:487});
    if(item.purpose)paragraph(`Purpose: ${item.purpose}`,{size:8.8});
    if(item.success_metric)paragraph(`Success measure: ${item.success_metric}`,{size:8.8,color:muted});
  })}
  doc.moveDown(1);
  doc.roundedRect(54,doc.y,487,48,8).fill("#f6f8fc");
  doc.font("Helvetica").fontSize(8).fillColor(muted).text("This report is a scenario estimate, not a guarantee of savings. Validate assumptions through a controlled pilot, retain human oversight for sensitive decisions, and review actual performance before production rollout.",{width:455,align:"left"}).moveDown(1);

  // Consistent running header and page numbering on every page, including pages created by long sections.
  const range=doc.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){
    doc.switchToPage(i);
    if(i>0){doc.save();doc.font("Helvetica-Bold").fontSize(8).fillColor(blue).text("AUTOWORTH",54,28);doc.font("Helvetica").fontSize(8).fillColor(muted).text("FULL AUTOMATION ECONOMICS REPORT",380,28,{width:161,align:"right"});doc.moveTo(54,43).lineTo(541,43).strokeColor(line).lineWidth(.6).stroke();doc.restore();}
    doc.save();doc.moveTo(54,758).lineTo(541,758).strokeColor(line).lineWidth(.6).stroke();doc.font("Helvetica").fontSize(8).fillColor(muted).text("AutoWorth  •  Confidential business workflow analysis",54,768,{width:390});doc.text(`Page ${i+1} of ${range.count}`,444,768,{width:97,align:"right"});doc.restore();
  }
  doc.end();
});
app.delete("/api/reports/:id",auth,(req,res)=>{q.deleteReport.run(Number(req.params.id),req.user.id);res.json({ok:true})});
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,()=>console.log("AutoWorth V2.2.0 on http://localhost:"+PORT));
