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

  const prompt =
    `Analyze this resume and return ONLY valid JSON — no markdown.\n\n` +
    `Resume:\n${resumeText.substring(0, 4000)}\n\n` +
    `Preferences: Locations: ${(locations||[]).join(', ')||'any'} | ` +
    `Roles: ${(roles||[]).join(', ')||'any'} | Salary: ₹${salMin}L–₹${salMax}L\n\n` +
    `JSON schema:\n` +
    `{\n` +
    `  "skills": ["top 8 technical skills"],\n` +
    `  "yearsExperience": <integer total years>,\n` +
    `  "seniority": "fresher|junior|mid|senior|lead|principal",\n` +
    `  "domain": "primary domain e.g. frontend, backend, data science",\n` +
    `  "searchKeywords": ["3-5 exact job titles matching their level, e.g. Senior Product Manager"],\n` +
    `  "seniorityKeywords": ["seniority prefixes/suffixes appropriate for this person, e.g. Senior, Lead, Staff"],\n` +
    `  "experienceRange": { "min": <yearsExperience - 1>, "max": <yearsExperience + 3> },\n` +
    `  "avoidKeywords": ["junior", "entry level", "fresher", "intern", "trainee"] if yearsExperience > 3 else [],\n` +
    `  "summary": "one sentence professional summary"\n` +
    `}\n\n` +
    `IMPORTANT: searchKeywords MUST reflect the seniority level. ` +
    `For someone with 8 years experience, use "Senior Software Engineer" not "Software Engineer".`;

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

  // Ensure avoidKeywords always exists
  parsed.avoidKeywords = parsed.avoidKeywords || [];
  parsed.seniorityKeywords = parsed.seniorityKeywords || [];
  return parsed;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SerpAPI — Google Jobs (LinkedIn + Glassdoor + Indeed)
───────────────────────────────────────────────────────────────────────────── */
async function searchSerpAPI(profile, locations) {
  const results = [];
  // Use seniority-aware titles from the profile
  const keywords = profile.searchKeywords || ['Software Engineer'];
  for (const q of buildQueries(keywords, locations, 4)) {
    try {
      const r = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_jobs',
          q: `${q.keyword} jobs`,
          location: `${q.location}, India`,
          chips: 'date_posted:week',
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
   Scoring — experience-aware
   Rewards:  skill/domain/keyword matches
   Penalizes: seniority mismatch (junior job for senior candidate or vice versa)
───────────────────────────────────────────────────────────────────────────── */
function scoreAndRank(jobs, profile) {
  const skillWords = [
    profile.domain,
    ...(profile.skills || []),
    ...(profile.searchKeywords || [])
  ].join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const seniorityBoostWords  = (profile.seniorityKeywords || []).map(w => w.toLowerCase());
  const avoidWords           = (profile.avoidKeywords     || []).map(w => w.toLowerCase());
  const expYears             = profile.yearsExperience || 0;

  // Words that signal seniority mismatch in the opposite direction
  const overqualifiedSignals = ['intern', 'trainee', 'apprentice', 'graduate trainee', 'entry level', 'entry-level', 'fresher'];
  const underqualifiedSignals = ['vp ', 'vice president', 'chief ', 'cto', 'cso', 'cpo', 'director of', 'head of', 'managing director'];

  return jobs
    .map(j => {
      const txt = `${j.title} ${j.co} ${j.excerpt}`.toLowerCase();
      let score = 50;

      // +5 per matching skill/domain word (cap at +30)
      let skillBonus = 0;
      for (const w of skillWords) {
        if (txt.includes(w)) skillBonus = Math.min(skillBonus + 5, 30);
      }
      score += skillBonus;

      // +8 if the job title explicitly matches seniority level
      for (const w of seniorityBoostWords) {
        if (j.title.toLowerCase().includes(w)) { score += 8; break; }
      }

      // Seniority mismatch penalties
      const titleLower = j.title.toLowerCase();

      if (expYears >= 4) {
        // Experienced candidate — penalise junior/entry roles
        for (const w of [...avoidWords, ...overqualifiedSignals]) {
          if (titleLower.includes(w)) { score -= 20; break; }
        }
      }

      if (expYears <= 3) {
        // Junior candidate — penalise VP/Director/C-suite roles
        for (const w of underqualifiedSignals) {
          if (titleLower.includes(w)) { score -= 15; break; }
        }
      }

      // If user specified preferred roles and this job matches one — bonus
      if (profile.searchKeywords) {
        for (const kw of profile.searchKeywords) {
          if (titleLower.includes(kw.toLowerCase())) { score += 10; break; }
        }
      }

      return { ...j, match: Math.min(Math.max(score, 10), 99) };
    })
    .sort((a, b) => b.match - a.match)
    .map((j, i) => ({ ...j, id: i + 1 }));
}
