// Einbürgerungstest – Bayern
// Lernmodus + Prüfungsmodus mit Glossar

const state = {
    questions: [],
    translations: {},
    glossary: {},
    states: null,           // states.json contents
    land: null,             // selected Bundesland code (e.g., 'BY'); null until chosen
    mode: 'study',          // 'study' | 'exam'
    lang: null,             // 'pt' | 'en' — null until user chose
    quizQuestions: [],      // active set (with shuffled options)
    currentIndex: 0,
    answers: {},            // {questionId: optionIndex (in shuffled order)}
    glossaryWords: [],      // collected words {de, pt, en}
    timer: null,
    timeLeft: 60 * 60,
    examFinished: false,
    favorites: [],          // array of question IDs (most recent first)
    questionStats: {},      // { [qid]: { lastCorrect: bool, correct: int, wrong: int } }
};

const FAVORITES_KEY = 'einbuergerung_favorites_v1';
const GLOSSARY_KEY = 'einbuergerung_glossary_v1';
const LANG_KEY = 'einbuergerung_lang_v1';
const LAND_KEY = 'einbuergerung_land_v1';
const STATS_KEY = 'einbuergerung_stats_v1';
const DEFAULT_LAND = 'BY';
const SUPPORTED_LANGS = ['pt', 'en', 'es', 'uk', 'tr', 'ar', 'fa'];
const LANG_LABELS = { pt: 'Português', en: 'English', tr: 'Türkçe', ar: 'العربية', fa: 'فارسی' };

// Shortcut to i18n.t (graceful fallback if i18n.js failed to load)
const T = (key, vars) => (window.EinbI18n ? window.EinbI18n.t(key, vars) : key);

function getTrans(qid) {
    const entry = state.translations[qid];
    if (!entry) return null;
    // Fallback chain: current lang -> en -> pt -> first available
    return entry[state.lang] || entry.en || entry.pt || Object.values(entry)[0] || null;
}

function glossaryValue(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return entry; // backward-compat
    return entry[state.lang] || entry.en || entry.pt || Object.values(entry)[0] || null;
}

const EXAM_TIME_SEC = 60 * 60;
const EXAM_QUESTIONS_GENERAL = 30;
const EXAM_QUESTIONS_BAYERN = 3;
const PASS_THRESHOLD = 17;

const $ = (id) => document.getElementById(id);

// -- DATA LOADING --
async function loadData() {
    const [q, t, g, s] = await Promise.all([
        fetch('data/questions.json?v=20260526').then(r => r.json()),
        fetch('data/translations.json?v=20260526').then(r => r.json()),
        fetch('data/glossary.json?v=20260526').then(r => r.json()),
        fetch('data/states.json?v=20260526').then(r => r.json()).catch(() => null),
    ]);
    state.questions = q;
    state.translations = t;
    state.glossary = g;
    state.states = s;
    if (window.EinbStateMap && s) window.EinbStateMap.setData(s);
}

// -- SCREEN ROUTING --
function show(screen) {
    ['screen-welcome', 'screen-home', 'screen-quiz', 'screen-result'].forEach(id => {
        const el = $(id);
        if (el) el.classList.toggle('hidden', id !== screen);
    });
}

// -- MODE SWITCHING --
function setMode(mode) {
    state.mode = mode;
    $('btn-mode-study').classList.toggle('active', mode === 'study');
    $('btn-mode-exam').classList.toggle('active', mode === 'exam');
}

// Header mode buttons should also launch the quiz directly.
function selectModeAndStart(mode) {
    if (state.mode === 'exam' && !state.examFinished && !$('screen-quiz').classList.contains('hidden')) {
        if (!confirm(T('quiz.confirm_abort'))) return;
        stopTimer();
    }
    setMode(mode);
    if (mode === 'study') startStudy();
    else startExam();
}

// -- SHUFFLING --
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Build a quiz-question with shuffled options.
// Keeps mapping from new index -> original index so translations still match.
function prepareQuestion(q) {
    const indices = shuffle(q.options.map((_, i) => i));
    return {
        id: q.id,
        category: q.category,
        question: q.question,
        options: indices.map(i => q.options[i]),
        correct: indices.indexOf(q.correct),
        _origMap: indices,   // newIdx -> origIdx
        image: q.image || null,
        option_images: q.option_images ? indices.map(i => q.option_images[i]) : null,
    };
}

// -- QUIZ START --
function startStudy() {
    state.mode = 'study';
    state.quizQuestions = shuffle(activeQuestions()).map(prepareQuestion);
    state.currentIndex = 0;
    state.answers = {};
    state.examFinished = false;
    show('screen-quiz');
    $('timer').classList.add('hidden');
    $('btn-translate').classList.remove('hidden');
    $('btn-finish').classList.add('hidden');
    $('glossary-panel').classList.remove('hidden');
    renderQuestion();
}

function startStudyFavorites() {
    if (state.favorites.length === 0) return;
    state.mode = 'study';
    setMode('study');
    const favQs = state.favorites
        .map(id => state.questions.find(q => q.id === id))
        .filter(Boolean);
    state.quizQuestions = shuffle(favQs).map(prepareQuestion);
    state.currentIndex = 0;
    state.answers = {};
    state.examFinished = false;
    show('screen-quiz');
    $('timer').classList.add('hidden');
    $('btn-translate').classList.remove('hidden');
    $('btn-finish').classList.add('hidden');
    $('glossary-panel').classList.remove('hidden');
    renderQuestion();
}

