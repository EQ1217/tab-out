/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   WEEKLY FREQUENT PAGES — Constants & Classification
   ---------------------------------------------------------------- */

const WEEKLY_HISTORY_DAYS = 7;
const WEEKLY_CACHE_TTL_MS = 15 * 60 * 1000;
const WEEKLY_MAX_RESULTS = 300;
const WEEKLY_MIN_VISITS = 3;
const WEEKLY_MAX_PAGES = 50;

const WEEKLY_CATEGORY_RULES = [
  { id: 'jobs', label: '招聘相关', keywords: ['招聘', '岗位', '职位', '面试', '简历', '内推', '猎聘', '拉勾', 'boss直聘', 'jobs', 'career', 'hiring', 'recruit', 'careers', 'job', '求职'], hostKeywords: ['zhipin.com', 'lagou.com', 'linkedin.com/jobs'] },
  { id: 'ai', label: 'AI / LLM', keywords: ['ai', 'llm', 'gpt', 'claude', 'gemini', 'prompt', 'agent', '模型', '大模型', '人工智能', 'openai', 'anthropic', 'copilot'], hostKeywords: [] },
  { id: 'dev', label: '开发相关', keywords: ['github', 'pull request', 'issue', 'docs', 'api', 'javascript', 'typescript', 'python', 'react', 'chrome extension', '开发', '代码', '接口', 'debug', 'commit', 'branch', 'npm', 'yarn', 'docker', 'deploy'], hostKeywords: ['github.com', 'stackoverflow.com', 'npmjs.com', 'developer.mozilla.org'] },
  { id: 'docs', label: '文档 / 学习', keywords: ['docs', 'documentation', 'guide', 'tutorial', 'learn', 'course', '文档', '教程', '学习', 'wiki', 'handbook', 'reference'], hostKeywords: ['wikipedia.org'] },
  { id: 'design', label: '设计相关', keywords: ['figma', 'design', 'ui', 'ux', 'prototype', '设计', '原型', 'sketch', 'wireframe'], hostKeywords: ['figma.com'] },
  { id: 'shopping', label: '购物消费', keywords: ['cart', 'order', 'checkout', 'amazon', 'taobao', 'jd', 'tmall', '购物', '订单', '商品', '支付', 'purchase'], hostKeywords: ['amazon.com', 'taobao.com'] },
  { id: 'media', label: '视频 / 娱乐', keywords: ['youtube', 'bilibili', 'netflix', 'video', 'music', 'podcast', '视频', '音乐', '播客', 'watch', 'streaming', 'anime'], hostKeywords: ['youtube.com', 'bilibili.com', 'netflix.com', 'spotify.com'] },
  { id: 'social', label: '社交动态', keywords: ['twitter', 'x.com', 'reddit', 'linkedin', 'post', 'feed', '社交', '动态', 'thread', 'comment'], hostKeywords: ['x.com', 'reddit.com', 'linkedin.com'] },
  { id: 'news', label: '新闻阅读', keywords: ['news', 'newsletter', 'substack', 'hacker news', '新闻', '资讯', '报道', '头条', 'breaking'], hostKeywords: ['news.ycombinator.com', 'substack.com'] },
];

const WEEKLY_EN_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'home', 'login', 'search', 'official', 'page', 'app', 'www', 'this', 'that', 'what', 'how', 'why', 'not', 'are', 'was', 'has', 'had', 'but', 'can', 'all', 'you', 'your', 'our', 'its', 'his', 'her']);
const WEEKLY_CJK_STOP = new Set(['首页', '登录', '搜索', '个人', '中心', '官方', '网站', '最新', '全部', '我的', '设置', '更多', '关于', '帮助']);

const WEEKLY_STORAGE_KEYS = { cache: 'weeklyFrequentPages', prefs: 'weeklyPagePrefs' };

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getWeeklyHistoryRange() {
  const endTime = Date.now();
  return { startTime: endTime - WEEKLY_HISTORY_DAYS * 24 * 60 * 60 * 1000, endTime };
}

function isHistoryUrlAllowed(url) {
  if (!url) return false;
  return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') && !url.startsWith('edge://') && !url.startsWith('brave://') &&
    !url.startsWith('file://');
}

function normalizeHistoryUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'];
    for (const param of trackingParams) u.searchParams.delete(param);
    let result = u.href;
    result = result.replace(/\/$/, '');

    // 对特定网站进行更激进的归一化（避免重复）
    result = normalizeUrlForSite(result);

    return result;
  } catch {
    return url;
  }
}

