const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const DATA_FILE = path.join(ROOT, "opportunities.json");

const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_INTERVIEW_MODEL || "gpt-5.6-luna";
const MAX_BODY = 120000;
const FEED_CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_OPPORTUNITIES = 500;
const MAX_INTERVIEW_STORE = 5000;
const interviewStore = [];

let lastInterviewAt = 0;
let lastTestAt = 0;
const AI_INTERVAL = 1200;

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
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readData() {
  return readJson(DATA_FILE, {updatedAt:null, opportunities:[], stale:false});
}
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
function allowedDomain(d) {
  return !!d && [...ALLOWED_DOMAINS].some(x => d === x || d.endsWith("." + x));
}
function clean(v, n=12000) {
  return String(v || "").replace(/\s+/g," ").trim().slice(0,n);
}
function normalizeTitle(v) {
  return clean(v,300).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function decode(v) {
  return clean(String(v || "")
    .replace(/<[^>]*>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'"),10000);
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
    /\b20\d{2}-\d{2}-\d{2}\b/,
    /\b\d{1,2}\/\d{1,2}\/20\d{2}\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/i
  ]) { const m=String(t).match(r); if(m) return m[0]; }
  return null;
}
async function fetchText(url) {
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),15000);
  try {
    const r=await fetch(url,{signal:c.signal,headers:{"user-agent":"Applied-AI-Roadmap/3.0","accept":"application/rss+xml,application/xml,text/xml"}});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}
async function refreshOpportunities() {
  const current=readData(), all=[];
  let successful=0;
  for (const q of QUERIES) {
    const url="https://news.google.com/rss/search?q="+encodeURIComponent(q+" when:7d")+"&hl=en-IN&gl=IN&ceid=IN:en";
    try { const items=parseRSS(await fetchText(url)); if(items.length){successful++;all.push(...items);} } catch {}
  }
  const old=Array.isArray(current.opportunities)?current.opportunities:[];
  if (!successful) return {...current,opportunities:old,stale:true};

  const fresh=new Map();
  for (const x of all) {
    if (!allowedDomain(x.domain)) continue;
    const score=scoreItem(x.title,x.description,x.domain);
    if(score<30) continue;
    const id=normalizeTitle(x.title)+"|"+x.domain;
    if(fresh.has(id)) continue;
    fresh.set(id,{
      id,title:x.title,description:x.description,url:x.url,
      type:opportunityType(x.title,x.description),priority:priority(score),score,
      deadline:extractDate(x.title+" "+x.description),sourceDomain:x.domain,
      addedAt:new Date().toISOString(),read:false
    });
  }

  const merged=new Map();
  old.forEach(x=>{if(x&&x.id)merged.set(String(x.id),x);});
  for(const x of fresh.values()){
    const prev=merged.get(String(x.id));
    merged.set(String(x.id),prev?{...prev,...x,read:!!prev.read}:x);
  }
  const opportunities=[...merged.values()]
    .sort((a,b)=>Number(b.score||0)-Number(a.score||0))
    .slice(0,MAX_OPPORTUNITIES);
  const data={updatedAt:new Date().toISOString(),opportunities,stale:false};
  writeJson(DATA_FILE,data);
  return data;
}

