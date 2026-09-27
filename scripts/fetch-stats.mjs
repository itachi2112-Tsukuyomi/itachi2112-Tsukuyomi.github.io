// Fetches LeetCode / GeeksforGeeks / HackerRank stats server-side (no CORS)
// and writes them to data/stats.json. Run by .github/workflows/update-stats.yml.
// A platform that fails keeps its previous values, so the page never goes blank.

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const PROFILES = new URL('data/profiles.json', ROOT);
const STATS = new URL('data/stats.json', ROOT);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

// ---------- LeetCode ----------
const leetcodeSources = [
  async (u) => {
    const query = `query($u:String!){
      matchedUser(username:$u){ profile{ ranking } submitStatsGlobal{ acSubmissionNum{ difficulty count } } }
      userContestRanking(username:$u){ rating attendedContestsCount topPercentage }
    }`;
    const j = await getJSON('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: `https://leetcode.com/u/${u}/` },
      body: JSON.stringify({ query, variables: { u } }),
    });
    const m = j?.data?.matchedUser;
    if (!m) throw new Error('user not found');
    const by = Object.fromEntries(m.submitStatsGlobal.acSubmissionNum.map((x) => [x.difficulty, x.count]));
    const c = j.data.userContestRanking;
    return {
      solved: by.All, easy: by.Easy, medium: by.Medium, hard: by.Hard,
      ranking: num(m.profile?.ranking),
      contestRating: c ? Math.round(c.rating) : null,
      contests: c ? c.attendedContestsCount : null,
      topPercentage: c ? num(c.topPercentage) : null,
      source: 'leetcode.com/graphql',
    };
  },
  async (u) => {
    const j = await getJSON(`https://leetcode-api-faisalshohag.vercel.app/${u}`);
    if (typeof j.totalSolved !== 'number') throw new Error('bad payload');
    return {
      solved: j.totalSolved, easy: j.easySolved, medium: j.mediumSolved, hard: j.hardSolved,
      ranking: num(j.ranking), source: 'leetcode-api-faisalshohag.vercel.app',
    };
  },
];

// ---------- GeeksforGeeks ----------
const gfgSources = [
  async (u) => {
    const j = await getJSON(
      `https://authapi.geeksforgeeks.org/api-get/user-profile-info/?handle=${encodeURIComponent(u)}&article_count=false&redirect=true`
    );
    const d = j?.data;
    if (!d || d.total_problems_solved === undefined) throw new Error('bad payload');
    const out = {
      solved: num(d.total_problems_solved),
      codingScore: num(d.score),
      instituteRank: num(d.institute_rank),
      streak: num(d.pod_solved_longest_streak),
      source: 'authapi.geeksforgeeks.org',
    };
    // Difficulty split lives on a separate endpoint; best-effort.
    try {
      const p = await getJSON('https://practiceapi.geeksforgeeks.org/api/v1/user/problems/submissions/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: u, requestType: '', year: '', month: '' }),
      });
      const r = p?.result || {};
      const cnt = (k) => (r[k] ? Object.keys(r[k]).length : 0);
      Object.assign(out, { school: cnt('School'), basic: cnt('Basic'), easy: cnt('Easy'), medium: cnt('Medium'), hard: cnt('Hard') });
    } catch { /* keep totals only */ }
    return out;
  },
  async (u) => {
    const j = await getJSON(`https://geeks-for-geeks-api.vercel.app/${encodeURIComponent(u)}`);
    const i = j?.info;
    if (!i) throw new Error(j?.error || 'bad payload');
    const s = j.solvedStats || {};
    return {
      solved: num(i.totalProblemsSolved), codingScore: num(i.codingScore),
      instituteRank: num(i.instituteRank), streak: num(i.maxStreak ?? i.currentStreak),
      school: s.school?.count ?? null, basic: s.basic?.count ?? null,
      easy: s.easy?.count ?? null, medium: s.medium?.count ?? null, hard: s.hard?.count ?? null,
      source: 'geeks-for-geeks-api.vercel.app',
    };
  },
];

// ---------- HackerRank ----------
const hackerrankSources = [
  async (u) => {
    const j = await getJSON(`https://www.hackerrank.com/rest/hackers/${encodeURIComponent(u)}/badges`);
    if (!Array.isArray(j?.models)) throw new Error('bad payload');
    const badges = j.models
      .filter((b) => b.stars > 0 || b.solved > 0)
      .map((b) => ({ name: b.badge_name, stars: b.stars || 0, solved: b.solved || 0 }))
      .sort((a, b) => b.stars - a.stars || b.solved - a.solved);
    return {
      solved: badges.reduce((s, b) => s + b.solved, 0),
      badgeCount: badges.filter((b) => b.stars > 0).length,
      stars: badges.reduce((s, b) => s + b.stars, 0),
      badges,
      source: 'hackerrank.com/rest',
    };
  },
];

async function firstOk(name, sources, handle) {
  for (const src of sources) {
    try {
      const data = await src(handle);
      console.log(`[ OK ] ${name} ← ${data.source}`);
      return data;
    } catch (e) {
      console.log(`[FAIL] ${name}: ${e.message}`);
    }
  }
  return null;
}

const profiles = JSON.parse(await readFile(PROFILES, 'utf8'));
let prev = { updatedAt: null, platforms: {} };
try { prev = JSON.parse(await readFile(STATS, 'utf8')); } catch { /* first run */ }

const now = new Date().toISOString();
const plan = { leetcode: leetcodeSources, gfg: gfgSources, hackerrank: hackerrankSources };
const platforms = { ...(prev.platforms || {}) };
let changed = false;

for (const [key, sources] of Object.entries(plan)) {
  const handle = profiles[key];
  if (!handle) continue;
  const data = await firstOk(key, sources, handle);
  if (!data) continue;
  const next = { handle, ...data };
  const { fetchedAt: _, ...old } = platforms[key] || {};
  // Only touch the file when the numbers move, so the repo isn't committed to daily for nothing.
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    platforms[key] = { ...next, fetchedAt: now };
    changed = true;
  }
}

if (changed) {
  await writeFile(STATS, JSON.stringify({ updatedAt: now, platforms }, null, 2) + '\n');
  console.log('wrote data/stats.json');
} else {
  console.log('nothing new; data/stats.json left unchanged');
}