// Map Bundesland state code → question category in questions.json
const LAND_CATEGORY = {
    BY: 'bayern', BW: 'baden_wuerttemberg', BE: 'berlin', BB: 'brandenburg',
    HB: 'bremen', HH: 'hamburg', HE: 'hessen', MV: 'mecklenburg_vorpommern',
    NI: 'niedersachsen', NW: 'nrw', RP: 'rheinland_pfalz', SL: 'saarland',
    SN: 'sachsen', ST: 'sachsen_anhalt', SH: 'schleswig_holstein', TH: 'thueringen',
};
function activeLandCategory() {
    return LAND_CATEGORY[state.land || DEFAULT_LAND] || 'bayern';
}

// Questions visible to the user for study/progress/favorites:
// 300 general + 10 from the chosen Bundesland (NOT all 460 mixed).
function activeQuestions() {
    const landCat = activeLandCategory();
    return state.questions.filter(q => q.category === 'general' || q.category === landCat);
}

function startExam() {
    state.mode = 'exam';
    const landCat = activeLandCategory();
    const general = state.questions.filter(q => q.category === 'general');
    const landQ = state.questions.filter(q => q.category === landCat);
    const picked = [
        ...shuffle(general).slice(0, EXAM_QUESTIONS_GENERAL),
        ...shuffle(landQ).slice(0, EXAM_QUESTIONS_BAYERN),
    ];
    state.quizQuestions = shuffle(picked).map(prepareQuestion);
    state.currentIndex = 0;
    state.answers = {};
    state.examFinished = false;
    show('screen-quiz');
    $('timer').classList.remove('hidden');
    $('btn-translate').classList.add('hidden');
    $('btn-finish').classList.remove('hidden');
    $('glossary-panel').classList.add('hidden');
    startTimer();
    renderQuestion();
}

// -- TIMER --
function startTimer() {
    state.timeLeft = EXAM_TIME_SEC;
    updateTimer();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
        state.timeLeft--;
        updateTimer();
        if (state.timeLeft <= 0) {
            clearInterval(state.timer);
            finishExam();
        }
    }, 1000);
}

function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
}

