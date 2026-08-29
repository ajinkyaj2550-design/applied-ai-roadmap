const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'index.html');
const DATA_FILE = path.join(ROOT, 'opportunities.json');
const FEED_CACHE_MS = 6 * 60 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 45 * 1000;
const MAX_OPPORTUNITIES = 500;
const MAX_DISCOVERY_CANDIDATES = 220;
const MAX_SOURCE_RESOLVES = 80;
const MAX_BODY = 50000;
let lastRefreshAt = 0;

// No API key is required. Discovery uses public RSS feeds; ranking/selection is deterministic.
const QUERIES = [
  'AI internship India 2026','generative AI internship 2026','machine learning internship India 2026',
  'AI fellowship 2026','AI scholarship 2026','AI hackathon India 2026','AI hackathon 2026',
  'generative AI hackathon 2026','AI competition 2026','AI challenge India 2026',
  'AI student ambassador 2026','Google student ambassador 2026','Microsoft student ambassador 2026',
  'AWS student ambassador 2026','developer student program 2026','GitHub student program 2026',
  'AI developer program 2026','cloud student program 2026','AI apprenticeship India 2026',
  'AI jobs entry level India 2026','AI mentorship program 2026','AI workshop India 2026',
  'GenAI workshop 2026','AI bootcamp 2026','AI agents competition 2026','AI automation 2026',
  'n8n AI 2026','Python developer internship India 2026','cloud internship India 2026'
];

const TRUSTED = new Set([
  'google.com','cloud.google.com','developers.google.com','microsoft.com','learn.microsoft.com',
  'aws.amazon.com','github.com','nvidia.com','huggingface.co','openai.com','anthropic.com',
  'ibm.com','oracle.com','kaggle.com','devpost.com','mlh.io','unstop.com','internshala.com',
  'deeplearning.ai','hackathon.com'
]);
const OPPORTUNITY_TERMS = /\b(internship|intern|fellowship|scholarship|hackathon|competition|challenge|ambassador|apprenticeship|mentorship|workshop|bootcamp|developer program|student program|open source program|hiring|job|apply|applications open|applications closing|registration|contest)\b/i;
const NOISE_TERMS = /\b(earnings|stock|funding|acquisition|quarter|revenue|market share|product launch|press release|opinion|podcast|webinar recap|research paper|study finds|analysis|interview with|conference recap)\b/i;
const RELEVANT_TERMS = [
  ['ai automation',18],['generative ai',17],['genai',16],['llm',15],['ai agent',16],['agentic',16],
  ['machine learning',12],['artificial intelligence',12],['rag',12],['n8n',14],['api',10],['python',9],
  ['cloud',8],['developer',6],['student',6],['hackathon',10],['internship',10],['fellowship',9],
  ['scholarship',9],['ambassador',10],['apprenticeship',9],['program',6],['challenge',7],['competition',8],
  ['workshop',5],['bootcamp',5],['mentorship',6],['job',8],['hiring',8],['career',6]
];
const TYPES = [
  [/hackathon|competition|challenge/i,'Hackathon / Competition'],
  [/internship|intern\b|hiring|job|career/i,'Internship / Job'],
  [/fellowship|scholarship/i,'Scholarship / Fellowship'],
  [/ambassador/i,'Student Ambassador'],
  [/apprenticeship/i,'Apprenticeship'],
  [/workshop|webinar|bootcamp/i,'Workshop / Bootcamp'],
  [/mentorship/i,'Mentorship'],
  [/developer|student program|program/i,'Student / Developer Program']
];

