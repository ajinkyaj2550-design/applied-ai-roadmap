const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const DATA_FILE = path.join(ROOT, "opportunities.json");

// Gemini is called only from this server. The API key never reaches the browser.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_OPPORTUNITY_MODEL = process.env.GEMINI_OPPORTUNITY_MODEL || "gemini-3.5-flash-lite";

const MAX_BODY = 120000;
const FEED_CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_OPPORTUNITIES = 30;
const TOP_OPPORTUNITIES = 10;
const AI_INTERVAL = 1200;
const REFRESH_COOLDOWN_MS = 45 * 1000;
const GEMINI_DAILY_REQUEST_LIMIT = Number(process.env.GEMINI_DAILY_REQUEST_LIMIT || 300);
const GEMINI_IP_WINDOW_MS = 60 * 1000;
const GEMINI_IP_LIMIT = 20;

let lastRefreshAt = 0;
let lastGeminiFailureReason = null;
let lastGeminiSuccessAt = null;
let geminiDay = "";
let geminiDayCount = 0;
const ipBuckets = new Map();

const QUERIES = [
  // Roadmap-aligned discovery: keep these broad so the notification center can surface
  // internships, programs, ambassador opportunities, scholarships, hackathons, etc.
  "AI hackathon India 2026","AI hackathon 2026","generative AI hackathon 2026",
  "machine learning hackathon 2026","AI competition India 2026","AI internship India 2026",
  "machine learning internship India 2026","generative AI internship 2026",
  "AI fellowship 2026","AI scholarship 2026","AI program India 2026",
  "generative AI program 2026","AI agents competition 2026",
  "AI automation hackathon 2026","n8n AI hackathon 2026","AI challenge India 2026",
  "AI student ambassador 2026","Google student ambassador 2026","Microsoft student ambassador 2026",
  "AWS student ambassador 2026","GitHub student program 2026","developer student program 2026",
  "AI workshop India 2026","GenAI workshop 2026","AI bootcamp 2026",
  "AI mentorship program 2026","AI apprenticeship India 2026",
  "AI developer program 2026","cloud student program 2026","AI certification challenge 2026","student scholarship India 2026","UG scholarship India 2026","AI student program India 2026","cloud student program India 2026"
];

const ALLOWED_DOMAINS = new Set([
  "devpost.com","mlh.io","kaggle.com","hackathon.com","unstop.com","internshala.com",
  "google.com","cloud.google.com","developers.google.com","microsoft.com",
  "learn.microsoft.com","aws.amazon.com","nvidia.com","huggingface.co",
  "deeplearning.ai","openai.com","anthropic.com","github.com","meta.com",
  "ibm.com","oracle.com","aicte-india.org","internship.aicte-india.org","scholarships.gov.in","india.gov.in","reliancefoundation.org","sidtm.edu.in","pib.gov.in","education.github.com","githubcampus.expert","hackathon.com"
]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}
function readData() { return readJson(DATA_FILE, {updatedAt:null, opportunities:[], stale:false}); }
function safeUrl(v) {
  try {
    const u = new URL(String(v || ""));
    return ["http:","https:"].includes(u.protocol) ? u.toString() : "";
  } catch { return ""; }
}
function domainOf(v) {
  try { return new URL(v).hostname.toLowerCase().replace(/^www\./,""); }
  catch { return ""; }
}
function allowedDomain(d) { return !!d && [...ALLOWED_DOMAINS].some(x => d === x || d.endsWith("." + x)); }
function clean(v, n=12000) { return String(v || "").replace(/\s+/g," ").trim().slice(0,n); }
function normalizeTitle(v) { return clean(v,300).toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function decode(v) {
  return clean(String(v || "").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'"),10000);
}
function tag(block, name) {
  const m = block.match(new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+name+">","i"));
  return m ? decode(m[1]) : "";
}
function sourceUrl(block) {
  const m = block.match(/<source[^>]*\burl=["']([^"']+)["']/i);
  return m ? safeUrl(m[1]) : "";
}
function parseRSS(xml) {
  const out = [];
  for (const block of xml.match(/<item[\s\S]*?<\/item>/gi) || []) {
    const title = tag(block,"title");
    const link = safeUrl(tag(block,"link")) || sourceUrl(block);
    const desc = tag(block,"description");
    const source = sourceUrl(block);
    const domain = domainOf(source) || domainOf(link);
    if (title && link) out.push({title:title.slice(0,180),description:desc.slice(0,700),url:link,domain});
  }
  return out;
}
function scoreItem(title, desc, domain) {
  const t = (title+" "+desc).toLowerCase();
  let s = allowedDomain(domain) ? 20 : 0;
  for (const x of ["hackathon","internship","fellowship","scholarship","competition","challenge","cohort","program","generative ai","machine learning","artificial intelligence","ai agents","automation"])
    if (t.includes(x)) s += 7;
  for (const x of ["ai","genai","llm","rag","agent","agentic","python"])
    if (t.includes(x)) s += 3;
  if (/2026|2027/.test(t)) s += 5;
  return Math.min(100,s);
}
function opportunityType(title, desc) {
  const t=(title+" "+desc).toLowerCase();
  if (/hackathon|competition|challenge/.test(t)) return "Hackathon / Competition";
  if (/internship|intern\b|hiring|job/.test(t)) return "Internship / Job";
  if (/fellowship|scholarship/.test(t)) return "Scholarship / Fellowship";
  if (/workshop|webinar|bootcamp/.test(t)) return "Workshop / Webinar";
  return "AI Program";
}
function priority(s) { return s>=65?"important":s>=50?"useful":"optional"; }
function extractDate(t) {
  for (const r of [
    /\b20\d{2}-\d{2}-\d{2}\b/, /\b\d{1,2}\/\d{1,2}\/20\d{2}\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/i
  ]) { const m=String(t).match(r); if(m) return m[0]; }
  return null;
}
async function fetchText(url) {
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),8000);
  try {
    const r=await fetch(url,{signal:c.signal,headers:{"user-agent":"Applied-AI-Roadmap/4.0","accept":"application/rss+xml,application/xml,text/xml"}});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}