function updateTimer() {
    const m = Math.floor(state.timeLeft / 60);
    const s = state.timeLeft % 60;
    $('timer').textContent = `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// -- RENDER QUESTION --
async function renderQuestion() {
    const q = state.quizQuestions[state.currentIndex];
    if (!q) return;

    // Trial / paywall gate (delegates to auth.js). Now async because it calls
    // the backend (`/api/trial/check`) to catch users who clear localStorage.
    if (window.EinbAuth) {
        const ok = await window.EinbAuth.guardQuestion(q.id);
        if (!ok) return;
    }

    $('progress').textContent = state.mode === 'exam'
        ? T('quiz.progress',         { i: state.currentIndex + 1, total: state.quizQuestions.length })
        : T('quiz.progress_with_id', { i: state.currentIndex + 1, total: state.quizQuestions.length, qid: q.id });

    if (q.category !== 'general') {
        const landCode = Object.entries(LAND_CATEGORY).find(([_, c]) => c === q.category);
        const code = landCode ? landCode[0] : 'BY';
        const stateName = (window.EinbStateMap && window.EinbStateMap.stateName)
            ? window.EinbStateMap.stateName(code, state.lang || 'de')
            : code;
        $('q-num').textContent = T('quiz.question_label_state', { state: stateName, n: q.id });
    } else {
        $('q-num').textContent = T('quiz.question_label', { n: q.id });
    }

    // Question text with clickable words (strip [Bild] prefix)
    const questionText = q.question.replace(/^\[Bild\]\s*/, '');
    $('q-text').innerHTML = wrapWords(questionText);

    // Question image (single image shown above options)
    let qImgEl = $('q-image');
    if (!qImgEl) {
        qImgEl = document.createElement('div');
        qImgEl.id = 'q-image';
        qImgEl.className = 'question-image';
        $('q-text').after(qImgEl);
    }
    if (q.image) {
        qImgEl.innerHTML = `<img src="${q.image}" alt="Bild zur Frage" loading="lazy" onerror="this.parentElement.classList.add('img-error')">`;
        qImgEl.classList.remove('hidden');
    } else {
        qImgEl.innerHTML = '';
        qImgEl.classList.add('hidden');
    }

    // Options
    const ul = $('q-options');
    ul.innerHTML = '';
    const trans = getTrans(q.id) || {};
    const hasOptImages = !!(q.option_images && q.option_images.length);
    q.options.forEach((opt, idx) => {
        const li = document.createElement('li');
        li.dataset.idx = idx;
        const letter = String.fromCharCode(65 + idx);
        const origIdx = q._origMap[idx];
        const optTranslation = trans.options ? trans.options[origIdx] : null;
        const optImgSrc = hasOptImages ? q.option_images[idx] : null;
        li.innerHTML = `
            <button class="opt-select" data-idx="${idx}" aria-label="Antwort ${letter} wählen">${letter}</button>
            <div class="opt-content${hasOptImages ? ' opt-has-image' : ''}">
                ${optImgSrc ? `<img class="opt-image" src="${optImgSrc}" alt="Option ${letter}" loading="lazy" onerror="this.style.display='none'">` : ''}
                <div class="opt-text${hasOptImages ? ' hidden' : ''}">${wrapWords(opt)}</div>
                <div class="opt-translation hidden"></div>
            </div>
            ${state.mode === 'study' && optTranslation && !hasOptImages ? `<button class="opt-translate-btn" title="Übersetzen" data-trans="${escapeAttr(optTranslation)}">${state.lang.toUpperCase()}</button>` : ''}
        `;
        ul.appendChild(li);
    });

    // Wire up option-select buttons (letter buttons A/B/C/D)
    ul.querySelectorAll('.opt-select').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectOption(parseInt(btn.dataset.idx, 10));
        });
    });

    // Also allow clicking directly on option images to select
    ul.querySelectorAll('.opt-image').forEach(img => {
        img.style.cursor = 'pointer';
        img.addEventListener('click', (e) => {
            e.stopPropagation();
            const li = img.closest('li');
            selectOption(parseInt(li.dataset.idx, 10));
        });
    });

    // Wire up per-option translation buttons
    ul.querySelectorAll('.opt-translate-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const li = btn.closest('li');
            const tEl = li.querySelector('.opt-translation');
            if (tEl.classList.contains('hidden')) {
                tEl.textContent = btn.dataset.trans;
                tEl.classList.remove('hidden');
                btn.classList.add('active');
            } else {
                tEl.classList.add('hidden');
                btn.classList.remove('active');
            }
        });
    });

    // Restore selection
    const selected = state.answers[q.id];
    if (selected !== undefined) {
        markSelection(selected, q.correct);
    }

    // Reset translation display
    $('q-translation').classList.add('hidden');
    $('q-translation').textContent = '';

    // Buttons
    $('btn-prev').disabled = state.currentIndex === 0;
    if (state.mode === 'exam') {
        $('btn-next').classList.toggle('hidden', state.currentIndex === state.quizQuestions.length - 1);
        $('btn-finish').classList.toggle('hidden', state.currentIndex !== state.quizQuestions.length - 1);
    } else {
        $('btn-next').disabled = state.currentIndex === state.quizQuestions.length - 1;
    }

    // Feedback (only in study mode after answering)
    $('q-feedback').classList.add('hidden');
    if (state.mode === 'study' && selected !== undefined) {
        showFeedback(selected, q);
    }

    updateFavoriteButton();
}

function selectOption(idx) {
    const q = state.quizQuestions[state.currentIndex];
    const alreadyAnswered = state.answers[q.id] !== undefined;
    state.answers[q.id] = idx;

    // Track stats: in study mode every answer counts immediately;
    // in exam mode we only record on finishExam so changes of mind don't pollute.
    if (state.mode === 'study' && !alreadyAnswered) {
        recordAnswer(q.id, idx === q.correct);
    }

    if (state.mode === 'study') {
        markSelection(idx, q.correct);
        showFeedback(idx, q);
    } else {
        document.querySelectorAll('#q-options li').forEach((li, i) => {
            li.classList.toggle('selected', i === idx);
        });
    }
}

function markSelection(selectedIdx, correctIdx) {
    document.querySelectorAll('#q-options li').forEach((li, i) => {
        li.classList.remove('selected', 'correct', 'wrong');
        if (state.mode === 'study') {
            if (i === correctIdx) li.classList.add('correct');
            else if (i === selectedIdx) li.classList.add('wrong');
        } else {
            if (i === selectedIdx) li.classList.add('selected');
        }
    });
}

function showFeedback(selectedIdx, q) {
    const fb = $('q-feedback');
    fb.classList.remove('hidden');
    if (selectedIdx === q.correct) {
        fb.className = 'feedback correct';
        fb.textContent = T('quiz.feedback_right');
    } else {
        const correctLetter = String.fromCharCode(65 + q.correct);
        fb.className = 'feedback wrong';
        const prefix = T('quiz.feedback_wrong_prefix', { letter: correctLetter });
        const hasOptImages = q.option_images && q.option_images.length;
        if (hasOptImages) {
            fb.innerHTML = `${escapeHtml(prefix)} <img src="${q.option_images[q.correct]}" alt="" class="feedback-img" onerror="this.style.display='none'">`;
        } else {
            fb.textContent = `${prefix} ${q.options[q.correct]}`;
        }
    }
}

// -- WORD WRAPPING / GLOSSARY --
function wrapWords(text) {
    return text.replace(/([A-Za-zÄÖÜäöüß]+)/g, (m) => `<span class="word">${m}</span>`);
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function escapeAttr(s) {
    return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Smart glossary lookup with German-aware stemming
function lookupWord(rawWord) {
    if (!rawWord) return null;
    const word = rawWord;
    const lower = word.toLowerCase();
    const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

    // Direct lookups
    const direct = [word, lower, cap];
    for (const w of direct) {
        if (state.glossary[w]) return state.glossary[w];
    }

    // Try removing common German declension endings
    // Order matters: longer endings first
    const endings = ['innen', 'inen', 'esten', 'isten', 'tens', 'lich', 'ungs', 'ung', 'ern', 'erin', 'igen',
                     'sten', 'ten', 'end', 'ens', 'tem', 'ter', 'tes',
                     'es', 'er', 'em', 'en', 'st', 'rt', 't', 's', 'n', 'e'];
    for (const end of endings) {
        if (word.length - end.length < 3) continue;
        if (lower.endsWith(end)) {
            const stem = word.slice(0, -end.length);
            const stemLower = stem.toLowerCase();
            const stemCap = stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();
            for (const w of [stem, stemLower, stemCap]) {
                if (state.glossary[w]) return state.glossary[w];
            }
        }
    }

    // Try common prefix removal: "ge-" (past participle), separable prefixes
    const prefixes = ['gegen', 'unter', 'über', 'durch', 'wieder', 'aus', 'ein', 'mit', 'nach', 'vor', 'an', 'auf', 'bei', 'zu', 'ab', 'ge', 'be', 'ver', 'ent', 'er', 'zer'];
    for (const pref of prefixes) {
        if (lower.startsWith(pref) && word.length - pref.length >= 4) {
            const root = word.slice(pref.length);
            const rootCap = root.charAt(0).toUpperCase() + root.slice(1).toLowerCase();
            for (const w of [root, root.toLowerCase(), rootCap]) {
                if (state.glossary[w]) return state.glossary[w];
            }
        }
    }

    return null;
}

// -- TOOLTIP & SIDEBAR --
const tooltip = $('tooltip');

// Returns the translated string in the current language (or null).
function lookupTranslated(word) {
    return glossaryValue(lookupWord(word));
}

document.addEventListener('mouseover', (e) => {
    if (state.mode !== 'study') return;
    const el = e.target;
    if (!el.classList || !el.classList.contains('word')) return;
    const word = el.textContent;
    const tr = lookupTranslated(word);
    const noTransMsg = T('quiz.no_translation');
    if (!tr) {
        tooltip.textContent = `${word} → ${noTransMsg}`;
        tooltip.classList.add('no-trans');
    } else {
        tooltip.textContent = `${word} → ${tr}`;
        tooltip.classList.remove('no-trans');
    }
    tooltip.classList.remove('hidden');
    positionTooltip(e);
});

document.addEventListener('mousemove', (e) => {
    if (tooltip.classList.contains('hidden')) return;
    positionTooltip(e);
});

document.addEventListener('mouseout', (e) => {
    if (e.target.classList && e.target.classList.contains('word')) {
        tooltip.classList.add('hidden');
    }
});

let tooltipHideTimer = null;
document.addEventListener('click', (e) => {
    if (state.mode !== 'study') return;
    const el = e.target;
    if (!el.classList || !el.classList.contains('word')) return;
    e.stopPropagation();
    const word = el.textContent;
    const entry = lookupWord(word);
    const translated = glossaryValue(entry);
    const noTransMsg = T('quiz.no_translation');
    tooltip.textContent = `${word} → ${translated || noTransMsg}`;
    tooltip.classList.toggle('no-trans', !translated);
    tooltip.classList.remove('hidden');
    // Position above the tapped word (works on touch where there is no mouse position)
    const rect = el.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, rect.top - tooltip.offsetHeight - 8)}px`;
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(() => tooltip.classList.add('hidden'), 1800);

    if (!entry) return;  // don't store untranslated words
    const pt = (typeof entry === 'string') ? entry : (entry.pt || '');
    const en = (typeof entry === 'string') ? '' : (entry.en || '');
    addToGlossary(word, pt, en);
});