function extractOutputText(r) {
  if(typeof r?.output_text==="string" && r.output_text.trim()) return r.output_text.trim();
  const a=[];
  for(const item of r?.output||[])
    for(const c of item?.content||[])
      if(c?.type==="output_text" && typeof c.text==="string") a.push(c.text);
  return a.join("\n").trim();
}
async function openAI(input, web=false, schema=null) {
  const key=process.env.OPENAI_API_KEY;
  if(!key) throw Object.assign(new Error("OPENAI_API_KEY is not configured"),{code:"NO_OPENAI_KEY"});
  const body={model:OPENAI_MODEL,input,store:false};
  if(web) body.tools=[{type:"web_search"}];
  if(schema) body.text={format:{type:"json_schema",name:schema.name,strict:true,schema:schema.schema}};
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);
  try {
    const r=await fetch(OPENAI_URL,{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify(body),signal:c.signal});
    const raw=await r.text(); let d=null; try{d=JSON.parse(raw)}catch{}
    if(!r.ok) throw new Error(d?.error?.message || "OpenAI HTTP "+r.status);
    return d;
  } finally { clearTimeout(timer); }
}
function similarityKey(v) {
  return clean(v,600).toLowerCase().replace(/[^a-z0-9]+/g," ")
    .replace(/\b(what|why|how|is|are|the|a|an|and|to|of|in|for|you|your)\b/g,"")
    .replace(/\s+/g," ").trim();
}
function sourceList(a) {
  const out=[],seen=new Set();
  for(const x of Array.isArray(a)?a:[]) {
    const url=safeUrl(x?.url), title=clean(x?.title,180);
    if(!url||seen.has(url)) continue;
    seen.add(url); out.push({title:title||domainOf(url),url});
    if(out.length===6) break;
  }
  return out;
}
function validateInterview(x,p,topics) {
  if(!x?.question||!x?.answer) throw new Error("Interview response is missing question or answer");
  if(p.level!=="all" && String(x.level)!==String(p.level)) throw new Error("Wrong roadmap level returned");
  if(p.topic!=="all" && String(x.topic)!==String(p.topic)) throw new Error("Wrong roadmap topic returned");
  if(p.topic==="all" && !topics.includes(String(x.topic))) throw new Error("Topic is outside selected roadmap");
  if(p.difficulty!=="auto" && x.difficulty!==p.difficulty) throw new Error("Wrong difficulty returned");
  if(/[ऀ-ॿ]/.test(x.question+" "+x.answer)) throw new Error("Interview content must be English");
  if(!x.sources?.length) throw new Error("No supporting sources returned");
}
async function makeInterview(p) {
  const level=String(p.level||"all"),topic=clean(p.topic||"all",300);
  const difficulty=["beginner","intermediate","advanced"].includes(p.difficulty)?p.difficulty:"auto";
  const topics=Array.isArray(p.topics)?p.topics.map(x=>clean(x,250)).filter(Boolean).slice(0,30):[];
  const recent=Array.isArray(p.recentQuestions)?p.recentQuestions:Array.isArray(p.recent)?p.recent:[];
  const store=readInterviewStore();
  const avoid=[...new Set([
    ...recent.map(x=>clean(x,500)).filter(Boolean),
    ...store.filter(x=>String(x.level)===level&&(topic==="all"||String(x.topic)===topic)).slice(-100).map(x=>x.question)
  ])].slice(-150);

  const schema={name:"interview_question",schema:{
    type:"object",additionalProperties:false,
    properties:{
      question:{type:"string"},answer:{type:"string"},level:{type:"string"},
      topic:{type:"string"},difficulty:{type:"string",enum:["beginner","intermediate","advanced"]},
      sources:{type:"array",items:{type:"object",additionalProperties:false,properties:{title:{type:"string"},url:{type:"string"}},required:["title","url"]}}
    },
    required:["question","answer","level","topic","difficulty","sources"]
  }};
  const prompt=`You are an interview engine for an Applied AI Engineer roadmap.
Selected level: ${level}. Selected topic: ${topic}. Topics allowed: ${JSON.stringify(topics)}.
Difficulty: ${difficulty}. Create ONE original technical interview question and a correct interview-ready English answer.
Use web search first. Prefer official documentation and primary/reputable technical sources. Do not invent facts or copy questions.
The returned level/topic MUST exactly match the selected values when they are not "all".
The question and answer must be English. Return 1-6 real supporting URLs.
Avoid substantially similar questions: ${JSON.stringify(avoid)}.`;
  let last;
  for(let i=0;i<2;i++) {
    try {
      const r=await openAI(prompt+(i?"\nPrevious attempt violated a constraint. Obey every selection constraint exactly.":""),true,schema);
      let x; try{x=JSON.parse(extractOutputText(r))}catch{throw new Error("Invalid structured interview response");}
      x.question=clean(x.question,500);x.answer=clean(x.answer,7000);x.level=clean(x.level,20);
      x.topic=clean(x.topic,300);x.sources=sourceList(x.sources);
      if(!["beginner","intermediate","advanced"].includes(x.difficulty)) throw new Error("Invalid difficulty");
      validateInterview(x,{level,topic,difficulty},topics);
      if(avoid.some(q=>similarityKey(q)===similarityKey(x.question))) throw new Error("Duplicate question returned");
      store.push({id:Date.now()+"-"+Math.random().toString(36).slice(2,8),...x,createdAt:new Date().toISOString()});
      writeInterviewStore(store);
      return x;
    } catch(e){last=e;}
  }
  throw last||new Error("Interview engine failed");
}

async function translateText(question,answer) {
  const schema={name:"marathi_translation",schema:{type:"object",additionalProperties:false,properties:{translation:{type:"string"}},required:["translation"]}};
  const input=`Translate the following technical interview/test content into natural Marathi for an Indian learner. Translate the question, options/answer and reason if present. Keep technical terms such as API, RAG, LLM, Git, Docker, Python, webhook and vector database in English when clearer. Do not add facts.
QUESTION:
${clean(question,4000)}
CONTENT:
${clean(answer,10000)}`;
  const r=await openAI(input,false,schema);
  let x;try{x=JSON.parse(extractOutputText(r))}catch{throw new Error("Invalid translation response");}
  return clean(x.translation,14000);
}