function normalizeUrlForSite(url) {
  try {
    const u = new URL(url);

    // 飞书系列：只保留应用主路径
    if (u.hostname.includes('feishu.cn') || u.hostname.includes('larksuite.com') || u.hostname.includes('larkoffice.com')) {
      // 飞书表格：https://bitable.feishu.cn/app/xxxxx/block/xxxxx -> https://bitable.feishu.cn/app/xxxxx
      if (u.hostname.includes('bitable') || u.hostname.includes('table') || u.pathname.includes('/sheets/')) {
        // 移除 sheet 参数（不同 sheets 的区别）
        u.searchParams.delete('sheet');

        if (u.pathname.includes('/app/')) {
          const bitableMatch = u.pathname.match(/^\/app\/([A-Za-z0-9_-]+)/);
          if (bitableMatch) {
            return `${u.protocol}//${u.hostname}/app/${bitableMatch[1]}`;
          }
          return url; // 已经归一化到 app 层
        }

        // 飞书在线表格：https://bytedance.larkoffice.com/sheets/xxxxx?sheet=yyy -> https://bytedance.larkoffice.com/sheets/xxxxx
        const sheetsMatch = u.pathname.match(/^\/sheets\/([A-Za-z0-9_-]+)/);
        if (sheetsMatch) {
          return `${u.protocol}//${u.hostname}/sheets/${sheetsMatch[1]}`;
        }

        return url;
      }

      // 飞书文档：https://xxx.feishu.cn/docx/yyyyy -> https://xxx.feishu.cn/docx/yyyyy
      // 飞书文档的多页面：?blockId=zzzz -> 去除 blockId
      if (u.pathname.includes('/docx/') || u.pathname.includes('/docs/')) {
        u.searchParams.delete('blockId');
        u.searchParams.delete('pageId');
        return u.href;
      }

      return url;
    }

    // 火山方舟：console.volcengine.com/ark/... 只保留 ark 层
    if (u.hostname.includes('volcengine.com') && u.pathname.includes('/ark/')) {
      const arkMatch = u.pathname.match(/^\/ark\/([^/]+)/);
      if (arkMatch) {
        return `${u.protocol}//${u.hostname}/ark/${arkMatch[1]}`;
      }
    }

    // GitHub：https://github.com/owner/repo/issues/123 -> https://github.com/owner/repo/issues
    // https://github.com/owner/repo/blob/xxx -> https://github.com/owner/repo
    if (u.hostname.includes('github.com')) {
      const githubMatch = u.pathname.match(/^\/([^/]+\/[^/]+)/);
      if (githubMatch) {
        return `${u.protocol}//${u.hostname}/${githubMatch[1]}`;
      }
    }

    return url;
  } catch {
    return url;
  }
}

function fetchWeeklyHistoryPages() {
  return new Promise((resolve) => {
    const { startTime, endTime } = getWeeklyHistoryRange();
    chrome.history.search({ text: '', startTime, endTime, maxResults: WEEKLY_MAX_RESULTS }, (items) => {
      if (chrome.runtime.lastError) {
        console.warn('[tab-out] History search failed:', chrome.runtime.lastError);
        resolve([]);
        return;
      }

      const allowedItems = items.filter(item => isHistoryUrlAllowed(item.url));

      if (allowedItems.length === 0) {
        resolve([]);
        return;
      }

      countWeeklyVisitsForItems(allowedItems).then(visitsMap => {
        const pages = allowedItems.map(item => {
          const normalized = normalizeHistoryUrl(item.url);
          const urlObj = new URL(item.url);
          return {
            url: item.url,
            normalizedUrl: normalized,
            title: item.title || '',
            cleanTitle: cleanTitle(item.title || ''),
            hostname: urlObj.hostname,
            pathname: urlObj.pathname,
            lastVisitTime: item.lastVisitTime,
            visitCount: item.visitCount || 0,
            weeklyVisits: visitsMap.get(normalized) || 0,
          };
        }).filter(p => p.weeklyVisits >= WEEKLY_MIN_VISITS);

        // 调试输出：7天内所有网页的访问统计
        console.log('=== 7天历史记录访问统计（按访问次数排序）===');
        const allPagesStats = allowedItems.map(item => {
          const normalized = normalizeHistoryUrl(item.url);
          const urlObj = new URL(item.url);
          return {
            normalizedUrl: normalized,
            title: item.title || '',
            cleanTitle: cleanTitle(item.title || ''),
            hostname: urlObj.hostname,
            weeklyVisits: visitsMap.get(normalized) || 0,
          };
        });
        // 按访问次数去重并排序
        const statsByNormalized = new Map();
        for (const p of allPagesStats) {
          const existing = statsByNormalized.get(p.normalizedUrl);
          if (!existing || p.weeklyVisits > existing.weeklyVisits) {
            statsByNormalized.set(p.normalizedUrl, p);
          }
        }
        const sortedStats = Array.from(statsByNormalized.values())
          .sort((a, b) => b.weeklyVisits - a.weeklyVisits);
        sortedStats.forEach((s, i) => {
          console.log(`${i + 1}. [${s.weeklyVisits}次] ${s.cleanTitle || s.title}`);
          console.log(`   URL: ${s.normalizedUrl}`);
          console.log(`   Host: ${s.hostname}`);
        });
        console.log('=== 过滤阈值：≥', WEEKLY_MIN_VISITS, '次 ===');
        console.log('=== 过滤后剩余:', pages.length, '个页面 ===');

        resolve(pages);
      });
    });
  });
}

