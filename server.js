const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MOBILE_FILE = path.join(ROOT, 'index.html');
const DATA_FILE = path.join(ROOT, 'opportunities.json');
const CACHE_MS = 6 * 60 * 60 * 1000;

const QUERIES = [
  'AI hackathon India 2026',
  'generative AI hackathon 2026',
  'AI internship India 2026',
  'machine learning internship India 2026',
  'AI fellowship scholarship 2026',
  'generative AI program cohort 2026',
  'AI agents competition 2026',
  'n8n AI automation hackathon 2026'
];

const ALLOWED_DOMAINS = new Set([
  'devpost.com','mlh.io','kaggle.com','hackathon.com','unstop.com','internshala.com',
  'google.com','cloud.google.com','developers.google.com','microsoft.com','learn.microsoft.com',
  'aws.amazon.com','nvidia.com','huggingface.co','deeplearning.ai','openai.com',
  'anthropic.com','github.com','meta.com','ibm.com','oracle.com'
]);

function readData(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch { return {updatedAt:null, opportunities:[]}; }
}
function writeData(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function stripTags(s){
  return String(s||'')
    .replace(/<[^>]*>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&quot;/gi,'"')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))
    .replace(/\s+/g,' ')
    .trim();
}
function domainOf(u){ try{return new URL(u).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';} }
function allowedDomain(d){ return [...ALLOWED_DOMAINS].some(x=>d===x || d.endsWith('.'+x)); }
function safeUrl(u){ try { const x=new URL(u); return ['https:','http:'].includes(x.protocol) ? x.toString() : ''; } catch { return ''; } }
function scoreItem(title,desc,domain){
  const t=(title+' '+desc).toLowerCase(); let score=0;
  const terms=['ai','artificial intelligence','generative ai','genai','llm','rag','agent','agentic','automation','python','machine learning','hackathon','internship','fellowship','scholarship','cohort','competition'];
  for(const term of terms) if(t.includes(term)) score += term.length>5?5:3;
  if(allowedDomain(domain)) score += 20;
  if(/2026|2027/.test(t)) score += 5;
  return Math.min(100,score);
}
function priority(score,deadline){
  if(deadline){ const d=Math.ceil((new Date(deadline+'T00:00:00')-new Date())/86400000); if(d>=0&&d<=7)return 'important'; }
  return score>=55?'useful':'optional';
}
function extractTag(block,tag){ const m=block.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>','i')); return m?stripTags(m[1]):''; }
async function fetchText(url){ const r=await fetch(url,{headers:{'user-agent':'Applied-AI-Roadmap-Opportunity-Bot/1.0','accept':'application/rss+xml, application/xml, text/xml'}}); if(!r.ok)throw new Error('HTTP '+r.status); return r.text(); }
function parseRSS(xml){
  const out=[]; const blocks=xml.match(/<item[\s\S]*?<\/item>/gi)||[];
  for(const b of blocks){
    const title=extractTag(b,'title'); const link=extractTag(b,'link'); const desc=extractTag(b,'description'); const source=extractTag(b,'source');
    const url=safeUrl(link); const d=domainOf(url) || domainOf(source); if(!title||!url)continue;
    out.push({title,description:desc.slice(0,500),url,domain:d});
  }
  return out;
}
async function refresh(){
  const all=[];
  let successfulSources=0;
  for(const q of QUERIES){
    const rss='https://news.google.com/rss/search?q='+encodeURIComponent(q+' when:30d')+'&hl=en-IN&gl=IN&ceid=IN:en';
    try { all.push(...parseRSS(await fetchText(rss))); successfulSources++; } catch(e) {}
  }
  const map=new Map();
  for(const x of all){
    if(!allowedDomain(x.domain)) continue;
    const score=scoreItem(x.title,x.description,x.domain); if(score<35)continue;
    const id=(x.url+'|'+x.title).slice(0,220);
    if(map.has(id))continue;
    map.set(id,{id,title:x.title.slice(0,180),description:x.description.slice(0,500),url:x.url,type:/hackathon|competition/i.test(x.title)?'Hackathon / Competition':/internship|hiring|job/i.test(x.title)?'Internship / Job':/fellowship|scholarship/i.test(x.title)?'Scholarship / Fellowship':/workshop|webinar/i.test(x.title)?'Workshop / Webinar':'AI Program',priority:priority(score,null),score,deadline:null,sourceDomain:x.domain,addedAt:new Date().toISOString(),read:false});
  }
  const current=readData();
  const items=[...map.values()].sort((a,b)=>b.score-a.score).slice(0,100);
  // Never erase a previously good feed just because sources are temporarily unavailable.
  if(successfulSources===0){
    return {updatedAt:current.updatedAt||null,opportunities:Array.isArray(current.opportunities)?current.opportunities:[],stale:true};
  }
  const finalItems = items.length ? items : (Array.isArray(current.opportunities) ? current.opportunities : []);
  const data={updatedAt:new Date().toISOString(),opportunities:finalItems,stale:false}; writeData(data); return data;
}
function send(res,status,type,body){res.writeHead(status,{'content-type':type,'access-control-allow-origin':'*','cache-control':'no-store'});res.end(body);}
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&u.pathname==='/opportunities.json'){
    let data=readData(); if(!data.updatedAt || Date.now()-new Date(data.updatedAt).getTime()>CACHE_MS){ try{data=await refresh();}catch(e){} }
    return send(res,200,'application/json; charset=utf-8',JSON.stringify(data));
  }
  if(req.method==='POST'&&u.pathname==='/refresh'){
    const expected=process.env.REFRESH_TOKEN||'';
    const provided=req.headers['x-refresh-token']||u.searchParams.get('token')||'';
    if(expected && provided!==expected) return send(res,401,'application/json',JSON.stringify({error:'unauthorized'}));
    if(!expected) return send(res,403,'application/json',JSON.stringify({error:'set REFRESH_TOKEN on the server'}));
    try{return send(res,200,'application/json; charset=utf-8',JSON.stringify(await refresh()));}catch(e){return send(res,500,'application/json',JSON.stringify({error:'refresh failed'}));}
  }
  if(req.method==='GET'&&u.pathname==='/health') return send(res,200,'application/json',JSON.stringify({ok:true,updatedAt:readData().updatedAt}));
  if(req.method==='GET' && (u.pathname==='/' || u.pathname==='/index.html')){ if(fs.existsSync(MOBILE_FILE)) return send(res,200,'text/html; charset=utf-8',fs.readFileSync(MOBILE_FILE)); }
  send(res,404,'text/plain; charset=utf-8','Not found');
});
server.listen(PORT,()=>console.log('Applied AI Roadmap server listening on '+PORT));