const OPPORTUNITY_SCHEMA={type:"object",properties:{items:{type:"array",items:{type:"object",properties:{title:{type:"string"},description:{type:"string"},url:{type:"string"},type:{type:"string"},priority:{type:"string",enum:["important","useful","optional"]},deadline:{type:"string"},score:{type:"number"}},required:["title","description","url","type","priority","deadline","score"]}}},required:["items"]};

async function geminiOpportunitySearch(req, excludedIds=new Set()){
  const prompt=`You are the live opportunity discovery engine for an Applied AI Engineer roadmap for an Indian student. Today is ${new Date().toISOString().slice(0,10)}.
Find 10 to 15 REAL, currently open or upcoming opportunities that strongly match this roadmap: Python, APIs/integration, n8n/automation, AI/GenAI/LLMs, RAG, agents, cloud, DevOps, databases and software projects.
Allowed notification categories: internships, scholarships, student programs, ambassador/community programs, hackathons, competitions, fellowships, apprenticeships, developer programs, cloud programs, workshops, bootcamps, mentorships, challenges and relevant student events.
DO NOT return interview-prep, interview questions, mock interviews, tests, exams, test-prep, or generic news. Do not invent opportunities, dates, eligibility or URLs.
Prefer India/Pan-India and student-accessible opportunities. Prefer official/primary source pages. A trusted platform is acceptable when it is the actual opportunity page.
For each item, give a 0-100 score based on: roadmap relevance (40), student eligibility/India accessibility (20), credibility (15), current/open status (15), deadline/actionability (10). Return the actual opportunity URL, not a search-results URL. If deadline is unknown, return an empty string. Keep descriptions concise and factual.
Excluded IDs/URLs from the current browser session: ${JSON.stringify([...excludedIds].slice(0,120))}
Return ONLY JSON matching the schema.`;
  // Keep Google Search grounding and JSON parsing separate here. Google's current docs note
  // that structured outputs + built-in tools are preview/limited to newer Gemini 3 models;
  // the default 2.5 Flash-Lite path is more reliable when we request JSON in the prompt
  // and validate/parse it ourselves.
  const r=await geminiGenerate({model:GEMINI_OPPORTUNITY_MODEL,prompt,grounding:true,schema:null,temperature:0.1,req});
  const x=parseJsonText(extractGeminiText(r));
  const items=(Array.isArray(x.items)?x.items:[]).map(item=>{
    const url=safeUrl(item.url); if(!url)return null;
    const domain=domainOf(url); if(!domain)return null;
    const title=clean(item.title,180),description=clean(item.description,700); if(!title||!description)return null;
    const text=(title+' '+description).toLowerCase();
    if(/interview|mock interview|interview prep|test prep|exam preparation|practice test|aptitude test|quiz/.test(text))return null;
    if(!/hackathon|internship|fellowship|scholarship|competition|challenge|program|workshop|bootcamp|ambassador|apprenticeship|student|developer|event|conference|certification|mentorship/i.test(text))return null;
    const score=Math.max(0,Math.min(100,Math.round(Number(item.score)||0)));
    const id=normalizeTitle(title)+'|'+domain;
    return {id,title,description,url,type:clean(item.type,60)||opportunityType(title,description),priority:['important','useful','optional'].includes(item.priority)?item.priority:priority(score),score,deadline:/^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline||''))?item.deadline:null,sourceDomain:domain,addedAt:new Date().toISOString(),read:false};
  }).filter(Boolean).filter(item=>!excludedIds.has(String(item.id))&&!excludedIds.has(String(item.url)));
  if(!items.length) throw new Error("Gemini returned no usable opportunities");
  return dedupeOpportunities(items);
}
function canonicalUrl(v){
  try{const u=new URL(v); for(const k of [...u.searchParams.keys()]) if(/^(utm_|fbclid|gclid|ref|source)$/i.test(k)||k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k); return u.toString().replace(/\/$/,'').toLowerCase();}catch{return String(v||'').toLowerCase();}
}
function dedupeOpportunities(items){
  const m=new Map();
  for(const x of items){const key=canonicalUrl(x.url)||String(x.id); const prev=m.get(key); if(!prev || Number(x.score||0)>Number(prev.score||0))m.set(key,x);}
  return [...m.values()];
}