function countWeeklyVisitsForItems(items) {
  return new Promise((resolve) => {
    const uniqueUrls = [...new Set(items.map(i => normalizeHistoryUrl(i.url)))];
    const visitsMap = new Map();
    const activationMap = new Map();
    const loadVisitsMap = new Map();
    let pending = uniqueUrls.length;

    console.log('[tab-out] countWeeklyVisitsForItems - uniqueUrls:', uniqueUrls.length);

    if (uniqueUrls.length === 0) {
      resolve(visitsMap);
      return;
    }

    const { startTime, endTime } = getWeeklyHistoryRange();

    // 只统计用户主动打开的 transition 类型（页面加载次数）
    const ACTIVE_TRANSITIONS = new Set([
      'link',       // 点击链接
      'typed',      // 直接输入网址
      'generated',  // 生成（如地址栏补全）
      'auto_bookmark', // 点击书签
      'auto_subframe',  // 子框架（如 iframe）
      'manual_subframe', // 手动子框架
      'start_page',     // 启动页
      'form_submit',    // 表单提交
    ]);

    // 第一步：从 storage 获取 tab 激活次数
    chrome.storage.local.get(null, (data) => {
      if (chrome.runtime.lastError) {
        console.warn('[tab-out] Failed to read storage:', chrome.runtime.lastError);
      } else {
        console.log('[tab-out] storage keys count:', Object.keys(data || {}).length);
        console.log('[tab-out] activation keys count:', Object.keys(data || {}).filter(k => k.startsWith('activations:')).length);

        for (const url of uniqueUrls) {
          const key = `activations:${url}`;
          activationMap.set(url, data[key] || 0);
        }
      }

      // 第二步：从 chrome.history 获取页面加载次数
      for (const url of uniqueUrls) {
        chrome.history.getVisits({ url }, (visits) => {
          const inRangeVisits = (visits || []).filter(v =>
            v.visitTime >= startTime && v.visitTime <= endTime &&
            ACTIVE_TRANSITIONS.has(v.transition)
          ).length;
          loadVisitsMap.set(url, inRangeVisits);

          pending--;
          if (pending === 0) {
            // 合并：加载次数 + 激活次数
            for (const url of uniqueUrls) {
              const loads = loadVisitsMap.get(url) || 0;
              const activations = activationMap.get(url) || 0;
              const total = loads + activations;
              visitsMap.set(url, total);

              console.log(`[tab-out] ${url.slice(0, 50)}: loads=${loads}, activations=${activations}, total=${total}`);
            }

            console.log('[tab-out] Final visitsMap sample:', Array.from(visitsMap.entries()).slice(0, 5));
            resolve(visitsMap);
          }
        });
      }
    });
  });
}

function tokenizeWeeklyText(text) {
  if (!text) return [];

  const tokens = [];

  // 检测是否有中文字符
  const hasCJK = /[一-鿿]/.test(text);
  const lowerText = text.toLowerCase();

  if (hasCJK) {
    // 中文 n-gram 提取（2-4 字）
    for (let i = 0; i < lowerText.length; i++) {
      for (let n = 2; n <= 4 && i + n <= lowerText.length; n++) {
        const gram = lowerText.substring(i, i + n);
        if (!WEEKLY_CJK_STOP.has(gram) && gram.trim().length > 0) {
          tokens.push(gram);
        }
      }
    }

    // 单字（排除停用）
    for (let i = 0; i < lowerText.length; i++) {
      const char = lowerText[i];
      if (!WEEKLY_CJK_STOP.has(char) && /[一-鿿]/.test(char)) {
        tokens.push(char);
      }
    }
  }

  // 英文分词
  const words = lowerText.split(/[\s\-_]+/).filter(w => w.length > 1 && !WEEKLY_EN_STOP.has(w));
  tokens.push(...words);

  return tokens;
}

function extractWeeklyKeywords(page, scoreThreshold = 1) {
  const textSources = [page.title || '', page.hostname || ''];
  const allTokens = [];
  const tokenCounts = new Map();

  for (const text of textSources) {
    const tokens = tokenizeWeeklyText(text);
    allTokens.push(...tokens);
  }

  for (const token of allTokens) {
    tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }

  return [...tokenCounts.entries()]
    .filter(([token, count]) => count >= scoreThreshold)
    .sort((a, b) => b[1] - a[1])
    .map(([token, count]) => ({ token, count }));
}

function scoreWeeklyCategoryRule(rule, page) {
  let score = 0;
  const lowerTitle = (page.title || '').toLowerCase();
  const lowerHostname = (page.hostname || '').toLowerCase();
  const lowerPath = (page.pathname || '').toLowerCase();

  for (const kw of rule.keywords) {
    const kwLower = kw.toLowerCase();
    if (lowerTitle.includes(kwLower)) score += 3;
    if (lowerPath.includes(kwLower)) score += 2;
  }

  for (const hostKw of rule.hostKeywords) {
    if (lowerHostname.includes(hostKw.toLowerCase())) score += 4;
  }

  return score;
}

function classifyWeeklyPage(page) {
  let bestMatch = null;
  let bestScore = 0;

  for (const rule of WEEKLY_CATEGORY_RULES) {
    const score = scoreWeeklyCategoryRule(rule, page);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { categoryId: `rule:${rule.id}`, label: rule.label, score };
    }
  }

  return bestMatch;
}

function generateWeeklyGroupLabel(keyword) {
  const kw = keyword.toLowerCase();

  if (kw.includes('招聘') || kw.includes('job') || kw.includes('career')) return '招聘相关';
  if (kw.includes('ai') || kw.includes('llm') || kw.includes('gpt') || kw.includes('模型')) return 'AI / LLM';
  if (kw.includes('开发') || kw.includes('代码') || kw.includes('dev')) return '开发相关';
  if (kw.includes('文档') || kw.includes('docs') || kw.includes('教程')) return '文档 / 学习';
  if (kw.includes('设计') || kw.includes('ui') || kw.includes('ux')) return '设计相关';
  if (kw.includes('购物') || kw.includes('订单') || kw.includes('商品')) return '购物消费';
  if (kw.includes('视频') || kw.includes('bilibili') || kw.includes('youtube')) return '视频 / 娱乐';
  if (kw.includes('社交') || kw.includes('动态') || kw.includes('feed')) return '社交动态';
  if (kw.includes('新闻') || kw.includes('news') || kw.includes('资讯')) return '新闻阅读';

  return `${keyword} 相关`;
}

