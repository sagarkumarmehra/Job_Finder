const { onRequest } = require('firebase-functions/v2/https');
const admin    = require('firebase-admin');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const axios    = require('axios');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, UnderlineType, BorderStyle, Table, TableRow, TableCell, WidthType, ShadingType } = require('docx');

admin.initializeApp();

/* ─────────────────────────────────────────────────────────────────────────────
   extractTextFromBuffer  — handles PDF, DOCX, DOC by mimeType or content sniff
───────────────────────────────────────────────────────────────────────────── */
async function extractTextFromBuffer(buffer, mimeType) {
  const mime = (mimeType || '').toLowerCase();
  const isPdf  = mime.includes('pdf') || (buffer[0] === 0x25 && buffer[1] === 0x50); // %P
  const isDocx = mime.includes('wordprocessingml') || mime.includes('docx') ||
                 mime.includes('msword');

  if (isPdf) {
    const data = await pdfParse(buffer);
    return { text: data.text.trim(), pages: data.numpages, format: 'pdf' };
  }

  if (isDocx) {
    const result = await mammoth.extractRawText({ buffer });
    const warnings = result.messages.filter(m => m.type === 'warning');
    if (warnings.length) console.log('Mammoth warnings:', warnings.map(w => w.message));
    return { text: result.value.trim(), pages: null, format: 'docx' };
  }

  // Unknown type — try PDF first, then DOCX
  try {
    const data = await pdfParse(buffer);
    return { text: data.text.trim(), pages: data.numpages, format: 'pdf' };
  } catch (_) {}

  try {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value.trim(), pages: null, format: 'docx' };
  } catch (_) {}

  throw new Error(`Unsupported file type: ${mimeType}. Please upload a PDF or DOCX file.`);
}

