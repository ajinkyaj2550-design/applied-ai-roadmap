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
const GEMINI_INTERVIEW_MODEL = process.env.GEMINI_INTERVIEW_MODEL || "gemini-2.5-flash";
const GEMINI_TEST_MODEL = process.env.GEMINI_TEST_MODEL || "gemini-2.5-flash-lite";
const GEMINI_TRANSLATE_MODEL = process.env.GEMINI_TRANSLATE_MODEL || "gemini-2.5-flash-lite";

const MAX_BODY = 120000;
const FEED_CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_OPPORTUNITIES = 500;
const MAX_INTERVIEW_STORE = 5000;
const AI_INTERVAL = 1200;
const REFRESH_COOLDOWN_MS = 45 * 1000;
const GEMINI_DAILY_REQUEST_LIMIT = Number(process.env.GEMINI_DAILY_REQUEST_LIMIT || 180);
const GEMINI_IP_WINDOW_MS = 60 * 1000;
const GEMINI_IP_LIMIT = 20;

const interviewStore = [];
let lastInterviewAt = 0;
let lastTestAt = 0;
let lastRefreshAt = 0;
let geminiDay = "";
let geminiDayCount = 0;
const ipBuckets = new Map();

const QUERIES = [
  "AI hackathon India 2026","AI hackathon 2026","generative AI hackathon 2026",
  "machine learning hackathon 2026","AI competition India 2026","AI internship India 2026",
  "machine learning internship India 2026","generative AI internship 2026",
  "AI fellowship 2026","AI scholarship 2026","AI program India 2026",
  "generative AI program 2026","AI agents competition 2026",
  "AI automation hackathon 2026","n8n AI hackathon 2026","AI challenge India 2026"
];

const ALLOWED_DOMAINS = new Set([
  "devpost.com","mlh.io","kaggle.com","hackathon.com","unstop.com","internshala.com",
  "google.com","cloud.google.com","developers.google.com","microsoft.com",
  "learn.microsoft.com","aws.amazon.com","nvidia.com","huggingface.co",
  "deeplearning.ai","openai.com","anthropic.com","github.com","meta.com",
  "ibm.com","oracle.com"
]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}
function readData() { return readJson(DATA_FILE, {updatedAt:null, opportunities:[], stale:false}); }
function readInterviewStore() { return interviewStore; }
function writeInterviewStore(x) {
  interviewStore.length = 0;
  interviewStore.push(...x.slice(-MAX_INTERVIEW_STORE));
}
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
const OPPORTUNITY_SCHEMA={type:"object",properties:{items:{type:"array",items:{type:"object",properties:{title:{type:"string"},description:{type:"string"},url:{type:"string"},type:{type:"string"},priority:{type:"string",enum:["important","useful","optional"]},deadline:{type:"string"}},required:["title","description","url","type","priority","deadline"],additionalProperties:false}}},required:["items"],additionalProperties:false};

async function geminiOpportunitySearch(req){
  const prompt=`You are the live opportunity discovery engine for an Applied AI Engineer roadmap in India. Today is ${new Date().toISOString().slice(0,10)}.
Find 8 to 12 REAL, currently relevant opportunities available to an Indian learner: AI/ML/GenAI hackathons, competitions, internships, fellowships, scholarships, programs, workshops or challenges. Prefer opportunities with a clear official or trusted source page and a current 2026 deadline/open status. Do not invent opportunities, dates or URLs.
Use Google Search grounding. Prefer primary/official sources such as Devpost, MLH, Kaggle, Unstop, Internshala, Google, Microsoft, AWS, NVIDIA, Hugging Face, DeepLearning.AI, GitHub, IBM and similar credible organizers.
Return ONLY JSON. Every URL must be the actual page for that opportunity, not a search-results page. If a deadline is unknown, use an empty string. Keep each description concise and factual.`;
  const r=await geminiGenerate({model:GEMINI_TEST_MODEL,prompt,grounding:true,schema:OPPORTUNITY_SCHEMA,temperature:0.15,req});
  const x=parseJsonText(extractGeminiText(r));
  const sources=sourceListFromGemini(r);
  const sourceDomains=new Set(sources.map(s=>domainOf(s.url)));
  const items=(Array.isArray(x.items)?x.items:[]).map((item,i)=>{
    const url=safeUrl(item.url); if(!url)return null;
    const domain=domainOf(url); if(!domain)return null;
    const title=clean(item.title,180),description=clean(item.description,700); if(!title||!description)return null;
    if(!/hackathon|internship|fellowship|scholarship|competition|challenge|program|workshop|bootcamp/i.test(title+' '+description))return null;
    return {id:normalizeTitle(title)+'|'+domain,title,description,url,type:clean(item.type,60)||opportunityType(title,description),priority:['important','useful','optional'].includes(item.priority)?item.priority:'useful',score:Math.min(100,55+(sourceDomains.has(domain)?10:0)),deadline:clean(item.deadline,80),sourceDomain:domain,addedAt:new Date().toISOString(),read:false};
  }).filter(Boolean);
  if(!items.length) throw new Error("Gemini returned no usable opportunities");
  return items;
}