// 字符串相似度计算（Jaccard 相似度：交集/并集）
function textSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const tokens1 = new Set(str1.toLowerCase().split(/[\s\-_]+/).filter(t => t.length > 0));
  const tokens2 = new Set(str2.toLowerCase().split(/[\s\-_]+/).filter(t => t.length > 0));

  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = new Set([...tokens1, ...tokens2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// 按标题相似度聚类页面
function clusterByTitleSimilarity(pages, threshold = 0.15) {
  if (pages.length <= 6) return [{ pages }];

  const clusters = [];
  const assigned = new Set();

  const sortedPages = [...pages].sort((a, b) => (b.weeklyVisits || 0) - (a.weeklyVisits || 0));

  for (const page of sortedPages) {
    if (assigned.has(page.normalizedUrl)) continue;

    const cluster = [page];
    assigned.add(page.normalizedUrl);

    for (const other of sortedPages) {
      if (assigned.has(other.normalizedUrl)) continue;

      const similarities = cluster.map(c => textSimilarity(c.cleanTitle || c.title || '', other.cleanTitle || other.title || ''));
      const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

      if (avgSimilarity >= threshold) {
        cluster.push(other);
        assigned.add(other.normalizedUrl);
      }
    }

    clusters.push({ pages: cluster });
  }

  const avgClusterSize = clusters.reduce((s, c) => s + c.pages.length, 0) / clusters.length;
  if (avgClusterSize < 2) {
    return [{ pages }];
  }

  return clusters;
}

// 从页面标题中提取分组名称
function extractGroupLabelFromTitle(title) {
  if (!title) return 'Other';

  const cleanTitle = title
    .replace(/\s*[-–·]\s*(GitHub|YouTube|Twitter|X|LinkedIn|Reddit|Medium|Notion|Figma|Slack|Discord|ChatGPT|Claude).*$/gi, '')
    .replace(/\s*[-–·]\s*(Docs|Documentation|Guide|Tutorial|Help|Support).*$/gi, '')
    .replace(/\s*[-–·]\s*\d{4}$/gi, )
    .replace(/\s*\(\d+\)$/gi, )
    .replace(/\s*[-–·]\s*\d+.*$/gi, )
    .trim();

  if (!cleanTitle || cleanTitle.length < 3) return 'Other';

  return cleanTitle.substring(0, 30);
}

function buildWeeklyFrequentGroups(pages) {
  if (!pages || pages.length === 0) return [];
  const grouped = {};
  const assigned = new Set();

  for (const page of pages) {
    if ((page.weeklyVisits || 0) < WEEKLY_MIN_VISITS && page.source !== 'manual') {
      continue;
    }

    const hostname = page.hostname || 'unknown';
    const mainDomain = hostname.replace(/^www\./, '');

    if (!grouped[mainDomain]) {
      grouped[mainDomain] = { id: `domain:${mainDomain}`, autoLabel: friendlyDomain(hostname), label: friendlyDomain(hostname), pages: [], source: 'domain' };
    }
    grouped[mainDomain].pages.push(page);
    assigned.add(page.normalizedUrl);
  }

  const result = [];
  for (const domain of Object.keys(grouped)) {
    const group = grouped[domain];

    if (group.pages.length > 6) {
      const clusters = clusterByTitleSimilarity(group.pages);

      for (let i = 0; i < clusters.length; i++) {
        const clusterPages = clusters[i].pages;

        const bestPage = clusterPages.sort((a, b) => (b.weeklyVisits || 0) - (a.weeklyVisits || 0))[0];
        const clusterLabel = extractGroupLabelFromTitle(bestPage.cleanTitle || bestPage.title || '');

        const clusterId = `domain:${domain}:cluster:${i}`;

        result.push({
          id: clusterId,
          autoLabel: clusterLabel,
          label: clusterLabel,
          pages: clusterPages,
          score: clusterPages.reduce((s, p) => s + (p.weeklyVisits || 0), 0),
          source: 'domain-cluster',
        });
      }
    } else {
      result.push(group);
    }
  }

  for (const group of result) {
    const titleToBestPage = new Map();
    for (const page of group.pages) {
      const titleKey = page.cleanTitle || page.title || "";
      const existing = titleToBestPage.get(titleKey);
      const isBetter = !existing ||
                     page.source === 'manual' ||
                     (page.weeklyVisits || 0) > (existing.weeklyVisits || 0) ||
                     ((page.weeklyVisits || 0) === (existing.weeklyVisits || 0) && page.lastVisitTime > existing.lastVisitTime);
      if (isBetter) {
        titleToBestPage.set(titleKey, page);
      }
    }
    group.pages = Array.from(titleToBestPage.values());
    group.score = group.pages.reduce((s, p) => s + (p.weeklyVisits || 0), 0);
  }

  return result.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function buildKeywordClusters(pages) {
  if (pages.length === 0) return [];

  const tokenToPages = new Map();
  for (const page of pages) {
    const keywords = extractWeeklyKeywords(page, 1);
    for (const { token } of keywords) {
      if (!tokenToPages.has(token)) tokenToPages.set(token, []);
      tokenToPages.get(token).push(page);
    }
  }

  const assignments = new Map();
  const assigned = new Set();
  const sortedTokens = [...tokenToPages.entries()]
    .filter(([token, pageList]) => pageList.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [token, pageList] of sortedTokens) {
    const unassignedPages = pageList.filter(p => !assigned.has(p.normalizedUrl));
    if (unassignedPages.length >= 2) {
      const clusterId = `kw:${token}`;
      assignments.set(clusterId, {
        id: clusterId,
        autoLabel: generateWeeklyGroupLabel(token),
        label: generateWeeklyGroupLabel(token),
        pages: unassignedPages,
        score: unassignedPages.reduce((s, p) => s + (p.weeklyVisits || 1), 0),
        source: 'cluster',
      });
      for (const p of unassignedPages) assigned.add(p.normalizedUrl);
    }
  }

  return Array.from(assignments.values());
}

function buildWeeklyFrequentGroups(pages) {
  if (!pages || pages.length === 0) return [];
  const grouped = {};
  const assigned = new Set();

  // 按主域名分组
  for (const page of pages) {
    // 只保留高频页面（≥10次）
    if ((page.weeklyVisits || 0) < WEEKLY_MIN_VISITS && page.source !== 'manual') {
      continue;
    }

    // 使用主域名作为分组 key
    const hostname = page.hostname || 'unknown';
    const mainDomain = hostname.replace(/^www\./, '');

    if (!grouped[mainDomain]) {
      grouped[mainDomain] = { id: `domain:${mainDomain}`, autoLabel: friendlyDomain(hostname), label: friendlyDomain(hostname), pages: [], source: 'domain' };
    }
    grouped[mainDomain].pages.push(page);
    assigned.add(page.normalizedUrl);
  }

  // 处理每个域名分组：如果超过 6 个页面，按标题相似度拆分
  const result = [];
  for (const domain of Object.keys(grouped)) {
    const group = grouped[domain];

    if (group.pages.length > 6) {
      // 按标题相似度拆分
      const clusters = clusterByTitleSimilarity(group.pages);

      for (let i = 0; i < clusters.length; i++) {
        const clusterPages = clusters[i].pages;

        // 从该聚类中访问次数最高的页面提取分组名
        const bestPage = clusterPages.sort((a, b) => (b.weeklyVisits || 0) - (a.weeklyVisits || 0))[0];
        const clusterLabel = extractGroupLabelFromTitle(bestPage.cleanTitle || bestPage.title || '');

        const clusterId = `domain:${domain}:cluster:${i}`;

        result.push({
          id: clusterId,
          autoLabel: clusterLabel,
          label: clusterLabel,
          pages: clusterPages,
          score: clusterPages.reduce((s, p) => s + (p.weeklyVisits || 0), 0),
          source: 'domain-cluster',
        });
      }
    } else {
      // 不需要拆分，直接使用域名作为分组
      result.push(group);
    }
  }

  // 去重：按标题保留最佳页面
  for (const group of result) {
    const titleToBestPage = new Map();
    for (const page of group.pages) {
      const titleKey = page.cleanTitle || page.title || "";
      const existing = titleToBestPage.get(titleKey);
      const isBetter = !existing ||
                     page.source === 'manual' ||
                     (page.weeklyVisits || 0) > (existing.weeklyVisits || 0) ||
                     ((page.weeklyVisits || 0) === (existing.weeklyVisits || 0) && page.lastVisitTime > existing.lastVisitTime);
      if (isBetter) {
        titleToBestPage.set(titleKey, page);
      }
    }
    group.pages = Array.from(titleToBestPage.values());
    group.score = group.pages.reduce((s, p) => s + (p.weeklyVisits || 0), 0);
  }

  return result.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function sortWeeklyGroups(groups) {
  return groups.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function sortWeeklyPages(pages) {
  return pages.sort((a, b) => (b.weeklyVisits || 0) - (a.weeklyVisits || 0) ||
                              b.lastVisitTime - a.lastVisitTime);
}

/* ----------------------------------------------------------------
   WEEKLY STORAGE HELPERS
   ---------------------------------------------------------------- */

function getWeeklyPagePrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([WEEKLY_STORAGE_KEYS.prefs], (result) => {
      const prefs = result[WEEKLY_STORAGE_KEYS.prefs] || {
        customLabels: {},
        manualUrls: {},
        urlToCategory: {},
        removedCategories: [],
      };
      resolve(prefs);
    });
  });
}

function saveWeeklyPagePrefs(prefs) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [WEEKLY_STORAGE_KEYS.prefs]: prefs }, () => {
      resolve();
    });
  });
}

function getWeeklyFrequentCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([WEEKLY_STORAGE_KEYS.cache], (result) => {
      const cache = result[WEEKLY_STORAGE_KEYS.cache];
      if (!cache) {
        resolve(null);
        return;
      }
      const now = Date.now();
      if (cache.timestamp && (now - cache.timestamp) < WEEKLY_CACHE_TTL_MS) {
        resolve(cache.data);
      } else {
        resolve(null);
      }
    });
  });
}

function saveWeeklyFrequentCache(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [WEEKLY_STORAGE_KEYS.cache]: {
        timestamp: Date.now(),
        data: data,
      },
    }, () => {
      resolve();
    });
  });
}

function applyWeeklyPrefs(groups, prefs) {
  const result = [];

  for (const group of groups) {
    // 过滤已删除的分类
    if (prefs.removedCategories && prefs.removedCategories.includes(group.id)) {
      continue;
    }

    const customLabel = prefs.customLabels[group.id];
    const updatedGroup = {
      ...group,
      label: customLabel || group.label,
      pages: sortWeeklyPages([...group.pages]),
    };

    // 添加手动 URL
    for (const [url, catId] of Object.entries(prefs.urlToCategory)) {
      if (catId === group.id && prefs.manualUrls[url]) {
        const manualPage = {
          ...prefs.manualUrls[url],
          url: url,
          normalizedUrl: normalizeHistoryUrl(url),
          source: 'manual',
        };
        updatedGroup.pages.push(manualPage);
      }
    }

    updatedGroup.pages = sortWeeklyPages(updatedGroup.pages);
    updatedGroup.score = updatedGroup.pages.reduce((s, p) => s + (p.weeklyVisits || 1), 0);
    result.push(updatedGroup);
  }

  // 添加只有手动 URL 的分类
  const catsWithManuals = new Set(Object.values(prefs.urlToCategory));
  for (const catId of catsWithManuals) {
    if (result.some(g => g.id === catId)) continue;

    const manualPages = [];
    for (const [url, assignedCatId] of Object.entries(prefs.urlToCategory)) {
      if (assignedCatId === catId && prefs.manualUrls[url]) {
        const manualPage = {
          ...prefs.manualUrls[url],
          url: url,
          normalizedUrl: normalizeHistoryUrl(url),
          source: 'manual',
        };
        manualPages.push(manualPage);
      }
    }

    if (manualPages.length > 0) {
      result.push({
        id: catId,
        autoLabel: catId.startsWith('rule:') ? catId.slice(5) : catId,
        label: prefs.customLabels[catId] || catId,
        pages: sortWeeklyPages(manualPages),
        score: manualPages.reduce((s, p) => s + (p.weeklyVisits || 1), 0),
        source: 'manual',
      });
    }
  }

  return sortWeeklyGroups(result);
}

