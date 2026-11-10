// === Box art: TheGamesDB, then Wikipedia ================================
// Covers are looked up one game at a time and kept in localStorage, so each
// game costs one lookup per browser, ever. Two sources, in order:
//
//  1. TheGamesDB: the right console's box, usually the PAL one. It goes
//     through our Deno proxy (api.thegamesdb.net sends no CORS headers) and
//     the key has a small monthly allowance (1000), so:
//       - the game being viewed is looked up first (tgdb.want),
//       - background filling only uses it while RESERVE or more are left,
//       - a refusal (quota / bad key) stops it until the allowance resets.
//  2. Wikipedia: free, no key, callable from the browser. Used when
//     TheGamesDB has no match or is being saved, so the collection still
//     fills in. Usually one cover per game (often the US box). A game showing
//     Wikipedia art is upgraded to TheGamesDB later, when it can be afforded.
//
// Anything with neither falls back to CeX art in the page.
// Needs collection-core.js (CORS_PROXIES, fetchWithTimeout, normalizeConsole).

const TGDB_KEY = "b4fb97af26e82fae3e2e264002739320cd200dc2e034d3e81b570fb6a1f3e6cb";
const TGDB_API = "https://api.thegamesdb.net";
// Sheet tab name -> TheGamesDB platform id (checked against /v1/Platforms).
const TGDB_PLATFORM = {
    "Xbox 360": 15,
    "Xbox One": 4920,
    "Xbox Series": 4981,
    "PlayStation 1": 10,
    "PlayStation 2": 11,
    "PlayStation 4": 4919,
    PSP: 13,
    PC: 1,
    GBA: 5,
    DS: 8,
    Wii: 9,
};
// Region / country preference when a title exists in several regions.
const TGDB_UK = 18; // country: United Kingdom
const TGDB_PAL = [6, 7, 8]; // regions: PAL, PAL-A, PAL-B
const TGDB_NTSC_U = 2;
const WIKI_API = "https://en.wikipedia.org/w/api.php";