function positionTooltip(e) {
    const x = e.clientX + 12;
    const y = e.clientY - 32;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
}

function loadGlossary() {
    try {
        const raw = localStorage.getItem(GLOSSARY_KEY);
        state.glossaryWords = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(state.glossaryWords)) state.glossaryWords = [];
    } catch {
        state.glossaryWords = [];
    }
}

function saveGlossary() {
    try {
        localStorage.setItem(GLOSSARY_KEY, JSON.stringify(state.glossaryWords));
    } catch {}
}

function addToGlossary(de, pt, en) {
    if (state.glossaryWords.find(w => w.de.toLowerCase() === de.toLowerCase())) return;
    state.glossaryWords.unshift({ de, pt: pt || '', en: en || '' });
    saveGlossary();
    renderGlossary();
}

function removeFromGlossary(de) {
    const key = de.toLowerCase();
    state.glossaryWords = state.glossaryWords.filter(w => w.de.toLowerCase() !== key);
    saveGlossary();
    renderGlossary();
}

function renderGlossary() {
    const targets = [
        { ul: $('glossary-list'), clearBtn: $('btn-clear-glossary'), countEl: null },
        { ul: $('home-glossary-list'), clearBtn: $('btn-clear-home-glossary'), countEl: $('home-glossary-count') },
    ];
    targets.forEach(({ ul, clearBtn, countEl }) => {
        if (!ul) return;
        ul.innerHTML = '';
        state.glossaryWords.forEach(w => {
            // Try stored translation for current lang; fall back to live lookup.
            let translated = w[state.lang];
            if (!translated) translated = lookupTranslated(w.de) || w.pt || w.en || '';
            const li = document.createElement('li');
            li.innerHTML = `
                <div class="glossary-word">
                    <span class="de">${escapeHtml(w.de)}</span>
                    <span class="pt">${escapeHtml(translated)}</span>
                </div>
                <button class="glossary-delete" data-de="${escapeAttr(w.de)}" title="Entfernen" aria-label="Entfernen">✕</button>
            `;
            li.querySelector('.glossary-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                removeFromGlossary(w.de);
            });
            ul.appendChild(li);
        });
        if (clearBtn) clearBtn.classList.toggle('hidden', state.glossaryWords.length === 0);
        if (countEl) countEl.textContent = state.glossaryWords.length;
    });
}

