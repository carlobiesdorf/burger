// Einbürgerungstest — states-map.js
// Renders an interactive SVG map of the 16 German Bundesländer using the
// real Germany SVG (germany.svg, ~111 KB, sourced from simplemaps.com,
// commercial-use free; CC0 by Pareto Software, LLC).
// Exposes window.EinbStateMap.{render, setSelected, onSelect, codes, ...}.
(function () {
    'use strict';

    // Approximate label positions inside each state (from upstream SVG's label_points).
    // viewBox: 0 0 1000 1000. x/y are SVG coords; the renderer adds an overlay <text>.
    const LABELS = {
        SH: { x: 448.9, y: 170 },
        HH: { x: 472.5, y: 233.3 },
        NI: { x: 463.1, y: 360.1 },
        HB: { x: 381.4, y: 289.2 },
        MV: { x: 670.0, y: 205.4 },
        BB: { x: 768.2, y: 411.9 },
        BE: { x: 718.0, y: 359.0 },
        ST: { x: 590.3, y: 429.6 },
        NW: { x: 278.9, y: 479.5 },
        HE: { x: 411.3, y: 567.5 },
        TH: { x: 535.9, y: 550.5 },
        SN: { x: 710.3, y: 538.8 },
        RP: { x: 268.5, y: 642.2 },
        SL: { x: 248.9, y: 720.5 },
        BW: { x: 401.1, y: 819.7 },
        BY: { x: 588.3, y: 791.2 },
    };

    // Distinct soft pastel colors per state (accessible contrast against white labels).
    const COLORS = {
        SH: '#cfe8d4', HH: '#a3c3ee', NI: '#f0d59a', HB: '#90b8ec',
        MV: '#d8c4e2', BB: '#f9c89b', BE: '#7da7e1', ST: '#bcd8a1',
        NW: '#f3aeb0', HE: '#cdd8a0', TH: '#e3a8b2', SN: '#b2d6c6',
        RP: '#e7b9d2', SL: '#dab7e8', BW: '#f4c685', BY: '#ade1d6',
    };

    const codes = Object.keys(LABELS);
    const callbacks = new Set();
    let currentSelected = null;
    let stateData = null;
    let svgEl = null;     // reference to the active SVG element
    let pending = null;   // promise of the fetch
    const MAP_URL = 'germany.svg?v=20260526';

    async function fetchMap() {
        if (pending) return pending;
        pending = fetch(MAP_URL, { credentials: 'omit' })
            .then(r => r.ok ? r.text() : Promise.reject(new Error('Map HTTP ' + r.status)))
            .then(text => text);
        return pending;
    }

    async function render(rootEl, opts) {
        opts = opts || {};
        if (!rootEl) return;
        let mapSvg;
        try {
            mapSvg = await fetchMap();
        } catch (e) {
            console.warn('[states-map] fetch failed:', e);
            rootEl.innerHTML = '<p style="color:#888">⚠ Karte konnte nicht geladen werden.</p>';
            return;
        }
        // Inject into root and post-process.
        rootEl.innerHTML = mapSvg;
        svgEl = rootEl.querySelector('svg');
        if (!svgEl) return;
        svgEl.classList.add('einb-state-map-svg');
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
        svgEl.style.width = '100%';
        svgEl.style.height = 'auto';

        // Decorate each state path: color, code attribute, click handler.
        codes.forEach(code => {
            const p = svgEl.querySelector('#DE' + code);
            if (!p) return;
            p.setAttribute('fill', COLORS[code] || '#dddddd');
            p.setAttribute('stroke', '#333');
            p.setAttribute('stroke-width', '0.8');
            p.classList.add('einb-state');
            p.setAttribute('data-code', code);
            p.setAttribute('tabindex', '0');
            p.setAttribute('role', 'button');
            // <title> child for native tooltip + a11y
            let title = p.querySelector('title');
            if (!title) {
                const ns = 'http://www.w3.org/2000/svg';
                title = document.createElementNS(ns, 'title');
                p.appendChild(title);
            }
            title.textContent = stateName(code, currentLang());

            p.addEventListener('click', () => select(code));
            p.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(code); }
            });
        });

        // Overlay labels (state codes) at label_points.
        const ns = 'http://www.w3.org/2000/svg';
        const labelGroup = document.createElementNS(ns, 'g');
        labelGroup.setAttribute('id', 'einb-state-labels');
        labelGroup.setAttribute('pointer-events', 'none');
        codes.forEach(code => {
            const pos = LABELS[code];
            if (!pos) return;
            const t = document.createElementNS(ns, 'text');
            t.setAttribute('x', String(pos.x));
            t.setAttribute('y', String(pos.y));
            t.setAttribute('text-anchor', 'middle');
            t.setAttribute('dominant-baseline', 'central');
            t.setAttribute('class', 'einb-state-code');
            t.setAttribute('data-code', code);
            t.textContent = code;
            labelGroup.appendChild(t);
        });
        svgEl.appendChild(labelGroup);

        if (opts.compact) rootEl.classList.add('einb-state-map-compact');
        applySelectionStyle();
    }

    function select(code) {
        if (!codes.includes(code)) return;
        currentSelected = code;
        applySelectionStyle();
        callbacks.forEach(cb => { try { cb(code); } catch (e) { console.warn(e); } });
    }

    function applySelectionStyle() {
        if (!svgEl) return;
        svgEl.querySelectorAll('.einb-state').forEach(p => {
            p.classList.toggle('selected', p.getAttribute('data-code') === currentSelected);
        });
        svgEl.querySelectorAll('#einb-state-labels text').forEach(t => {
            t.classList.toggle('selected', t.getAttribute('data-code') === currentSelected);
        });
    }

    function setSelected(code) {
        currentSelected = code;
        applySelectionStyle();
    }

    function onSelect(cb) { callbacks.add(cb); }

    function setData(s) { stateData = s; }
    function getData() { return stateData; }

    function stateName(code, lang) {
        if (!stateData || !stateData.states) return code;
        const e = stateData.states.find(s => s.code === code);
        if (!e) return code;
        return (e.name && (e.name[lang] || e.name.de)) || code;
    }

    function currentLang() {
        try {
            return (window.EinbI18n && window.EinbI18n.getLang && window.EinbI18n.getLang()) || 'de';
        } catch (e) { return 'de'; }
    }

    function refreshLabels() {
        if (!svgEl) return;
        const lang = currentLang();
        codes.forEach(code => {
            const path = svgEl.querySelector('#DE' + code);
            if (path) {
                const title = path.querySelector('title');
                if (title) title.textContent = stateName(code, lang);
            }
        });
    }

    window.EinbStateMap = {
        render, select, setSelected, onSelect, codes,
        setData, getData, stateName, refreshLabels,
    };
})();
