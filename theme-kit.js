// Theme kit: the plumbing every themed collection page shares.
//
// Load order on a themed page:
//   1. the page's own markup, with [data-kit="controls"] / [data-kit="value"]
//      placeholders and #stats / #cardsGrid / #tableWrap / #wallView /
//      #shelfView placed wherever the theme wants them
//   2. theme-kit.js   – fills the placeholders and injects the overlays, modal,
//                       toasts and loading screen (collection-core.js wires
//                       event handlers to these at load, so they must exist first)
//   3. collection-core.js – data, CeX pricing, filters, modal, extras
//   4. the theme's own script – calls kit.install(), then replaces
//      displayCards / displayStats etc. via window.<name> = function …
//   5. theme-nav.js
//
// Theme scripts must assign overrides through window.* inside an IIFE: core
// declares a lot of top-level const/let names, and redeclaring any of them
// would throw a SyntaxError and take the whole theme script down.
(function () {
    const THEME = (window.THEME = window.THEME || {});
    const L = (key, fallback) =>
        THEME.labels && THEME.labels[key] !== undefined
            ? THEME.labels[key]
            : fallback;

    // ---- Placeholders ------------------------------------------------------
    const controlsHTML = () => `
        <div class="kit-controls">
            <div class="kit-search">
                <input type="text" id="searchBox" autocomplete="off"
                    placeholder="${L("search", "Search title, console, edition, notes…   ( / )")}"
                    oninput="onSearchInput()" />
            </div>
            <div class="seg kit-views">
                <button id="viewGridBtn" class="active" onclick="setView('grid')">${L("grid", "Grid")}</button>
                <button id="viewTableBtn" onclick="setView('table')">${L("table", "Table")}</button>
                <button id="viewWallBtn" onclick="setView('wall')">${L("wall", "Wall")}</button>
                <button id="viewShelfBtn" onclick="setView('shelf')">${L("shelf", "Shelf")}</button>
            </div>
            <button id="refreshButton" onclick="refreshData()" class="ghost-btn" title="Refresh from Google Sheets">
                <span id="refreshIcon">↻</span><span>${L("refresh", "Refresh")}</span>
            </button>
            <div class="relative kit-sort">
                <button id="sortButton" onclick="toggleSortDropdown()" class="ghost-btn">
                    <span id="sortButtonText">Title (A–Z)</span><span class="kit-caret">▾</span>
                </button>
                <div id="sortDropdown" class="hidden kit-dropdown"></div>
            </div>
            <button class="ghost-btn" onclick="toggleBreakdown()">
                <span>${L("breakdown", "Breakdown")}</span>
                <span id="breakdownToggleIcon" class="kit-caret transition-transform">▾</span>
            </button>
            <button class="ghost-btn" onclick="toggleFilters()">
                <span>${L("filters", "Filters")}</span>
                <span id="filterCount" class="hidden kit-badge">0</span>
                <span id="filterToggleIcon" class="kit-caret transition-transform">▾</span>
            </button>
            <div class="kit-extras">
                <button class="ghost-btn" onclick="rollRandomGame()" title="Pick something to play">${L("roll", "🎲")}</button>
                <button class="ghost-btn" onclick="openTrophies()" title="Trophy cabinet">${L("trophies", "🏆")}</button>
                <button class="ghost-btn" onclick="openWrapped()" title="Collection Wrapped">${L("wrapped", "🎁")}</button>
                <button class="ghost-btn" onclick="openGuess()" title="Guess the price">${L("guess", "💷")}</button>
                <button class="ghost-btn" onclick="openHealth()" title="Data health check">${L("health", "🩺")}</button>
                <button class="ghost-btn" onclick="printInventory()" title="Printable inventory / insurance report">${L("print", "🖨")}</button>
            </div>
        </div>
        <div id="breakdownSection" class="kit-panel transition-all duration-300 overflow-hidden collapsed"></div>
        <div id="filtersSection" class="kit-panel transition-all duration-300 overflow-hidden collapsed">
            <div id="filterGroups" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-5"></div>
            <div class="mt-4 flex items-center gap-3 flex-wrap">
                <button class="ghost-btn" onclick="clearAllFilters()">${L("clear", "Clear all filters")}</button>
                <span id="filterSummary" class="kit-summary"></span>
            </div>
        </div>`;

    const TOTALS = [
        ["sell", "totalSell", "CeX retail", "What CeX charges for these games — the basis for Current value and Gain / loss"],
        ["cash", "totalCash", "Trade-in cash", "What CeX would pay YOU in cash to take the lot — trade-in value, always well below retail"],
        ["voucher", "totalVoucher", "Trade-in voucher", "What CeX would pay you in store vouchers — usually a little above the cash offer"],
        ["nolink", "totalNoLink", "No CeX price", "Games with no usable CeX SKU, valued from the sheet's Current Price column"],
        ["paid", "totalPaidAll", "Total paid", "What the whole owned collection cost"],
        ["value", "totalCurrentValue", "Current value", "What CeX sells it for, where known — otherwise the sheet's Current Price"],
        ["gain", "totalGain", "Gain / loss", "Current value minus total paid"],
    ];

    const valueHTML = () => `
        <div class="kit-value">
            <div class="kit-value-head">
                <button id="calcCexBtn" onclick="loadCexPrices(true)" class="accent-btn"
                    title="Re-fetch every CeX price, ignoring the local cache">
                    <span id="calcCexIcon">£</span><span>${L("cex", "Refresh CeX prices")}</span>
                </button>
                <div id="cexStatus" class="kit-status">Waiting for collection data…</div>
            </div>
            <div id="cexTotals" class="kit-totals">
                ${TOTALS.map(
                    ([k, id, label, tip]) => `
                    <div class="kit-total" data-k="${k}" title="${tip}">
                        <div class="kit-total-label">${L("total_" + k, label)}</div>
                        <div class="kit-total-value" id="${id}">—</div>
                    </div>`,
                ).join("")}
            </div>
        </div>`;

    document.querySelectorAll('[data-kit="controls"]').forEach((el) => {
        el.outerHTML = controlsHTML();
    });
    document.querySelectorAll('[data-kit="value"]').forEach((el) => {
        el.outerHTML = valueHTML();
    });

    // ---- Overlays, modal, toasts, loading ----------------------------------
    const close = L("close", "Close");
    document.body.insertAdjacentHTML(
        "beforeend",
        `
        <div id="rollOverlay" class="ov hidden fixed inset-0 z-[450] items-center justify-center">
            <div class="ov-roll text-center">
                <div class="ov-kicker">${L("rollTitle", "Tonight you play")}</div>
                <div id="rollCover" class="ov-roll-cover"></div>
                <div id="rollTitle" class="ov-roll-title"></div>
                <div id="rollConsole" class="ov-roll-console"></div>
            </div>
        </div>

        <div id="trophyOverlay" class="ov hidden fixed inset-0 z-[450] overflow-y-auto scroll-thin p-6 md:p-10">
            <div class="ov-panel max-w-6xl mx-auto">
                <div class="flex items-center justify-between mb-8 gap-4">
                    <div>
                        <h2 class="ov-title">${L("trophyTitle", "Trophy cabinet")}</h2>
                        <p id="trophyScore" class="ov-sub"></p>
                    </div>
                    <button class="ghost-btn ov-close" onclick="closeOverlay('trophyOverlay')">${close}</button>
                </div>
                <div id="trophyGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"></div>
            </div>
        </div>

        <div id="wrappedOverlay" class="ov hidden fixed inset-0 z-[460] items-center justify-center p-6">
            <button class="absolute top-5 right-5 ghost-btn ov-close z-10" onclick="closeOverlay('wrappedOverlay')">${close}</button>
            <div id="wrappedDots" class="absolute top-6 left-1/2 -translate-x-1/2 flex gap-1.5"></div>
            <button class="ov-arrow absolute left-4 top-1/2 -translate-y-1/2" onclick="wrappedStep(-1)">‹</button>
            <button class="ov-arrow absolute right-4 top-1/2 -translate-y-1/2" onclick="wrappedStep(1)">›</button>
            <div id="wrappedSlide" class="max-w-2xl w-full text-center"></div>
        </div>

        <div id="guessOverlay" class="ov hidden fixed inset-0 z-[450] items-center justify-center p-6">
            <div class="ov-panel ov-card max-w-md w-full relative">
                <button class="ov-x absolute top-4 right-4" onclick="closeOverlay('guessOverlay')">×</button>
                <div class="ov-kicker">${L("guessTitle", "Guess the CeX price")}</div>
                <div id="guessBody"></div>
            </div>
        </div>

        <div id="healthOverlay" class="ov hidden fixed inset-0 z-[450] overflow-y-auto scroll-thin p-6 md:p-10">
            <div class="ov-panel max-w-4xl mx-auto">
                <div class="flex items-center justify-between mb-8 gap-4">
                    <div>
                        <h2 class="ov-title">${L("healthTitle", "Data health")}</h2>
                        <p id="healthSummary" class="ov-sub"></p>
                    </div>
                    <button class="ghost-btn ov-close" onclick="closeOverlay('healthOverlay')">${close}</button>
                </div>
                <div id="healthBody" class="flex flex-col gap-3"></div>
            </div>
        </div>

        <div id="printReport"></div>

        <div id="error" class="kit-toast kit-toast-error fixed z-[200] hidden"></div>
        <div id="success" class="kit-toast kit-toast-ok fixed z-[200] hidden"></div>
        <div class="kit-toasts"></div>

        <div id="loadingOverlay" class="kit-loading fixed inset-0 z-[300] hidden items-center justify-center">
            <div class="kit-loading-panel text-center">
                ${THEME.loadingHTML || `<div class="kit-loading-title">${L("loading", "Loading MASTER sheet…")}</div>`}
            </div>
        </div>

        <div id="modal" class="kit-modal hidden fixed inset-0 z-[400] animate-fadeIn items-center justify-center p-5">
            <div class="relative max-w-5xl w-full">
                <div id="modalBox" class="kit-modal-box w-full max-h-[92vh] overflow-hidden animate-slideUp flex flex-col md:flex-row md:items-stretch relative">
                    <button onclick="closeModal()" class="kit-modal-close absolute top-4 right-4 z-10" title="Close">×</button>
                    <img id="modalPoster" class="hidden w-full md:w-[420px] md:min-w-[420px] aspect-[4/5] object-cover md:self-start" alt="" />
                    <div id="modalBody" class="p-8 flex-1 overflow-y-auto scroll-thin"></div>
                </div>
                <button id="modalPrev" onclick="navModal(-1)" title="Previous game"
                    class="kit-modal-nav absolute left-1 sm:left-auto sm:right-full sm:mr-4 top-1/2 -translate-y-1/2 z-20">‹</button>
                <button id="modalNext" onclick="navModal(1)" title="Next game"
                    class="kit-modal-nav absolute right-1 sm:right-auto sm:left-full sm:ml-4 top-1/2 -translate-y-1/2 z-20">›</button>
            </div>
        </div>`,
    );

    // ---- Helpers -------------------------------------------------------------
    const kit = (window.kit = {});

    // Small deterministic hash, for per-card "random" tilts that survive re-renders.
    kit.hash = (s) => {
        let h = 2166136261;
        s = String(s);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) / 4294967295;
    };

    // 0–5 value tier, used for wanted stars, rarities, ranks…
    kit.tier = (value) =>
        [2, 5, 10, 20, 40].filter((t) => value >= t).length;

    // Everything a card needs to know about a row, computed once.
    kit.card = (row) => {
        const paid = rowPaid(row);
        const value = rowValue(row);
        return {
            row,
            title: row["Game"] || "Untitled",
            tbc: isTBC(row),
            sealed: isSealed(row),
            completed: isCompleted(row),
            complete: isComplete(row),
            edition: editionOf(row),
            consoleName: normalizeConsole(row["Console Version"]),
            date: row["Date Purchased"] || "",
            dup: isDuplicate(row),
            paid,
            value,
            gain: value - paid,
            gainPct: paid > 0 ? ((value - paid) / paid) * 100 : 0,
            priced: rowCexValue(row) !== null,
            hasCex: rowSkus(row).length > 0,
            cover: coverFromRow(row, "m"),
            coverS: coverFromRow(row, "s"),
            coverL: coverFromRow(row, "l"),
            delta: deltaBadge(row),
            pills: completenessPills(row),
            tier: kit.tier(value),
            hasCoverArt: hasCover(row),
            hasInsert: hasInsert(row),
        };
    };

    kit.img = (src, cls = "", alt = "") =>
        src
            ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="${cls}" loading="lazy" decoding="async" onerror="this.remove()" />`
            : "";

    // RAWG fallback for rows CeX can't picture. Holds the element itself so a
    // re-render can't send the image to a different game.
    kit.coverFallback = (el, c, cls = "kit-fallback-img") => {
        if (c.cover || !el) return;
        fetchGameCover(c.row["Game"], c.consoleName).then((url) => {
            if (!url || !el.isConnected) return;
            const img = document.createElement("img");
            img.src = url;
            img.alt = c.title;
            img.className = cls;
            img.loading = "lazy";
            el.insertBefore(img, el.firstChild);
            el.classList.add("has-fallback");
        });
    };

    kit.empty = (msg = L("empty", "No games match the current filters.")) =>
        `<p class="kit-empty">${escapeHtml(msg)}</p>`;

    kit.stats = () => {
        const owned = allData.filter((r) => !isTBC(r));
        const t = collectionTotals(allData);
        const completed = owned.filter(isCompleted).length;
        return {
            owned,
            games: owned.length,
            toBuy: allData.length - owned.length,
            consoles: new Set(
                owned.map((r) => normalizeConsole(r["Console Version"])),
            ).size,
            paid: t.paid,
            value: t.value,
            gain: t.gain,
            priced: t.priced,
            gainPct: t.paid > 0 ? Math.round((t.gain / t.paid) * 100) : 0,
            completed,
            completedPct: owned.length
                ? Math.round((completed / owned.length) * 100)
                : 0,
            sealed: owned.filter(isSealed).length,
            complete: owned.filter(isComplete).length,
            totals: t,
        };
    };

    kit.countUp = (el, to, fmt = (n) => Math.round(n), ms = 900) => {
        if (!el) return;
        const from = Number(el.dataset.n || 0);
        el.dataset.n = to;
        const t0 = performance.now();
        const step = (t) => {
            const p = Math.min(1, (t - t0) / ms);
            const e = 1 - Math.pow(1 - p, 3);
            el.textContent = fmt(from + (to - from) * e);
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    };

    kit.toast = (html, cls = "", ms = 3800) => {
        const host = document.querySelector(".kit-toasts");
        const el = document.createElement("div");
        el.className = `kit-pop ${cls}`;
        el.innerHTML = html;
        host.appendChild(el);
        requestAnimationFrame(() => el.classList.add("in"));
        setTimeout(() => {
            el.classList.remove("in");
            el.classList.add("out");
            setTimeout(() => el.remove(), 600);
        }, ms);
        return el;
    };

    // ---- Sound effects (synthesised, off until the visitor turns them on) ---
    let audio = null;
    kit.sfxOn = () => {
        try {
            return localStorage.getItem("themeSfx") === "1";
        } catch (e) {
            return false;
        }
    };
    kit.toggleSfx = () => {
        const on = !kit.sfxOn();
        try {
            localStorage.setItem("themeSfx", on ? "1" : "0");
        } catch (e) {}
        document
            .querySelectorAll(".kit-sfx")
            .forEach((b) => b.classList.toggle("on", on));
        document
            .querySelectorAll(".kit-sfx-label")
            .forEach((s) => (s.textContent = on ? "Sound on" : "Sound off"));
        if (on) kit.sfx(THEME.sfxDemo || "click");
    };
    kit.sfxButton = (cls = "") =>
        `<button class="kit-sfx ${cls} ${kit.sfxOn() ? "on" : ""}" onclick="kit.toggleSfx()" title="Toggle sound effects">
            <span aria-hidden="true">♪</span><span class="kit-sfx-label">${kit.sfxOn() ? "Sound on" : "Sound off"}</span>
        </button>`;

    kit.sfx = (kind) => {
        if (!kit.sfxOn()) return;
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            if (audio.state === "suspended") audio.resume();
        } catch (e) {
            return;
        }
        const ctx = audio;
        const now = ctx.currentTime;
        const tone = (freq, start, dur, type = "sine", vol = 0.12, endFreq) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = type;
            o.frequency.setValueAtTime(freq, now + start);
            if (endFreq)
                o.frequency.exponentialRampToValueAtTime(endFreq, now + start + dur);
            g.gain.setValueAtTime(0.0001, now + start);
            g.gain.exponentialRampToValueAtTime(vol, now + start + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
            o.connect(g).connect(ctx.destination);
            o.start(now + start);
            o.stop(now + start + dur + 0.05);
        };
        const noise = (start, dur, vol = 0.3, freq = 1200) => {
            const len = Math.floor(ctx.sampleRate * dur);
            const buf = ctx.createBuffer(1, len, ctx.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < len; i++)
                d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const f = ctx.createBiquadFilter();
            f.type = "lowpass";
            f.frequency.value = freq;
            const g = ctx.createGain();
            g.gain.value = vol;
            src.connect(f).connect(g).connect(ctx.destination);
            src.start(now + start);
        };
        switch (kind) {
            case "chime": // achievement bloop
                tone(880, 0, 0.18, "sine", 0.1);
                tone(1318.5, 0.09, 0.35, "sine", 0.1);
                break;
            case "hit": // hitmarker tick
                tone(2400, 0, 0.04, "square", 0.05);
                noise(0, 0.05, 0.2, 5000);
                break;
            case "shot": // distant revolver
                noise(0, 0.5, 0.6, 900);
                tone(120, 0, 0.25, "sine", 0.2, 40);
                break;
            case "pass": // mission passed flourish
                [523, 659, 784, 1046].forEach((f, i) =>
                    tone(f, i * 0.09, 0.3, "triangle", 0.09),
                );
                break;
            case "wasted":
                tone(330, 0, 0.9, "sawtooth", 0.06, 80);
                noise(0, 0.6, 0.15, 400);
                break;
            case "blip": // pip-boy
                tone(1500, 0, 0.05, "square", 0.04);
                break;
            case "pop": // block pop
                tone(600, 0, 0.08, "sine", 0.12, 1400);
                break;
            default:
                tone(1000, 0, 0.05, "triangle", 0.06);
        }
    };

    // ---- Core hooks (call once, after collection-core.js has loaded) --------
    kit.wrap = (name, make) => {
        const orig = window[name];
        window[name] = make(orig);
    };

    kit.install = () => {
        kit.wrap("updateValueStrip", (orig) => function () {
            orig.apply(this, arguments);
            // Core rewrites #totalGain's className with Tailwind sizing; put the
            // theme hook back and expose the sign for styling.
            const g = document.getElementById("totalGain");
            const t = collectionTotals(allData);
            g.className = `kit-total-value ${t.gain >= 0 ? "is-up" : "is-down"}`;
            if (THEME.onValue) THEME.onValue(t);
        });
        kit.wrap("openModal", (orig) => function (row, index) {
            const p = orig.call(this, row, index);
            if (THEME.onModal) {
                try {
                    THEME.onModal(row);
                } catch (e) {
                    console.warn(e);
                }
            }
            return p;
        });
        kit.wrap("render", (orig) => function () {
            orig.apply(this, arguments);
            if (THEME.onRender) THEME.onRender();
        });
        kit.wrap("parseCSV", (orig) => function () {
            const ok = orig.apply(this, arguments);
            if (ok && THEME.onData) THEME.onData();
            return ok;
        });
    };
})();