// -- TRANSLATE FULL QUESTION --
function toggleTranslation() {
    const q = state.quizQuestions[state.currentIndex];
    const tr = getTrans(q.id);
    const el = $('q-translation');
    if (!tr) {
        el.textContent = T('quiz.no_translation');
        el.classList.remove('hidden');
        return;
    }
    if (el.classList.contains('hidden')) {
        let html = `<strong>${state.lang.toUpperCase()}:</strong> ${escapeHtml(tr.question)}`;
        if (tr.options) {
            html += '<ul style="margin-top:0.5rem;padding-left:1.2rem;">';
            // Render options in CURRENT (shuffled) order using _origMap
            q.options.forEach((opt, i) => {
                const origIdx = q._origMap[i];
                const ptOpt = tr.options[origIdx] || '';
                html += `<li><strong>${String.fromCharCode(65 + i)})</strong> ${escapeHtml(ptOpt)}</li>`;
            });
            html += '</ul>';
        }
        el.innerHTML = html;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

// -- FINISH EXAM --
function finishExam() {
    stopTimer();
    state.examFinished = true;
    let correct = 0;
    state.quizQuestions.forEach(q => {
        const wasCorrect = state.answers[q.id] === q.correct;
        if (wasCorrect) correct++;
        // Record exam stats only for answered questions (unanswered = skipped, don't penalize)
        if (state.answers[q.id] !== undefined) {
            recordAnswer(q.id, wasCorrect);
        }
    });
    $('score-correct').textContent = correct;
    $('score-total').textContent = state.quizQuestions.length;
    const passed = correct >= PASS_THRESHOLD;
    const status = $('score-status');
    status.textContent = passed ? '✓ ' + T('result.pass') : '✗ ' + T('result.fail');
    status.className = 'score-status ' + (passed ? 'passed' : 'failed');
    show('screen-result');
}

// -- STATS / APTITUDE --
function loadStats() {
    try {
        const raw = localStorage.getItem(STATS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        state.questionStats = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        state.questionStats = {};
    }
}

function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(state.questionStats)); } catch {}
}

function recordAnswer(qid, correct) {
    const s = state.questionStats[qid] || { correct: 0, wrong: 0, lastCorrect: false };
    if (correct) s.correct++; else s.wrong++;
    s.lastCorrect = !!correct;
    state.questionStats[qid] = s;
    saveStats();
    renderAptitude();
}

function computeAptitude() {
    // Only count questions in the active set (general + selected state)
    const active = activeQuestions();
    const total = active.length || 1;
    const activeIds = new Set(active.map(q => q.id));
    let mastered = 0;   // last answer was correct
    let wrong = 0;      // last answer was wrong
    let seen = 0;
    for (const id in state.questionStats) {
        if (!activeIds.has(Number(id))) continue; // skip stats from other states
        const s = state.questionStats[id];
        seen++;
        if (s.lastCorrect) mastered++;
        else wrong++;
    }
    return {
        total,
        mastered,
        wrong,
        unseen: total - seen,
        pct: Math.round((mastered / total) * 100),
    };
}

function renderAptitude() {
    const card = $('aptitude-card');
    if (!card) return;
    const a = computeAptitude();
    const titleEl = $('aptitude-title');
    const pctEl = $('aptitude-pct');
    const barEl = $('aptitude-bar-fill');
    const msgEl = $('aptitude-message');
    const breakdownEl = $('aptitude-breakdown');

    titleEl.textContent = T('home.aptitude_title');
    pctEl.textContent = a.pct + '%';
    barEl.style.width = a.pct + '%';

    // Color levels
    let level = 'low';
    let msg;
    if (a.mastered === 0) {
        level = 'none';
        msg = state.lang === 'en'
            ? 'Start answering questions to see your readiness.'
            : 'Comece a responder questões pra ver sua prontidão.';
    } else if (a.pct < 40) {
        level = 'low';
        msg = state.lang === 'en' ? 'Keep studying — you\'re just getting started.' : 'Continue estudando — só está começando.';
    } else if (a.pct < 60) {
        level = 'mid';
        msg = state.lang === 'en' ? 'Good progress! Keep it up.' : 'Bom progresso! Continue.';
    } else if (a.pct < 80) {
        level = 'good';
        msg = state.lang === 'en' ? 'Almost there!' : 'Quase lá!';
    } else {
        level = 'ready';
        msg = state.lang === 'en' ? 'You\'re ready for the real test! 🎉' : 'Pronto pra prova! 🎉';
    }
    msgEl.textContent = msg;
    card.dataset.level = level;
    barEl.dataset.level = level;

    const lblMastered = state.lang === 'en' ? 'mastered' : 'dominadas';
    const lblWrong = state.lang === 'en' ? 'wrong' : 'erradas';
    const lblUnseen = state.lang === 'en' ? 'unseen' : 'não vistas';
    breakdownEl.innerHTML = `
        <span class="bd-item bd-mastered"><strong>${a.mastered}</strong> ${lblMastered}</span>
        <span class="bd-sep">·</span>
        <span class="bd-item bd-wrong"><strong>${a.wrong}</strong> ${lblWrong}</span>
        <span class="bd-sep">·</span>
        <span class="bd-item bd-unseen"><strong>${a.unseen}</strong> ${lblUnseen}</span>
    `;
}