async function refreshOpportunities(req=null) {
  const current=readData(), old=Array.isArray(current.opportunities)?current.opportunities:[];
  let freshItems=[];
  try {
    freshItems=await geminiOpportunitySearch(req);
  } catch (geminiError) {
    const all=[];
    const results=await Promise.allSettled(QUERIES.map(async q=>{
      const url="https://news.google.com/rss/search?q="+encodeURIComponent(q+" when:7d")+"&hl=en-IN&gl=IN&ceid=IN:en";
      return parseRSS(await fetchText(url));
    }));
    for(const result of results){if(result.status==='fulfilled'&&result.value.length)all.push(...result.value);}
    const fresh=new Map();
    for(const x of all){
      const score=scoreItem(x.title,x.description,x.domain); if(score<10)continue;
      const id=normalizeTitle(x.title)+"|"+x.domain; if(fresh.has(id))continue;
      fresh.set(id,{id,title:x.title,description:x.description,url:x.url,type:opportunityType(x.title,x.description),priority:priority(score),score,deadline:extractDate(x.title+" "+x.description),sourceDomain:x.domain,addedAt:new Date().toISOString(),read:false});
    }
    freshItems=[...fresh.values()];
  }
  if(!freshItems.length) return {...current,opportunities:old,stale:true};
  const merged=new Map(); old.forEach(x=>{if(x&&x.id)merged.set(String(x.id),x);});
  for(const x of freshItems){const prev=merged.get(String(x.id));merged.set(String(x.id),prev?{...prev,...x,read:!!prev.read}:x);}
  const opportunities=[...merged.values()].sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,MAX_OPPORTUNITIES);
  const data={updatedAt:new Date().toISOString(),opportunities,stale:false}; writeJson(DATA_FILE,data); return data;
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
  if(grounding) body.tools=[{google_search:{}}];
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
function similarityTokens(v){
  return new Set(clean(v,900).toLowerCase().replace(/[^a-z0-9]+/g," ").split(/\s+/).filter(w=>w.length>2&&!/^(what|why|how|is|are|the|a|an|and|to|of|in|for|you|your|can|could|would|should|does|do|did)$/.test(w)));
}
function isSimilarQuestion(a,b){
  const A=similarityTokens(a),B=similarityTokens(b);
  if(!A.size||!B.size)return false;
  let common=0; for(const w of A) if(B.has(w)) common++;
  const jaccard=common/(A.size+B.size-common);
  const containment=common/Math.min(A.size,B.size);
  return jaccard>=0.62 || containment>=0.82;
}

const INTERVIEW_SCHEMA={type:"object",properties:{question:{type:"string"},answer:{type:"string"},level:{type:"string"},topic:{type:"string"},difficulty:{type:"string",enum:["beginner","intermediate","advanced"]}},required:["question","answer","level","topic","difficulty"],additionalProperties:false};
const TEST_SCHEMA={type:"object",properties:{question:{type:"string"},options:{type:"array",items:{type:"string"},minItems:4,maxItems:4},answer:{type:"integer",minimum:0,maximum:3},reason:{type:"string"},level:{type:"string"},topic:{type:"string"}},required:["question","options","answer","reason","level","topic"],additionalProperties:false};
const TRANSLATION_SCHEMA={type:"object",properties:{translation:{type:"string"}},required:["translation"],additionalProperties:false};

