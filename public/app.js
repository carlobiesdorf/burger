// Einbürgerungstest – Bayern
// Lernmodus + Prüfungsmodus mit Glossar

const state = {
    questions: [],
    translations: {},
    glossary: {},
    mode: 'study',          // 'study' | 'exam'
    quizQuestions: [],      // active set (with shuffled options)
    currentIndex: 0,
    answers: {},            // {questionId: optionIndex (in shuffled order)}
    glossaryWords: [],      // collected words {de, pt}
    timer: null,
    timeLeft: 60 * 60,
    examFinished: false,
};

const EXAM_TIME_SEC = 60 * 60;
const EXAM_QUESTIONS_GENERAL = 30;
const EXAM_QUESTIONS_BAYERN = 3;
const PASS_THRESHOLD = 17;

const $ = (id) => document.getElementById(id);

// -- DATA LOADING --
async function loadData() {
    const [q, t, g] = await Promise.all([
        fetch('data/questions.json').then(r => r.json()),
        fetch('data/translations.json').then(r => r.json()),
        fetch('data/glossary.json').then(r => r.json()),
    ]);
    state.questions = q;
    state.translations = t;
    state.glossary = g;
}

// -- SCREEN ROUTING --
function show(screen) {
    ['screen-home', 'screen-quiz', 'screen-result'].forEach(id => {
        $(id).classList.toggle('hidden', id !== screen);
    });
}

// -- MODE SWITCHING --
function setMode(mode) {
    state.mode = mode;
    $('btn-mode-study').classList.toggle('active', mode === 'study');
    $('btn-mode-exam').classList.toggle('active', mode === 'exam');
    show('screen-home');
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
    };
}

