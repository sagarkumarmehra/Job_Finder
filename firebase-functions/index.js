const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const cors      = require('cors')({ origin: true });
const pdfParse  = require('pdf-parse');
const axios     = require('axios');

admin.initializeApp();

// API keys are stored in Firebase Secret Manager.
// Set them once with:
//   firebase functions:secrets:set OPENAI_KEY
//   firebase functions:secrets:set SERPAPI_KEY
// They are injected as process.env.OPENAI_KEY / process.env.SERPAPI_KEY at runtime.

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
exports.processSearch = functions
  .runWith({ timeoutSeconds: 120, memory: '512MB', secrets: ['OPENAI_KEY', 'SERPAPI_KEY'] })
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(200).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const Busboy = require('busboy');
      const busboy = Busboy({ headers: req.headers });
      const fields  = {};
      const fileBuffers = {};

      busboy.on('field', (name, val) => { fields[name] = val; });
      busboy.on('file', (name, file) => {
        const chunks = [];
        file.on('data', d => chunks.push(d));
        file.on('end', () => { fileBuffers[name] = Buffer.concat(chunks); });
      });

      busboy.on('finish', async () => {
        try {
          const buf = fileBuffers['resume'] || fileBuffers['file'];
          if (!buf) return res.status(400).json({ error: 'No resume file received' });

          // Step 1 — extract text from PDF
          const parsed     = await pdfParse(buf);
          const resumeText = parsed.text.trim();

          // Step 2 — parse preferences
          const locations = JSON.parse(fields.locations || '[]');
          const roles     = JSON.parse(fields.roles     || '[]');
          const salaryMin = parseInt(fields.salaryMin   || '0',   10);
          const salaryMax = parseInt(fields.salaryMax   || '200', 10);

          // Step 3 — AI profile summary (keys come from Secret Manager via process.env)
          const profile = await summarizeProfile(
            resumeText, locations, roles, salaryMin, salaryMax
          );

          // Step 4 — parallel job scraping
          const [serpJobs, naukriJobs] = await Promise.all([
            process.env.SERPAPI_KEY
              ? searchSerpAPI(profile.searchKeywords, locations)
              : [],
            searchNaukri(profile.searchKeywords, locations, salaryMin, salaryMax)
          ]);

          // Step 5 — merge, rank, return
          const jobs = scoreAndRank(deduplicate([...serpJobs, ...naukriJobs]), profile);
          res.json({ jobs: jobs.slice(0, 10), profile });
        } catch (err) {
          console.error('processSearch error:', err);
          res.status(500).json({ error: err.message });
        }
      });

      busboy.end(req.rawBody);
    });
  });

/* ─────────────────────────────────────────────────────────────────────────────
   extractResume  (standalone / utility endpoint)
   POST  { pdf: "<base64>", mimeType: "application/pdf" }
   →     { text: "...", pages: 3 }
───────────────────────────────────────────────────────────────────────────── */
exports.extractResume = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method === 'OPTIONS') return res.status(200).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { pdf } = req.body;
    if (!pdf) return res.status(400).json({ error: 'Missing required field: pdf (base64 string)' });

    try {
      const buffer = Buffer.from(pdf, 'base64');
      const data   = await pdfParse(buffer);
      res.json({ text: data.text.trim(), pages: data.numpages });
    } catch (err) {
      res.status(500).json({ error: 'PDF parsing failed', detail: err.message });
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   searchJobs  (standalone endpoint — accepts pre-extracted resume text)
   POST  { resumeText, locations: [], roles: [], salaryMin, salaryMax }
   →     { jobs: [...], profile: {...} }
───────────────────────────────────────────────────────────────────────────── */
exports.searchJobs = functions
  .runWith({ timeoutSeconds: 120, memory: '512MB', secrets: ['OPENAI_KEY', 'SERPAPI_KEY'] })
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(200).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { resumeText, locations, roles, salaryMin, salaryMax } = req.body;
      if (!resumeText) return res.status(400).json({ error: 'Missing resumeText' });

      try {
        const profile = await summarizeProfile(
          resumeText, locations, roles, salaryMin, salaryMax
        );

        const [serpJobs, naukriJobs] = await Promise.all([
          process.env.SERPAPI_KEY
            ? searchSerpAPI(profile.searchKeywords, locations)
            : [],
          searchNaukri(profile.searchKeywords, locations, salaryMin, salaryMax)
        ]);

        const jobs = scoreAndRank(deduplicate([...serpJobs, ...naukriJobs]), profile);
        res.json({ jobs: jobs.slice(0, 10), profile });
      } catch (err) {
        console.error('searchJobs error:', err);
        res.status(500).json({ error: err.message });
      }
    });
  });

