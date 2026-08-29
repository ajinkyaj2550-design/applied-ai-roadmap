const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MOBILE_FILE = path.join(ROOT, 'index.html');
const DATA_FILE = path.join(ROOT, 'opportunities.json');
const INTERVIEW_FILE = path.join(ROOT, 'interview-questions.json');

const CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

/*
 * Manual refresh cooldown.
 * Prevents the refresh button from being spammed and hammering
 * Google News RSS repeatedly within a short window. No API key
 * involved anywhere in this flow — this is just basic abuse
 * protection so the free RSS source doesn't get rate-limited.
 */
const REFRESH_COOLDOWN_MS = 45 * 1000;
let lastManualRefreshAt = 0;

/*
 * Multiple searches = better chance of finding fresh opportunities.
 * "when:7d" focuses on recently published results.
 */
const QUERIES = [
  'AI hackathon India 2026',
  'AI hackathon 2026',
  'generative AI hackathon 2026',
  'machine learning hackathon 2026',
  'AI competition India 2026',
  'AI internship India 2026',
  'machine learning internship India 2026',
  'generative AI internship 2026',
  'AI fellowship 2026',
  'AI scholarship 2026',
  'AI program India 2026',
  'generative AI program 2026',
  'AI agents competition 2026',
  'AI automation hackathon 2026',
  'n8n AI hackathon 2026',
  'AI challenge India 2026'
];

/*
 * Keep trusted opportunity platforms and official organizations.
 */