// -- FAVORITES --
function loadFavorites() {
    try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        state.favorites = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(state.favorites)) state.favorites = [];
    } catch {
        state.favorites = [];
    }
}

function saveFavorites() {
    try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
    } catch {}
}

function isFavorite(id) {
    return state.favorites.includes(id);
}

function toggleFavorite(id) {
    if (isFavorite(id)) {
        state.favorites = state.favorites.filter(x => x !== id);
    } else {
        state.favorites.unshift(id);
    }
    saveFavorites();
    updateFavoriteButton();
    renderFavorites();
}

function removeFavorite(id) {
    state.favorites = state.favorites.filter(x => x !== id);
    saveFavorites();
    updateFavoriteButton();
    renderFavorites();
}

function updateFavoriteButton() {
    const btn = $('btn-favorite');
    if (!btn) return;
    const q = state.quizQuestions[state.currentIndex];
    if (!q) return;
    const fav = isFavorite(q.id);
    btn.textContent = fav ? '★' : '☆';
    btn.classList.toggle('active', fav);
    btn.title = fav ? 'Favorit entfernen' : 'Als Favorit speichern';
}

function renderFavorites() {
    const card = $('favorites-card');
    const grid = $('favorites-grid');
    const count = $('favorites-count');
    const studyBtn = $('btn-study-favorites');
    if (!card || !grid) return;

    if (state.favorites.length === 0) {
        card.classList.add('hidden');
        grid.innerHTML = '';
        return;
    }

    card.classList.remove('hidden');
    count.textContent = state.favorites.length;
    if (studyBtn) {
        const lbl = state.lang === 'en' ? 'Study only favorites' : 'Estudar somente favoritas';
        studyBtn.innerHTML = `📌 ${lbl} (${state.favorites.length})`;
    }
    grid.innerHTML = '';

    state.favorites.forEach(id => {
        const q = state.questions.find(x => x.id === id);
        if (!q) return;
        const text = q.question.replace(/^\[Bild\]\s*/, '');
        let cat;
        if (q.category === 'general') {
            cat = 'Allgemein';
        } else {
            const landCode = Object.entries(LAND_CATEGORY).find(([_, c]) => c === q.category);
            cat = landCode && window.EinbStateMap
                ? window.EinbStateMap.stateName(landCode[0], state.lang || 'de')
                : q.category;
        }
        const div = document.createElement('div');
        div.className = 'favorite-item';
        div.dataset.id = id;
        div.innerHTML = `
            <button class="fav-delete" data-id="${id}" title="Entfernen" aria-label="Entfernen">✕</button>
            <div class="fav-meta">
                <span class="fav-tag fav-tag-${q.category}">${cat}</span>
                <span class="fav-id">Frage ${q.id}</span>
            </div>
            <div class="fav-text">${escapeHtml(text)}</div>
        `;
        div.addEventListener('click', (e) => {
            if (e.target.classList.contains('fav-delete')) return;
            openFavorite(id);
        });
        div.querySelector('.fav-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            removeFavorite(id);
        });
        grid.appendChild(div);
    });
}

function openFavorite(id) {
    state.mode = 'study';
    $('btn-mode-study').classList.add('active');
    $('btn-mode-exam').classList.remove('active');
    const original = state.questions.find(q => q.id === id);
    if (!original) return;
    state.quizQuestions = [prepareQuestion(original)];
    state.currentIndex = 0;
    state.answers = {};
    state.examFinished = false;
    show('screen-quiz');
    $('timer').classList.add('hidden');
    $('btn-translate').classList.remove('hidden');
    $('btn-finish').classList.add('hidden');
    $('glossary-panel').classList.remove('hidden');
    renderQuestion();
}

// -- EVENT BINDINGS --
function goHome() {
    if (state.mode === 'exam' && !state.examFinished && !$('screen-quiz').classList.contains('hidden')) {
        if (!confirm(T('quiz.confirm_abort'))) return;
        stopTimer();
    }
    show('screen-home');
}

// -- LAND (Bundesland) --
function loadLand() {
    try {
        const v = localStorage.getItem(LAND_KEY);
        if (window.EinbStateMap && window.EinbStateMap.codes.includes(v)) {
            state.land = v;
        }
    } catch {}
}

function saveLand() {
    try { localStorage.setItem(LAND_KEY, state.land); } catch {}
}

function setLand(code) {
    if (!window.EinbStateMap || !window.EinbStateMap.codes.includes(code)) return;
    const first = state.land === null;
    state.land = code;
    saveLand();
    if (window.EinbStateMap.setSelected) window.EinbStateMap.setSelected(code);
    applyLandUI();
    closeLandDropdown();
    // Counter total + favorites set depend on the chosen Land — re-render.
    renderAptitude();
    renderFavorites();
    // If on welcome and both land+lang chosen, advance.
    if (first && state.lang !== null) {
        // Already on welcome but lang was set first; advance now.
        show('screen-home');
    }
}

