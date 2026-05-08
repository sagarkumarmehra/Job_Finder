const { onRequest } = require('firebase-functions/v2/https');
const admin    = require('firebase-admin');
const pdfParse = require('pdf-parse');
const axios    = require('axios');

admin.initializeApp();

const SECRETS  = ['OPENAI_KEY', 'SERPAPI_KEY'];
const RUN_OPTS = { timeoutSeconds: 120, memory: '512MiB', secrets: SECRETS, cors: true };

/* ─────────────────────────────────────────────────────────────────────────────
   processSearch  ← MAIN ENTRY POINT called by the frontend
   POST  multipart/form-data:
         resume    (File — PDF/DOC)
         locations (JSON string array)
         roles     (JSON string array)
         salaryMin (number string)
         salaryMax (number string)
   →     { jobs: [...], profile: {...} }
───────────────────────────────────────────────────────────────────────────── */
exports.processSearch = onRequest(RUN_OPTS, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fields, fileBuffer } = await parseMultipart(req);

    if (!fileBuffer) return res.status(400).json({ error: 'No resume file received' });

    const parsed     = await pdfParse(fileBuffer);
    const resumeText = parsed.text.trim();

    const locations = JSON.parse(fields.locations || '[]');
    const roles     = JSON.parse(fields.roles     || '[]');
    const salaryMin = parseInt(fields.salaryMin   || '0',   10);
    const salaryMax = parseInt(fields.salaryMax   || '200', 10);

    const profile = await summarizeProfile(resumeText, locations, roles, salaryMin, salaryMax);

    const [serpJobs, naukriJobs] = await Promise.all([
      process.env.SERPAPI_KEY ? searchSerpAPI(profile, locations) : [],
      searchNaukri(profile, locations, salaryMin, salaryMax)
    ]);

    const jobs = scoreAndRank(deduplicate([...serpJobs, ...naukriJobs]), profile);
    res.json({ jobs: jobs.slice(0, 10), profile });
  } catch (err) {
    console.error('processSearch error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   extractResume  (utility — standalone PDF extraction)
───────────────────────────────────────────────────────────────────────────── */
exports.extractResume = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { pdf } = req.body;
  if (!pdf) return res.status(400).json({ error: 'Missing pdf field (base64)' });
  try {
    const data = await pdfParse(Buffer.from(pdf, 'base64'));
    res.json({ text: data.text.trim(), pages: data.numpages });
  } catch (err) {
    res.status(500).json({ error: 'PDF parsing failed', detail: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   searchJobs  (utility — accepts pre-extracted resume text)
───────────────────────────────────────────────────────────────────────────── */
exports.searchJobs = onRequest(RUN_OPTS, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { resumeText, locations, roles, salaryMin, salaryMax } = req.body;
  if (!resumeText) return res.status(400).json({ error: 'Missing resumeText' });
  try {
    const profile = await summarizeProfile(resumeText, locations, roles, salaryMin, salaryMax);
    const [serpJobs, naukriJobs] = await Promise.all([
      process.env.SERPAPI_KEY ? searchSerpAPI(profile, locations) : [],
      searchNaukri(profile, locations, salaryMin, salaryMax)
    ]);
    const jobs = scoreAndRank(deduplicate([...serpJobs, ...naukriJobs]), profile);
    res.json({ jobs: jobs.slice(0, 10), profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   Multipart parser (busboy)
───────────────────────────────────────────────────────────────────────────── */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const Busboy = require('busboy');
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    let fileBuffer = null;

    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('file', (_name, file) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    busboy.on('finish', () => resolve({ fields, fileBuffer }));
    busboy.on('error', reject);
    busboy.end(req.rawBody);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   OpenAI profile summarisation
───────────────────────────────────────────────────────────────────────────── */
async function summarizeProfile(resumeText, locations, roles, salMin, salMax) {
  if (!process.env.OPENAI_KEY) {
    return {
      skills: [], yearsExperience: 0, seniority: 'mid',
      domain: (roles || []).join(' ') || 'general',
      searchKeywords: roles?.length ? roles : ['Software Engineer'],
      seniorityKeywords: ['Software Engineer'],
      summary: 'Job seeker'
    };
  }

  const userRoles   = (roles || []).join(', ') || 'not specified';
  const userLocs    = (locations || []).join(', ') || 'any';

  const prompt =
    `You are a career analyst. Carefully read this resume and extract a precise job-search profile.\n\n` +
    `=== RESUME ===\n${resumeText.substring(0, 5000)}\n=== END RESUME ===\n\n` +
    `=== CANDIDATE PREFERENCES ===\n` +
    `Desired roles: ${userRoles}\nLocations: ${userLocs}\nSalary: ₹${salMin}L–₹${salMax}L\n\n` +
    `Extract the following and return ONLY valid JSON (no markdown, no explanation):\n\n` +
    `{\n` +
    `  "currentTitle": "their most recent job title exactly as on the resume",\n` +
    `  "skills": ["up to 10 specific technical skills, tools, frameworks found in the resume — e.g. React, PostgreSQL, Kubernetes, not generic words like 'communication'"],\n` +
    `  "yearsExperience": <total years of work experience as integer>,\n` +
    `  "seniority": "fresher|junior|mid|senior|lead|principal — based on years and titles held",\n` +
    `  "domain": "one specific domain: e.g. frontend engineering, backend engineering, data science, product management, devops, mobile development, design, marketing, finance",\n` +
    `  "industries": ["industries the person has worked in, e.g. fintech, ecommerce, saas, healthcare"],\n` +
    `  "searchKeywords": [\n` +
    `    "5 job titles to search for — MUST match their seniority and domain.",\n` +
    `    "Use SPECIFIC titles from the resume, not generic ones.",\n` +
    `    "If their resume shows React+Node experience, use 'Senior Full Stack Engineer' not 'Software Engineer'.",\n` +
    `    "If preferences specify a role, include that role with correct seniority prefix.",\n` +
    `    "Example for 6yr React developer: ['Senior Frontend Engineer', 'Senior React Developer', 'Lead UI Engineer', 'Frontend Tech Lead', 'Senior Software Engineer React']"\n` +
    `  ],\n` +
    `  "seniorityKeywords": ["seniority words matching their level: e.g. Senior, Lead, Staff, Principal"],\n` +
    `  "avoidKeywords": ["words that indicate wrong seniority: e.g. junior, fresher, intern, trainee, entry-level — only if yearsExperience > 3"],\n` +
    `  "summary": "one sentence: their current role, years of experience, and top 2-3 skills"\n` +
    `}\n\n` +
    `RULES:\n` +
    `- skills must be real tools/technologies found IN the resume, not assumptions\n` +
    `- searchKeywords must be realistic Indian job market titles (what companies actually post)\n` +
    `- yearsExperience: calculate from work history dates if available, otherwise estimate from context\n` +
    `- if candidate specified desired roles in preferences, those take priority in searchKeywords`;

  const r = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a resume analyzer. Return ONLY valid JSON.' },
        { role: 'user',   content: prompt }
      ]
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
  );
  const parsed = JSON.parse(r.data.choices[0].message.content);

  parsed.avoidKeywords     = parsed.avoidKeywords     || [];
  parsed.seniorityKeywords = parsed.seniorityKeywords || [];
  parsed.industries        = parsed.industries        || [];
  parsed.currentTitle      = parsed.currentTitle      || '';
  return parsed;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SerpAPI — Google Jobs (LinkedIn + Glassdoor + Indeed)
───────────────────────────────────────────────────────────────────────────── */
async function searchSerpAPI(profile, locations) {
  const results = [];
  const keywords = profile.searchKeywords || ['Software Engineer'];
  // Include top 2 skills in the query so Google returns targeted results
  const topSkills = (profile.skills || []).slice(0, 2);

  for (const q of buildQueries(keywords, locations, 4)) {
    try {
      // e.g. "Senior Product Manager SQL Analytics" — far more targeted than just the title
      const skillSuffix = topSkills.length ? ' ' + topSkills.join(' ') : '';
      const r = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_jobs',
          q: `${q.keyword}${skillSuffix}`,
          location: `${q.location}, India`,
          chips: 'date_posted:month',
          api_key: process.env.SERPAPI_KEY,
          hl: 'en', gl: 'in'
        },
        timeout: 15000
      });
      for (const j of (r.data.jobs_results || [])) {
        const link = j.apply_options?.[0]?.link || j.share_link || '#';
        results.push({
          title: j.title, co: j.company_name, loc: j.location || q.location,
          sal: j.detected_extensions?.salary || '', src: detectSrc(link),
          date: j.detected_extensions?.posted_at || 'Recent',
          excerpt: (j.description || '').substring(0, 220), url: link, match: null
        });
      }
    } catch (e) { console.error(`SerpAPI [${q.keyword}@${q.location}]:`, e.message); }
  }
  return results;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Naukri — unofficial API
   experience param: minimum years expected by candidate
───────────────────────────────────────────────────────────────────────────── */
async function searchNaukri(profile, locations, salaryMin, salaryMax) {
  const results = [];
  const keywords = profile.searchKeywords || ['Software Engineer'];
  // Map years of experience to Naukri's experience filter
  const expYears = profile.yearsExperience || 0;
  const naukriExp = expYears <= 0 ? 0 : Math.max(0, expYears - 1); // allow ±1 year flexibility

  for (const q of buildQueries(keywords, locations, 4)) {
    try {
      const params = {
        noOfResults: 10, urlType: 'search_by_key_loc', searchType: 'adv',
        keyword: q.keyword, location: q.location, page: 1,
        experience: naukriExp  // use actual experience from profile
      };
      if (salaryMin) params.salary = `${salaryMin * 100000},${salaryMax * 100000}`;

      const r = await axios.get('https://www.naukri.com/jobapi/v3/search', {
        headers: {
          appid: '109', systemid: 'jobsearch', 'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: 'https://www.naukri.com/'
        },
        params, timeout: 12000
      });
      for (const j of (r.data.jobDetails || [])) {
        results.push({
          title: j.title || '', co: j.companyName || '',
          loc: j.placeholders?.find(p => p.type === 'location')?.label || q.location,
          sal: j.placeholders?.find(p => p.type === 'salary')?.label || '',
          src: 'kn', date: j.footerPlaceholderLabel || 'Recent',
          excerpt: (j.jobDescription || '').replace(/<[^>]+>/g, '').substring(0, 220),
          url: j.jdURL || '#', match: null
        });
      }
    } catch (e) { console.error(`Naukri [${q.keyword}@${q.location}]:`, e.message); }
  }
  return results;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */
function buildQueries(keywords, locations, max) {
  const kws  = (keywords  || []).slice(0, 2);
  const locs = (locations || ['India']).slice(0, 2);
  const out  = [];
  for (const keyword of kws)
    for (const location of locs) {
      if (out.length >= max) return out;
      out.push({ keyword, location });
    }
  return out.length ? out : [{ keyword: 'Software Engineer', location: 'India' }];
}

function detectSrc(url) {
  if (!url || url === '#') return 'gg';
  if (url.includes('linkedin.com')) return 'li';
  if (url.includes('glassdoor'))    return 'gd';
  if (url.includes('naukri.com'))   return 'kn';
  return 'gg';
}

function deduplicate(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = `${(j.title||'').toLowerCase().trim()}|${(j.co||'').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   Scoring — relevance-first, experience-aware
   Base: 20.  A job must earn its way up via real matches.
   Hard minimum: 45 — anything below is discarded as irrelevant.
───────────────────────────────────────────────────────────────────────────── */
function scoreAndRank(jobs, profile) {
  const skillWords = (profile.skills || []).map(s => s.toLowerCase()).filter(w => w.length > 2);
  const titleKeywords = (profile.searchKeywords || []).map(k => k.toLowerCase());
  const domainWords = (profile.domain || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const seniorityBoost = (profile.seniorityKeywords || []).map(w => w.toLowerCase());
  const avoidWords = (profile.avoidKeywords || []).map(w => w.toLowerCase());
  const expYears = profile.yearsExperience || 0;

  // Non-technical domains that would be irrelevant for a technical profile
  const crossDomainPenaltyWords = ['sales executive', 'business development', 'relationship manager',
    'field sales', 'telecaller', 'insurance advisor', 'loan officer', 'real estate agent',
    'marketing executive', 'hr executive', 'recruiter', 'content writer', 'seo executive',
    'accountant', 'chartered accountant', 'ca ', 'doctor', 'nurse', 'teacher', 'lecturer'];

  const overqualifiedSignals = ['intern', 'internship', 'trainee', 'apprentice', 'graduate trainee',
    'entry level', 'entry-level', 'fresher', '0-1 year', '0 - 1 year'];
  const underqualifiedSignals = ['vp ', 'vice president', 'chief ', ' cto', ' cso', ' cpo',
    'director of', 'head of', 'managing director', 'president'];

  // Determine if profile is technical (most roles are)
  const techDomains = ['software', 'engineering', 'frontend', 'backend', 'fullstack', 'devops',
    'data', 'ml', 'ai', 'product', 'design', 'analytics', 'cloud', 'mobile', 'security'];
  const isTechProfile = techDomains.some(d =>
    (profile.domain || '').toLowerCase().includes(d) ||
    skillWords.some(s => s.includes(d))
  );

  const scored = jobs.map(j => {
    const titleLower   = (j.title || '').toLowerCase();
    const fullText     = `${j.title} ${j.excerpt}`.toLowerCase();
    let score = 20; // start low — must earn relevance

    // ── Title keyword match (strongest signal) ──────────────────────────────
    let titleMatched = false;
    for (const kw of titleKeywords) {
      // Check word-by-word: "product manager" in "Senior Product Manager" → match
      const kwWords = kw.split(/\s+/).filter(w => w.length > 2);
      const matchedWords = kwWords.filter(w => titleLower.includes(w));
      if (matchedWords.length >= Math.ceil(kwWords.length * 0.6)) {
        score += 30; // strong match — title aligns with what we searched
        titleMatched = true;
        break;
      }
    }

    // ── Skill matches in full text ───────────────────────────────────────────
    let skillMatches = 0;
    for (const s of skillWords) {
      if (fullText.includes(s)) skillMatches++;
    }
    // At least 1 skill mention is required for relevance; each extra adds 5 (cap +25)
    if (skillMatches >= 1) score += Math.min(skillMatches * 5, 25);

    // ── Domain matches ───────────────────────────────────────────────────────
    for (const d of domainWords) {
      if (fullText.includes(d)) { score += 5; break; }
    }

    // ── Seniority alignment ──────────────────────────────────────────────────
    for (const w of seniorityBoost) {
      if (titleLower.includes(w)) { score += 8; break; }
    }

    // ── Cross-domain penalty — sales/HR/non-tech jobs for tech profiles ──────
    if (isTechProfile) {
      for (const w of crossDomainPenaltyWords) {
        if (titleLower.includes(w)) { score -= 40; break; }
      }
    }

    // ── Seniority mismatch penalties ─────────────────────────────────────────
    if (expYears >= 4) {
      for (const w of [...avoidWords, ...overqualifiedSignals]) {
        if (titleLower.includes(w)) { score -= 25; break; }
      }
    }
    if (expYears <= 3) {
      for (const w of underqualifiedSignals) {
        if (titleLower.includes(w)) { score -= 15; break; }
      }
    }

    // ── Hard penalty if zero skill AND zero title match ──────────────────────
    if (!titleMatched && skillMatches === 0) score -= 25;

    return { ...j, match: Math.min(Math.max(score, 5), 99) };
  });

  // Hard filter: discard anything that scored below 45 (genuinely irrelevant)
  const relevant = scored.filter(j => j.match >= 45);

  // If filtering left us with < 3 results, relax threshold to 30
  const results = relevant.length >= 3 ? relevant : scored.filter(j => j.match >= 30);

  return results
    .sort((a, b) => b.match - a.match)
    .map((j, i) => ({ ...j, id: i + 1 }));
}