async function makeTestQuestion(p) {
  const level=String(p.level||"all"),topic=clean(p.topic||"all",300);
  const topics=Array.isArray(p.topics)?p.topics.map(x=>clean(x,250)).filter(Boolean).slice(0,30):[];
  const recent=Array.isArray(p.recentQuestions)?p.recentQuestions:Array.isArray(p.recent)?p.recent:[];
  const schema={name:"mcq_question",schema:{
    type:"object",additionalProperties:false,
    properties:{
      question:{type:"string"},options:{type:"array",minItems:4,maxItems:4,items:{type:"string"}},
      answer:{type:"integer",minimum:0,maximum:3},reason:{type:"string"},
      level:{type:"string"},topic:{type:"string"}
    },
    required:["question","options","answer","reason","level","topic"]
  }};
  const prompt=`You are a multiple-choice test engine for an Applied AI Engineer roadmap.
Selected level: ${level}. Selected topic: ${topic}. Allowed topics: ${JSON.stringify(topics)}.
Create ONE technically accurate English MCQ. The question must match the selected level/topic exactly. Provide exactly four distinct English options and one correct option index 0-3. Give a concise English reason explaining why the selected answer is correct.
Do not use Marathi. Do not duplicate these recent questions: ${JSON.stringify(recent.slice(-30))}.
Use current reliable technical knowledge; for current APIs/tools, use web search and verify from primary sources.`;
  const r=await openAI(prompt,true,schema);
  let x;try{x=JSON.parse(extractOutputText(r))}catch{throw new Error("Invalid MCQ response");}
  x.question=clean(x.question,700);x.options=(x.options||[]).map(v=>clean(v,500));
  x.reason=clean(x.reason,2500);x.level=clean(x.level,20);x.topic=clean(x.topic,300);
  if(x.options.length!==4||new Set(x.options.map(v=>v.toLowerCase())).size!==4) throw new Error("MCQ must contain four unique options");
  if(!Number.isInteger(x.answer)||x.answer<0||x.answer>3) throw new Error("Invalid MCQ answer index");
  if(level!=="all"&&x.level!==level) throw new Error("Wrong MCQ level");
  if(topic!=="all"&&x.topic!==topic) throw new Error("Wrong MCQ topic");
  if(topic==="all"&&!topics.includes(x.topic)) throw new Error("MCQ topic outside roadmap");
  return x;
}

function body(req) {
  return new Promise((resolve,reject)=>{
    let s="";
    req.on("data",c=>{s+=c;if(s.length>MAX_BODY){reject(new Error("request too large"));req.destroy();}});
    req.on("end",()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error("invalid JSON"))}});
    req.on("error",reject);
  });
}
function send(res,status,type,data) {
  res.writeHead(status,{"content-type":type,"cache-control":"no-store","access-control-allow-origin":"*"});
  res.end(data);
}
function json(res,status,data){send(res,status,"application/json; charset=utf-8",JSON.stringify(data));}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");

  try {
    if(req.method==="GET" && u.pathname==="/health") {
      const d=readData();
      return json(res,200,{ok:true,openaiConfigured:!!process.env.OPENAI_API_KEY,model:OPENAI_MODEL,updatedAt:d.updatedAt||null,opportunityCount:Array.isArray(d.opportunities)?d.opportunities.length:0});
    }

    if(req.method==="GET" && u.pathname==="/opportunities.json") {
      let d=readData(), t=d.updatedAt?new Date(d.updatedAt).getTime():0;
      if(!t || Date.now()-t>FEED_CACHE_MS) { try{d=await refreshOpportunities();}catch{} }
      return json(res,200,d);
    }

    if(req.method==="POST" && u.pathname==="/refresh") {
      return json(res,200,await refreshOpportunities());
    }

    if(req.method==="POST" && u.pathname==="/interview-question") {
      if(Date.now()-lastInterviewAt<AI_INTERVAL) return json(res,429,{error:"Please wait a moment before requesting another interview question."});
      lastInterviewAt=Date.now();
      const p=await body(req);
      return json(res,200,await makeInterview(p));
    }

    if(req.method==="POST" && u.pathname==="/interview-translate") {
      const p=await body(req);
      if(!p.question||!p.answer) return json(res,400,{error:"Question and answer are required"});
      return json(res,200,{translation:await translateText(p.question,p.answer)});
    }

    if(req.method==="POST" && u.pathname==="/test-question") {
      if(Date.now()-lastTestAt<AI_INTERVAL) return json(res,429,{error:"Please wait a moment before requesting another test question."});
      lastTestAt=Date.now();
      const p=await body(req);
      return json(res,200,await makeTestQuestion(p));
    }

    if(req.method==="GET" && (u.pathname==="/"||u.pathname==="/index.html")) {
      if(!fs.existsSync(INDEX_FILE)) return send(res,500,"text/plain; charset=utf-8","index.html not found");
      return send(res,200,"text/html; charset=utf-8",fs.readFileSync(INDEX_FILE,"utf8"));
    }

    return send(res,404,"text/plain; charset=utf-8","Not found");
  } catch(e) {
    const status=e.code==="NO_OPENAI_KEY"?503:(/rate limit|too many|quota/i.test(e.message)?429:500);
    return json(res,status,{error:e.message||"server error"});
  }
});

server.listen(PORT,()=>console.log(`Applied AI Roadmap server listening on ${PORT}`));
