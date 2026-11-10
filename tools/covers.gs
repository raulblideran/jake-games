/**
 * Box art for the collection sheet.
 *
 * Fills a "Cover" column on every console tab with a link to each game's
 * cover art. The website reads that column, so every game is looked up once,
 * ever, and every visitor sees the covers straight away.
 *
 * Sources, best first:
 *   RetroArch thumbnails (PS1, PS2, PSP, GBA, DS, Wii): European boxes.
 *   Microsoft Store (Xbox 360, One, Series): clean poster art.
 *   TheGamesDB (any console): real boxes, UK/PAL preferred. Monthly allowance.
 *   Wikipedia (any console): the article's cover.
 *
 * Rules:
 *   - Only empty Cover cells are filled. Paste your own image link into a
 *     cell and it is never touched.
 *   - Each filled cell gets a note saying where the cover came from.
 *   - Games nothing matched get a "No cover found" note. The nightly run
 *     tries them again after 30 days; clicking fillCoversNow tries them again
 *     straight away (e.g. after fixing a typo in the title).
 *
 * Setup (once): Extensions → Apps Script, paste this file, save, then run
 * `step1_setUp` and approve the permissions. It fills what it can (Apps Script
 * stops a run after ~6 minutes, so a big first fill continues by itself every
 * 10 minutes until done) and then checks for new games every night.
 */

const TGDB_KEY = "b4fb97af26e82fae3e2e264002739320cd200dc2e034d3e81b570fb6a1f3e6cb";
const TGDB_RESERVE = 100; // TheGamesDB lookups left alone each month
const COVER_HEADER = "Cover";
const RETRY_DAYS = 30;
const RUN_LIMIT_MS = 4.5 * 60 * 1000; // stop well before Apps Script's 6-minute cap

// Tab name -> where to look. Tabs not listed (e.g. a new console) still get
// Wikipedia; add them here for the other sources.
const PLATFORMS = {
  "Xbox 360": { tgdb: 15, store: "exact" }, // only the original listing, never a remaster
  "Xbox One": { tgdb: 4920, store: true },
  "Xbox Series": { tgdb: 4981, store: true },
  "PlayStation 1": { tgdb: 10, retro: "Sony - PlayStation" },
  "PlayStation 2": { tgdb: 11, retro: "Sony - PlayStation 2" },
  "PlayStation 4": { tgdb: 4919 },
  PSP: { tgdb: 13, retro: "Sony - PlayStation Portable" },
  PC: { tgdb: 1 },
  GBA: { tgdb: 5, retro: "Nintendo - Game Boy Advance" },
  DS: { tgdb: 8, retro: "Nintendo - Nintendo DS" },
  Wii: { tgdb: 9, retro: "Nintendo - Wii" },
};
const SKIP_TAB = /achievement/i;

// ---- The buttons --------------------------------------------------------
// Only these appear in the Run dropdown (everything else ends in "_", which
// Apps Script keeps private). None of them deletes or overwrites anything:
// they only ever fill EMPTY Cover cells and add notes.
//
//   step1_setUp          Run this once. Adds the Cover columns, fills them,
//                        and schedules a nightly check for new games.
//   fillCoversNow        Fill any empty Cover cells right now, including ones
//                        marked "No cover found". Safe anytime.
//   stopAutomaticRuns    Turn off the nightly / follow-up runs. Safe anytime;
//                        run step1_setUp again to turn them back on.
//   automaticRun         What the timers call. Same as fillCoversNow, so
//                        clicking it does no harm, but there's no need to.

function step1_setUp() {
  stopAutomaticRuns();
  ScriptApp.newTrigger("automaticRun").timeBased().everyDays(1).atHour(3).create();
  run_();
}

function fillCoversNow() {
  run_(true);
}