async function refreshOpportunities(req=null, excludedIds=new Set()) {
  const current=readData();
  const old=Array.isArray(current.opportunities)?current.opportunities:[];
  // userExcluded = things the client explicitly asked to drop (currently the UI never
  // sends this — dismiss is intentionally temporary — but the mechanism is kept for any
  // future explicit "don't show again" action). This is the ONLY set allowed to remove
  // an item from our own merged list below.
  const userExcluded=new Set([...excludedIds].map(String));
  // BUGFIX: separately, tell Gemini about everything we already have on file (not just
  // client-dismissed items) so it's nudged to surface something NEW each time instead of
  // re-confirming the same well-known top results on every refresh (which is what was
  // happening: the prompt's "Excluded IDs" list was always empty in practice, since the
  // client never sends deletedIds). A known-good item that Gemini simply doesn't repeat
  // in a given search still survives via the `old` merge loop below — this only affects
  // what we ask Gemini to look for, never what we keep.
  const knownForGemini=new Set(userExcluded);
  for(const x of old){ if(x&&x.id)knownForGemini.add(String(x.id)); if(x&&x.url)knownForGemini.add(String(x.url)); }
  let freshItems=[];
  let geminiFailureReason=null;
  let usedGeminiSearch=false;
  try {
    freshItems=await geminiOpportunitySearch(req, knownForGemini);
    usedGeminiSearch=true;
  } catch (geminiError) {
    // BUGFIX: previously this reason was swallowed completely — nothing in the logs or
    // the API response told you WHY Gemini failed, so "is Gemini actually working" was
    // impossible to answer without guessing. Now it's logged (check Render -> Logs) and
    // also carried into the response as lastGeminiError, so /opportunities.json and
    // /refresh both show it directly.
    geminiFailureReason=geminiError && geminiError.message ? geminiError.message : String(geminiError);
    console.error("[gemini-opportunity-search] falling back to RSS —", geminiFailureReason);
    // Fallback: recent Google News RSS discovery. This is only a fallback;
    // Gemini Search grounding remains the preferred source.
    const all=[];
    const results=await Promise.allSettled(QUERIES.map(async q=>{
      const url="https://news.google.com/rss/search?q="+encodeURIComponent(q+" when:7d")+"&hl=en-IN&gl=IN&ceid=IN:en";
      return parseRSS(await fetchText(url));
    }));
    for(const result of results){if(result.status==='fulfilled'&&result.value.length)all.push(...result.value);}
    const fresh=new Map();
    for(const x of all){
      const text=(x.title+' '+x.description).toLowerCase();
      if(/interview|mock interview|test prep|exam preparation|practice test|quiz/.test(text))continue;
      const score=scoreItem(x.title,x.description,x.domain); if(score<18)continue;
      const id=normalizeTitle(x.title)+"|"+x.domain;
      if(userExcluded.has(id)||userExcluded.has(String(x.url)))continue;
      const item={id,title:x.title,description:x.description,url:x.url,type:opportunityType(x.title,x.description),priority:priority(score),score,deadline:extractDate(x.title+" "+x.description),sourceDomain:x.domain,addedAt:new Date().toISOString(),read:false};
      if(!fresh.has(id)||score>fresh.get(id).score)fresh.set(id,item);
    }
    freshItems=[...fresh.values()];
  }

  const merged=new Map();
  for(const x of old){
    if(!x||!x.id||userExcluded.has(String(x.id))||userExcluded.has(String(x.url)))continue;
    const d=x.deadline;
    if(d && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d+'T23:59:59').getTime()<Date.now())continue;
    merged.set(String(x.id),x);
  }
  for(const x of freshItems){
    if(userExcluded.has(String(x.id))||userExcluded.has(String(x.url)))continue;
    const prev=merged.get(String(x.id));
    merged.set(String(x.id),prev?{...prev,...x,read:!!prev.read}:x);
  }

  // Dynamic ranking: there is NO permanent top-10 list. Every refresh recomputes
  // the ranking, so a genuinely stronger new opportunity can enter the top 10.
  const opportunities=dedupeOpportunities([...merged.values()])
    .filter(x=>{const d=x.deadline;return !d||new Date(d+'T23:59:59').getTime()>=Date.now();})
    .sort((a,b)=>{
      const da=a.deadline?Math.ceil((new Date(a.deadline+'T23:59:59').getTime()-Date.now())/86400000):9999;
      const db=b.deadline?Math.ceil((new Date(b.deadline+'T23:59:59').getTime()-Date.now())/86400000):9999;
      const urgency=x=>x<=3?10:x<=7?6:x<=14?3:0;
      return (Number(b.score||0)+urgency(db))-(Number(a.score||0)+urgency(da));
    })
    .slice(0,MAX_OPPORTUNITIES);
  const data={updatedAt:new Date().toISOString(),opportunities,stale:!freshItems.length,discovery:{count:opportunities.length,topCount:Math.min(TOP_OPPORTUNITIES,opportunities.length),source:usedGeminiSearch?'gemini-search-grounded':'rss-fallback'},lastGeminiError:geminiFailureReason};
  lastGeminiFailureReason=geminiFailureReason;
  if(usedGeminiSearch)lastGeminiSuccessAt=data.updatedAt;
  writeJson(DATA_FILE,data); return data;
}