const ALLOWED_DOMAINS = new Set([
  'devpost.com',
  'mlh.io',
  'kaggle.com',
  'hackathon.com',
  'unstop.com',
  'internshala.com',

  'google.com',
  'cloud.google.com',
  'developers.google.com',

  'microsoft.com',
  'learn.microsoft.com',

  'aws.amazon.com',
  'nvidia.com',
  'huggingface.co',
  'deeplearning.ai',
  'openai.com',
  'anthropic.com',
  'github.com',
  'meta.com',
  'ibm.com',
  'oracle.com'
]);

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {
      updatedAt: null,
      opportunities: [],
      stale: false
    };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function domainOf(value) {
  try {
    const u = new URL(value);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function allowedDomain(domain) {
  if (!domain) return false;

  return [...ALLOWED_DOMAINS].some(
    d => domain === d || domain.endsWith('.' + d)
  );
}

function safeUrl(value) {
  try {
    const u = new URL(value);

    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return '';
    }

    return u.toString();
  } catch {
    return '';
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}

function stripTags(value) {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const regex = new RegExp(
    '<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>',
    'i'
  );

  const match = block.match(regex);

  return match ? stripTags(match[1]) : '';
}

/*
 * IMPORTANT:
 * Google News RSS <source> can contain the real publisher URL
 * in a url="..." attribute.
 */
function sourceUrlOf(block) {
  const match = block.match(
    /<source[^>]*\burl=["']([^"']+)["'][^>]*>/i
  );

  return match ? safeUrl(match[1]) : '';
}

function scoreItem(title, description, domain) {
  const text = (
    String(title || '') +
    ' ' +
    String(description || '')
  ).toLowerCase();

  let score = 0;

  const strongTerms = [
    'hackathon',
    'internship',
    'fellowship',
    'scholarship',
    'competition',
    'challenge',
    'cohort',
    'program',
    'generative ai',
    'machine learning',
    'artificial intelligence',
    'ai agents',
    'automation'
  ];

  const normalTerms = [
    'ai',
    'genai',
    'llm',
    'rag',
    'agent',
    'agentic',
    'python'
  ];

  for (const term of strongTerms) {
    if (text.includes(term)) score += 7;
  }

  for (const term of normalTerms) {
    if (text.includes(term)) score += 3;
  }

  if (allowedDomain(domain)) {
    score += 20;
  }

  if (/2026|2027/.test(text)) {
    score += 5;
  }

  return Math.min(100, score);
}

function opportunityType(title, description) {
  const text = (
    String(title || '') +
    ' ' +
    String(description || '')
  ).toLowerCase();

  if (/hackathon|competition|challenge/.test(text)) {
    return 'Hackathon / Competition';
  }

  if (/internship|intern\b|hiring|job/.test(text)) {
    return 'Internship / Job';
  }

  if (/fellowship|scholarship/.test(text)) {
    return 'Scholarship / Fellowship';
  }

  if (/workshop|webinar|bootcamp/.test(text)) {
    return 'Workshop / Webinar';
  }

  return 'AI Program';
}

function priority(score) {
  if (score >= 65) return 'important';
  if (score >= 50) return 'useful';
  return 'optional';
}

function extractDate(text) {
  const value = String(text || '');

  const patterns = [
    /\b20\d{2}-\d{2}-\d{2}\b/,
    /\b\d{1,2}\/\d{1,2}\/20\d{2}\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[0];
  }

  return null;
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function makeId(item) {
  return normalizeTitle(item.title) + '|' + domainOf(item.url);
}

async function fetchText(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Applied-AI-Roadmap-Opportunity-Bot/2.0',
        accept:
          'application/rss+xml, application/xml, text/xml'
      }
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseRSS(xml) {
  const results = [];

  const blocks =
    xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const description = extractTag(
      block,
      'description'
    );

    const sourceUrl = sourceUrlOf(block);

    /*
     * Prefer publisher/source URL for domain filtering.
     * Fall back to link if source URL is unavailable.
     */
    const url =
      safeUrl(link) ||
      sourceUrl;

    const domain =
      domainOf(sourceUrl) ||
      domainOf(url);

    if (!title || !url) continue;

    results.push({
      title: title.slice(0, 180),
      description: description.slice(0, 700),
      url,
      domain
    });
  }

  return results;
}

async function refresh() {
  const all = [];

  let successfulSources = 0;

  /*
   * Run all searches independently.
   * One failed query should not stop the other queries.
   */
  for (const query of QUERIES) {
    const rss =
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent(query + ' when:7d') +
      '&hl=en-IN&gl=IN&ceid=IN:en';

    try {
      const xml = await fetchText(rss);
      const results = parseRSS(xml);

      if (results.length > 0) {
        successfulSources++;
        all.push(...results);
      }
    } catch (error) {
      /*
       * Ignore one failed query and continue.
       */
    }
  }

  const current = readData();

  /*
   * If every search failed, NEVER destroy existing data.
   */
  if (successfulSources === 0) {
    return {
      updatedAt: current.updatedAt || null,
      opportunities: Array.isArray(
        current.opportunities
      )
        ? current.opportunities
        : [],
      stale: true
    };
  }

  const map = new Map();

  for (const item of all) {
    const domain = item.domain;

    if (!allowedDomain(domain)) {
      continue;
    }

    const score = scoreItem(
      item.title,
      item.description,
      domain
    );

    /*
     * Slightly less restrictive than the old version.
     */
    if (score < 30) {
      continue;
    }

    const id = makeId(item);

    if (map.has(id)) {
      continue;
    }

    const combinedText =
      item.title + ' ' + item.description;

    map.set(id, {
      id,
      title: item.title,
      description: item.description,
      url: item.url,
      type: opportunityType(
        item.title,
        item.description
      ),
      priority: priority(score),
      score,
      deadline: extractDate(combinedText),
      sourceDomain: domain,
      addedAt: new Date().toISOString(),
      read: false
    });
  }

  const freshItems = [...map.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        new Date(b.addedAt) -
        new Date(a.addedAt)
      );
    });

  /*
   * Keep up to 100 fresh opportunities.
   *
   * If a refresh successfully contacts Google News but
   * filtering produces nothing, preserve the old feed.
   */
  const finalItems =
    freshItems.length > 0
      ? freshItems.slice(0, 100)
      : Array.isArray(current.opportunities)
        ? current.opportunities
        : [];

  const data = {
    updatedAt: new Date().toISOString(),
    opportunities: finalItems,
    stale: false
  };

  writeData(data);

  return data;
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  });

  res.end(body);
}