const tgdb = (() => {
    // v2: matcher reads roman numerals and avoids variant editions; entries
    // made by the first matcher are looked up again.
    const COVERS_KEY = "tgdbCovers_v2";
    const WIKI_KEY = "wikiCovers_v1";
    const META_KEY = "tgdbMeta_v1";
    const LOCK_KEY = "tgdbLock";
    const RESERVE = 150; // TheGamesDB requests kept back for games people open
    const TGDB_GAP = 3000; // ms between background TheGamesDB lookups
    const WIKI_GAP = 1200; // ms between background Wikipedia lookups
    const WANT_GAP = 400; // ms between lookups for viewed games
    const MISS_RETRY = 30 * 864e5; // try unmatched games again after 30 days
    const SIZES = { s: "small", m: "thumb", l: "medium" }; // core size -> TGDB size
    const DEFAULT_BASE = "https://cdn.thegamesdb.net/images/";

    const read = (k, fallback) => {
        try {
            return JSON.parse(localStorage.getItem(k)) || fallback;
        } catch (e) {
            return fallback;
        }
    };
    const write = (k, v) => {
        try {
            localStorage.setItem(k, JSON.stringify(v));
        } catch (e) {}
    };

    try {
        localStorage.removeItem("tgdbCovers_v1");
    } catch (e) {}
    let covers = read(COVERS_KEY, {}); // TheGamesDB results
    let wiki = read(WIKI_KEY, {}); // Wikipedia results
    let meta = read(META_KEY, {});
    const wanted = []; // keys, most recent first
    const rowsByKey = new Map();
    let busy = false;
    let timer = null;
    let fillOrder = [];
    // Short back-offs after errors, per source (in memory only).
    const downUntil = { tgdb: 0, wiki: 0 };
    const errors = { tgdb: 0, wiki: 0 };

    // ---- Keys -----------------------------------------------------------
    // Roman numerals count as numbers, so "Fable 3" matches "Fable III".
    const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
    const words = (s) =>
        String(s ?? "")
            .toLowerCase()
            .replace(/&/g, " and ")
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
            .split(" ")
            .map((w) => ROMAN[w] || w)
            .join(" ");
    // Words that mark a variant release rather than the standard game.
    const VARIANT = /\[|\b(limited|collector'?s?|edition|special|deluxe|gold|goty|game of the year|not for resale|steelbook|bundle|classics|platinum|greatest hits|essentials|demo|premium|ultimate)\b/i;
    const flat = (s) => words(s).replace(/ /g, "");
    function platformOf(row) {
        return TGDB_PLATFORM[normalizeConsole(row["Console Version"])] || null;
    }
    function keyOf(row) {
        const p = platformOf(row);
        const t = flat(row["Game"]);
        return p && t ? `${p}|${t}` : null;
    }

    // ---- Reading the cache ---------------------------------------------------
    const expired = (e) => !!e && !!e.miss && Date.now() - e.miss > MISS_RETRY;
    const hasTgdb = (k) => !!covers[k]?.front;
    const hasWiki = (k) => !!wiki[k]?.img;
    const needsTgdb = (k) => !covers[k] || expired(covers[k]);
    const needsWiki = (k) => !hasTgdb(k) && (!wiki[k] || expired(wiki[k]));

    function cover(row, size = "m") {
        const k = keyOf(row);
        if (!k) return null;
        if (hasTgdb(k)) return `${meta.baseUrl || DEFAULT_BASE}${SIZES[size] || "thumb"}/${covers[k].front}`;
        if (hasWiki(k)) return wiki[k].img;
        return null;
    }
    // Neither source had anything (both have been asked).
    function isMiss(row) {
        const k = keyOf(row);
        return !!k && !hasTgdb(k) && !hasWiki(k) && !!covers[k]?.miss && !!wiki[k]?.miss;
    }

    // ---- TheGamesDB matching ---------------------------------------------
    // Best result for the sheet's title: exact title first, then one that
    // starts the same, then the closest by shared words. Among equal titles,
    // UK > PAL > US. Only results with front box art count.
    function pick(json, title) {
        const games = json?.data?.games || [];
        const art = json?.include?.boxart?.data || {};
        const want = words(title);
        const wantFlat = want.replace(/ /g, "");
        const wantSet = new Set(want.split(" "));
        let best = null;
        let bestScore = -1;
        for (const g of games) {
            const sides = art[g.id] || [];
            const front = sides.find((b) => b.side === "front");
            if (!front) continue;
            const got = words(g.game_title);
            const gotFlat = got.replace(/ /g, "");
            let score;
            if (gotFlat === wantFlat) score = 100;
            else if (gotFlat.startsWith(wantFlat) || wantFlat.startsWith(gotFlat)) score = 70;
            else {
                const gotSet = new Set(got.split(" "));
                const shared = [...wantSet].filter((w) => gotSet.has(w)).length;
                const overlap = shared / Math.max(wantSet.size, gotSet.size);
                if (overlap < 0.6) continue;
                score = 40 + overlap * 20;
            }
            // Limited / collector's / demo variants only when the sheet says so.
            if (VARIANT.test(g.game_title) && !VARIANT.test(title)) score -= 20;
            if (g.country_id === TGDB_UK) score += 12;
            else if (TGDB_PAL.includes(g.region_id)) score += 10;
            else if (g.region_id === TGDB_NTSC_U) score += 4;
            if (score > bestScore) {
                bestScore = score;
                const back = sides.find((b) => b.side === "back");
                best = { id: g.id, title: g.game_title, front: front.filename, back: back ? back.filename : null };
            }
        }
        return best;
    }

    // A looser name when the exact title finds nothing:
    // "Rayman (Platinum)" -> "Rayman", "Fable III [GOTY]" -> "Fable III".
    function simplify(title) {
        return String(title)
            .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
            .replace(/\b(game of the year|goty|collector'?s|limited|special|platinum|classics|essentials|greatest hits|edition)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    // ---- TheGamesDB network ---------------------------------------------------
    function allowanceLeft() {
        return typeof meta.remaining === "number" ? meta.remaining : Infinity;
    }
    function paused() {
        return !!meta.pausedUntil && Date.now() < meta.pausedUntil;
    }
    // Can TheGamesDB be used right now? Viewed games may dip into the reserve.
    function tgdbOpen(viewed) {
        if (paused() || Date.now() < downUntil.tgdb) return false;
        return viewed || allowanceLeft() >= RESERVE;
    }
    function noteAllowance(json) {
        if (typeof json?.remaining_monthly_allowance === "number") {
            meta.remaining = json.remaining_monthly_allowance + (json.extra_allowance || 0);
        }
        if (typeof json?.allowance_refresh_timer === "number" && json.allowance_refresh_timer > 0) {
            meta.refreshAt = Date.now() + json.allowance_refresh_timer * 1000;
        }
    }

    // Through our own proxy, keeping the status: core's fetchWithProxy turns
    // every non-OK reply into null, which would hide a quota refusal.
    async function proxied(url) {
        const { url: via, timeout } = CORS_PROXIES[0];
        return fetchWithTimeout(via(url), timeout);
    }

    async function search(name, platform) {
        const url =
            `${TGDB_API}/v1.1/Games/ByGameName?apikey=${TGDB_KEY}` +
            `&name=${encodeURIComponent(name)}&filter%5Bplatform%5D=${platform}&include=boxart`;
        const resp = await proxied(url);
        const text = await resp.text();
        // The proxy's own refusal: TheGamesDB isn't on its allowed list.
        if (/host not allowed/i.test(text)) {
            meta.proxyBlocked = Date.now();
            throw new Error("proxy doesn't allow api.thegamesdb.net");
        }
        meta.proxyBlocked = 0;
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (e) {}
        noteAllowance(json);
        if (resp.status === 403 || json?.code === 403) {
            // Out of allowance (or the key was revoked): stop until reset.
            meta.pausedUntil = meta.refreshAt && meta.refreshAt > Date.now() ? meta.refreshAt : Date.now() + 864e5;
            throw new Error("refused (allowance used up?)");
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const base = json?.include?.boxart?.base_url?.original;
        if (base) meta.baseUrl = base.replace(/original\/$/, "");
        return json;
    }

    async function tgdbLookup(row) {
        const k = keyOf(row);
        const platform = platformOf(row);
        const title = row["Game"];
        let hit = pick(await search(title, platform), title);
        const simple = simplify(title);
        if (!hit && simple && simple !== title && allowanceLeft() > 0) {
            hit = pick(await search(simple, platform), simple);
        }
        covers[k] = hit ? { ...hit, ts: Date.now() } : { miss: Date.now() };
        write(COVERS_KEY, covers);
        write(META_KEY, meta);
        return !!hit;
    }

    // ---- Wikipedia --------------------------------------------------------
    // Looks the article up by exact title (and "<title> (video game)"),
    // following Wikipedia's redirects ("Fable 3" -> "Fable III"), and only
    // accepts a page described as a video game with a lead image.
    const WIKI_PROPS = "&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=500&pilicense=any";
    // A game article with a lead image, not a series or franchise page.
    const isGamePage = (p) =>
        !("missing" in p) &&
        !!p.thumbnail?.source &&
        /video game/i.test(p.description || "") &&
        !/series|franchise/i.test(p.description || "");
    // "Aliens vs. Predator (2010 video game)" -> "aliensvspredator"
    const baseTitle = (t) => flat(String(t).replace(/\s*\([^)]*\)$/, ""));

    async function wikiQuery(params) {
        const resp = await fetchWithTimeout(`${WIKI_API}?action=query&format=json&origin=*&redirects=1${WIKI_PROPS}${params}`, 12000);
        if (!resp.ok) throw new Error(`Wikipedia HTTP ${resp.status}`);
        const json = await resp.json();
        return Object.values(json?.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }

    async function wikiLookup(row) {
        const k = keyOf(row);
        const title = row["Game"];
        const want = flat(title);
        // 1. The article by exact title, following redirects.
        const names = [...new Set([title, `${title} (video game)`, simplify(title)].filter(Boolean))];
        let pages = (await wikiQuery(`&titles=${encodeURIComponent(names.join("|"))}`)).filter(isGamePage);
        let hit = pages.find((p) => baseTitle(p.title) === want) || pages[0];
        // 2. A search, accepting only an article whose name is the game's,
        //    give or take punctuation and a "(2010 video game)" suffix.
        if (!hit) {
            pages = (await wikiQuery(`&generator=search&gsrlimit=6&gsrsearch=${encodeURIComponent(`${title} video game`)}`)).filter(isGamePage);
            hit = pages.find((p) => baseTitle(p.title) === want || baseTitle(p.title) === flat(simplify(title)));
        }
        wiki[k] = hit ? { img: hit.thumbnail.source, title: hit.title, ts: Date.now() } : { miss: Date.now() };
        write(WIKI_KEY, wiki);
        return !!hit;
    }

    // One tab at a time spends TheGamesDB lookups: a short-lived lock.
    function takeLock() {
        try {
            const held = Number(localStorage.getItem(LOCK_KEY)) || 0;
            if (Date.now() - held < 15000) return false;
            localStorage.setItem(LOCK_KEY, String(Date.now()));
            return true;
        } catch (e) {
            return true;
        }
    }
    function dropLock() {
        try {
            localStorage.removeItem(LOCK_KEY);
        } catch (e) {}
    }

    // ---- Queue ----------------------------------------------------------
    // The next job: viewed games first, then the background fill. Each game
    // tries TheGamesDB when it can be used, then Wikipedia if that found
    // nothing (or can't be used right now).
    function jobFor(k, viewed) {
        if (needsTgdb(k) && tgdbOpen(viewed)) return { k, viewed, src: "tgdb" };
        if (needsWiki(k) && Date.now() >= downUntil.wiki) return { k, viewed, src: "wiki" };
        return null;
    }
    function nextJob() {
        while (wanted.length) {
            const k = wanted[0];
            const job = rowsByKey.has(k) && jobFor(k, true);
            if (job) return job;
            wanted.shift();
        }
        while (fillOrder.length) {
            const k = fillOrder[0];
            const job = rowsByKey.has(k) && jobFor(k, false);
            if (job) return job;
            fillOrder.shift();
        }
        return null;
    }

    function schedule(delay) {
        clearTimeout(timer);
        timer = setTimeout(tick, delay);
    }

    async function tick() {
        if (busy || document.visibilityState === "hidden") return;
        const job = nextJob();
        if (!job) {
            // Nothing doable right now; check again once a back-off ends.
            const wait = Math.max(downUntil.tgdb, downUntil.wiki) - Date.now();
            if (wait > 0) schedule(wait + 500);
            return;
        }
        if (job.src === "tgdb" && !takeLock()) return schedule(5000);
        busy = true;
        try {
            const found = job.src === "tgdb" ? await tgdbLookup(rowsByKey.get(job.k)) : await wikiLookup(rowsByKey.get(job.k));
            errors[job.src] = 0;
            if (found) document.dispatchEvent(new CustomEvent("tgdb:cover", { detail: { key: job.k } }));
            schedule(wanted.length ? WANT_GAP : job.src === "tgdb" ? TGDB_GAP : WIKI_GAP);
        } catch (e) {
            // That source rests for a while (longer each time); the other one
            // can carry on meanwhile. A quota refusal also sets pausedUntil.
            errors[job.src]++;
            downUntil[job.src] = Date.now() + Math.min(10 * 60000, 15000 * 2 ** Math.min(errors[job.src], 5));
            write(META_KEY, meta);
            console.warn(`${job.src === "tgdb" ? "TheGamesDB" : "Wikipedia"} lookup failed:`, e.message);
            schedule(WANT_GAP);
        } finally {
            busy = false;
            if (job.src === "tgdb") dropLock();
            // Success or not, the counter and its tooltip reflect the latest state.
            document.dispatchEvent(new CustomEvent("tgdb:status"));
        }
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") schedule(1000);
    });

    // ---- Public ---------------------------------------------------------
    return {
        _pick: pick, // exposed for testing the matcher offline
        cover,
        isMiss,
        keyOf,
        // Collection loaded (or changed): remember every row and queue the
        // ones still wanting art, in list order.
        setRows(rows) {
            rowsByKey.clear();
            const order = [];
            for (const r of rows) {
                const k = keyOf(r);
                if (!k || rowsByKey.has(k)) continue;
                rowsByKey.set(k, r);
                if (needsTgdb(k) || needsWiki(k)) order.push(k);
            }
            fillOrder = order;
            schedule(1500);
        },
        // The game on screen: look it up next.
        want(row) {
            const k = keyOf(row);
            if (!k || (!needsTgdb(k) && !needsWiki(k))) return;
            const i = wanted.indexOf(k);
            if (i >= 0) wanted.splice(i, 1);
            wanted.unshift(k);
            if (!busy) schedule(WANT_GAP);
        },
        status() {
            const total = rowsByKey.size;
            let fromTgdb = 0;
            let fromWiki = 0;
            let misses = 0;
            for (const k of rowsByKey.keys()) {
                if (hasTgdb(k)) fromTgdb++;
                else if (hasWiki(k)) fromWiki++;
                else if (covers[k]?.miss && wiki[k]?.miss) misses++;
            }
            return {
                total,
                cached: fromTgdb + fromWiki,
                fromTgdb,
                fromWiki,
                misses,
                remaining: typeof meta.remaining === "number" ? meta.remaining : null,
                refreshAt: meta.refreshAt || null,
                paused: paused(),
                saving: !paused() && allowanceLeft() < RESERVE,
                proxyBlocked: !!meta.proxyBlocked,
            };
        },
    };
})();