const OPENAI_KEY = process.env.OPENAI_KEY || 'PASTE_YOUR_OPENAI_KEY_HERE';
const SERPAPI_KEY = '9ee0a0db5e8213e18682134924eb7c7711699c7e06f5ae485d154ffd011fd199';
const SECRETS  = [];
const RUN_OPTS = { timeoutSeconds: 120, memory: '512MiB', cors: true };

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

    const mimeType = fields.mimeType || '';
    const { text: resumeText } = await extractTextFromBuffer(fileBuffer, mimeType);

    const locations = JSON.parse(fields.locations || '[]');
    const roles     = JSON.parse(fields.roles     || '[]');
    const salaryMin = parseInt(fields.salaryMin   || '0',   10);
    const salaryMax = parseInt(fields.salaryMax   || '200', 10);

    const profile = await summarizeProfile(resumeText, locations, roles, salaryMin, salaryMax);

    // Strip job-type words (Full-Time, Remote, etc.) — these are not job titles
    const JOB_TYPE_WORDS = ['full-time', 'part-time', 'remote', 'contract', 'freelance',
      'internship', 'full time', 'part time', 'temporary', 'permanent', 'hybrid'];
    const validRoles = (roles || []).filter(r =>
      !JOB_TYPE_WORDS.includes(r.toLowerCase().trim()) && r.trim().length > 2
    );

    // Prepend valid user-specified roles as priority keywords
    if (validRoles.length) {
      profile.searchKeywords = [...validRoles, ...(profile.searchKeywords || [])].slice(0, 6);
    }
    profile.roles = roles || [];
    console.log('PROFILE:', JSON.stringify(profile));

    const [serpJobs, naukriJobs] = await Promise.all([
      SERPAPI_KEY ? searchSerpAPI(profile, locations) : [],
      searchNaukri(profile, locations, salaryMin, salaryMax)
    ]);
    console.log(`JOBS FOUND: serp=${serpJobs.length} naukri=${naukriJobs.length}`);
    if (serpJobs.length) console.log('SERP SAMPLE:', JSON.stringify(serpJobs.slice(0,2).map(j => ({title:j.title, co:j.co}))));
    if (naukriJobs.length) console.log('NAUKRI SAMPLE:', JSON.stringify(naukriJobs.slice(0,2).map(j => ({title:j.title, co:j.co}))));

    const jobs = scoreAndRank(deduplicate([...serpJobs, ...naukriJobs]), profile);
    console.log(`AFTER SCORING: ${jobs.length} relevant jobs`);
    res.json({ jobs: jobs.slice(0, 15), profile, resumeText: resumeText.substring(0, 6000) });
  } catch (err) {
    console.error('processSearch error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   extractResume  — accepts PDF or DOCX as base64
   Body: { file: "<base64>", mimeType: "application/pdf" | "...wordprocessingml..." }
   Also accepts legacy { pdf: "<base64>" } for backward compatibility
───────────────────────────────────────────────────────────────────────────── */
exports.extractResume = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const fileBase64 = req.body.file || req.body.pdf;
  const mimeType   = req.body.mimeType || (req.body.pdf ? 'application/pdf' : '');

  if (!fileBase64) return res.status(400).json({ error: 'Missing file field (base64)' });

  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    const { text, pages, format } = await extractTextFromBuffer(buffer, mimeType);
    if (!text) return res.status(422).json({ error: 'Could not extract any text from the file. Is it a scanned image?' });
    res.json({ text, pages, format });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   analyzeResume  — multipart upload → profile JSON only (no job search)
   POST  multipart/form-data:
         resume    (File — PDF or DOCX)
         locations (JSON string array)
         roles     (JSON string array)
         salaryMin (number string)
         salaryMax (number string)
   →     profile JSON
───────────────────────────────────────────────────────────────────────────── */
exports.analyzeResume = onRequest(RUN_OPTS, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { fields, fileBuffer, mimeType } = await parseMultipart(req);
    if (!fileBuffer) return res.status(400).json({ error: 'No resume file received' });

    const fileMime = mimeType || fields.mimeType || '';
    const { text: resumeText } = await extractTextFromBuffer(fileBuffer, fileMime);

    const locations = JSON.parse(fields.locations || '[]');
    const roles     = JSON.parse(fields.roles     || '[]');
    const salaryMin = parseInt(fields.salaryMin   || '0',   10);
    const salaryMax = parseInt(fields.salaryMax   || '200', 10);

    const profile = await summarizeProfile(resumeText, locations, roles, salaryMin, salaryMax);
    console.log('ANALYZE PROFILE:', JSON.stringify(profile));
    res.json(profile);
  } catch (err) {
    console.error('analyzeResume error:', err);
    res.status(500).json({ error: err.message });
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
      SERPAPI_KEY ? searchSerpAPI(profile, locations) : [],
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

    let fileMimeType = '';
    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('file', (_name, file, info) => {
      fileMimeType = info?.mimeType || info?.mime || '';
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    busboy.on('finish', () => resolve({ fields, fileBuffer, mimeType: fileMimeType }));
    busboy.on('error', reject);
    busboy.end(req.rawBody);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   OpenAI profile summarisation
───────────────────────────────────────────────────────────────────────────── */
async function summarizeProfile(resumeText, locations, roles, salMin, salMax) {
  if (!OPENAI_KEY) {
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
    `You are a career analyst. Read this resume carefully and extract a precise job-search profile.\n\n` +
    `=== RESUME ===\n${resumeText.substring(0, 5000)}\n=== END RESUME ===\n\n` +
    `=== CANDIDATE PREFERENCES ===\n` +
    `Desired roles: ${userRoles}\nLocations: ${userLocs}\nSalary: ₹${salMin}L–₹${salMax}L\n\n` +
    `Return ONLY valid JSON (no markdown, no explanation):\n\n` +
    `{\n` +
    `  "currentTitle": "their most recent job title exactly as written on the resume",\n` +
    `  "skills": ["up to 10 specific tools, platforms, methodologies found in the resume — must be real items from the resume text"],\n` +
    `  "yearsExperience": <total years as integer, calculated from work history dates>,\n` +
    `  "seniority": "fresher|junior|mid|senior|lead|principal",\n` +
    `  "domain": "the candidate's PRIMARY domain based on their job titles and industry — e.g. 'commercial excellence', 'business strategy', 'pharma operations', 'product management', 'software engineering', 'data science'. DERIVE THIS FROM THEIR TITLES, not from skills.",\n` +
    `  "industries": ["industries worked in, e.g. pharma, fintech, ecommerce, saas"],\n` +
    `  "searchKeywords": [\n` +
    `    "Generate exactly 5 job title strings the candidate should search for. Rules:",\n` +
    `    "1. SENIORITY FIRST: If their currentTitle has Director/VP/Head/GM/MD — every search keyword must also start with Director/VP/Head/Senior Director/GM. Never generate Manager, Executive, Analyst, Associate or lower titles for a Director-level candidate.",\n` +
    `    "2. DOMAIN MATCH: Titles must reflect their actual domain from currentTitle — not from skills.",\n` +
    `    "3. PREFERRED ROLES: If desired roles are specified, include those verbatim plus seniority-matched variations.",\n` +
    `    "4. Example for a Director of Commercial Excellence in pharma: ['Director Commercial Excellence', 'Head of Business Excellence', 'VP Commercial Operations', 'Senior Director Business Strategy', 'Director Go-To-Market Strategy']",\n` +
    `    "5. Example for a Software Engineering Manager: ['Engineering Manager', 'Senior Engineering Manager', 'Director of Engineering', 'Head of Software Engineering', 'VP Engineering']",\n` +
    `    "Return as a flat array of exactly 5 strings."\n` +
    `  ],\n` +
    `  "seniorityKeywords": ["2-3 seniority-level words matching their level, e.g. Director, VP, Senior, Head"],\n` +
    `  "avoidKeywords": ["words indicating wrong seniority — only if yearsExperience > 3: junior, fresher, intern, trainee, entry-level"],\n` +
    `  "summary": "one sentence: their current role, years of experience, domain, and top 2-3 skills"\n` +
    `}\n\n` +
    `ABSOLUTE RULES:\n` +
    `- searchKeywords MUST match the person's actual domain from their titles — never infer domain from skills alone\n` +
    `- If currentTitle has 'Director', 'VP', 'Head', 'Manager', 'Lead' — searchKeywords must reflect that seniority\n` +
    `- searchKeywords must be what Indian companies actually post on job boards for this profile\n` +
    `- Return a flat JSON array for searchKeywords, not nested explanations`;

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
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
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
  const industry = (profile.industries || [])[0] || '';

  for (const q of buildQueries(keywords, locations, 4)) {
    try {
      const queryStr = industry ? `${q.keyword} ${industry}` : q.keyword;
      const r = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_jobs',
          q: queryStr,
          location: `${q.location}, India`,
          api_key: SERPAPI_KEY,
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
        experience: naukriExp
      };

      const r = await axios.get('https://www.naukri.com/jobapi/v3/search', {
        headers: {
          'appid': '109',
          'systemid': 'jobsearch',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.naukri.com/',
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
  const kws  = (keywords  || []).slice(0, 3);
  const locs = (locations && locations.length ? locations : ['India']).slice(0, 2);
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
    'managing director', 'president'];

  // Detect if candidate is Director/VP/Head level based on title or seniority
  const currentTitle = (profile.currentTitle || '').toLowerCase();
  const isDirectorLevel = ['director', 'vp', 'vice president', 'head of', 'gm ', 'general manager',
    'managing director', 'chief', 'president', 'principal'].some(w => currentTitle.includes(w)) ||
    expYears >= 12;

  // Roles that are too junior for a Director-level candidate
  const tooJuniorForDirector = ['executive', 'analyst', 'associate', 'coordinator', 'specialist',
    'officer', 'assistant', 'junior', 'trainee', 'intern', 'fresher', 'entry level'];

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

    // ── Director-level: soft boost for senior titles, soft penalty for intern/fresher only ──
    if (isDirectorLevel) {
      const directorBoostWords = ['director', 'vp', 'vice president', 'head of',
        'general manager', 'chief', 'senior director', 'principal', 'global'];
      for (const w of directorBoostWords) {
        if (titleLower.includes(w)) { score += 12; break; }
      }
      // Only hard-penalise clear intern/entry-level roles, not executive/manager
      const clearlyJunior = ['intern', 'internship', 'trainee', 'fresher', 'entry level', 'entry-level', 'graduate trainee'];
      for (const w of clearlyJunior) {
        if (titleLower.includes(w)) { score -= 30; break; }
      }
    }

    // ── Hard penalty if zero skill AND zero title match ──────────────────────
    if (!titleMatched && skillMatches === 0) score -= 25;

    return { ...j, match: Math.min(Math.max(score, 5), 99) };
  });

  // Hard filter: discard anything below 35
  const relevant = scored.filter(j => j.match >= 35);

  // Relax to 25 if fewer than 5 results — but never show 5% junk
  const results = relevant.length >= 5 ? relevant : scored.filter(j => j.match >= 25);

  return results
    .sort((a, b) => b.match - a.match)
    .map((j, i) => ({ ...j, id: i + 1 }));
}

/* ─────────────────────────────────────────────────────────────────────────────
   generateDocx  — converts structured resume JSON → .docx buffer (base64)
   POST { resumeData: { name, contact, summary, experience, skills, education },
          jobTitle, company }
   →   { docxBase64, fileName }
───────────────────────────────────────────────────────────────────────────── */
exports.generateDocx = onRequest({ cors: true, timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { resumeData, jobTitle, company } = req.body;
  if (!resumeData) return res.status(400).json({ error: 'Missing resumeData' });

  try {
    const r = resumeData;

    // Twips helpers: 1 inch = 1440 twips, 1 cm = 567 twips
    const MARGIN = 1008; // ~1.78 cm — standard resume margin

    const hr = () => new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' } },
      spacing: { before: 160, after: 120 }
    });

    const sectionHeading = (text) => new Paragraph({
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 24, color: '1A1A2E', characterSpacing: 40 })],
      spacing: { before: 280, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1A1A2E' } }
    });

    const bullet = (text) => new Paragraph({
      children: [new TextRun({ text, size: 22, font: 'Calibri' })],
      bullet: { level: 0 },
      spacing: { after: 80 },
      indent: { left: 360 }
    });

    const children = [];

    // ── Name ──────────────────────────────────────────────────────────
    children.push(new Paragraph({
      children: [new TextRun({ text: r.name || 'Candidate', bold: true, size: 52, font: 'Calibri', color: '111111' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 }
    }));

    // ── Contact ───────────────────────────────────────────────────────
    if (r.contact) {
      children.push(new Paragraph({
        children: [new TextRun({ text: r.contact, size: 20, font: 'Calibri', color: '555560' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 }
      }));
    }

    // ── Tailored-for banner ───────────────────────────────────────────
    children.push(new Paragraph({
      children: [new TextRun({ text: `✦  Tailored for: ${jobTitle} at ${company}  ✦`, italics: true, size: 18, font: 'Calibri', color: '4060FF' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 }
    }));

    // ── Summary ───────────────────────────────────────────────────────
    if (r.summary) {
      children.push(sectionHeading('Professional Summary'));
      children.push(new Paragraph({
        children: [new TextRun({ text: r.summary, size: 22, font: 'Calibri', color: '222222' })],
        spacing: { before: 100, after: 80 },
        alignment: AlignmentType.JUSTIFIED
      }));
    }

    // ── Experience ────────────────────────────────────────────────────
    if (r.experience?.length) {
      children.push(sectionHeading('Professional Experience'));
      for (const exp of r.experience) {
        // Role title + company on one line, dates right-aligned
        children.push(new Paragraph({
          children: [
            new TextRun({ text: exp.title || '', bold: true, size: 24, font: 'Calibri', color: '111111' }),
            new TextRun({ text: exp.company ? `  —  ${exp.company}` : '', size: 22, font: 'Calibri', color: '444444' })
          ],
          spacing: { before: 180, after: 20 }
        }));
        if (exp.dates) {
          children.push(new Paragraph({
            children: [new TextRun({ text: exp.dates, size: 20, font: 'Calibri', color: '888888', italics: true })],
            spacing: { after: 80 }
          }));
        }
        for (const b of (exp.bullets || [])) {
          children.push(bullet(b));
        }
      }
    }

    // ── Skills ────────────────────────────────────────────────────────
    if (r.skills?.length) {
      children.push(sectionHeading('Key Skills'));
      // Group skills into rows of 4 for a clean grid look
      const rows = [];
      for (let i = 0; i < r.skills.length; i += 4) {
        rows.push(r.skills.slice(i, i + 4));
      }
      for (const row of rows) {
        children.push(new Paragraph({
          children: [new TextRun({ text: row.join('    •    '), size: 22, font: 'Calibri', color: '222222' })],
          spacing: { before: 60, after: 60 },
          indent: { left: 200 }
        }));
      }
    }

    // ── Education ─────────────────────────────────────────────────────
    if (r.education?.length) {
      children.push(sectionHeading('Education'));
      for (const edu of r.education) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: edu.degree || '', bold: true, size: 22, font: 'Calibri', color: '111111' }),
            new TextRun({ text: edu.institution ? `  —  ${edu.institution}` : '', size: 22, font: 'Calibri', color: '444444' }),
            new TextRun({ text: edu.year ? `  (${edu.year})` : '', size: 20, font: 'Calibri', color: '888888', italics: true })
          ],
          spacing: { before: 120, after: 80 }
        }));
      }
    }

    // ── Certifications / Achievements (if present) ───────────────────
    if (r.certifications?.length) {
      children.push(sectionHeading('Certifications'));
      for (const c of r.certifications) {
        children.push(new Paragraph({
          children: [new TextRun({ text: typeof c === 'string' ? c : `${c.name || ''}${c.issuer ? ' — ' + c.issuer : ''}${c.year ? ' (' + c.year + ')' : ''}`, size: 22, font: 'Calibri' })],
          bullet: { level: 0 },
          spacing: { after: 60 },
          indent: { left: 360 }
        }));
      }
    }

    const doc = new Document({
      creator: 'Launchpad Job Finder',
      title: `${r.name || 'Resume'} — ${jobTitle} at ${company}`,
      styles: {
        default: {
          document: {
            run: { font: 'Calibri', size: 22, color: '222222' }
          }
        }
      },
      sections: [{
        properties: {
          page: {
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN }
          }
        },
        children
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    const docxBase64 = buffer.toString('base64');
    const safeCompany  = (company  || 'Company') .replace(/[^a-zA-Z0-9]/g, '_');
    const safeTitle    = (jobTitle || 'Role')     .replace(/[^a-zA-Z0-9]/g, '_');
    const safeName     = (r.name   || 'Resume')   .replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `${safeName}_${safeCompany}_${safeTitle}.docx`;

    res.json({ docxBase64, fileName });
  } catch (err) {
    console.error('generateDocx error:', err);
    res.status(500).json({ error: err.message });
  }
});