function extractGeminiText(r) {
  const parts = r?.candidates?.[0]?.content?.parts || [];
  return parts.filter(p=>typeof p?.text === "string").map(p=>p.text).join("\n").trim();
}
function sourceListFromGemini(r) {
  const chunks=r?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const out=[],seen=new Set();
  for(const c of chunks){
    const url=safeUrl(c?.web?.uri), title=clean(c?.web?.title,180);
    if(!url || seen.has(url)) continue; seen.add(url); out.push({title:title||domainOf(url),url}); if(out.length>=6)break;
  }
  return out;
}
function jsonSchemaConfig(schema) {
  return {responseMimeType:"application/json",responseSchema:schema};
}
function resetDailyCounterIfNeeded(){
  const day=new Date().toISOString().slice(0,10);
  if(geminiDay!==day){geminiDay=day;geminiDayCount=0;}
}
function clientIp(req){
  const x=String(req.headers["x-forwarded-for"]||"").split(",")[0].trim();
  return x || req.socket.remoteAddress || "unknown";
}
function checkGeminiBudget(req){
  resetDailyCounterIfNeeded();
  if(geminiDayCount>=GEMINI_DAILY_REQUEST_LIMIT) throw Object.assign(new Error("Daily Gemini safety limit reached. Please try again tomorrow."),{code:"GEMINI_DAILY_LIMIT"});
  const ip=clientIp(req), now=Date.now();
  const arr=(ipBuckets.get(ip)||[]).filter(t=>now-t<GEMINI_IP_WINDOW_MS);
  if(arr.length>=GEMINI_IP_LIMIT) throw Object.assign(new Error("Too many AI requests. Please wait a minute."),{code:"GEMINI_IP_LIMIT"});
  arr.push(now); ipBuckets.set(ip,arr); geminiDayCount++;
}
async function geminiGenerate({model,prompt,grounding=false,schema,temperature=0.2,req}){
  const key=process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if(!key) throw Object.assign(new Error("GEMINI_API_KEY is not configured on Render."),{code:"NO_GEMINI_KEY"});
  checkGeminiBudget(req);
  const body={contents:[{parts:[{text:prompt}]}],generationConfig:{temperature}};
  if(schema) Object.assign(body.generationConfig,jsonSchemaConfig(schema));
  // BUGFIX: current Gemini REST API documents the grounding tool as
  // "googleSearch" (camelCase); the previous snake_case "google_search" key
  // is the older/alternate spelling and is more likely to be silently ignored
  // by some model/endpoint combinations, which would turn off grounding
  // without ever raising an error.
  if(grounding) body.tools=[{googleSearch:{}}];
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{
    const r=await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify(body),signal:controller.signal});
    const raw=await r.text(); let d=null; try{d=JSON.parse(raw)}catch{}
    if(!r.ok){const msg=d?.error?.message||`Gemini HTTP ${r.status}`; const e=new Error(msg); e.status=r.status; throw e;}
    return d;
  } finally {clearTimeout(timer);}
}
function parseJsonText(text){
  try{return JSON.parse(text)}catch{}
  const m=String(text||"").match(/\{[\s\S]*\}/); if(m) try{return JSON.parse(m[0])}catch{}
  throw new Error("Gemini returned invalid JSON.");
}
function body(req){
  return new Promise((resolve,reject)=>{let s="";req.on("data",c=>{s+=c;if(s.length>MAX_BODY){reject(new Error("request too large"));req.destroy();}});req.on("end",()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error("invalid JSON"))}});req.on("error",reject);});
}
function send(res,status,type,data){res.writeHead(status,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"same-origin"});res.end(data);}
function json(res,status,data){send(res,status,"application/json; charset=utf-8",JSON.stringify(data));}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  try{
    if(req.method==="GET"&&u.pathname==="/api-status"){
      try{
        const r=await geminiGenerate({model:GEMINI_OPPORTUNITY_MODEL,prompt:"Reply with exactly the word OK.",grounding:false,schema:{type:"object",properties:{ok:{type:"string"}},required:["ok"]},temperature:0,req});
        return json(res,200,{ok:true,gemini:true,model:GEMINI_OPPORTUNITY_MODEL});
      }catch(e){
        return json(res,200,{ok:false,gemini:false,errorCode:e.code||null,status:e.status||null,message:e.message||"Gemini unavailable"});
      }
    }
    if(req.method==="GET"&&u.pathname==="/health"){
      const d=readData(); resetDailyCounterIfNeeded();
      return json(res,200,{ok:true,geminiConfigured:!!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY),opportunityModel:GEMINI_OPPORTUNITY_MODEL,geminiDailyRequestsUsed:geminiDayCount,geminiDailySafetyLimit:GEMINI_DAILY_REQUEST_LIMIT,updatedAt:d.updatedAt||null,opportunityCount:Array.isArray(d.opportunities)?d.opportunities.length:0,lastOpportunitySource:d.discovery?d.discovery.source:null,lastGeminiFailureReason,lastGeminiSuccessAt});
    }
    if(req.method==="GET"&&u.pathname==="/opportunities.json"){
      let d=readData(),t=d.updatedAt?new Date(d.updatedAt).getTime():0;
      if(!t||Date.now()-t>FEED_CACHE_MS){try{d=await refreshOpportunities(req)}catch{}}
      return json(res,200,d);
    }
    if(req.method==="POST"&&u.pathname==="/refresh"){
      const p=await body(req);
      const excludedIds=new Set(Array.isArray(p.deletedIds)?p.deletedIds.map(x=>String(x)).slice(0,200):[]);
      const forceForDeleted=excludedIds.size>0;
      if(!forceForDeleted && Date.now()-lastRefreshAt<REFRESH_COOLDOWN_MS){const d=readData();return json(res,200,{...d,cooldown:true,message:"Feed was refreshed recently; showing the latest cached data."});}
      lastRefreshAt=Date.now();
      return json(res,200,await refreshOpportunities(req,excludedIds));
    }
    if(req.method==="GET"&&(u.pathname==="/"||u.pathname==="/index.html")){
      if(!fs.existsSync(INDEX_FILE))return send(res,500,"text/plain; charset=utf-8","index.html not found");
      return send(res,200,"text/html; charset=utf-8",fs.readFileSync(INDEX_FILE,"utf8"));
    }
    return send(res,404,"text/plain; charset=utf-8","Not found");
  }catch(e){
    const status=e.code==="NO_GEMINI_KEY"?503:e.code==="GEMINI_DAILY_LIMIT"?429:e.code==="GEMINI_IP_LIMIT"?429:(e.status===429||/rate limit|quota|resource exhausted|too many/i.test(e.message||""))?429:500;
    return json(res,status,{error:e.message||"server error",code:e.code||null});
  }
});
server.listen(PORT,()=>console.log(`Applied AI Roadmap server listening on ${PORT}`));
