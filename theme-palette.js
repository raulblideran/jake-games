// Palette helper for the themed pages' Tailwind configs. Core and the shared
// overlays emit stock Tailwind classes (text-zinc-500, bg-white/5,
// text-emerald-400…), so a theme recolours all of that output at once by
// remapping those palettes rather than restyling every element.
//
// ramp(a, b) spreads a colour scale from `a` at 50 to `b` at 950. Dark themes
// go light → dark like stock Tailwind; light (paper) themes pass dark → light
// so "text-zinc-100" (the brightest text on a dark page) becomes the darkest ink.
window.ramp = function (a, b) {
    const hex = (h) => {
        h = h.replace("#", "");
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    };
    const pa = hex(a);
    const pb = hex(b);
    const keys = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const out = {};
    keys.forEach((k, i) => {
        const t = i / (keys.length - 1);
        out[k] =
            "#" +
            pa
                .map((c, j) =>
                    Math.round(c + (pb[j] - c) * t)
                        .toString(16)
                        .padStart(2, "0"),
                )
                .join("");
    });
    return out;
};