function stopAutomaticRuns() {
  // Also clears triggers left by earlier versions of this script.
  const ours = ["automaticRun", "fillCovers", "continueFill"];
  ScriptApp.getProjectTriggers()
    .filter((t) => ours.includes(t.getHandlerFunction()))
    .forEach((t) => ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().deleteProperty("followUpTrigger");
  console.log("Automatic runs are off.");
}

function automaticRun() {
  run_();
}

// ---- The work -----------------------------------------------------------

function run_(retryMisses) {
  const started = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  let filled = 0;
  let missed = 0;
  let unfinished = false;

  for (const sheet of ss.getSheets()) {
    const tab = sheet.getName();
    if (SKIP_TAB.test(tab)) continue;
    const values = sheet.getDataRange().getValues();
    const headerRow = values.findIndex((r) => r.some((c) => /^game\s*title$|^game$/i.test(String(c).trim())));
    if (headerRow < 0) continue;
    const header = values[headerRow].map((c) => String(c).trim());
    const titleCol = header.findIndex((c) => /^game\s*title$|^game$/i.test(c));
    let coverCol = header.findIndex((c) => c.toLowerCase() === COVER_HEADER.toLowerCase());
    if (coverCol < 0) {
      coverCol = sheet.getLastColumn(); // 0-based index of the new column
      sheet.getRange(headerRow + 1, coverCol + 1).setValue(COVER_HEADER).setFontWeight("bold");
    }
    const notes = sheet.getRange(1, coverCol + 1, values.length, 1).getNotes();

    for (let i = headerRow + 1; i < values.length; i++) {
      const title = String(values[i][titleCol] || "").trim();
      if (!title) continue;
      if (String(values[i][coverCol] || "").trim()) continue; // filled, or the user's own link
      const note = notes[i][0] || "";
      const checked = note.match(/^No cover found \(checked (\d{4}-\d{2}-\d{2})\)/);
      if (checked && !retryMisses && (today - new Date(checked[1])) / 864e5 < RETRY_DAYS) continue;
      if (Date.now() - started > RUN_LIMIT_MS) {
        unfinished = true;
        break;
      }
      const hit = findCover_(title, tab);
      const cell = sheet.getRange(i + 1, coverCol + 1);
      if (hit) {
        cell.setValue(hit.url).setNote(`${hit.source}: ${hit.matched}`);
        filled++;
      } else {
        cell.setNote(`No cover found (checked ${Utilities.formatDate(today, "UTC", "yyyy-MM-dd")})`);
        missed++;
      }
    }
    if (unfinished) break;
  }

  // A big fill carries on every 10 minutes until it's done, then that
  // follow-up timer removes itself. The nightly timer is separate.
  const props = PropertiesService.getScriptProperties();
  const followUpId = props.getProperty("followUpTrigger");
  const followUp = ScriptApp.getProjectTriggers().find((t) => t.getUniqueId() === followUpId);
  if (unfinished && !followUp) {
    const t = ScriptApp.newTrigger("automaticRun").timeBased().everyMinutes(10).create();
    props.setProperty("followUpTrigger", t.getUniqueId());
  }
  if (!unfinished && followUp) {
    ScriptApp.deleteTrigger(followUp);
    props.deleteProperty("followUpTrigger");
  }
  console.log(`Covers: ${filled} filled, ${missed} not found${unfinished ? ", more to do (continuing in 10 minutes)" : ", all done"}.`);
}

// ---- Lookup order ---------------------------------------------------------

// Tries the sheet's title first. If nothing matches, tries other names for
// the same game (the sheet itself is never changed; the cell's note says
// which name worked):
//   - without an edition ending: "… Dog Days Limited Edition" -> "… Dog Days"
//   - Wikipedia's "did you mean": "Batman Akrham Asylum" -> "batman arkham asylum"
//   - Wikipedia's top game article containing every word of the title:
//     "Bloodstone 007" -> "James Bond 007: Blood Stone"
function findCover_(title, tab) {
  const hit = findCoverAs_(title, tab);
  if (hit) return hit;
  const tried = new Set([norm_(title)]);
  for (const name of [withoutEdition_(title), () => wikiSuggestion_(title), () => wikiSearchTitle_(title)]) {
    let alt = null;
    try {
      alt = typeof name === "function" ? name() : name;
    } catch (e) {
      console.warn(`${tab} / ${title}: ${e.message}`);
    }
    if (!alt || tried.has(norm_(alt))) continue;
    tried.add(norm_(alt));
    const found = findCoverAs_(alt, tab);
    if (found) return { ...found, matched: `${found.matched} (searched as "${alt}")` };
  }
  return null;
}

function findCoverAs_(title, tab) {
  const p = PLATFORMS[tab] || {};
  const tries = [
    p.retro && (() => retroArch_(title, p.retro)),
    p.store && (() => microsoftStore_(title, p.store)),
    p.tgdb && (() => theGamesDb_(title, p.tgdb)),
    () => wikipedia_(title),
  ].filter(Boolean);
  for (const attempt of tries) {
    try {
      const hit = attempt();
      if (hit) return hit;
    } catch (e) {
      console.warn(`${tab} / ${title}: ${e.message}`);
    }
  }
  return null;
}

// ---- Other names for a title ------------------------------------------------

// "Kane & Lynch 2: Dog Days Limited Edition" -> "Kane & Lynch 2: Dog Days",
// "Elden Ring: Nightreign Seekers Edition" -> "Elden Ring: Nightreign".
function withoutEdition_(title) {
  const t = String(title).replace(/[\s:–-]*\b(?:[\w']+\s+)?edition\s*$/i, "").trim();
  return t && t !== title ? t : null;
}

const WIKI_SEARCH = "https://en.wikipedia.org/w/api.php?action=query&format=json";

// Wikipedia's spelling correction for the title, if it has one.
function wikiSuggestion_(title) {
  const json = fetchJson_(`${WIKI_SEARCH}&list=search&srlimit=1&srinfo=suggestion&srsearch=${encodeURIComponent(title)}`).json;
  return (json && json.query && json.query.searchinfo && json.query.searchinfo.suggestion) || null;
}

// The top game article whose title contains every word of ours (allowing a
// small typo in each word), e.g. "Marvel Avengers" -> "Marvel's Avengers".
// Searches plainly first, then with Wikipedia's fuzzy "word~" syntax, which
// gets past typos like "Deaus Ex". As a last resort, a title like
// "Spongebob Squarepants: Volcano Island" may match on its subtitle alone
// ("Nicktoons: Battle for Volcano Island").
function wikiSearchTitle_(title) {
  const words = (t) => norm_spaced_(t).split(" ").filter(Boolean);
  // A year in brackets counts: "Modern Warfare (2019)" must not become
  // "Modern Warfare 2".
  const want = words(title);
  if (!want.length) return null;
  const has = (w, cands) => cands.some((c) => c.includes(w) || (w.length > 3 && similarity_(w, c) >= 0.75));
  const colon = title.indexOf(":");
  const sub = colon > 0 ? words(title.slice(colon + 1)) : [];
  const plain = title.replace(/[()]/g, " ");
  const fuzzy = plain.replace(/[A-Za-z]{4,}/g, (w) => `${w}~`);
  const seen = [];
  for (const query of [plain, fuzzy]) {
    const json = fetchJson_(`${WIKI_SEARCH}&generator=search&gsrlimit=8&prop=description&gsrsearch=${encodeURIComponent(`${query} video game`)}`).json;
    const pages = Object.values((json && json.query && json.query.pages) || {})
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .filter((p) => /\bgame\b/i.test(p.description || "") && !/series|franchise|licensed/i.test(p.description || ""));
    for (const p of pages) {
      const cands = words(p.title).concat([norm_(p.title)]);
      if (want.every((w) => has(w, cands))) return p.title;
      seen.push(cands.concat([p.title]));
    }
  }
  if (sub.length >= 2) {
    const m = seen.find((c) => sub.every((w) => c.includes(w)));
    if (m) return m[m.length - 1];
  }
  return null;
}

// ---- Shared title helpers ---------------------------------------------------

const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
// Like norm_ but keeping the spaces between words.
function norm_spaced_(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // "Piñata" -> "Pinata"
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/&|_/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && w !== "the" && w !== "and")
    .map((w) => ROMAN[w] || w)
    .join(" ");
}
// Lower-case, punctuation-free, "The"/"and" dropped, roman numerals as numbers.
function norm_(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // "Piñata" -> "Pinata"
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/&|_/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && w !== "the" && w !== "and")
    .map((w) => ROMAN[w] || w)
    .join("");
}
// Similarity 0..1 by edit distance, for small typos ("Enter The Martix").
// Swapping two neighbouring letters counts as one edit.
function similarity_(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}
function fetchJson_(url, options) {
  const resp = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options || {}));
  const code = resp.getResponseCode();
  if (code === 429 || code >= 500) throw new Error(`HTTP ${code} from ${url.split("?")[0]}`);
  return { code, json: JSON.parse(resp.getContentText() || "null") };
}