function validateInterview(x,p,topics){
  if(!x?.question||!x?.answer) throw new Error("Interview response is incomplete");
  if(p.level!=="all"&&String(x.level)!==String(p.level)) throw new Error("Gemini returned the wrong level");
  if(p.topic!=="all"&&String(x.topic)!==String(p.topic)) throw new Error("Gemini returned the wrong topic");
  if(p.topic==="all"&&topics.length&&!topics.includes(String(x.topic))) throw new Error("Gemini returned a topic outside the roadmap");
  if(p.difficulty!=="auto"&&x.difficulty!==p.difficulty) throw new Error("Gemini returned the wrong difficulty");
  if(/[ऀ-ॿ]/.test(x.question+" "+x.answer)) throw new Error("Interview content must be English");
}
async function makeInterview(p,req){
  const level=String(p.level||"all"),topic=clean(p.topic||"all",300),difficulty=["beginner","intermediate","advanced"].includes(p.difficulty)?p.difficulty:"auto";
  const topics=Array.isArray(p.topics)?p.topics.map(x=>clean(x,250)).filter(Boolean).slice(0,30):[];
  const recent=Array.isArray(p.recentQuestions)?p.recentQuestions:Array.isArray(p.recent)?p.recent:[];
  const avoid=[...new Set([...recent.map(x=>clean(x,500)).filter(Boolean),...interviewStore.filter(x=>String(x.level)===level&&(topic==="all"||String(x.topic)===topic)).slice(-80).map(x=>x.question)])].slice(-120);
  const prompt=`You are the online interview engine for an Applied AI Engineer learning roadmap.
Selected level: ${level}. Selected topic: ${topic}. Allowed roadmap topics: ${JSON.stringify(topics)}. Difficulty: ${difficulty}.
Create ONE original technical interview question and a correct, interview-ready English answer.
The question must be useful for an Indian learner preparing for real technical interviews. Prefer practical questions, examples, trade-offs, and concise explanations appropriate to the selected difficulty.
Use Google Search grounding to verify current or tool/API-specific facts. Do not invent facts and do not copy a source verbatim.
When level/topic are not "all", the returned level/topic MUST exactly match the selected values.
Return ONLY the requested JSON object. Do not write Marathi.
Avoid substantially similar questions: ${JSON.stringify(avoid)}.`;
  let last;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r=await geminiGenerate({model:GEMINI_INTERVIEW_MODEL,prompt:prompt+(attempt?"\nPrevious attempt failed validation. Obey every constraint exactly.":""),grounding:true,schema:INTERVIEW_SCHEMA,temperature:0.25,req});
      const x=parseJsonText(extractGeminiText(r));
      x.question=clean(x.question,700);x.answer=clean(x.answer,8000);x.level=clean(x.level,30);x.topic=clean(x.topic,300);
      validateInterview(x,{level,topic,difficulty},topics);
      if(avoid.some(q=>isSimilarQuestion(q,x.question))) throw new Error("Gemini returned a duplicate or substantially similar question");
      x.sources=sourceListFromGemini(r);
      const saved={...x,id:Date.now()+"-"+Math.random().toString(36).slice(2,8),createdAt:new Date().toISOString()};
      interviewStore.push(saved); writeInterviewStore(interviewStore); return x;
    }catch(e){last=e;}
  }
  throw last||new Error("Interview engine failed");
}
async function translateText(p,req){
  const prompt=`Translate ALL of the following technical learning content into natural Marathi for an Indian learner.
Keep technical terms such as API, RAG, LLM, Git, Docker, Python, webhook, vector database, JSON, HTTP and Gemini in English when that is clearer.
Preserve labels, option letters, numbering, and meaning. Do not omit any option or reason. Do not add new facts.
QUESTION:\n${clean(p.question,5000)}\nCONTENT:\n${clean(p.content||p.answer,14000)}`;
  const r=await geminiGenerate({model:GEMINI_TRANSLATE_MODEL,prompt,grounding:false,schema:TRANSLATION_SCHEMA,temperature:0.1,req});
  const x=parseJsonText(extractGeminiText(r)); return clean(x.translation,18000);
}
async function makeTestQuestion(p,req){
  const level=String(p.level||"all"),topic=clean(p.topic||"all",300),topics=Array.isArray(p.topics)?p.topics.map(x=>clean(x,250)).filter(Boolean).slice(0,30):[];
  const recent=Array.isArray(p.recentQuestions)?p.recentQuestions:[];
  const prompt=`You are the online MCQ test engine for an Applied AI Engineer roadmap.
Selected level: ${level}. Selected topic: ${topic}. Allowed roadmap topics: ${JSON.stringify(topics)}.
Create ONE technically accurate English multiple-choice question.
Provide exactly FOUR distinct English options. Set answer to the zero-based index 0,1,2,3 of the correct option. Give a concise but useful English reason that teaches why the correct option is right and why the concept matters.
The question, options and reason must be English only. The level/topic must exactly match the selected values when they are not "all". If topic is "all", choose one of the allowed roadmap topics.
Use Google Search grounding for current APIs, tools, model behavior or other time-sensitive facts. Prefer official documentation and primary technical sources.
Do not repeat these recent questions: ${JSON.stringify(recent.slice(-30))}.
Return ONLY JSON.`;
  const r=await geminiGenerate({model:GEMINI_TEST_MODEL,prompt,grounding:true,schema:TEST_SCHEMA,temperature:0.2,req});
  const x=parseJsonText(extractGeminiText(r));
  x.question=clean(x.question,1000);x.options=(x.options||[]).map(v=>clean(v,700));x.reason=clean(x.reason,3000);x.level=clean(x.level,30);x.topic=clean(x.topic,300);
  if(x.options.length!==4||new Set(x.options.map(v=>v.toLowerCase())).size!==4) throw new Error("MCQ must contain four unique options");
  if(!Number.isInteger(x.answer)||x.answer<0||x.answer>3) throw new Error("Invalid MCQ answer index");
  if(level!=="all"&&x.level!==level) throw new Error("Gemini returned the wrong MCQ level");
  if(topic!=="all"&&x.topic!==topic) throw new Error("Gemini returned the wrong MCQ topic");
  if(topic==="all"&&topics.length&&!topics.includes(x.topic)) throw new Error("MCQ topic outside roadmap");
  x.sources=sourceListFromGemini(r); return x;
}