// -- QUIZ START --
function startStudy() {
    state.mode = 'study';
    state.quizQuestions = shuffle(state.questions).map(prepareQuestion);
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

function startExam() {
    state.mode = 'exam';
    const general = state.questions.filter(q => q.category === 'general');
    const bayern = state.questions.filter(q => q.category === 'bayern');
    const picked = [
        ...shuffle(general).slice(0, EXAM_QUESTIONS_GENERAL),
        ...shuffle(bayern).slice(0, EXAM_QUESTIONS_BAYERN),
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
function renderQuestion() {
    const q = state.quizQuestions[state.currentIndex];
    if (!q) return;

    $('progress').textContent = state.mode === 'exam'
        ? `Frage ${state.currentIndex + 1} / ${state.quizQuestions.length}`
        : `Frage ${state.currentIndex + 1} / ${state.quizQuestions.length} (ID ${q.id})`;

    $('q-num').textContent = q.category === 'bayern' ? `Bayern – Frage ${q.id}` : `Frage ${q.id}`;

    // Question text with clickable words
    $('q-text').innerHTML = wrapWords(q.question);

    // Options
    const ul = $('q-options');
    ul.innerHTML = '';
    const trans = state.translations[q.id] || {};
    q.options.forEach((opt, idx) => {
        const li = document.createElement('li');
        li.dataset.idx = idx;
        const letter = String.fromCharCode(65 + idx);
        const origIdx = q._origMap[idx];
        const optTranslation = trans.options ? trans.options[origIdx] : null;
        li.innerHTML = `
            <button class="opt-select" data-idx="${idx}" aria-label="Antwort ${letter} wählen">${letter}</button>
            <div class="opt-content">
                <div class="opt-text">${wrapWords(opt)}</div>
                <div class="opt-translation hidden"></div>
            </div>
            ${state.mode === 'study' && optTranslation ? `<button class="opt-translate-btn" title="Übersetzen" data-trans="${escapeAttr(optTranslation)}">PT</button>` : ''}
        `;
        ul.appendChild(li);
    });

    // Wire up option-select buttons
    ul.querySelectorAll('.opt-select').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectOption(parseInt(btn.dataset.idx, 10));
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
}

function selectOption(idx) {
    const q = state.quizQuestions[state.currentIndex];
    state.answers[q.id] = idx;

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
        fb.textContent = '✓ Richtig!';
    } else {
        const correctLetter = String.fromCharCode(65 + q.correct);
        fb.className = 'feedback wrong';
        fb.textContent = `✗ Falsch. Richtige Antwort: ${correctLetter}) ${q.options[q.correct]}`;
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

document.addEventListener('mouseover', (e) => {
    if (state.mode !== 'study') return;
    const el = e.target;
    if (!el.classList || !el.classList.contains('word')) return;
    const word = el.textContent;
    const tr = lookupWord(word);
    if (!tr) {
        tooltip.textContent = `${word} → (sem tradução)`;
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

document.addEventListener('click', (e) => {
    if (state.mode !== 'study') return;
    const el = e.target;
    if (!el.classList || !el.classList.contains('word')) return;
    e.stopPropagation();
    const word = el.textContent;
    const tr = lookupWord(word);
    if (!tr) return;  // don't add untranslated words
    addToGlossary(word, tr);
});

function positionTooltip(e) {
    const x = e.clientX + 12;
    const y = e.clientY - 32;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
}

function addToGlossary(de, pt) {
    if (state.glossaryWords.find(w => w.de.toLowerCase() === de.toLowerCase())) return;
    state.glossaryWords.unshift({ de, pt });
    renderGlossary();
}

function renderGlossary() {
    const ul = $('glossary-list');
    ul.innerHTML = '';
    state.glossaryWords.forEach(w => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="de">${escapeHtml(w.de)}</span><span class="pt">${escapeHtml(w.pt)}</span>`;
        ul.appendChild(li);
    });
    $('btn-clear-glossary').classList.toggle('hidden', state.glossaryWords.length === 0);
}

// -- TRANSLATE FULL QUESTION --
function toggleTranslation() {
    const q = state.quizQuestions[state.currentIndex];
    const tr = state.translations[q.id];
    const el = $('q-translation');
    if (!tr) {
        el.textContent = '(Übersetzung nicht verfügbar)';
        el.classList.remove('hidden');
        return;
    }
    if (el.classList.contains('hidden')) {
        let html = `<strong>PT-BR:</strong> ${escapeHtml(tr.question)}`;
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
        if (state.answers[q.id] === q.correct) correct++;
    });
    $('score-correct').textContent = correct;
    $('score-total').textContent = state.quizQuestions.length;
    const passed = correct >= PASS_THRESHOLD;
    const status = $('score-status');
    status.textContent = passed ? '✓ Bestanden!' : '✗ Nicht bestanden';
    status.className = 'score-status ' + (passed ? 'passed' : 'failed');
    show('screen-result');
}

// -- EVENT BINDINGS --
function bind() {
    $('btn-mode-study').addEventListener('click', () => setMode('study'));
    $('btn-mode-exam').addEventListener('click', () => setMode('exam'));
    $('start-study').addEventListener('click', startStudy);
    $('start-exam').addEventListener('click', startExam);

    $('btn-back').addEventListener('click', () => {
        if (state.mode === 'exam' && !state.examFinished) {
            if (!confirm('Prüfung wirklich abbrechen? Der Fortschritt geht verloren.')) return;
            stopTimer();
        }
        show('screen-home');
    });

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
        if (confirm(`Prüfung abgeben? (${Object.keys(state.answers).length} / ${state.quizQuestions.length} beantwortet)`)) {
            finishExam();
        }
    });

    $('btn-translate').addEventListener('click', toggleTranslation);

    $('btn-clear-glossary').addEventListener('click', () => {
        state.glossaryWords = [];
        renderGlossary();
    });

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
        bind();
        show('screen-home');
    } catch (err) {
        document.body.innerHTML = `<div style="padding:2rem;color:#c00;font-family:monospace;">Fehler beim Laden: ${err.message}</div>`;
        console.error(err);
    }
})();
