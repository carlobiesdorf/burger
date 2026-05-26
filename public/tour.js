// Einbürgerungstest – self-contained onboarding tour (no external libs)
// Exposes window.EinbTour
(function () {
    'use strict';

    const DONE_KEY = 'einb_tour_done_v1';
    let currentStep = 0;
    let steps = [];
    let onDone = null;

    const t = (key) => (window.EinbI18n ? window.EinbI18n.t(key) : key);
    const tr = (titleKey, bodyKey) => ({ titleKey, bodyKey });

    // ----- default steps (only selectors + i18n keys) -----
    function defaultSteps() {
        return [
            { selector: '#screen-home h2', ...tr('tour.step_welcome_title', 'tour.step_welcome_body'), placement: 'bottom' },
            { selector: '.mode-card[data-mode="study"]', ...tr('tour.step_lernmodus_title', 'tour.step_lernmodus_body'), placement: 'right' },
            { selector: '.mode-card[data-mode="exam"]',  ...tr('tour.step_pruefungsmodus_title', 'tour.step_pruefungsmodus_body'), placement: 'left' },
            { selector: '#aptitude-card', ...tr('tour.step_progress_title', 'tour.step_progress_body'), placement: 'bottom' },
            { selector: '#home-glossary', ...tr('tour.step_wortschatz_title', 'tour.step_wortschatz_body'), placement: 'left' },
            { selector: '#favorites-card', ...tr('tour.step_favorites_title', 'tour.step_favorites_body'), placement: 'top', forceVisible: true },
            { selector: '#btn-study-favorites', ...tr('tour.step_favorites_study_title', 'tour.step_favorites_study_body'), placement: 'top', forceVisible: true },
            { selector: '#einb-trial-slot', ...tr('tour.step_trial_title', 'tour.step_trial_body'), placement: 'bottom', optional: true },
            { selector: '#einb-auth-slot', ...tr('tour.step_account_title', 'tour.step_account_body'), placement: 'bottom' },
            { selector: '.lang-toggle, #einb-lang-grid', ...tr('tour.step_language_title', 'tour.step_language_body'), placement: 'bottom' },
            { selector: 'header h1', ...tr('tour.step_done_title', 'tour.step_done_body'), placement: 'bottom', isLast: true },
        ];
    }

    // ----- DOM helpers -----
    function ensureRoot() {
        let r = document.getElementById('einb-tour-root');
        if (!r) {
            r = document.createElement('div');
            r.id = 'einb-tour-root';
            r.innerHTML = `
                <div class="einb-tour-overlay" aria-hidden="true"></div>
                <div class="einb-tour-spotlight" aria-hidden="true"></div>
                <div class="einb-tour-popover" role="dialog" aria-modal="true">
                    <div class="einb-tour-arrow"></div>
                    <div class="einb-tour-title"></div>
                    <div class="einb-tour-body"></div>
                    <div class="einb-tour-foot">
                        <span class="einb-tour-count"></span>
                        <div class="einb-tour-actions">
                            <button class="einb-tour-skip" type="button"></button>
                            <button class="einb-tour-prev" type="button"></button>
                            <button class="einb-tour-next btn-primary" type="button"></button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(r);
            r.querySelector('.einb-tour-skip').addEventListener('click', stop);
            r.querySelector('.einb-tour-prev').addEventListener('click', prev);
            r.querySelector('.einb-tour-next').addEventListener('click', next);
            r.querySelector('.einb-tour-overlay').addEventListener('click', stop);
            document.addEventListener('keydown', onKey);
            window.addEventListener('resize', () => positionFor(currentStep));
            window.addEventListener('scroll', () => positionFor(currentStep), { passive: true });
        }
        return r;
    }
    function onKey(e) {
        if (!isOpen()) return;
        if (e.key === 'Escape') stop();
        else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
        else if (e.key === 'ArrowLeft') prev();
    }
    function isOpen() {
        const r = document.getElementById('einb-tour-root');
        return r && r.classList.contains('open');
    }

    // Restore any temporarily-shown elements when leaving a step.
    const _tempShown = [];
    function restoreTempShown() {
        while (_tempShown.length) {
            const el = _tempShown.pop();
            el.classList.add('hidden');
        }
    }

    // ----- spotlight + popover positioning -----
    function positionFor(idx) {
        const r = ensureRoot();
        restoreTempShown();
        const step = steps[idx];
        if (!step) { stop(); return; }
        let target = document.querySelector(step.selector);
        // forceVisible: temporarily reveal a hidden element so we can highlight it
        // (e.g. favorites-card is hidden when the user has no favorites yet).
        if (step.forceVisible && target && target.classList.contains('hidden')) {
            target.classList.remove('hidden');
            _tempShown.push(target);
        }
        // Also try parent containers that may hide our target
        if (step.forceVisible && target) {
            let p = target.parentElement;
            while (p && p !== document.body) {
                if (p.classList && p.classList.contains('hidden')) {
                    p.classList.remove('hidden');
                    _tempShown.push(p);
                }
                p = p.parentElement;
            }
        }
        if (!target) {
            // skip silently if element not present (e.g. trial badge hidden after subscribe)
            if (step.optional || idx < steps.length - 1) { currentStep++; positionFor(currentStep); return; }
            stop(); return;
        }
        const rect = target.getBoundingClientRect();
        const pad = 6;
        const sp = r.querySelector('.einb-tour-spotlight');
        sp.style.top  = (rect.top - pad) + 'px';
        sp.style.left = (rect.left - pad) + 'px';
        sp.style.width  = (rect.width + 2 * pad) + 'px';
        sp.style.height = (rect.height + 2 * pad) + 'px';

        const pop = r.querySelector('.einb-tour-popover');
        pop.querySelector('.einb-tour-title').textContent = t(step.titleKey);
        pop.querySelector('.einb-tour-body').textContent  = t(step.bodyKey);
        pop.querySelector('.einb-tour-count').textContent = `${idx + 1} / ${steps.length}`;

        const skip = pop.querySelector('.einb-tour-skip');
        const prevBtn = pop.querySelector('.einb-tour-prev');
        const nextBtn = pop.querySelector('.einb-tour-next');
        skip.textContent = t('tour.skip');
        prevBtn.textContent = t('tour.back');
        nextBtn.textContent = step.isLast ? t('tour.done') : t('tour.next');
        prevBtn.disabled = idx === 0;
        prevBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';

        // popover placement
        const place = step.placement || 'bottom';
        const popW = 320;
        const margin = 14;
        let top, left, arrow;
        if (place === 'bottom') {
            top = rect.bottom + margin;
            left = rect.left + rect.width / 2 - popW / 2;
            arrow = 'top';
        } else if (place === 'top') {
            top = rect.top - margin - 200;
            left = rect.left + rect.width / 2 - popW / 2;
            arrow = 'bottom';
        } else if (place === 'left') {
            top = rect.top + rect.height / 2 - 80;
            left = rect.left - popW - margin;
            arrow = 'right';
        } else { // right
            top = rect.top + rect.height / 2 - 80;
            left = rect.right + margin;
            arrow = 'left';
        }
        // clamp into viewport
        const vw = window.innerWidth, vh = window.innerHeight;
        left = Math.max(8, Math.min(left, vw - popW - 8));
        top  = Math.max(8, Math.min(top, vh - 220));
        pop.style.top = top + 'px';
        pop.style.left = left + 'px';
        pop.style.width = popW + 'px';
        pop.dataset.arrow = arrow;

        // scroll target into view if needed
        if (rect.top < 60 || rect.bottom > vh - 100) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // ----- API -----
    function start(customSteps, opts = {}) {
        steps = customSteps || defaultSteps();
        currentStep = 0;
        onDone = opts.onDone || null;
        const r = ensureRoot();
        r.classList.add('open');
        // small delay to let layout settle (auth slot, badges)
        setTimeout(() => positionFor(0), 50);
    }
    function next() {
        if (currentStep >= steps.length - 1) { complete(); return; }
        currentStep++;
        positionFor(currentStep);
    }
    function prev() {
        if (currentStep === 0) return;
        currentStep--;
        positionFor(currentStep);
    }
    function stop() {
        const r = document.getElementById('einb-tour-root');
        if (r) r.classList.remove('open');
        restoreTempShown();
        try { localStorage.setItem(DONE_KEY, '1'); } catch {}
    }
    function complete() {
        stop();
        if (onDone) onDone();
    }
    function reset() { try { localStorage.removeItem(DONE_KEY); } catch {} }
    function isDone() { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; } }

    // Auto-start on first visit after language is chosen and home screen visible
    function autoStartIfNeeded() {
        if (isDone()) return;
        // ensure home is visible and not the welcome screen
        const home = document.getElementById('screen-home');
        if (!home || home.classList.contains('hidden')) return;
        // small delay so EinbAuth has rendered the header slots
        setTimeout(() => start(), 400);
    }

    window.EinbTour = { start, stop, reset, isDone, autoStartIfNeeded };
})();