function mergeWeeklyPrefs(existing, updates) {
  const merged = { ...existing };

  if (updates.customLabels) {
    merged.customLabels = { ...merged.customLabels, ...updates.customLabels };
  }

  if (updates.manualUrls) {
    merged.manualUrls = { ...merged.manualUrls, ...updates.manualUrls };
  }

  if (updates.urlToCategory) {
    merged.urlToCategory = { ...merged.urlToCategory, ...updates.urlToCategory };
  }

  if (updates.removedCategories) {
    merged.removedCategories = updates.removedCategories;
  }

  return merged;
}

function deleteWeeklyGroup(groupId) {
  return getWeeklyPagePrefs().then(prefs => {
    const removed = prefs.removedCategories || [];
    if (!removed.includes(groupId)) {
      removed.push(groupId);
    }
    prefs.removedCategories = removed;
    return saveWeeklyPagePrefs(prefs);
  });
}

function removeWeeklyUrl(url) {
  return getWeeklyPagePrefs().then(prefs => {
    const normalized = normalizeHistoryUrl(url);
    delete prefs.manualUrls[normalized];
    delete prefs.urlToCategory[normalized];
    return saveWeeklyPagePrefs(prefs);
  });
}

function saveWeeklyGroupTitle(groupId, newLabel) {
  return getWeeklyPagePrefs().then(prefs => {
    prefs.customLabels = prefs.customLabels || {};
    prefs.customLabels[groupId] = newLabel;
    return saveWeeklyPagePrefs(prefs);
  });
}

function addWeeklyUrlToCategory(url, categoryId) {
  return getWeeklyPagePrefs().then(prefs => {
    const normalized = normalizeHistoryUrl(url);
    prefs.manualUrls = prefs.manualUrls || {};
    prefs.urlToCategory = prefs.urlToCategory || {};

    prefs.manualUrls[normalized] = {
      title: url,
      cleanTitle: cleanTitle(url),
      hostname: new URL(url).hostname,
      pathname: new URL(url).pathname,
      lastVisitTime: Date.now(),
      weeklyVisits: 1,
    };
    prefs.urlToCategory[normalized] = categoryId;

    return saveWeeklyPagePrefs(prefs);
  });
}

/* ----------------------------------------------------------------
   WEEKLY FETCH MAIN ENTRY
   ---------------------------------------------------------------- */

async function getWeeklyFrequentData(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getWeeklyFrequentCache();
    if (cached) {
      return cached;
    }
  }

  const pages = await fetchWeeklyHistoryPages();
  const rawGroups = buildWeeklyFrequentGroups(pages);
  const prefs = await getWeeklyPagePrefs();
  const groups = applyWeeklyPrefs(rawGroups, prefs);

  await saveWeeklyFrequentCache(groups);
  return groups;
}

/* ----------------------------------------------------------------
   WEEKLY RENDERING
   ---------------------------------------------------------------- */

function renderWeeklyFrequentSection(groups) {
  const section = document.getElementById('weeklyFrequentSection');
  const countEl = document.getElementById('weeklyFrequentCount');
  const missionsEl = document.getElementById('weeklyFrequentMissions');
  const emptyEl = document.getElementById('weeklyFrequentEmpty');

  if (!section || !missionsEl) return;

  if (!groups || groups.length === 0) {
    section.style.display = 'none';
    return;
  }

  const totalGroups = groups.length;
  const totalPages = groups.reduce((s, g) => s + g.pages.length, 0);

  section.style.display = 'block';
  if (countEl) countEl.textContent = `${totalGroups} groups · ${totalPages} pages`;

  missionsEl.innerHTML = groups.map(group => renderWeeklyFrequentCard(group)).join('');

  if (emptyEl) emptyEl.style.display = 'none';
}