function applyLandUI() {
    const code = state.land || DEFAULT_LAND;
    const nameEl = $('einb-land-name');
    const footEl = $('einb-footer-land');
    const capEl = $('einb-state-caption');
    const lang = state.lang || (window.EinbI18n && window.EinbI18n.getLang()) || 'de';
    const display = (window.EinbStateMap && window.EinbStateMap.stateName)
        ? window.EinbStateMap.stateName(code, lang)
        : code;
    if (nameEl) nameEl.textContent = display;
    if (footEl) footEl.textContent = display;
    if (capEl) {
        const entry = state.states && state.states.states.find(s => s.code === code);
        const cap = entry ? entry.capital : '';
        capEl.innerHTML = '';
        capEl.classList.remove('empty');
        const main = document.createElement('span');
        main.textContent = display;
        capEl.appendChild(main);
        if (cap) {
            const sub = document.createElement('span');
            sub.className = 'einb-state-caption-capital';
            sub.textContent = '· ' + cap;
            capEl.appendChild(sub);
        }
    }
    // Mark active item in dropdown
    document.querySelectorAll('#einb-land-dropdown .einb-land-dropdown-item').forEach(b => {
        b.classList.toggle('active', b.dataset.code === code);
    });
}

function buildStateMap() {
    if (!window.EinbStateMap) return;
    const mapEl = $('einb-state-map');
    if (mapEl) {
        window.EinbStateMap.render(mapEl);
        window.EinbStateMap.onSelect(code => setLand(code));
    }
    if (state.land) {
        window.EinbStateMap.setSelected(state.land);
    }
    buildLandDropdown();
}

function buildLandDropdown() {
    const dd = $('einb-land-dropdown');
    if (!dd || !state.states) return;
    dd.innerHTML = '';
    const lang = state.lang || (window.EinbI18n && window.EinbI18n.getLang()) || 'de';
    state.states.states.forEach(s => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'einb-land-dropdown-item';
        b.dataset.code = s.code;
        const nm = document.createElement('span');
        nm.className = 'einb-land-dropdown-item-name';
        nm.textContent = (s.name && (s.name[lang] || s.name.de)) || s.code;
        const cd = document.createElement('span');
        cd.className = 'einb-land-dropdown-item-code';
        cd.textContent = s.code;
        b.appendChild(nm);
        b.appendChild(cd);
        b.addEventListener('click', () => setLand(s.code));
        dd.appendChild(b);
    });
    applyLandUI();
}

function toggleLandDropdown() {
    const dd = $('einb-land-dropdown');
    const sel = $('einb-land-selector');
    if (!dd || !sel) return;
    const open = !dd.classList.contains('hidden');
    if (open) { closeLandDropdown(); return; }
    // Position relative to selector
    const r = sel.getBoundingClientRect();
    dd.style.top = (window.scrollY + r.bottom + 6) + 'px';
    dd.style.left = (window.scrollX + r.left) + 'px';
    dd.classList.remove('hidden');
    sel.setAttribute('aria-expanded', 'true');
}

function closeLandDropdown() {
    const dd = $('einb-land-dropdown');
    const sel = $('einb-land-selector');
    if (dd) dd.classList.add('hidden');
    if (sel) sel.setAttribute('aria-expanded', 'false');
}

function bindLandSelector() {
    const sel = $('einb-land-selector');
    const dd = $('einb-land-dropdown');
    if (sel) {
        sel.setAttribute('aria-expanded', 'false');
        sel.setAttribute('aria-haspopup', 'listbox');
        sel.addEventListener('click', (ev) => { ev.stopPropagation(); toggleLandDropdown(); });
    }
    // Close on outside click / Escape
    document.addEventListener('click', (ev) => {
        if (!dd || dd.classList.contains('hidden')) return;
        if (ev.target.closest && (ev.target.closest('#einb-land-dropdown') || ev.target.closest('#einb-land-selector'))) return;
        closeLandDropdown();
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeLandDropdown();
    });
}

// -- LANGUAGE --
function loadLang() {
    try {
        const v = localStorage.getItem(LANG_KEY);
        if (SUPPORTED_LANGS.includes(v)) state.lang = v;
    } catch {}
}

function saveLang() {
    try { localStorage.setItem(LANG_KEY, state.lang); } catch {}
}

async function setLang(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) return;
    const first = state.lang === null;
    state.lang = lang;
    saveLang();
    if (window.EinbI18n) {
        await window.EinbI18n.setLang(lang); // applies <html dir>, swaps data-i18n texts
    }
    applyLangUI();
    // Refresh land UI (caption + dropdown labels switch to chosen lang)
    if (window.EinbStateMap && window.EinbStateMap.refreshLabels) window.EinbStateMap.refreshLabels();
    buildLandDropdown();
    applyLandUI();
    if (window.EinbAuth && window.EinbAuth.rerender) window.EinbAuth.rerender();
    if (first) {
        // Only advance to home if a state has also been selected
        if (state.land !== null) {
            show('screen-home');
            if (window.EinbTour) {
                setTimeout(() => window.EinbTour.autoStartIfNeeded(), 250);
            }
        }
        // else: stay on welcome until they pick a state too
    } else {
        renderGlossary();
        renderFavorites();
        if (!$('screen-quiz').classList.contains('hidden')) {
            renderQuestion();
        }
    }
    renderAptitude();
}

function applyLangUI() {
    // Mark active flag in both header and welcome grids
    document.querySelectorAll('.einb-flag-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === state.lang);
    });
}