function readJson(file, fallback){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;} }
function writeJson(file,data){ fs.writeFileSync(file,JSON.stringify(data,null,2)); }
function readData(){return readJson(DATA_FILE,{updatedAt:null,opportunities:[],stale:false});}
function safeUrl(v){try{const u=new URL(String(v||''));return ['http:','https:'].includes(u.protocol)?u.toString():'';}catch{return '';}}
function domainOf(v){try{return new URL(v).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}}
function clean(v,n=700){return String(v||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim().slice(0,n);}
function normalizeTitle(v){return clean(v,250).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function allowedDomain(d){return !!d&&[...TRUSTED].some(x=>d===x||d.endsWith('.'+x));}
function tag(block,name){const m=block.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i'));return m?clean(m[1],2000):'';}
function sourceUrl(block){const m=block.match(/<source[^>]*\burl=["']([^"']+)["']/i);return m?safeUrl(m[1]):'';}
function parseRSS(xml){
  const out=[];
  for(const block of xml.match(/<item[\s\S]*?<\/item>/gi)||[]){
    const title=tag(block,'title');
    const link=safeUrl(tag(block,'link'))||sourceUrl(block);
    const desc=tag(block,'description');
    const source=sourceUrl(block);
    const domain=domainOf(source)||domainOf(link);
    if(title&&link)out.push({title,description:desc,url:link,sourceDomain:domain});
  }
  return out;
}
async function fetchText(url){
  const c=new AbortController();const timer=setTimeout(()=>c.abort(),9000);
  try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'Applied-AI-Roadmap/6.0','accept':'application/rss+xml,application/xml,text/xml'}});if(!r.ok)throw new Error('HTTP '+r.status);return await r.text();}
  finally{clearTimeout(timer);}
}
async function resolveFinalUrl(url){
  try{
    const c=new AbortController();const timer=setTimeout(()=>c.abort(),7000);
    const r=await fetch(url,{signal:c.signal,redirect:'follow',headers:{'user-agent':'Applied-AI-Roadmap/6.0','accept':'text/html,*/*'}});
    clearTimeout(timer);
    return safeUrl(r.url)||url;
  }catch{return url;}
}
function extractDate(text){
  const s=String(text||'');
  const patterns=[/\b20\d{2}-\d{2}-\d{2}\b/,/\b\d{1,2}\/\d{1,2}\/20\d{2}\b/,/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/i];
  for(const p of patterns){const m=s.match(p);if(m)return m[0];}
  return null;
}
function daysUntil(date){
  if(!date)return null;let d=new Date(date+'T00:00:00');if(Number.isNaN(d.getTime()))d=new Date(date);if(Number.isNaN(d.getTime()))return null;
  return Math.ceil((d-new Date())/86400000);
}
function typeOf(title,desc){const t=title+' '+desc;for(const [re,label] of TYPES)if(re.test(t))return label;return 'AI Program';}
function scoreItem(title,desc,domain){
  const t=(title+' '+desc).toLowerCase();let s=0;
  if(allowedDomain(domain))s+=25;
  for(const [term,pts] of RELEVANT_TERMS)if(t.includes(term))s+=pts;
  if(/india|indian|remote|worldwide|global/.test(t))s+=4;
  if(/2026|2027/.test(t))s+=4;
  if(/free|no fee|stipend|paid/.test(t))s+=3;
  const d=extractDate(t),days=daysUntil(d);
  if(days!==null){if(days<0)s-=60;else if(days<=1)s+=20;else if(days<=3)s+=17;else if(days<=7)s+=12;else if(days<=14)s+=7;}
  return Math.max(0,Math.min(100,s));
}
function priority(score){return score>=75?'important':score>=50?'useful':'optional';}
function normalizeItem(x){
  const title=clean(x.title,180),description=clean(x.description,700),url=safeUrl(x.url),domain=domainOf(x.sourceDomain?('https://'+x.sourceDomain):url);
  if(!title||!url||!domain)return null;
  const score=Math.round(Number.isFinite(Number(x.score))?Number(x.score):scoreItem(title,description,domain));
  return {id:String(x.id||normalizeTitle(title)+'|'+domain),title,description,url,type:String(x.type||typeOf(title,description)).slice(0,70),priority:['important','useful','optional'].includes(x.priority)?x.priority:priority(score),score,deadline:x.deadline||extractDate(title+' '+description),sourceDomain:domain,addedAt:x.addedAt||new Date().toISOString()};
}
async function discover(){
  const all=[];
  const results=await Promise.allSettled(QUERIES.map(q=>fetchText('https://news.google.com/rss/search?q='+encodeURIComponent(q+' when:30d')+'&hl=en-IN&gl=IN&ceid=IN:en')));
  for(const r of results)if(r.status==='fulfilled')all.push(...parseRSS(r.value));
  const map=new Map();
  for(const x of all){
    if(!allowedDomain(x.sourceDomain))continue;
    const text=(x.title+' '+x.description).toLowerCase();
    // Hard anti-noise gate: a trusted publisher alone is not enough; the item must actually look like an opportunity.
    if(!OPPORTUNITY_TERMS.test(text)||NOISE_TERMS.test(text))continue;
    const score=scoreItem(x.title,x.description,x.sourceDomain);
    if(score<50)continue;
    const id=normalizeTitle(x.title)+'|'+x.sourceDomain;
    const item=normalizeItem({id,title:x.title,description:x.description,url:x.url,sourceDomain:x.sourceDomain,score,type:typeOf(x.title,x.description),priority:priority(score),deadline:extractDate(x.title+' '+x.description)});
    if(!item)continue;
    const prev=map.get(id);if(!prev||item.score>prev.score)map.set(id,item);
  }
  const candidates=[...map.values()].sort((a,b)=>b.score-a.score).slice(0,MAX_DISCOVERY_CANDIDATES);
  // Google News can return redirect URLs. Resolve only the best candidates so the UI gets a usable destination.
  const resolved=await Promise.all(candidates.slice(0,MAX_SOURCE_RESOLVES).map(async x=>({...x,url:await resolveFinalUrl(x.url)})));
  return [...resolved,...candidates.slice(MAX_SOURCE_RESOLVES)];
}
async function refreshOpportunities(){
  const old=readData().opportunities||[];
  let fresh=[];try{fresh=await discover();}catch{fresh=[];}
  const merged=new Map();
  old.map(normalizeItem).filter(Boolean).forEach(o=>merged.set(o.id,o));
  fresh.forEach(o=>merged.set(o.id,{...merged.get(o.id),...o}));
  const opportunities=[...merged.values()].filter(o=>{const d=daysUntil(o.deadline);return d===null||d>=0;}).sort((a,b)=>b.score-a.score).slice(0,MAX_OPPORTUNITIES);
  const data={updatedAt:new Date().toISOString(),opportunities,stale:fresh.length===0};writeJson(DATA_FILE,data);return data;
}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>MAX_BODY){reject(new Error('request too large'));req.destroy();}});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{resolve({})}});req.on('error',reject);});}
function send(res,status,type,data){res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'});res.end(data);}
function json(res,status,data){send(res,status,'application/json; charset=utf-8',JSON.stringify(data));}
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  try{
    if(req.method==='GET'&&u.pathname==='/health'){
      const d=readData();return json(res,200,{ok:true,apiKeyRequired:false,discovery:'public RSS + deterministic ranking',updatedAt:d.updatedAt||null,opportunityCount:Array.isArray(d.opportunities)?d.opportunities.length:0});
    }
    if(req.method==='GET'&&u.pathname==='/opportunities.json'){
      let d=readData();const t=d.updatedAt?new Date(d.updatedAt).getTime():0;
      if(!t||Date.now()-t>FEED_CACHE_MS){try{d=await refreshOpportunities();}catch{}}
      return json(res,200,d);
    }
    if(req.method==='POST'&&u.pathname==='/refresh'){
      await body(req);
      if(Date.now()-lastRefreshAt<REFRESH_COOLDOWN_MS){const d=readData();return json(res,200,{...d,cooldown:true,message:'Feed was refreshed recently; showing latest cached data.'});}
      lastRefreshAt=Date.now();return json(res,200,await refreshOpportunities());
    }
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
      if(!fs.existsSync(INDEX_FILE))return send(res,500,'text/plain; charset=utf-8','index.html not found');
      return send(res,200,'text/html; charset=utf-8',fs.readFileSync(INDEX_FILE,'utf8'));
    }
    return send(res,404,'text/plain; charset=utf-8','Not found');
  }catch(e){return json(res,500,{error:e.message||'server error'});}
});
server.listen(PORT,()=>console.log('Applied AI Roadmap server listening on '+PORT));