/* ─────────────────────────────────────────────────────────────────────────────
   Profile summarisation via OpenAI gpt-4o-mini
───────────────────────────────────────────────────────────────────────────── */
async function summarizeProfile(resumeText, locations, roles, salMin, salMax) {
  if (!process.env.OPENAI_KEY) {
    return {
      skills: [],
      yearsExperience: 0,
      seniority: 'mid',
      domain: (roles || []).join(' ') || 'general',
      searchKeywords: roles?.length ? roles : ['Software Engineer'],
      summary: 'Job seeker'
    };
  }

  const prompt =
    `Analyze this resume and return ONLY valid JSON — no markdown, no explanation.\n\n` +
    `Resume (first 4000 chars):\n${resumeText.substring(0, 4000)}\n\n` +
    `User preferences:\n` +
    `- Locations: ${(locations || []).join(', ') || 'any'}\n` +
    `- Desired roles: ${(roles || []).join(', ') || 'any'}\n` +
    `- Salary: ₹${salMin}L – ₹${salMax}L per annum\n\n` +
    `Return this JSON schema:\n` +
    `{ "skills": ["string"], "yearsExperience": 0, "seniority": "junior|mid|senior|lead", ` +
    `"domain": "string", "searchKeywords": ["3-5 job title variations"], "summary": "one sentence" }`;

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
    { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}`, 'Content-Type': 'application/json' } }
  );

  return JSON.parse(r.data.choices[0].message.content);
}

/* ─────────────────────────────────────────────────────────────────────────────
   SerpAPI — Google Jobs (covers LinkedIn, Glassdoor, Indeed, Naukri listings)
───────────────────────────────────────────────────────────────────────────── */
async function searchSerpAPI(keywords, locations) {
  const results = [];
  for (const q of buildQueries(keywords, locations, 4)) {
    try {
      const r = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine:   'google_jobs',
          q:        `${q.keyword} jobs`,
          location: `${q.location}, India`,
          chips:    'date_posted:week',
          api_key:  process.env.SERPAPI_KEY,
          hl:       'en',
          gl:       'in'
        },
        timeout: 15000
      });

      for (const j of (r.data.jobs_results || [])) {
        const link = j.apply_options?.[0]?.link || j.share_link || '#';
        results.push({
          title:   j.title,
          co:      j.company_name,
          loc:     j.location || q.location,
          sal:     j.detected_extensions?.salary || '',
          src:     detectSrc(link),
          date:    j.detected_extensions?.posted_at || 'Recent',
          excerpt: (j.description || '').substring(0, 220),
          url:     link,
          match:   null
        });
      }
    } catch (e) {
      console.error(`SerpAPI error [${q.keyword} @ ${q.location}]:`, e.message);
    }
  }
  return results;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Naukri — unofficial mobile/web API
───────────────────────────────────────────────────────────────────────────── */
async function searchNaukri(keywords, locations, salaryMin, salaryMax) {
  const results = [];
  for (const q of buildQueries(keywords, locations, 4)) {
    try {
      const params = {
        noOfResults: 10,
        urlType:    'search_by_key_loc',
        searchType: 'adv',
        keyword:    q.keyword,
        location:   q.location,
        page:       1,
        experience: 0
      };
      if (salaryMin) params.salary = `${salaryMin * 100000},${salaryMax * 100000}`;

      const r = await axios.get('https://www.naukri.com/jobapi/v3/search', {
        headers: {
          appid:          '109',
          systemid:       'jobsearch',
          'Content-Type': 'application/json',
          'User-Agent':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Referer:        'https://www.naukri.com/'
        },
        params,
        timeout: 12000
      });

      for (const j of (r.data.jobDetails || [])) {
        const locLabel = j.placeholders?.find(p => p.type === 'location')?.label;
        const salLabel = j.placeholders?.find(p => p.type === 'salary')?.label;
        results.push({
          title:   j.title || '',
          co:      j.companyName || '',
          loc:     locLabel || q.location,
          sal:     salLabel || '',
          src:     'kn',
          date:    j.footerPlaceholderLabel || 'Recent',
          excerpt: (j.jobDescription || '').replace(/<[^>]+>/g, '').substring(0, 220),
          url:     j.jdURL || '#',
          match:   null
        });
      }
    } catch (e) {
      console.error(`Naukri error [${q.keyword} @ ${q.location}]:`, e.message);
    }
  }
  return results;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */
function buildQueries(keywords, locations, max) {
  const kws  = (keywords || []).slice(0, 2);
  const locs = (locations || ['India']).slice(0, 2);
  const out  = [];
  for (const keyword of kws) {
    for (const location of locs) {
      if (out.length >= max) return out;
      out.push({ keyword, location });
    }
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
    const key = `${(j.title || '').toLowerCase().trim()}|${(j.co || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreAndRank(jobs, profile) {
  const profileText = [
    profile.domain,
    ...(profile.skills || []),
    profile.seniority,
    ...(profile.searchKeywords || [])
  ].join(' ').toLowerCase();

  const profileWords = profileText.split(/\s+/).filter(w => w.length > 3);

  return jobs
    .map(j => {
      const jobText = `${j.title} ${j.co} ${j.excerpt}`.toLowerCase();
      let score = 55;
      for (const word of profileWords) {
        if (jobText.includes(word)) score = Math.min(score + 5, 99);
      }
      return { ...j, match: score };
    })
    .sort((a, b) => b.match - a.match)
    .map((j, i) => ({ ...j, id: i + 1 }));
}