// ---- RetroArch ------------------------------------------------------------
// thumbnails.libretro.com/<System>/Named_Boxarts/ lists every box art, named
// like "24 - The Game (Europe, Australia) (En,Fr).png". Library names use
// " - " for ":", move "The" to the end ("Simpsons Game, The") and often add
// a publisher ("DreamWorks Shark Tale").

const retroLists = {};
const PUBLISHER = /^(disney[\s-]*pixar'?s?|disney'?s?|dreamworks|nickelodeon|tom clancy'?s|wwe|dr\.? kawashima'?s|007 -|james bond 007:?|james bond 007 in\.*)\s*/i;
const UNWANTED = /\((beta|demo|proto|sample|kiosk|preview|trade demo)[^)]*\)/i;

function retroList_(system) {
  if (!retroLists[system]) {
    const html = UrlFetchApp.fetch(`https://thumbnails.libretro.com/${encodeURIComponent(system)}/Named_Boxarts/`).getContentText();
    retroLists[system] = [...html.matchAll(/href="([^"]+\.png)"/g)].map((m) => decodeURIComponent(m[1]));
  }
  return retroLists[system];
}
function retroName_(file) {
  let n = file.replace(/\.png$/, "").replace(/\s*\(.*$/, "");
  const m = n.match(/^(.*), (The|A|An)( - .*)?$/);
  if (m) n = `${m[2]} ${m[1]}${m[3] || ""}`;
  return n;
}
function retroArch_(title, system) {
  const files = retroList_(system).filter((f) => !UNWANTED.test(f));
  const names = {};
  for (const f of files) (names[retroName_(f)] = names[retroName_(f)] || []).push(f);
  const want = norm_(title);
  const wantCore = norm_(title.replace(PUBLISHER, ""));
  const all = Object.keys(names);
  const core = (n) => norm_(n.replace(PUBLISHER, ""));
  // 1. Same title; 2. same without publisher; 3. our title + " - subtitle";
  // 4. a small typo. Steps 3-4 only count when exactly one game fits.
  let pick = all.filter((n) => norm_(n) === want);
  if (!pick.length) pick = all.filter((n) => core(n) === wantCore);
  if (!pick.length) {
    // Several subtitled versions of one name ("… - How Old Is Your Brain" and
    // "… - How Old Is Your Brain - Sudoku Download") count as one: the plain one.
    const sub = all.filter((n) => n.includes(" - ") && core(n.split(" - ")[0]) === wantCore).sort((a, b) => a.length - b.length);
    if (sub.length && sub.every((n) => n.startsWith(sub[0]))) pick = [sub[0]];
  }
  if (!pick.length) {
    const scored = all.map((n) => [n, similarity_(core(n), wantCore)]).filter(([, s]) => s >= 0.9);
    if (scored.length === 1) pick = [scored[0][0]];
  }
  if (!pick.length) return null;
  const name = pick[0];
  // European box first, then UK, then US, then anything; fewest extra tags.
  const rank = (f) => (/\((Europe|UK)/.test(f) ? 0 : /\(USA/.test(f) ? 1 : 2) * 10 + (f.match(/\(/g) || []).length;
  const file = names[name].sort((a, b) => rank(a) - rank(b))[0];
  return {
    url: `https://thumbnails.libretro.com/${encodeURIComponent(system)}/Named_Boxarts/${encodeURIComponent(file)}`,
    source: "RetroArch",
    matched: file.replace(/\.png$/, ""),
  };
}

// ---- Microsoft Store ------------------------------------------------------
// Its search wants exact wording, so try the full title, then its first two
// words, then the first word, and match the results ourselves.

const STORE_DLC = /\b(pack|dlc|outfit|season pass|add-?on|upgrade|soundtrack|costume|map pack|expansion|demo|trial|theme|avatar|gamerpic|insider|bundle)\b/i;
// Bundle editions share the base game's cover; remasters and definitive
// editions have newer art, so they never stand in for the game itself.
const STORE_EDITION = /\b(digital|deluxe|ultimate|complete|gold|goty|game of the year|premium|standard|hardened)\b[^:]*$/i;
const STORE_REMASTER = /\b(remaster(ed)?|definitive|anniversary|enhanced|for windows 10)\b/i;
const storeKey = (t, exact) =>
  norm_(String(t).replace(/\(.*?\)|\[.*?\]/g, " ").replace(exact ? /$^/ : STORE_EDITION, " "))
    .replace(/xbox|one|360/g, "");

function storeSearch_(q) {
  const url =
    "https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=GB&languages=en-GB&productFamilyNames=Games&query=" +
    encodeURIComponent(q);
  const { json } = fetchJson_(url);
  return ((json && json.Results) || [])
    .flatMap((f) => f.Products || [])
    .filter((p) => p.Type === "Game" && !STORE_DLC.test(p.Title || ""));
}
function microsoftStore_(title, mode) {
  const exact = mode === "exact";
  const want = storeKey(title, exact);
  const words = title.replace(/[^A-Za-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const queries = [title, words.slice(0, 2).join(" "), words[0]].filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of queries) {
    const hit = storeSearch_(q).find((p) => !STORE_REMASTER.test(p.Title) && storeKey(p.Title, exact) === want);
    if (!hit) continue;
    const { json } = fetchJson_(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${hit.ProductId}&market=GB&languages=en-GB`);
    const images = (((json && json.Products) || [])[0] || {}).LocalizedProperties?.[0]?.Images || [];
    const art = images.find((i) => i.ImagePurpose === "Poster") || images.find((i) => i.ImagePurpose === "BoxArt");
    if (!art) return null;
    return { url: `https:${art.Uri}`, source: "Microsoft Store", matched: hit.Title };
  }
  return null;
}

// ---- TheGamesDB -------------------------------------------------------------
// Same matching as the website used: exact title, then starts-the-same, then
// shared words; UK > PAL > US; variants (limited, demo…) only if asked for.

// Add-ons, never the game itself ("... Acceleration Expansion Pack").
const ADDON = /\b(expansion|add-?on|dlc|season pass|soundtrack|map pack)\b/i;
const VARIANT = /\[|\b(limited|collector'?s?|edition|special|deluxe|gold|goty|game of the year|not for resale|steelbook|bundle|classics|platinum|greatest hits|essentials|demo|premium|ultimate)\b/i;

function theGamesDb_(title, platform) {
  const props = PropertiesService.getScriptProperties();
  const left = Number(props.getProperty("tgdbRemaining") || "1000");
  const resetAt = Number(props.getProperty("tgdbResetAt") || "0");
  if (left < TGDB_RESERVE && Date.now() < resetAt) return null;
  const url =
    `https://api.thegamesdb.net/v1.1/Games/ByGameName?apikey=${TGDB_KEY}` +
    `&name=${encodeURIComponent(title)}&filter%5Bplatform%5D=${platform}&include=boxart`;
  const { code, json } = fetchJson_(url);
  if (json && typeof json.remaining_monthly_allowance === "number") {
    props.setProperty("tgdbRemaining", String(json.remaining_monthly_allowance + (json.extra_allowance || 0)));
    props.setProperty("tgdbResetAt", String(Date.now() + (json.allowance_refresh_timer || 0) * 1000));
  }
  if (code !== 200 || !json || !json.data) return null;
  const art = (json.include && json.include.boxart && json.include.boxart.data) || {};
  const want = norm_(title);
  let best = null;
  let bestScore = -1;
  for (const g of json.data.games || []) {
    const front = (art[g.id] || []).find((b) => b.side === "front");
    if (!front) continue;
    const got = norm_(g.game_title);
    let score;
    if (got === want) score = 100;
    else if (got.startsWith(want) || want.startsWith(got)) score = 70;
    else if (want.length >= 8 && got.includes(want)) score = 55; // "Flight Simulator X" in "Microsoft Flight Simulator X"
    else continue;
    if (ADDON.test(g.game_title) && !ADDON.test(title)) continue;
    if (VARIANT.test(g.game_title) && !VARIANT.test(title)) score -= 20;
    score -= Math.min(10, (got.length - want.length) / 10); // closest name first
    if (g.country_id === 18) score += 12; // United Kingdom
    else if ([6, 7, 8].includes(g.region_id)) score += 10; // PAL
    else if (g.region_id === 2) score += 4; // NTSC-U
    if (score > bestScore) {
      bestScore = score;
      best = { url: `https://cdn.thegamesdb.net/images/medium/${front.filename}`, source: "TheGamesDB", matched: g.game_title };
    }
  }
  return best;
}

// ---- Wikipedia --------------------------------------------------------------

function wikipedia_(title) {
  const props = "&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=500&pilicense=any";
  const base = "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1" + props;
  const isGame = (p) =>
    !("missing" in p) && p.thumbnail && /\bgame\b/i.test(p.description || "") && !/series|franchise|licensed/i.test(p.description || "");
  const baseTitle = (t) => norm_(String(t).replace(/\s*\([^)]*\)$/, ""));
  const want = norm_(title);
  let pages = Object.values(fetchJson_(`${base}&titles=${encodeURIComponent([title, `${title} (video game)`].join("|"))}`).json?.query?.pages || {}).filter(isGame);
  let hit = pages.find((p) => baseTitle(p.title) === want) || pages[0];
  if (!hit) {
    pages = Object.values(fetchJson_(`${base}&generator=search&gsrlimit=6&gsrsearch=${encodeURIComponent(`${title} video game`)}`).json?.query?.pages || {}).filter(isGame);
    hit = pages.find((p) => baseTitle(p.title) === want);
  }
  return hit ? { url: hit.thumbnail.source, source: "Wikipedia", matched: hit.title } : null;
}
