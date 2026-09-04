import express from "express";
import OpenAI from "openai";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import PDFDocument from "pdfkit";
import path from "path";
import {fileURLToPath} from "url";

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

const db=new Database(process.env.DB_PATH||path.join(__dirname,"autoworth.db"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,plan TEXT DEFAULT "free",report_credits INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,workflow TEXT NOT NULL,analysis_json TEXT NOT NULL,economics_json TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS stripe_events(id TEXT PRIMARY KEY,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS checkout_sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT "created",created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id));`);
const q={userByEmail:db.prepare("SELECT * FROM users WHERE email=?"),userById:db.prepare("SELECT id,email FROM users WHERE id=?"),
insertUser:db.prepare("INSERT INTO users(email,password_hash) VALUES(?,?)"),insertReport:db.prepare("INSERT INTO reports(user_id,title,workflow,analysis_json,economics_json) VALUES(?,?,?,?,?)"),
reports:db.prepare("SELECT id,title,created_at FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 50"),report:db.prepare("SELECT * FROM reports WHERE id=? AND user_id=?"),deleteReport:db.prepare("DELETE FROM reports WHERE id=? AND user_id=?"),
insertCheckout:db.prepare("INSERT OR REPLACE INTO checkout_sessions(id,user_id,status) VALUES(?,?,?)"),
checkout:db.prepare("SELECT * FROM checkout_sessions WHERE id=?"),
eventExists:db.prepare("SELECT id FROM stripe_events WHERE id=?"),
insertEvent:db.prepare("INSERT INTO stripe_events(id) VALUES(?)")
};

function token(user){return jwt.sign({id:user.id,email:user.email},JWT_SECRET,{expiresIn:"7d"})}
function auth(req,res,next){try{const t=req.cookies.autoworth_token;if(!t)return res.status(401).json({error:"Login required"});req.user=jwt.verify(t,JWT_SECRET);next()}catch{return res.status(401).json({error:"Session expired. Please log in again."})}}

const schema={type:"object",additionalProperties:false,properties:{
workflow_summary:{type:"string"},confidence:{type:"number",minimum:0,maximum:100},assumptions:{type:"array",items:{type:"string"}},flags:{type:"array",items:{type:"string"}},
steps:{type:"array",minItems:1,maxItems:12,items:{type:"object",additionalProperties:false,properties:{
id:{type:"integer"},name:{type:"string"},description:{type:"string"},type:{type:"string",enum:["input","data","decision","calculation","language","workflow","control","high_risk","judgement","unknown"]},
automation_potential:{type:"number",minimum:0,maximum:100},risk:{type:"string",enum:["Low","Medium","High","Unknown"]},recommended_mode:{type:"string",enum:["AUTOMATE","AUGMENT","SIMPLIFY","BUY","KEEP_HUMAN"]},human_required:{type:"boolean"},estimated_time_share_pct:{type:"number",minimum:0,maximum:100},rationale:{type:"string"}},
required:["id","name","description","type","automation_potential","risk","recommended_mode","human_required","estimated_time_share_pct","rationale"]}},
recommended_architecture:{type:"array",minItems:2,maxItems:12,items:{type:"string"}},
build_plan:{type:"array",minItems:3,maxItems:8,items:{type:"object",additionalProperties:false,properties:{step:{type:"integer"},action:{type:"string"},purpose:{type:"string"},success_metric:{type:"string"}},required:["step","action","purpose","success_metric"]}},
ai_tasks:{type:"array",minItems:1,maxItems:8,items:{type:"object",additionalProperties:false,properties:{task:{type:"string"},input:{type:"string"},output:{type:"string"},guardrail:{type:"string"}},required:["task","input","output","guardrail"]}}
},required:["workflow_summary","confidence","assumptions","flags","steps","recommended_architecture","build_plan","ai_tasks"]};

const instructions=`You are AutoWorth. Interpret a business workflow into structured JSON for a deterministic economics engine.
Never invent financial values. Recommend AUTOMATE only for repeatable structured low-risk work; AUGMENT for AI first-pass + human exceptions; SIMPLIFY for deterministic rules; BUY for clearly common software categories; KEEP_HUMAN for high-stakes or judgement-dominant work. Mark human_required for high-risk/judgement work. State assumptions. Return only schema JSON.

CONFIDENCE CALIBRATION: confidence is a 0-100 percentage, NOT a 0-10 score. For a concrete workflow with clear steps, normally use 80-100. Use 60-79 when some important details are missing, 40-59 when several assumptions are required, and below 40 only when the workflow is genuinely ambiguous. Never output 1, 5, 10 etc. merely as a shorthand for a low-confidence score.

AUTOMATION POTENTIAL CALIBRATION: automation_potential is a 0-100 percentage for that specific step, NOT a 0-10 score. Repeatable structured low-risk steps such as receiving emails, downloading attachments, extracting standard fields, writing rows to a spreadsheet, and filing documents can often be 80-100. Judgement-heavy or high-stakes steps should be low and KEEP_HUMAN. Do not use 1% as a generic placeholder.

For the workflow itself, infer the actual operational steps from the user's text. Do not replace a concrete workflow with a generic template.`;

function fallback(t){let s=[];const rules=[[/email|request|form|message|ticket/,"Receive / read input","input",88,"Low","AUTOMATE"],[/copy|paste|extract|crm|spreadsheet|database|enter/,"Extract / store data","data",94,"Low","AUTOMATE"],[/categor|classif|triage|sort|route/,"Classify / route","decision",82,"Medium","AUTOMATE"],[/price|pricing|quote|calculate/,"Calculate / quote","calculation",76,"Medium","AUGMENT"],[/reply|respond|answer|draft|send/,"Draft / send response","language",78,"Medium","AUGMENT"],[/schedule|calendar|follow.?up|reminder/,"Schedule / follow up","workflow",90,"Low","AUTOMATE"],[/complaint|refund|payment|financial|legal|medical|safety/,"Sensitive decision","high_risk",25,"High","KEEP_HUMAN"],[/negotiat|sales call|close|escalat/,"Judgement / negotiation","judgement",35,"High","KEEP_HUMAN"]];for(const[r,n,type,p,risk,m]of rules)if(r.test(t.toLowerCase()))s.push({id:s.length+1,name:n,description:"Fallback detection.",type,automation_potential:p,risk,recommended_mode:m,human_required:m!=="AUTOMATE",estimated_time_share_pct:Math.round(100/Math.max(1,s.length+1)),rationale:"Fallback mode."});if(!s.length)s=[{id:1,name:"Process / output",description:"More detail needed.",type:"unknown",automation_potential:50,risk:"Unknown",recommended_mode:"AUGMENT",human_required:true,estimated_time_share_pct:100,rationale:"More detail needed."}];return{workflow_summary:"Fallback interpretation",confidence:55,assumptions:["Configure OPENAI_API_KEY for live AI"],flags:[],steps:s,recommended_architecture:["Trigger","AI / rules","Validation","Human exception queue","Output","Monitoring"],build_plan:[{step:1,action:"Run shadow pilot",purpose:"Measure actual performance",success_metric:"Target exception rate met"},{step:2,action:"Add validation",purpose:"Protect outputs",success_metric:"No critical errors"},{step:3,action:"Recalculate economics",purpose:"Validate case",success_metric:"Actual savings beat target"}],ai_tasks:[{task:"Extract fields",input:"Workflow data",output:"Structured fields",guardrail:"Reject low-confidence values"}]};}

app.get("/api/health",(req,res)=>res.json({ok:true,ai_enabled:Boolean(process.env.OPENAI_API_KEY),db:true,model:MODEL}));
app.post("/api/auth/register",rateLimit({windowMs:900000,max:10,keyPrefix:"register"}),async(req,res)=>{try{const email=String(req.body.email||"").trim().toLowerCase(),pw=String(req.body.password||"");if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||pw.length<8)return res.status(400).json({error:"Use a valid email and an 8+ character password."});const hash=await bcrypt.hash(pw,12);const info=q.insertUser.run(email,hash);res.cookie("autoworth_token",token({id:info.lastInsertRowid,email}),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:604800000});res.json({user:{id:info.lastInsertRowid,email}})}catch(e){if(String(e).includes("UNIQUE"))return res.status(409).json({error:"An account with this email already exists."});res.status(500).json({error:"Registration failed."})}});
app.post("/api/auth/login",rateLimit({windowMs:900000,max:15,keyPrefix:"login"}),async(req,res)=>{const email=String(req.body.email||"").trim().toLowerCase(),pw=String(req.body.password||""),u=q.userByEmail.get(email);if(!u||!(await bcrypt.compare(pw,u.password_hash)))return res.status(401).json({error:"Invalid email or password."});res.cookie("autoworth_token",token(u),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:604800000});res.json({user:{id:u.id,email:u.email}})});
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
    db.prepare('UPDATE users SET plan="pro",report_credits=MAX(report_credits,1) WHERE id=?').run(userId);
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
 const title=String(req.body.title||"Untitled workflow").slice(0,120),workflow=String(req.body.workflow||"").slice(0,12000),analysis=req.body.analysis,economics=req.body.economics;
 if(!workflow||!analysis)return res.status(400).json({error:"Missing report data"});
 const tx=db.transaction(()=>{
   const u=db.prepare("SELECT plan,report_credits FROM users WHERE id=?").get(req.user.id);
   if(!u)throw Object.assign(new Error("USER_NOT_FOUND"),{code:"USER_NOT_FOUND"});
   if(u.plan!=="pro"){
     const debit=db.prepare("UPDATE users SET report_credits=report_credits-1 WHERE id=? AND report_credits>0").run(req.user.id);
     if(debit.changes!==1)throw Object.assign(new Error("PAYWALL"),{code:"PAYWALL"});
   }
   return q.insertReport.run(req.user.id,title,workflow,JSON.stringify(analysis),JSON.stringify(economics??null));
 });
 try{const r=tx();res.json({id:r.lastInsertRowid});}
 catch(e){if(e.code==="PAYWALL")return res.status(402).json({error:"Full Report unlock required.",code:"PAYWALL"});res.status(500).json({error:"Could not save report."})}
});
app.get("/api/reports",auth,(req,res)=>res.json({reports:q.reports.all(req.user.id)}));
app.get("/api/reports/:id",auth,(req,res)=>{const r=q.report.get(Number(req.params.id),req.user.id);if(!r)return res.status(404).json({error:"Report not found"});res.json({...r,analysis:JSON.parse(r.analysis_json),economics:JSON.parse(r.economics_json)})});

