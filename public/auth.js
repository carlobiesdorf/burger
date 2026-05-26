// Einbürgerungstest – auth, trial counter, paywall, account UI
// All UI strings come from EinbI18n (i18n.js). DE fallback.
(function () {
    'use strict';

    const TRIAL_KEY = 'einb_trial_seen_v1';
    const TRIAL_LIMIT = 15;
    const API = '/api';

    const state = {
        user: null,
        trialSeen: new Set(),
        trialLimit: TRIAL_LIMIT,
    };

    const t = (key, vars) => (window.EinbI18n ? window.EinbI18n.t(key, vars) : key);

    // ---------- localStorage ----------
    function loadTrial() {
        try {
            const raw = localStorage.getItem(TRIAL_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            state.trialSeen = new Set(Array.isArray(arr) ? arr.filter(x => Number.isInteger(x)) : []);
        } catch { state.trialSeen = new Set(); }
    }
    function saveTrial() {
        try { localStorage.setItem(TRIAL_KEY, JSON.stringify([...state.trialSeen])); } catch {}
    }

    // ---------- API helpers ----------
    async function apiFetch(path, opts = {}) {
        const init = {
            method: opts.method || 'GET',
            credentials: 'same-origin',
            headers: {},
            ...opts,
        };
        if (opts.body !== undefined && typeof opts.body !== 'string') {
            init.body = JSON.stringify(opts.body);
            init.headers['Content-Type'] = 'application/json';
        }
        let resp;
        try { resp = await fetch(API + path, init); }
        catch { return { ok: false, status: 0, data: { detail: 'network_error' } }; }
        let data = null;
        try { data = await resp.json(); } catch { data = null; }
        return { ok: resp.ok, status: resp.status, data };
    }

    // ---------- entitlement ----------
    function isActive() {
        if (!state.user) return false;
        if (state.user.status !== 'active') return false;
        if (state.user.expires_at) {
            const exp = new Date(state.user.expires_at.replace(' ', 'T') + 'Z');
            if (exp.getTime() < Date.now()) return false;
        }
        return true;
    }
    function hasSeen(qid) { return state.trialSeen.has(qid); }
    function trialUsed() { return state.trialSeen.size; }
    function canViewNew() {
        if (isActive()) return true;
        return state.trialSeen.size < state.trialLimit;
    }
    function recordView(qid) {
        if (isActive()) return;
        if (!state.trialSeen.has(qid)) {
            state.trialSeen.add(qid);
            saveTrial();
            renderTrialBadge();
        }
    }
    // Server-validated trial gate. Defense in depth: localStorage is the fast
    // path; backend gives the authoritative answer (counts by IP+cookie token,
    // so clearing cache doesn't reset the trial). Falls back to local-only if
    // the network call fails so we don't block on network glitches.
    async function guardQuestion(qid) {
        if (isActive()) return true;
        if (state.trialSeen.has(qid)) return true;

        // Local quick path: if we're already over the limit, no point asking the server.
        if (state.trialSeen.size >= state.trialLimit) {
            showPaywall();
            return false;
        }

        // Ask the server. Times out gracefully — if the backend is slow,
        // we don't block the UI: we fall back to local accounting only.
        let allowed = null;
        try {
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => ctrl.abort(), 2000);
            const r = await fetch('/api/trial/check', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question_id: qid }),
                signal: ctrl.signal,
            });
            clearTimeout(timeoutId);
            if (r.ok) {
                const data = await r.json();
                allowed = data?.allowed === true;
                if (!allowed) {
                    showPaywall();
                    return false;
                }
            } else if (r.status === 429) {
                // Rate-limited by edge/backend — silent fail, fall through to local
                allowed = null;
            }
        } catch {
            allowed = null; // network/timeout — local fallback
        }

        // Allowed by server (or no answer): mark seen locally and proceed.
        recordView(qid);
        return true;
    }

    // ---------- modals ----------
    function ensureModalRoot() {
        let root = document.getElementById('einb-modal-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'einb-modal-root';
            document.body.appendChild(root);
        }
        return root;
    }
    function closeModal() {
        const root = document.getElementById('einb-modal-root');
        if (root) root.innerHTML = '';
    }
    function openModal(html, variant) {
        const root = ensureModalRoot();
        const variantCls = variant ? ` einb-modal--${variant}` : '';
        const backdropCls = variant ? ` einb-modal-backdrop--${variant}` : '';
        root.innerHTML = `
            <div class="einb-modal-backdrop${backdropCls}" data-close="1">
                <div class="einb-modal${variantCls}" role="dialog" aria-modal="true">
                    <button class="einb-modal-close" aria-label="✕" data-close="1">×</button>
                    ${html}
                </div>
            </div>`;
        root.querySelectorAll('[data-close]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target === el || el.classList.contains('einb-modal-close')) closeModal();
            });
        });
        const onKey = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    }

    function showLogin() {
        openModal(`
            <h2>${esc(t('auth.login_title'))}</h2>
            <form id="einb-login-form" class="einb-form" autocomplete="on">
                <label>${esc(t('auth.email'))}<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
                <label>${esc(t('auth.password'))}<input name="password" type="password" autocomplete="current-password" required minlength="1" maxlength="128"></label>
                <div class="einb-form-err" id="einb-login-err"></div>
                <button type="submit" class="btn-primary">${esc(t('auth.login_submit'))}</button>
                <p class="einb-form-switch">${esc(t('auth.switch_to_register'))} <a href="#" id="einb-switch-register">${esc(t('auth.switch_to_register_link'))}</a></p>
            </form>
        `);
        document.getElementById('einb-switch-register').addEventListener('click', (e) => { e.preventDefault(); showRegister(); });
        document.getElementById('einb-login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const btn = f.querySelector('button[type=submit]');
            btn.disabled = true;
            const err = document.getElementById('einb-login-err');
            err.textContent = '';
            const r = await apiFetch('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
            if (r.ok) {
                state.user = r.data;
                closeModal();
                renderHeaderAuth();
                renderTrialBadge();
            } else {
                err.textContent = msg(r.data?.detail, r.status);
                btn.disabled = false;
            }
        });
    }

    function showRegister(prefill = {}) {
        openModal(`
            <h2>${esc(t('auth.register_title'))}</h2>
            <p class="einb-form-lead">${esc(t('auth.register_lead'))}</p>
            <form id="einb-reg-form" class="einb-form" autocomplete="on">
                <label>${esc(t('auth.email'))}<input name="email" type="email" autocomplete="email" required maxlength="254" value="${escAttr(prefill.email || '')}"></label>
                <label>${esc(t('auth.register_password'))}<input name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="128"></label>
                <div class="einb-form-row">
                    <label class="einb-form-half">${esc(t('auth.register_age'))}<input name="age" type="number" min="10" max="120" required></label>
                    <label class="einb-form-half">${esc(t('auth.register_sex'))}
                        <select name="sex" required>
                            <option value="" disabled selected>${esc(t('auth.sex_select_required'))}</option>
                            <option value="M">${esc(t('auth.sex_male'))}</option>
                            <option value="F">${esc(t('auth.sex_female'))}</option>
                        </select>
                    </label>
                </div>
                <label>${esc(t('auth.register_nationality'))}<input name="nationality" type="text" required minlength="2" maxlength="64" placeholder="${escAttr(t('auth.register_nationality_placeholder'))}"></label>
                <label>${esc(t('auth.register_coupon'))}
                    <input name="coupon_code" type="text" maxlength="64" autocomplete="off" id="einb-reg-coupon">
                    <span id="einb-reg-coupon-status" class="einb-coupon-status"></span>
                </label>
                <div class="einb-form-err" id="einb-reg-err"></div>
                <button type="submit" class="btn-primary">${esc(t('auth.register_submit'))}</button>
                <p class="einb-form-switch">${esc(t('auth.switch_to_login'))} <a href="#" id="einb-switch-login">${esc(t('auth.switch_to_login_link'))}</a></p>
            </form>
        `);
        document.getElementById('einb-switch-login').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });

        let cTimer = null;
        const cInput = document.getElementById('einb-reg-coupon');
        const cStatus = document.getElementById('einb-reg-coupon-status');
        cInput.addEventListener('input', () => {
            clearTimeout(cTimer);
            cStatus.textContent = '';
            cStatus.className = 'einb-coupon-status';
            const code = cInput.value.trim();
            if (!code) return;
            cTimer = setTimeout(async () => {
                const r = await apiFetch('/coupons/validate', { method: 'POST', body: { code } });
                if (r.ok) {
                    const d = r.data;
                    const disc = d.discount_pct ? `-${d.discount_pct}%`
                                                 : d.discount_cents ? `-${(d.discount_cents/100).toFixed(2)} €`
                                                 : 'OK';
                    cStatus.textContent = d.partner
                        ? t('auth.coupon_status_ok_partner', { discount: disc, partner: d.partner })
                        : `✓ ${disc}`;
                    cStatus.classList.add('ok');
                } else {
                    cStatus.textContent = `✗ ${msg(r.data?.detail, r.status)}`;
                    cStatus.classList.add('err');
                }
            }, 400);
        });

        document.getElementById('einb-reg-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const btn = f.querySelector('button[type=submit]');
            btn.disabled = true;
            const err = document.getElementById('einb-reg-err');
            err.textContent = '';
            const body = {
                email: f.email.value.trim(),
                password: f.password.value,
                age: parseInt(f.age.value, 10),
                nationality: f.nationality.value.trim(),
                sex: f.sex.value,
            };
            const c = f.coupon_code.value.trim();
            if (c) body.coupon_code = c;
            const r = await apiFetch('/auth/register', { method: 'POST', body });
            if (r.ok) {
                state.user = r.data;
                closeModal();
                renderHeaderAuth();
                renderTrialBadge();
                showAfterRegister();
            } else {
                err.textContent = msg(r.data?.detail, r.status);
                btn.disabled = false;
            }
        });
    }

    function showAfterRegister() {
        openModal(`
            <h2>${esc(t('auth.welcome_user', { email: state.user.email }))}</h2>
            <p>${esc(t('auth.welcome_status'))}</p>
            <p>${esc(t('auth.welcome_body'))}</p>
            <div class="einb-modal-actions">
                <button class="btn-primary" id="einb-go-checkout">${esc(t('auth.pay_now'))}</button>
                <button class="btn-secondary" data-close="1">${esc(t('auth.pay_later'))}</button>
            </div>
            <p class="einb-hint">${esc(t('auth.pay_hint'))}</p>
        `);
        document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
        document.getElementById('einb-go-checkout').addEventListener('click', startCheckout);
    }

    async function startCheckout() {
        const btn = document.getElementById('einb-go-checkout') || document.getElementById('einb-pay-now') || document.getElementById('einb-pay-account');
        const originalLabel = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = t('auth.pay_redirecting'); }
        const r = await apiFetch('/checkout/create-session', { method: 'POST', body: {} });
        if (r.ok && r.data?.url) {
            window.location.href = r.data.url;
            return;
        }
        if (btn) { btn.disabled = false; btn.textContent = originalLabel || t('auth.pay_now'); }
        alert(msg(r.data?.detail, r.status));
    }

    function showPaywall() {
        const isPending = state.user && state.user.status === 'pending';
        const titleKey = isPending ? 'paywall.title_pending' : 'paywall.title_limit';
        const body = isPending
            ? t('paywall.body_pending')
            : t('paywall.body_limit', { limit: state.trialLimit });
        openModal(`
            <h2>${esc(t(titleKey))}</h2>
            <p>${esc(body)}</p>
            <ul class="einb-paywall-features">
                <li>✓ ${esc(t('paywall.feature_all_questions'))}</li>
                <li>✓ ${esc(t('paywall.feature_both_modes'))}</li>
                <li>✓ ${esc(t('paywall.feature_storage'))}</li>
                <li>✓ ${esc(t('paywall.feature_yearly'))}</li>
            </ul>
            <div class="einb-modal-actions">
                ${isPending
                    ? `<button class="btn-primary" id="einb-pay-now">${esc(t('auth.pay_now'))}</button>`
                    : `<button class="btn-primary" id="einb-go-register">${esc(t('paywall.action_register'))}</button>`}
                <button class="btn-secondary" id="einb-go-home">${esc(t('paywall.action_home'))}</button>
            </div>
            ${!isPending ? `<p class="einb-form-switch">${esc(t('paywall.action_login_question'))} <a href="#" id="einb-go-login">${esc(t('auth.switch_to_login_link'))}</a></p>` : ''}
        `);
        const home = document.getElementById('einb-go-home');
        if (home) home.addEventListener('click', () => {
            closeModal();
            document.dispatchEvent(new CustomEvent('einb:go-home'));
        });
        const reg = document.getElementById('einb-go-register');
        if (reg) reg.addEventListener('click', () => showRegister());
        const log = document.getElementById('einb-go-login');
        if (log) log.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
        const pay = document.getElementById('einb-pay-now');
        if (pay) pay.addEventListener('click', startCheckout);
    }

    async function showAccount() {
        if (!state.user) { showLogin(); return; }
        const u = state.user;
        const statusKey = u.status === 'active' ? 'auth.status_active'
                         : u.status === 'pending' ? 'auth.status_pending'
                         : 'auth.status_expired';

        const paymentsPromise = apiFetch('/me/payments');

        openModal(`
            <h2>${esc(t('auth.account_title'))}</h2>
            <dl class="einb-account-dl">
                <dt>${esc(t('auth.email'))}</dt><dd>${esc(u.email)}</dd>
                <dt>${esc(t('home.aptitude_title').replace(/^.[^\w]*/, '') || 'Status')}</dt>
                <dd class="status-${u.status}">${esc(t(statusKey))}</dd>
                <dt>${esc(t('auth.account_nationality'))}</dt><dd>${esc(u.nationality || '—')}</dd>
                <dt>${esc(t('auth.account_age'))}</dt><dd>${u.age ?? '—'}</dd>
                <dt>${esc(t('auth.account_sex'))}</dt><dd>${u.sex === 'M' ? esc(t('auth.sex_male')) : u.sex === 'F' ? esc(t('auth.sex_female')) : '—'}</dd>
                ${u.coupon_code ? `<dt>${esc(t('auth.account_coupon'))}</dt><dd>${esc(u.coupon_code)}</dd>` : ''}
                ${u.activated_at ? `<dt>${esc(t('auth.account_activated_at'))}</dt><dd>${fmtDate(u.activated_at)}</dd>` : ''}
                ${u.expires_at ? `<dt>${esc(t('auth.account_expires_at'))}</dt><dd>${fmtDate(u.expires_at)}</dd>` : ''}
                <dt>${esc(t('auth.account_member_since'))}</dt><dd>${fmtDate(u.created_at)}</dd>
            </dl>

            <details class="einb-account-section" id="einb-payments-section">
                <summary>${esc(t('auth.account_payments_section'))}</summary>
                <div id="einb-payments-body"><div class="einb-loading">${esc(t('auth.account_payments_loading'))}</div></div>
            </details>

            <details class="einb-account-section">
                <summary>${esc(t('auth.account_pw_section'))}</summary>
                <form id="einb-pw-form" class="einb-form" autocomplete="off">
                    <label>${esc(t('auth.account_pw_current'))}
                        <input name="current_password" type="password" autocomplete="current-password" required minlength="1" maxlength="128">
                    </label>
                    <label>${esc(t('auth.account_pw_new'))}
                        <input name="new_password" type="password" autocomplete="new-password" required minlength="10" maxlength="128">
                    </label>
                    <label>${esc(t('auth.account_pw_confirm'))}
                        <input name="new_password_confirm" type="password" autocomplete="new-password" required minlength="10" maxlength="128">
                    </label>
                    <div class="einb-form-err" id="einb-pw-err"></div>
                    <button type="submit" class="btn-primary">${esc(t('auth.account_pw_submit'))}</button>
                </form>
            </details>

            <p class="einb-hint">${esc(t('auth.account_help_lead'))} <a href="#" id="einb-account-contact-link">${esc(t('contact.button'))}</a>.</p>

            <div class="einb-modal-actions">
                ${u.status === 'pending' ? `<button class="btn-primary" id="einb-pay-account">${esc(t('auth.pay_now'))}</button>` : ''}
                <button class="btn-secondary" id="einb-logout-btn">${esc(t('auth.account_logout'))}</button>
            </div>
        `);

        const payBtn = document.getElementById('einb-pay-account');
        if (payBtn) payBtn.addEventListener('click', startCheckout);

        const contactLink = document.getElementById('einb-account-contact-link');
        if (contactLink) contactLink.addEventListener('click', (e) => { e.preventDefault(); showContact(); });

        document.getElementById('einb-logout-btn').addEventListener('click', async () => {
            await apiFetch('/auth/logout', { method: 'POST' });
            state.user = null;
            closeModal();
            renderHeaderAuth();
            renderTrialBadge();
        });

        document.getElementById('einb-pw-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const btn = f.querySelector('button[type=submit]');
            const err = document.getElementById('einb-pw-err');
            err.textContent = '';
            err.style.color = '';
            if (f.new_password.value !== f.new_password_confirm.value) {
                err.textContent = t('auth.account_pw_mismatch');
                return;
            }
            btn.disabled = true;
            const r = await apiFetch('/auth/change-password', { method: 'POST', body: {
                current_password: f.current_password.value,
                new_password: f.new_password.value,
            }});
            if (r.ok) {
                err.style.color = '#059669';
                err.textContent = t('auth.account_pw_success');
                f.reset();
            } else {
                err.textContent = msg(r.data?.detail, r.status);
            }
            btn.disabled = false;
        });

        const pr = await paymentsPromise;
        const body = document.getElementById('einb-payments-body');
        if (!body) return;
        if (!pr.ok) { body.innerHTML = `<div class="einb-form-err">${esc(msg(pr.data?.detail, pr.status))}</div>`; return; }
        const list = Array.isArray(pr.data) ? pr.data : [];
        if (list.length === 0) {
            body.innerHTML = `<p class="einb-hint">${esc(t('auth.account_no_payments'))}</p>`;
            return;
        }
        const rows = list.map(p => `
            <tr>
                <td>${fmtDate(p.paid_at || p.created_at)}</td>
                <td>${(p.amount_cents/100).toFixed(2)} ${esc(p.currency)}</td>
                <td class="einb-pay-status status-${escAttr(p.status)}">${esc(p.status)}</td>
            </tr>
        `).join('');
        body.innerHTML = `
            <table class="einb-payments-table">
                <thead><tr>
                    <th>${esc(t('auth.account_payments_col_date'))}</th>
                    <th>${esc(t('auth.account_payments_col_amount'))}</th>
                    <th>${esc(t('auth.account_payments_col_status'))}</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    // ---------- header rendering ----------
    function renderHeaderAuth() {
        const slot = document.getElementById('einb-auth-slot');
        if (!slot) return;
        const acctTitle = t('auth.account_title');
        const loginLabel = t('auth.login');
        if (state.user) {
            const dot = state.user.status === 'active' ? '🟢' : state.user.status === 'pending' ? '🟡' : '🔴';
            slot.innerHTML = `<button class="einb-account-btn" id="einb-account-btn" aria-label="${escAttr(acctTitle)}" title="${escAttr(acctTitle)}"><span class="einb-btn-icon">${dot}</span><span class="einb-btn-label">${esc(shortEmail(state.user.email))}</span></button>`;
            document.getElementById('einb-account-btn').addEventListener('click', showAccount);
        } else {
            slot.innerHTML = `<button class="einb-account-btn" id="einb-login-btn" aria-label="${escAttr(loginLabel)}" title="${escAttr(loginLabel)}"><span class="einb-btn-icon">🔑</span><span class="einb-btn-label">${esc(loginLabel)}</span></button>`;
            document.getElementById('einb-login-btn').addEventListener('click', showLogin);
        }
    }
    function renderTrialBadge() {
        const slot = document.getElementById('einb-trial-slot');
        if (!slot) return;
        if (isActive()) { slot.innerHTML = ''; return; }
        const used = trialUsed();
        const remaining = Math.max(0, state.trialLimit - used);
        const label = t('trial.badge_label');
        slot.innerHTML = `<span class="einb-trial-badge${remaining <= 3 ? ' low' : ''}" title="${escAttr(label)}"><span class="einb-trial-label">${esc(label)} </span>${used}/${state.trialLimit}</span>`;
    }

    // Called by app.js when the language changes — refresh open UI bits
    function rerender() {
        renderHeaderAuth();
        renderTrialBadge();
    }

    // ---------- utils ----------
    function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
    function escAttr(s) { return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function shortEmail(e) { return e && e.length > 22 ? e.slice(0, 20) + '…' : e; }
    function fmtDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso.replace(' ', 'T'));
        if (isNaN(d)) return iso;
        const lang = (window.EinbI18n && window.EinbI18n.getLang()) || 'de';
        try { return d.toLocaleDateString(lang); } catch { return d.toLocaleDateString(); }
    }
    function msg(detail, status) {
        if (detail && typeof detail === 'string') {
            const tr = t('errors.' + detail);
            if (tr !== 'errors.' + detail) return tr;
            return detail;
        }
        if (status === 0) return t('errors.network_error');
        return t('errors.generic', { status: status || '??' });
    }

    // ---------- init ----------
    async function init() {
        loadTrial();
        try {
            const r = await apiFetch('/auth/me');
            if (r.ok) state.user = r.data;
        } catch {}
        renderHeaderAuth();
        renderTrialBadge();
        handleStripeReturn();
    }

    function handleStripeReturn() {
        const params = new URLSearchParams(window.location.search);
        const paid = params.get('paid');
        if (!paid) return;
        if (window.history.replaceState) {
            window.history.replaceState({}, '', window.location.pathname);
        }
        if (paid === '1') {
            let tries = 0;
            const poll = async () => {
                tries++;
                const r = await apiFetch('/auth/me');
                if (r.ok && r.data?.status === 'active') {
                    state.user = r.data;
                    renderHeaderAuth();
                    renderTrialBadge();
                    showPaymentSuccess();
                    return;
                }
                if (tries < 10) setTimeout(poll, 1000);
                else showPaymentPending();
            };
            poll();
        } else {
            showPaymentCancelled();
        }
    }

    function showPaymentSuccess() {
        openModal(`
            <h2>${esc(t('payment_return.success_title'))}</h2>
            <p>${esc(t('payment_return.success_body'))}</p>
            <div class="einb-modal-actions">
                <button class="btn-primary" data-close="1">${esc(t('payment_return.success_action'))}</button>
            </div>
        `);
        document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    }
    function showPaymentPending() {
        openModal(`
            <h2>${esc(t('payment_return.pending_title'))}</h2>
            <p>${esc(t('payment_return.pending_body'))}</p>
            <div class="einb-modal-actions">
                <button class="btn-secondary" data-close="1">${esc(t('payment_return.ok'))}</button>
            </div>
        `);
        document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    }
    function showPaymentCancelled() {
        openModal(`
            <h2>${esc(t('payment_return.cancel_title'))}</h2>
            <p>${esc(t('payment_return.cancel_body'))}</p>
            <div class="einb-modal-actions">
                <button class="btn-secondary" data-close="1">${esc(t('payment_return.close'))}</button>
            </div>
        `);
        document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    }

    // ---------- contact form (public — accessible without login) ----------
    function showContact(prefill = {}) {
        const categories = ['bug', 'problem', 'suggestion', 'missing_language', 'other'];
        const defaultEmail = (state.user && state.user.email) || prefill.email || '';
        openModal(`
            <div class="einb-contact-head">
                <h2>${esc(t('contact.title'))}</h2>
                <p class="einb-contact-lead">${esc(t('contact.lead'))}</p>
            </div>
            <form id="einb-contact-form" class="einb-form einb-form--contact" autocomplete="on" novalidate>
                <div class="einb-form-row">
                    <label class="einb-form-half">
                        <span class="einb-field-label">${esc(t('contact.name'))}</span>
                        <input name="name" type="text" autocomplete="name" required minlength="1" maxlength="80" value="${escAttr(prefill.name || '')}" placeholder="${escAttr(t('contact.name'))}">
                    </label>
                    <label class="einb-form-half">
                        <span class="einb-field-label">${esc(t('contact.email'))}</span>
                        <input name="email" type="email" autocomplete="email" required maxlength="254" value="${escAttr(defaultEmail)}" placeholder="nome@exemplo.com">
                    </label>
                </div>
                <label>
                    <span class="einb-field-label">${esc(t('contact.category'))}</span>
                    <select name="category" required class="einb-select">
                        <option value="" disabled ${prefill.category ? '' : 'selected'}>${esc(t('contact.category_select'))}</option>
                        ${categories.map(c => `<option value="${c}" ${prefill.category === c ? 'selected' : ''}>${esc(t('contact.cat_' + c))}</option>`).join('')}
                    </select>
                </label>
                <label>
                    <span class="einb-field-label">${esc(t('contact.message'))}</span>
                    <textarea name="message" required minlength="5" maxlength="2000" rows="5" placeholder="${escAttr(t('contact.message'))}…"></textarea>
                </label>
                <label class="einb-honeypot" aria-hidden="true">
                    Website<input name="website" type="text" tabindex="-1" autocomplete="off">
                </label>
                <div class="einb-form-err" id="einb-contact-err" role="alert"></div>
                <div class="einb-form-ok" id="einb-contact-ok"></div>
                <button type="submit" class="btn-primary einb-contact-submit">${esc(t('contact.submit'))}</button>
            </form>
        `, 'contact');
        document.getElementById('einb-contact-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const btn = f.querySelector('button[type=submit]');
            const err = document.getElementById('einb-contact-err');
            const ok = document.getElementById('einb-contact-ok');
            err.textContent = '';
            ok.style.display = 'none';
            btn.disabled = true;
            const r = await apiFetch('/contact', { method: 'POST', body: {
                name: f.name.value.trim(),
                email: f.email.value.trim(),
                category: f.category.value,
                message: f.message.value.trim(),
                website: f.website.value, // honeypot
            } });
            if (r.ok) {
                ok.textContent = t('contact.sent');
                ok.style.display = 'block';
                f.reset();
                setTimeout(closeModal, 1800);
            } else {
                err.textContent = msg(r.data?.detail, r.status) || t('contact.failed');
                btn.disabled = false;
            }
        });
    }

    // Expose globally so any UI (footer button, header) can trigger
    document.addEventListener('click', (ev) => {
        const trig = ev.target.closest && ev.target.closest('[data-einb-contact]');
        if (trig) { ev.preventDefault(); showContact(); }
    });

    // ---------- public API ----------
    window.EinbAuth = {
        init,
        guardQuestion,
        recordView,
        hasSeen,
        canViewNew,
        isActive,
        trialUsed,
        trialLimit: TRIAL_LIMIT,
        showLogin,
        showRegister,
        showAccount,
        showPaywall,
        showContact,
        rerender,
        get user() { return state.user; },
    };
})();