const server = http.createServer(
  async (req, res) => {
    const url = new URL(
      req.url,
      'http://localhost'
    );

    /*
     * Feed endpoint.
     */
    if (
      req.method === 'GET' &&
      url.pathname === '/opportunities.json'
    ) {
      let data = readData();

      const updatedTime = data.updatedAt
        ? new Date(data.updatedAt).getTime()
        : 0;

      const needsRefresh =
        !updatedTime ||
        Date.now() - updatedTime > CACHE_MS;

      if (needsRefresh) {
        try {
          data = await refresh();
        } catch (error) {
          /*
           * Keep existing data if automatic refresh fails.
           */
        }
      }

      return send(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify(data)
      );
    }

    /*
     * Manual Refresh button endpoint.
     *
     * REFRESH_TOKEN remains optional.
     * If it is configured, the client must provide it.
     */
    if (
      req.method === 'POST' &&
      url.pathname === '/refresh'
    ) {
      const expected =
        process.env.REFRESH_TOKEN || '';

      const provided =
        req.headers['x-refresh-token'] ||
        url.searchParams.get('token') ||
        '';

      if (
        expected &&
        provided !== expected
      ) {
        return send(
          res,
          401,
          'application/json; charset=utf-8',
          JSON.stringify({
            error: 'unauthorized'
          })
        );
      }

      /*
       * Cooldown: if someone just refreshed a moment ago,
       * return the current cached data instead of hitting
       * Google News again. No API key needed — just a
       * lightweight, no-config throttle.
       */
      const now = Date.now();
      const sinceLast = now - lastManualRefreshAt;
      if (sinceLast < REFRESH_COOLDOWN_MS) {
        const data = readData();
        return send(
          res,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({
            ...data,
            cooldown: true,
            cooldownSecondsLeft: Math.ceil(
              (REFRESH_COOLDOWN_MS - sinceLast) / 1000
            )
          })
        );
      }

      try {
        lastManualRefreshAt = now;
        const data = await refresh();

        return send(
          res,
          200,
          'application/json; charset=utf-8',
          JSON.stringify(data)
        );
      } catch (error) {
        return send(
          res,
          500,
          'application/json; charset=utf-8',
          JSON.stringify({
            error: 'refresh failed'
          })
        );
      }
    }

    /*
     * Interview question bank.
     * Served from a plain local JSON file — no external API,
     * no key. The frontend fetches this over HTTP (same-origin)
     * so the practice bank can be updated without touching the
     * HTML file, and so it counts as a genuinely "online" source
     * distinct from the hardcoded per-level quiz data.
     */
    if (
      req.method === 'GET' &&
      url.pathname === '/interview-questions.json'
    ) {
      try {
        const raw = fs.readFileSync(INTERVIEW_FILE, 'utf8');
        return send(
          res,
          200,
          'application/json; charset=utf-8',
          raw
        );
      } catch (error) {
        return send(
          res,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({ updatedAt: null, questions: [] })
        );
      }
    }

    /*
     * Health check.
     */
    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      const data = readData();

      return send(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({
          ok: true,
          updatedAt: data.updatedAt || null,
          opportunityCount:
            Array.isArray(data.opportunities)
              ? data.opportunities.length
              : 0
        })
      );
    }

    /*
     * Serve the existing index.html.
     */
    if (
      req.method === 'GET' &&
      (
        url.pathname === '/' ||
        url.pathname === '/index.html'
      )
    ) {
      if (fs.existsSync(MOBILE_FILE)) {
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          fs.readFileSync(
            MOBILE_FILE,
            'utf8'
          )
        );
      }

      return send(
        res,
        500,
        'text/plain; charset=utf-8',
        'index.html not found'
      );
    }

    return send(
      res,
      404,
      'text/plain; charset=utf-8',
      'Not found'
    );
  }
);

server.listen(
  PORT,
  () =>
    console.log(
      'Applied AI Roadmap server listening on ' +
      PORT
    )
);
