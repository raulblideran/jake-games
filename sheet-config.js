// === SHEET SOURCE ======================================================
// The collection sheet keeps one tab per console. The tab name *is* the
// console, so a game's platform comes from which tab it sits on.
// Shared by the collection pages (via collection-core.js) and stats.html.
const SHEET_PUB =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQk1ME9PfkGNAumbepUjECuyWNawhReZG9qKGLAzh5ZwUXw6rEiQMGpghG1tKofcvU_RnczERE_7BYg/pub";

// Used when the live tab list can't be read. New console tabs added to the
// sheet are picked up automatically by discoverTabs(); this only matters
// if that lookup fails.
const FALLBACK_TABS = [
    { name: "Xbox 360", gid: "1191346075" },
    { name: "Xbox One", gid: "2068154611" },
    { name: "Xbox Series", gid: "461778615" },
    { name: "PlayStation 1", gid: "514607045" },
    { name: "PlayStation 2", gid: "895800200" },
    { name: "PlayStation 4", gid: "878912398" },
    { name: "PSP", gid: "1018397765" },
    { name: "PC", gid: "1931374785" },
    { name: "GBA", gid: "1299888119" },
    { name: "DS", gid: "1597748997" },
    { name: "Wii", gid: "868757416" },
];

// Tabs that aren't a console's games.
const NON_CONSOLE_TAB = /achievement/i;
// Achievement Tracker: Status, Achievement, GS, Description, Date Unlocked,
// Game, Platform. Used by achievements.html.
const ACHIEVEMENT_TAB_FALLBACK = { name: "Achievement Tracker", gid: "1096155675" };

// Opened straight from disk (file://), Google refuses the direct request:
// its redirect carries no CORS header for a page with a "null" origin. Pages
// then go straight to the proxy rather than failing first, which only slowed
// the first load and filled the console with red CORS errors.
const OPENED_FROM_FILE = location.protocol === "file:";

const tabCsvUrl = (gid) =>
    `${SHEET_PUB}?gid=${gid}&single=true&output=csv`;

// Every tab in the sheet, read from the published-to-web page, which embeds
// one `items.push({name: "...", ..., gid: "..."})` per tab. Returns null if
// the page can't be fetched or its shape has changed.
async function listSheetTabs(fetchText) {
    try {
        const html = await fetchText(`${SHEET_PUB.replace(/\/pub$/, "/pubhtml")}?_=${Date.now()}`);
        const tabs = [];
        const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
        let m;
        while ((m = re.exec(html || ""))) {
            const name = m[1]
                .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
                .replace(/\\(.)/g, "$1")
                .trim();
            if (name) tabs.push({ name, gid: m[2] });
        }
        if (tabs.length) return tabs;
    } catch (e) {
        console.warn("Tab discovery failed, using the built-in list", e);
    }
    return null;
}

// The console tabs (one per platform). Falls back to FALLBACK_TABS.
async function discoverTabs(fetchText) {
    const all = await listSheetTabs(fetchText);
    const tabs = (all || []).filter((t) => !NON_CONSOLE_TAB.test(t.name));
    return tabs.length ? tabs : FALLBACK_TABS.slice();
}

// Two-digit years are 20yy: the sheet writes dd/mm/yy.
function parseSheetDate(str) {
    if (!str) return null;
    const m = String(str)
        .trim()
        .match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    // Reject impossible days (31/02) rather than rolling into March.
    if (d.getMonth() !== Number(m[2]) - 1) return null;
    return d;
}

// Condition column → one of a small set of keys.
const CONDITIONS = {
    cib: { label: "Complete in box", short: "CIB" },
    sealed: { label: "Sealed in box", short: "Sealed" },
    "no-manual": { label: "Boxed, no manual", short: "No manual" },
    loose: { label: "Loose", short: "Loose" },
    unknown: { label: "Not recorded", short: "?" },
};
function conditionKey(text) {
    const s = String(text ?? "").trim().toLowerCase();
    if (!s) return "unknown";
    if (/seal/.test(s)) return "sealed";
    if (/loose/.test(s)) return "loose";
    if (/no\s*manual|without\s*manual/.test(s)) return "no-manual";
    if (/complete\s*in\s*box|^cib$/.test(s)) return "cib";
    return "unknown";
}

// Game Progression column → one of three keys.
const PROGRESS = {
    complete: { label: "Completed" },
    "in-progress": { label: "In progress" },
    "not-started": { label: "Not started" },
};
function progressKey(text) {
    const s = String(text ?? "").trim().toLowerCase();
    if (/progress|playing/.test(s)) return "in-progress";
    if (/^complete|finished|done/.test(s)) return "complete";
    return "not-started";
}