function renderWeeklyFrequentCard(group) {
  const safeId = escapeAttr(group.id);
  const safeLabel = escapeHtml(group.label);
  const pageCount = group.pages.length;
  const totalVisits = group.score || group.pages.reduce((s, p) => s + (p.weeklyVisits || 1), 0);

  const pagesHtml = group.pages.map(page => renderWeeklyPageChip(page, group.id)).join('');

  return `
<div class="mission-card has-neutral-bar" data-group-id="${safeId}">
  <div class="mission-content">
    <div class="mission-top">
      <span class="mission-name">${safeLabel}</span>
      <span class="mission-tag neutral">${totalVisits} visits</span>
      <button class="weekly-card-close" data-action="delete-weekly-group" data-group-id="${safeId}" title="Delete this category">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="mission-summary">${pageCount} pages</div>
    <div class="mission-pages">
      ${pagesHtml}
    </div>
    <div class="actions">
      <button class="action-btn" data-action="edit-weekly-group-title" data-group-id="${safeId}" data-current-label="${escapeAttr(group.label)}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.935-8.935Z" />
        </svg>
        Rename
      </button>
      <button class="action-btn" data-action="show-add-weekly-url" data-group-id="${safeId}" title="Add a URL to this category">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Add URL
      </button>
    </div>
    <div class="add-url-form" id="add-url-form-${safeId}" style="display:none">
      <div class="mission-pages">
        <div class="page-chip">
          <input type="text" class="add-url-input" id="add-url-input-${safeId}" placeholder="Paste URL here..." style="flex:1;min-width:0;padding:4px 8px;font-size:13px;border:1px solid var(--warm-gray);border-radius:4px;">
          <button class="chip-action chip-save" data-action="add-weekly-url" data-group-id="${safeId}" title="Add">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </button>
          <button class="chip-action chip-close" data-action="cancel-add-weekly-url" data-group-id="${safeId}" title="Cancel">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

function renderWeeklyPageChip(page, groupId) {
  const safeUrl = escapeAttr(page.url);
  const safeNormalizedUrl = escapeAttr(page.normalizedUrl);
  const safeTitle = escapeHtml(page.cleanTitle || page.title || page.url);
  const safeGroupId = escapeAttr(groupId);
  const weeklyVisits = page.weeklyVisits || 1;

  let domain = '';
  try { domain = new URL(page.url).hostname; } catch {}

  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';

  return `
<div class="page-chip clickable" data-action="open-weekly-url" data-url="${safeUrl}" title="${safeTitle}">
  ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
  <span class="chip-text">${safeTitle}</span>
  ${weeklyVisits > 1 ? `<span style="font-size:11px;color:var(--muted);margin-left:6px;">${weeklyVisits}x</span>` : ''}
  <div class="chip-actions">
    <button class="weekly-page-close" data-action="remove-weekly-url" data-url="${safeNormalizedUrl}" data-group-id="${safeGroupId}" title="Remove this URL">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</div>`;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // 测试 storage 读写
  chrome.storage.local.get('test-key', (data) => {
    console.log('[tab-out] storage test - read:', data);
    chrome.storage.local.set({ 'test-key': 'test-value-' + Date.now() }, () => {
      console.log('[tab-out] storage test - wrote');
    });
  });

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render weekly frequent pages ---
  try {
    const weeklyGroups = await getWeeklyFrequentData();
    renderWeeklyFrequentSection(weeklyGroups);
  } catch (err) {
    console.warn('[tab-out] Failed to render weekly frequent pages:', err);
  }

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }

  // ---- Weekly: open URL in new tab ----
  if (action === 'open-weekly-url') {
    const url = actionEl.dataset.url;
    if (url) {
      // 尝试找到已打开的 tab 并 focus，否则打开新 tab
      const allTabs = await chrome.tabs.query({});
      const match = allTabs.find(t => t.url === url);
      if (match) {
        await chrome.tabs.update(match.id, { active: true });
        await chrome.windows.update(match.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url });
      }
    }
    return;
  }

  // ---- Weekly: refresh history ----
  if (action === 'refresh-weekly-history') {
    try {
      const groups = await getWeeklyFrequentData(true);
      renderWeeklyFrequentSection(groups);
      showToast('Weekly pages refreshed');
    } catch (err) {
      console.warn('[tab-out] Failed to refresh weekly pages:', err);
      showToast('Refresh failed');
    }
    return;
  }

  // ---- Weekly: edit group title ----
  if (action === 'edit-weekly-group-title') {
    const groupId = actionEl.dataset.groupId;
    const currentLabel = actionEl.dataset.currentLabel;
    if (!groupId || !card) return;

    const nameEl = card.querySelector('.mission-name');
    if (!nameEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentLabel || '';
    input.className = 'edit-title-input';
    input.style.cssText = 'font-size:15px;font-weight:600;color:var(--ink);border:1px solid var(--accent-amber);border-radius:4px;padding:4px 8px;flex:1;';

    const actionsEl = card.querySelector('.actions');
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button class="action-btn" data-action="save-weekly-group-title" data-group-id="${escapeAttr(groupId)}">
          Save
        </button>
        <button class="action-btn" data-action="cancel-weekly-group-title" data-group-id="${escapeAttr(groupId)}" data-original-label="${escapeAttr(currentLabel)}">
          Cancel
        </button>
      `;
    }

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    // Handle Enter key
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.dispatchEvent(new Event('blur'));
      } else if (e.key === 'Escape') {
        const cancelBtn = card.querySelector('[data-action="cancel-weekly-group-title"]');
        if (cancelBtn) cancelBtn.click();
      }
    });

    // Auto-save on blur
    input.addEventListener('blur', async () => {
      const newLabel = input.value.trim();
      if (newLabel && newLabel !== currentLabel) {
        await saveWeeklyGroupTitle(groupId, newLabel);
        const nameElNew = document.createElement('span');
        nameElNew.className = 'mission-name';
        nameElNew.textContent = newLabel;
        input.replaceWith(nameElNew);
        actionsEl.innerHTML = `
          <button class="action-btn" data-action="edit-weekly-group-title" data-group-id="${escapeAttr(groupId)}" data-current-label="${escapeAttr(newLabel)}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.935-8.935Z" />
            </svg>
            Rename
          </button>
          <button class="action-btn" data-action="show-add-weekly-url" data-group-id="${escapeAttr(groupId)}" title="Add a URL to this category">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add URL
          </button>
        `;
      } else {
        // Revert to original
        const nameElNew = document.createElement('span');
        nameElNew.className = 'mission-name';
        nameElNew.textContent = currentLabel;
        input.replaceWith(nameElNew);
        actionsEl.innerHTML = `
          <button class="action-btn" data-action="edit-weekly-group-title" data-group-id="${escapeAttr(groupId)}" data="current-label="${escapeAttr(currentLabel)}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.935-8.935Z" />
            </svg>
            Rename
          </button>
          <button class="action-btn" data-action="show-add-weekly-url" data-group-id="${escapeAttr(groupId)}" title="Add a URL to this category">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add URL
          </button>
        `;
      }
    });

    return;
  }

  // ---- Weekly: save group title ----
  if (action === 'save-weekly-group-title') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId || !card) return;

    const input = card.querySelector('input.edit-title-input');
    if (!input) return;

    const newLabel = input.value.trim();
    if (newLabel) {
      await saveWeeklyGroupTitle(groupId, newLabel);
      showToast('Title saved');
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'mission-name';
    nameEl.textContent = newLabel;
    input.replaceWith(nameEl);

    const actionsEl = card.querySelector('.actions');
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button class="action-btn" data-action="edit-weekly-group-title" data-group-id="${escapeAttr(groupId)}" data-current-label="${escapeAttr(newLabel)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.935-8.935Z" />
          </svg>
          Rename
        </button>
        <button class="action-btn" data-action="show-add-weekly-url" data-group-id="${escapeAttr(groupId)}" title="Add a URL to this category">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add URL
        </button>
      `;
    }

    return;
  }

  // ---- Weekly: cancel group title edit ----
  if (action === 'cancel-weekly-group-title') {
    const groupId = actionEl.dataset.groupId;
    const originalLabel = actionEl.dataset.originalLabel;
    if (!groupId || !card) return;

    const input = card.querySelector('input.edit-title-input');
    if (!input) return;

    const nameEl = document.createElement('span');
    nameEl.className = 'mission-name';
    nameEl.textContent = originalLabel || '';
    input.replaceWith(nameEl);

    const actionsEl = card.querySelector('.actions');
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button class="action-btn" data-action="edit-weekly-group-title" data-group-id="${escapeAttr(groupId)}" data-current-label="${escapeAttr(originalLabel)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.935-8.935Z" />
          </svg>
          Rename
        </button>
        <button class="action-btn" data-action="show-add-weekly-url" data-group-id="${escapeAttr(groupId)}" title="Add a URL to this category">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add URL
        </button>
      `;
    }

    return;
  }

  // ---- Weekly: show add URL form ----
  if (action === 'show-add-weekly-url') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId || !card) return;

    const formEl = card.querySelector(`.add-url-form`);
    if (formEl) {
      formEl.style.display = 'block';
      const input = formEl.querySelector('input');
      if (input) {
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const addBtn = formEl.querySelector('[data-action="add-weekly-url"]');
            if (addBtn) addBtn.click();
          } else if (e.key === 'Escape') {
            const cancelBtn = formEl.querySelector('[data-action="cancel-add-weekly-url"]');
            if (cancelBtn) cancelBtn.click();
          }
        });
      }
    }

    return;
  }

  // ---- Weekly: add URL to category ----
  if (action === 'add-weekly-url') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId || !card) return;

    const input = card.querySelector('input.add-url-input');
    if (!input) return;

    const url = input.value.trim();
    if (!url) {
      showToast('Please enter a URL');
      return;
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      // Try adding protocol
      try {
        parsedUrl = new URL('https://' + url);
      } catch {
        showToast('Invalid URL format');
        return;
      }
    }

    await addWeeklyUrlToCategory(parsedUrl.href, groupId);
    showToast('URL added');

    // Re-render the section
    const groups = await getWeeklyFrequentData(true);
    renderWeeklyFrequentSection(groups);

    return;
  }

  // ---- Weekly: cancel add URL ----
  if (action === 'cancel-add-weekly-url') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId || !card) return;

    const formEl = card.querySelector(`.add-url-form`);
    if (formEl) {
      formEl.style.display = 'none';
      const input = formEl.querySelector('input');
      if (input) input.value = '';
    }

    return;
  }

  // ---- Weekly: delete category ----
  if (action === 'delete-weekly-group') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId || !card) return;

    await deleteWeeklyGroup(groupId);

    // Animate card out
    playCloseSound();
    animateCardOut(card);

    showToast('Category deleted');

    // Re-render the section
    setTimeout(async () => {
      const groups = await getWeeklyFrequentData(true);
      renderWeeklyFrequentSection(groups);
    }, 400);

    return;
  }

  // ---- Weekly: remove URL ----
  if (action === 'remove-weekly-url') {
    const url = actionEl.dataset.url;
    if (!url) return;

    await removeWeeklyUrl(url);

    // Find and remove the chip row
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If card now has no pages, remove it too
        if (card && card.querySelectorAll('.page-chip').length === 0) {
          animateCardOut(card);
          setTimeout(async () => {
            const groups = await getWeeklyFrequentData(true);
            renderWeeklyFrequentSection(groups);
          }, 400);
        }
      }, 200);
    }

    showToast('URL removed');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
