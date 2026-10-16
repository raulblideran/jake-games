// Theme switcher bar, shared by every version of the collection page.
// Each theme styles it through the --tnav-* custom properties (or by
// targeting .tnav directly). Switching carries the current search, sort,
// view and filters across, since every theme reads the same URL state.
(function () {
    const THEMES = [
        ["index.html", "Original", "◼"],
        ["rdr.html", "Red Dead", "🤠"],
        ["xbox.html", "Xbox 360", "🟢"],
        ["cod.html", "Call of Duty", "🎯"],
        ["gta.html", "Vice City", "🌴"],
        ["fallout.html", "Pip-Boy", "☢"],
        ["minecraft.html", "Minecraft", "⛏"],
    ];

    const here = location.pathname.split("/").pop() || "index.html";
    const current = Math.max(
        0,
        THEMES.findIndex(([file]) => file === here),
    );

    const style = document.createElement("style");
    style.textContent = `
        .tnav {
            position: sticky; top: 0; z-index: 350;
            display: flex; align-items: center; gap: 6px;
            padding: 8px 12px;
            overflow-x: auto; scrollbar-width: none;
            background: var(--tnav-bg, rgba(10,10,10,0.88));
            border-bottom: 1px solid var(--tnav-border, rgba(255,255,255,0.08));
            backdrop-filter: blur(10px);
            font-family: var(--tnav-font, inherit);
        }
        .tnav::-webkit-scrollbar { display: none; }
        .tnav-label {
            font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
            color: var(--tnav-muted, #71717a); padding-right: 6px; white-space: nowrap;
        }
        .tnav a {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 6px 12px; white-space: nowrap;
            font-size: 12px; font-weight: 600; text-decoration: none;
            color: var(--tnav-fg, #d4d4d8);
            border: 1px solid var(--tnav-btn-border, rgba(255,255,255,0.1));
            border-radius: var(--tnav-radius, 999px);
            background: var(--tnav-btn-bg, transparent);
            transition: all 0.15s ease;
        }
        .tnav a:hover { color: var(--tnav-hover-fg, #fff); border-color: var(--tnav-active-bg, #22d3ee); }
        .tnav a.on {
            background: var(--tnav-active-bg, #22d3ee);
            border-color: var(--tnav-active-bg, #22d3ee);
            color: var(--tnav-active-fg, #06212a);
        }
        .tnav-keys { margin-left: auto; font-size: 10px; color: var(--tnav-muted, #71717a); white-space: nowrap; padding-left: 8px; }
        @media (max-width: 640px) { .tnav-keys { display: none; } }
        @media print { .tnav { display: none !important; } }
    `;
    document.head.appendChild(style);

    const go = (file) => {
        location.href = file + location.search;
    };

    const nav = document.createElement("nav");
    nav.className = "tnav";
    nav.setAttribute("aria-label", "Page theme");
    nav.innerHTML =
        `<span class="tnav-label">Theme</span>` +
        THEMES.map(
            ([file, label, icon], i) =>
                `<a href="${file}" data-file="${file}" class="${i === current ? "on" : ""}"${
                    i === current ? ' aria-current="page"' : ""
                }><span aria-hidden="true">${icon}</span>${label}</a>`,
        ).join("") +
        `<span class="tnav-keys">[ ] to switch</span>`;
    nav.querySelectorAll("a").forEach((a) => {
        a.onclick = (e) => {
            e.preventDefault();
            go(a.dataset.file);
        };
    });
    document.body.insertBefore(nav, document.body.firstChild);

    document.addEventListener("keydown", (e) => {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        if (e.key !== "[" && e.key !== "]") return;
        const dir = e.key === "]" ? 1 : -1;
        go(THEMES[(current + dir + THEMES.length) % THEMES.length][0]);
    });
})();