function body(req){
  return new Promise((resolve,reject)=>{let s="";req.on("data",c=>{s+=c;if(s.length>MAX_BODY){reject(new Error("request too large"));req.destroy();}});req.on("end",()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error("invalid JSON"))}});req.on("error",reject);});
}
function send(res,status,type,data){res.writeHead(status,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"same-origin"});res.end(data);}
function json(res,status,data){send(res,status,"application/json; charset=utf-8",JSON.stringify(data));}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  try{
    if(req.method==="GET"&&u.pathname==="/health"){
      const d=readData(); resetDailyCounterIfNeeded();
      return json(res,200,{ok:true,geminiConfigured:!!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY),interviewModel:GEMINI_INTERVIEW_MODEL,testModel:GEMINI_TEST_MODEL,translateModel:GEMINI_TRANSLATE_MODEL,geminiDailyRequestsUsed:geminiDayCount,geminiDailySafetyLimit:GEMINI_DAILY_REQUEST_LIMIT,updatedAt:d.updatedAt||null,opportunityCount:Array.isArray(d.opportunities)?d.opportunities.length:0});
    }
    if(req.method==="GET"&&u.pathname==="/opportunities.json"){
      let d=readData(),t=d.updatedAt?new Date(d.updatedAt).getTime():0;
      if(!t||Date.now()-t>FEED_CACHE_MS){try{d=await refreshOpportunities(req)}catch{}}
      return json(res,200,d);
    }
    if(req.method==="POST"&&u.pathname==="/refresh"){
      if(Date.now()-lastRefreshAt<REFRESH_COOLDOWN_MS){const d=readData();return json(res,200,{...d,cooldown:true,message:"Feed was refreshed recently; showing the latest cached data."});}
      lastRefreshAt=Date.now(); return json(res,200,await refreshOpportunities(req));
    }
    if(req.method==="POST"&&u.pathname==="/interview-question"){
      if(Date.now()-lastInterviewAt<AI_INTERVAL)return json(res,429,{error:"Please wait a moment before requesting another interview question."});
      lastInterviewAt=Date.now(); const p=await body(req); return json(res,200,await makeInterview(p,req));
    }
    if(req.method==="POST"&&u.pathname==="/interview-translate"){
      const p=await body(req); if(!p.question||!(p.content||p.answer))return json(res,400,{error:"Question and content are required"});
      return json(res,200,{translation:await translateText(p,req)});
    }
    if(req.method==="POST"&&u.pathname==="/test-question"){
      if(Date.now()-lastTestAt<AI_INTERVAL)return json(res,429,{error:"Please wait a moment before requesting another test question."});
      lastTestAt=Date.now(); const p=await body(req); return json(res,200,await makeTestQuestion(p,req));
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