app.get("/api/reports/:id/pdf",auth,(req,res)=>{
  const r=q.report.get(Number(req.params.id),req.user.id);
  if(!r)return res.status(404).json({error:"Report not found"});
  const a=JSON.parse(r.analysis_json), e=JSON.parse(r.economics_json)||{};
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="AutoWorth-${r.id}-Full-Report.pdf"`);
  const doc=new PDFDocument({size:"A4",margin:48});
  doc.pipe(res);
  doc.fontSize(24).text("AutoWorth", {continued:false});
  doc.fontSize(10).fillColor("#667085").text("Full Automation Economics Report");
  doc.moveDown();
  doc.fillColor("#172033").fontSize(18).text(r.title);
  doc.fontSize(9).fillColor("#667085").text(new Date(r.created_at).toLocaleString());
  doc.moveDown();
  doc.fillColor("#172033").fontSize(13).text("Executive decision");
  doc.fontSize(28).text(`${e.score}/100 — ${e.mode}`);
  if(Number.isFinite(e.current)){
    doc.fontSize(11).text(`Risk-adjusted monthly saving: $${Number(e.saving||0).toFixed(0)}`);
    doc.text(`Payback: ${e.payback===null?"—":Number(e.payback).toFixed(1)+" months"}`);
  }else{
    doc.fontSize(11).text("Risk-adjusted saving: Not calculated");
    doc.text("Payback: Not calculated — workload data is missing.");
  }
  doc.moveDown();
  doc.fontSize(13).text("Workflow summary");
  doc.fontSize(10).text(a.workflow_summary);
  doc.moveDown();
  doc.fontSize(13).text("Economics");
  if(Number.isFinite(e.current)){
    doc.fontSize(10).text(`Current monthly cost: $${Number(e.current||0).toFixed(0)}`);
    doc.text(`Automation + review: $${Number(e.automation||0).toFixed(0)}`);
    doc.text(`Risk-adjusted saving: $${Number(e.saving||0).toFixed(0)}`);
    doc.text(`Assumed AI error rate: ${(Number(e.errorRate||0)*100).toFixed(1)}%`);
  }else{
    doc.fontSize(10).text("Economics: Not calculated — add monthly workload and time-per-task data to estimate ROI.");
  }
  doc.moveDown();
  doc.fontSize(13).text("Workflow steps");
  a.steps.forEach((s,i)=>{
    doc.moveDown(0.35);
    doc.fontSize(10).text(`${i+1}. ${s.name} — ${s.recommended_mode} — ${s.risk} risk`);
    doc.fontSize(9).fillColor("#4b5563").text(`Automation potential: ${Math.round(s.automation_potential)}%. ${s.rationale}`);
    doc.fillColor("#172033");
  });
  doc.moveDown();
  doc.fontSize(13).text("Recommended architecture");
  doc.fontSize(10).text(a.recommended_architecture.join(" -> "));
  doc.moveDown();
  doc.fontSize(13).text("Build plan");
  a.build_plan.forEach((x,i)=>doc.fontSize(10).text(`${i+1}. ${x.action} — ${x.purpose} (Success: ${x.success_metric})`));
  doc.moveDown();
  doc.fontSize(8).fillColor("#667085").text("Scenario estimate. Validate assumptions with a real pilot before production automation.");
  doc.end();
});
app.delete("/api/reports/:id",auth,(req,res)=>{q.deleteReport.run(Number(req.params.id),req.user.id);res.json({ok:true})});
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,()=>console.log("AutoWorth V1.5.6 on http://localhost:"+PORT));
