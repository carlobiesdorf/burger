// Einbürgerungstest — i18n module
// Loads /i18n/<lang>.json on demand, exposes window.EinbI18n.{t,setLang,...}
(function () {
    'use strict';

    const STORAGE_KEY = 'einbuergerung_lang_v1';
    const FALLBACK_LANG = 'de';
    const SUPPORTED = [
        { code: 'pt', name: 'Português',  native: 'Português',  flag: '🇧🇷', rtl: false },
        { code: 'en', name: 'English',    native: 'English',    flag: '🇬🇧', rtl: false },
        { code: 'es', name: 'Español',    native: 'Español',    flag: '🇪🇸', rtl: false },
        { code: 'uk', name: 'Українська', native: 'Українська', flag: '🇺🇦', rtl: false },
        { code: 'tr', name: 'Türkçe',     native: 'Türkçe',     flag: '🇹🇷', rtl: false },
        { code: 'ar', name: 'العربية',    native: 'العربية',    flag: '🇸🇦', rtl: true  },
        { code: 'fa', name: 'فارسی',     native: 'فارسی',      flag: '🇮🇷', rtl: true  },
    ];

    const dicts = {};   // {lang: {nested object}}
    let currentLang = null;
    const listeners = new Set();

    async function loadDict(lang) {
        if (dicts[lang]) return dicts[lang];
        try {
            const r = await fetch(`/i18n/${lang}.json`, { credentials: 'omit' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            dicts[lang] = await r.json();
            return dicts[lang];
        } catch (e) {
            console.warn(`[i18n] failed to load ${lang}:`, e);
            dicts[lang] = null;
            return null;
        }
    }

    function dotGet(obj, path) {
        if (!obj) return undefined;
        const parts = path.split('.');
        let cur = obj;
        for (const p of parts) {
            if (cur == null || typeof cur !== 'object') return undefined;
            cur = cur[p];
        }
        return cur;
    }

    function interp(s, vars) {
        if (typeof s !== 'string' || !vars) return s;
        return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    }

    function t(key, vars) {
        const lang = currentLang;
        let val = dotGet(dicts[lang], key);
        if (val == null) val = dotGet(dicts[FALLBACK_LANG], key);
        if (val == null) val = key; // last resort: show key
        return interp(val, vars);
    }

    function isRTL(lang) {
        return (SUPPORTED.find(l => l.code === (lang || currentLang)) || {}).rtl === true;
    }

    function applyDocLangDir() {
        const html = document.documentElement;
        html.setAttribute('lang', currentLang || FALLBACK_LANG);
        html.setAttribute('dir', isRTL() ? 'rtl' : 'ltr');
    }

    // Apply data-i18n="key" + data-i18n-attr="attr1,key1;attr2,key2"
    function applyDOM(root = document) {
        root.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const v = t(key);
            if (v) el.textContent = v;
        });
        root.querySelectorAll('[data-i18n-attr]').forEach(el => {
            const spec = el.getAttribute('data-i18n-attr');
            spec.split(';').forEach(pair => {
                const [attr, key] = pair.split(',').map(s => s && s.trim());
                if (!attr || !key) return;
                const v = t(key);
                if (v) el.setAttribute(attr, v);
            });
        });
    }

    async function setLang(lang, opts = {}) {
        if (!SUPPORTED.find(l => l.code === lang)) return;
        currentLang = lang;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
        await loadDict(lang);
        if (lang !== FALLBACK_LANG) await loadDict(FALLBACK_LANG); // safety net
        applyDocLangDir();
        applyDOM();
        listeners.forEach(fn => { try { fn(lang); } catch (e) { console.error(e); } });
    }

    function getLang() { return currentLang; }
    function supported() { return SUPPORTED.slice(); }
    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    function readStoredLang() {
        try {
            const v = localStorage.getItem(STORAGE_KEY);
            if (v && SUPPORTED.find(l => l.code === v)) return v;
        } catch {}
        return null;
    }

    async function init() {
        const stored = readStoredLang();
        // Preload de.json as fallback always
        await loadDict(FALLBACK_LANG);
        if (stored) await setLang(stored);
        else applyDocLangDir(); // still set <html lang="de" dir="ltr">
    }

    window.EinbI18n = {
        init, t, setLang, getLang, supported, isRTL, applyDOM, onChange,
        FALLBACK_LANG,
    };
})();