// -- Build flag grids (header + welcome) --
function buildLangGrids() {
    const langs = window.EinbI18n ? window.EinbI18n.supported() : [
        { code: 'pt', flag: '🇧🇷', native: 'Português' },
        { code: 'en', flag: '🇬🇧', native: 'English' },
        { code: 'tr', flag: '🇹🇷', native: 'Türkçe' },
        { code: 'ar', flag: '🇸🇦', native: 'العربية' },
        { code: 'fa', flag: '🇮🇷', native: 'فارسی' },
    ];
    const headerGrid = $('einb-lang-grid');
    const welcomeGrid = $('einb-welcome-lang');
    [headerGrid, welcomeGrid].forEach((root, i) => {
        if (!root) return;
        root.innerHTML = '';
        const isWelcome = root === welcomeGrid;
        langs.forEach(l => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = isWelcome ? 'einb-welcome-flag einb-flag-btn' : 'einb-flag-btn';
            b.dataset.lang = l.code;
            b.title = l.native;
            b.setAttribute('aria-label', l.native);
            b.innerHTML = `<span class="flag">${l.flag}</span><span class="code">${isWelcome ? l.native : l.code.toUpperCase()}</span>`;
            b.addEventListener('click', () => setLang(l.code));
            root.appendChild(b);
        });
    });
}

function bind() {
    // Header mode buttons now actually start the quiz.
    $('btn-mode-study').addEventListener('click', () => selectModeAndStart('study'));
    $('btn-mode-exam').addEventListener('click', () => selectModeAndStart('exam'));
    $('start-study').addEventListener('click', startStudy);
    $('start-exam').addEventListener('click', startExam);

    // Flag grids are built at init and re-bound there; nothing extra here.

    $('btn-back').addEventListener('click', goHome);
    $('btn-home').addEventListener('click', goHome);

    $('btn-prev').addEventListener('click', () => {
        if (state.currentIndex > 0) {
            state.currentIndex--;
            renderQuestion();
        }
    });

    $('btn-next').addEventListener('click', () => {
        if (state.currentIndex < state.quizQuestions.length - 1) {
            state.currentIndex++;
            renderQuestion();
        }
    });

    $('btn-finish').addEventListener('click', () => {
        if (confirm(T('quiz.confirm_finish', { n: Object.keys(state.answers).length, total: state.quizQuestions.length }))) {
            finishExam();
        }
    });

    $('btn-translate').addEventListener('click', toggleTranslation);

    $('btn-clear-glossary').addEventListener('click', () => {
        if (!confirm(T('quiz.confirm_clear_glossary'))) return;
        state.glossaryWords = [];
        saveGlossary();
        renderGlossary();
    });

    $('btn-clear-home-glossary').addEventListener('click', () => {
        if (!confirm(T('quiz.confirm_clear_glossary'))) return;
        state.glossaryWords = [];
        saveGlossary();
        renderGlossary();
    });

    $('btn-favorite').addEventListener('click', () => {
        const q = state.quizQuestions[state.currentIndex];
        if (q) toggleFavorite(q.id);
    });

    $('btn-clear-favorites').addEventListener('click', () => {
        if (state.favorites.length === 0) return;
        if (!confirm(T('quiz.confirm_clear_favorites'))) return;
        state.favorites = [];
        saveFavorites();
        updateFavoriteButton();
        renderFavorites();
    });

    $('btn-study-favorites').addEventListener('click', startStudyFavorites);

    $('btn-restart').addEventListener('click', () => {
        show('screen-home');
    });

    $('btn-review').addEventListener('click', () => {
        state.mode = 'study';
        $('btn-mode-study').classList.add('active');
        $('btn-mode-exam').classList.remove('active');
        $('timer').classList.add('hidden');
        $('btn-translate').classList.remove('hidden');
        $('btn-finish').classList.add('hidden');
        $('glossary-panel').classList.remove('hidden');
        state.currentIndex = 0;
        show('screen-quiz');
        renderQuestion();
    });
}

// -- INIT --
(async function init() {
    try {
        await loadData();
        loadLang();
        loadLand();
        loadFavorites();
        loadGlossary();
        loadStats();

        // Initialize i18n FIRST so all subsequent renders pick up translations.
        if (window.EinbI18n) {
            await window.EinbI18n.init();
            // If we already have a stored lang, ensure i18n has loaded it
            if (state.lang) await window.EinbI18n.setLang(state.lang);
        }

        buildLangGrids();
        buildStateMap();
        bind();
        bindLandSelector();
        applyLangUI();
        applyLandUI();
        renderFavorites();
        renderGlossary();
        renderAptitude();
        // Welcome stays open until BOTH land and lang are chosen.
        if (state.lang === null || state.land === null) {
            show('screen-welcome');
        } else {
            show('screen-home');
        }
        if (window.EinbAuth) {
            window.EinbAuth.init();
        }
        document.addEventListener('einb:go-home', goHome);

        // Tour buttons (header + footer) + auto-start on first visit
        const tourBtn = document.getElementById('btn-tour');
        if (tourBtn && window.EinbTour) {
            tourBtn.addEventListener('click', () => window.EinbTour.start());
        }
        const footerTour = document.getElementById('einb-footer-tour');
        if (footerTour && window.EinbTour) {
            footerTour.addEventListener('click', () => window.EinbTour.start());
        }
        if (window.EinbTour && state.lang !== null && state.land !== null) {
            window.EinbTour.autoStartIfNeeded();
        }
    } catch (err) {
        document.body.innerHTML = `<div style="padding:2rem;color:#c00;font-family:monospace;">Fehler beim Laden: ${err.message}</div>`;
        console.error(err);
    }
})();
