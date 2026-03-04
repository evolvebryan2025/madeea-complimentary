/* ============================================
   Meeting Preparation Automation™ — App Logic
   ============================================ */

// ─── Configuration ───
const CONFIG = {
    apiBase: '/api',
};

// ─── Supabase Client ───
// Supabase anon key is public and safe to include client-side
const SUPABASE_URL = 'https://ahzqnsxcwvspnncuwfjw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFoenFuc3hjd3ZzcG5uY3V3Zmp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMTcwNDgsImV4cCI6MjA4Njg5MzA0OH0.JHLjkpc2bVKJ1VdK5u7SHVsC4D2_HL_Qr0B3-vlgF10'; // Replace with your anon key from Supabase Dashboard → Settings → API
let supabaseClient = null;
try {
    if (SUPABASE_ANON_KEY && window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
} catch (e) {
    console.warn('Supabase client init skipped:', e.message);
}

// ─── State ───
let currentUser = null;
let isMenuOpen = false;

// ─── Theme (Dark Only) ───
function initTheme() {
    document.documentElement.setAttribute('data-theme', 'dark');
}

// ─── Navigation & Pages ───
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById(pageId);
    if (page) page.classList.add('active');
}

function showSection(sectionId, event) {
    if (event) event.preventDefault();
    closeUserMenu();
    document.querySelectorAll('.dashboard-section').forEach(s => s.classList.remove('active'));
    const section = document.getElementById(`section-${sectionId}`);
    if (section) {
        section.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// ─── User Menu ───
function toggleUserMenu() {
    isMenuOpen = !isMenuOpen;
    const dropdown = document.getElementById('user-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('show', isMenuOpen);
    }
}

function closeUserMenu() {
    isMenuOpen = false;
    const dropdown = document.getElementById('user-dropdown');
    if (dropdown) dropdown.classList.remove('show');
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('user-menu');
    if (menu && !menu.contains(e.target)) {
        closeUserMenu();
    }
});

// ─── Auth Forms ───
function scrollToAuth(event) {
    if (event) event.preventDefault();
    const el = document.getElementById('signin-email');
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => el.focus(), 400);
    }
}

function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('auth-signin-form').style.display = tab === 'signin' ? 'block' : 'none';
    document.getElementById('auth-signup-form').style.display = tab === 'signup' ? 'block' : 'none';
    // Clear messages
    showAuthMessage('signin-message', '');
    showAuthMessage('signup-message', '');
}

function showAuthMessage(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'auth-message' + (text ? (isError ? ' auth-message-error' : ' auth-message-success') : '');
}

async function handleSignUp() {
    const name = document.getElementById('signup-name')?.value?.trim();
    const email = document.getElementById('signup-email')?.value?.trim();
    const password = document.getElementById('signup-password')?.value;

    if (!name || !email || !password) {
        showAuthMessage('signup-message', 'Please fill in all fields.', true);
        return;
    }
    if (password.length < 6) {
        showAuthMessage('signup-message', 'Password must be at least 6 characters.', true);
        return;
    }
    if (!supabaseClient) {
        showAuthMessage('signup-message', 'Auth service unavailable. Please try again later.', true);
        return;
    }

    showAuthMessage('signup-message', 'Creating account...');

    const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { name } },
    });

    if (error) {
        showAuthMessage('signup-message', error.message, true);
        return;
    }

    // Supabase sends verification email automatically
    showAuthMessage('signup-message', 'Check your email for a verification link! Once verified, come back and sign in.');
}

async function handleSignIn() {
    const email = document.getElementById('signin-email')?.value?.trim();
    const password = document.getElementById('signin-password')?.value;

    if (!email || !password) {
        showAuthMessage('signin-message', 'Please fill in all fields.', true);
        return;
    }
    if (!supabaseClient) {
        showAuthMessage('signin-message', 'Auth service unavailable. Please try again later.', true);
        return;
    }

    showAuthMessage('signin-message', 'Signing in...');
    console.log('[SignIn] Step 1: Calling Supabase signInWithPassword...');

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        console.log('[SignIn] Step 1 done. error:', error?.message || 'none', 'hasSession:', !!data?.session);

        if (error) {
            showAuthMessage('signin-message', error.message, true);
            return;
        }

        if (!data?.session?.access_token) {
            console.error('[SignIn] No session/access_token returned from Supabase');
            showAuthMessage('signin-message', 'Sign in succeeded but no session was created. Is your email verified?', true);
            return;
        }

        // Bridge to our JWT cookie session
        showAuthMessage('signin-message', 'Authenticating...');
        console.log('[SignIn] Step 2: Calling /api/auth-email...');

        const response = await fetch(`${CONFIG.apiBase}/auth-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ access_token: data.session.access_token }),
        });

        const result = await response.json();
        console.log('[SignIn] Step 2 done. status:', response.status, 'result:', result);

        if (!response.ok) {
            console.error('[SignIn] auth-email failed:', response.status, result);
            showAuthMessage('signin-message', result.error || 'Authentication failed.', true);
            return;
        }

        // Success — reload session
        showAuthMessage('signin-message', 'Loading dashboard...');
        console.log('[SignIn] Step 3: Calling checkSession...');
        await checkSession();
        console.log('[SignIn] Step 3 done. checkSession complete.');
    } catch (err) {
        console.error('[SignIn] Error caught:', err);
        showAuthMessage('signin-message', 'Error: ' + err.message, true);
    }
}

// ─── Google Connect / Disconnect ───
function handleConnectGoogle() {
    window.location.href = `${CONFIG.apiBase}/auth-google`;
}

async function handleDisconnectGoogle() {
    if (!confirm('Disconnect Google? Features like Briefs, Priorities, and Inbox will be unavailable until you reconnect.')) {
        return;
    }

    showLoading(true);

    try {
        const response = await fetch(`${CONFIG.apiBase}/google-disconnect`, {
            method: 'POST',
            credentials: 'include',
        });

        if (response.ok) {
            currentUser.google_connected = false;
            currentUser.avatar_url = null;
            updateUserUI();
            showToast('Google account disconnected.');
        } else {
            showToast('Failed to disconnect Google. Please try again.');
        }
    } catch (err) {
        showToast('Network error. Please check your connection.');
    }

    showLoading(false);
}

// ─── Microsoft Connect / Disconnect ───
function handleConnectMicrosoft() {
    window.location.href = `${CONFIG.apiBase}/auth-microsoft`;
}

async function handleDisconnectMicrosoft() {
    if (!confirm('Disconnect Microsoft? Outlook-based features will be unavailable until you reconnect.')) {
        return;
    }

    showLoading(true);

    try {
        const response = await fetch(`${CONFIG.apiBase}/microsoft-disconnect`, {
            method: 'POST',
            credentials: 'include',
        });

        if (response.ok) {
            currentUser.microsoft_connected = false;
            updateUserUI();
            showToast('Microsoft account disconnected.');
        } else {
            showToast('Failed to disconnect Microsoft. Please try again.');
        }
    } catch (err) {
        showToast('Network error. Please check your connection.');
    }

    showLoading(false);
}

// ─── Auth Session Check ───
async function checkSession() {
    // Handle Supabase email verification redirect (hash fragment)
    if (window.location.hash && window.location.hash.includes('access_token') && supabaseClient) {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) {
                await fetch(`${CONFIG.apiBase}/auth-email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ access_token: session.access_token }),
                });
                window.history.replaceState({}, '', '/');
            }
        } catch (e) {
            console.log('Email verification bridge:', e.message);
        }
    }

    // Handle provider connected redirects
    const params = new URLSearchParams(window.location.search);
    if (params.get('google') === 'connected') {
        window.history.replaceState({}, '', '/');
        showToast('Google account connected successfully!');
    }
    if (params.get('microsoft') === 'connected') {
        window.history.replaceState({}, '', '/');
        showToast('Microsoft account connected successfully!');
    }

    try {
        console.log('[checkSession] Calling /api/auth-session...');
        console.log('[checkSession] Cookies present:', document.cookie || '(none visible - httpOnly cookies are hidden)');
        const response = await fetch(`${CONFIG.apiBase}/auth-session`, {
            credentials: 'include'
        });

        const data = await response.json();
        console.log('[checkSession] Response:', response.status, data);

        if (response.ok && data.user) {
            currentUser = data.user;
            showDashboard();
            return;
        }
        console.warn('[checkSession] No user in response — showing landing page');
    } catch (err) {
        console.error('[checkSession] Error:', err);
    }

    showPage('landing-page');
}

// ─── Dashboard ───
function showDashboard() {
    if (!currentUser) return;

    // Update UI with user data
    updateUserUI();
    showPage('dashboard-page');
    showSection('welcome');
}

function updateUserUI() {
    if (!currentUser) return;

    const name = currentUser.name || currentUser.email.split('@')[0];
    const avatar = currentUser.avatar_url || generateAvatarUrl(name);
    const googleConnected = !!currentUser.google_connected;
    const microsoftConnected = !!currentUser.microsoft_connected;
    const anyConnected = googleConnected || microsoftConnected;

    // Nav
    setElementText('user-name-nav', name.split(' ')[0]);
    setElementSrc('user-avatar', avatar);

    // Welcome
    setElementText('welcome-name', name.split(' ')[0]);

    // Status cards — show which provider(s) are connected
    let statusText = 'Not Connected';
    if (googleConnected && microsoftConnected) statusText = 'Google + Microsoft';
    else if (googleConnected) statusText = 'Google Connected';
    else if (microsoftConnected) statusText = 'Microsoft Connected';
    setElementText('connection-status', statusText);
    const statusCard = document.querySelector('.status-card-active');
    if (statusCard) {
        statusCard.style.borderColor = anyConnected ? 'rgba(56, 239, 125, 0.3)' : 'rgba(255, 107, 107, 0.3)';
    }
    setElementText('brief-time-display', formatTime(currentUser.send_time || '07:00'));
    setElementText('calendar-display', currentUser.calendar_id === 'primary' ? 'Primary' : currentUser.calendar_id);

    // Feature gate overlays — unlock when ANY provider is connected
    const gateIds = ['gate-brief', 'gate-priorities', 'gate-inbox'];
    gateIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = anyConnected ? 'none' : 'flex';
    });

    // Google account card in profile
    const notConnEl = document.getElementById('google-not-connected');
    const connEl = document.getElementById('google-connected-info');
    if (notConnEl) notConnEl.style.display = googleConnected ? 'none' : 'block';
    if (connEl) connEl.style.display = googleConnected ? 'block' : 'none';

    // Microsoft account card in profile
    const msNotConnEl = document.getElementById('microsoft-not-connected');
    const msConnEl = document.getElementById('microsoft-connected-info');
    if (msNotConnEl) msNotConnEl.style.display = microsoftConnected ? 'none' : 'block';
    if (msConnEl) msConnEl.style.display = microsoftConnected ? 'block' : 'none';

    // Profile form
    setElementValue('profile-name', currentUser.name || '');
    setElementValue('profile-email', currentUser.email);
    setElementSrc('profile-avatar-preview', avatar);
    setElementValue('profile-calendar', currentUser.calendar_id || 'primary');
    setElementValue('profile-time', currentUser.send_time || '07:00');

    const timezoneSelect = document.getElementById('profile-timezone');
    if (timezoneSelect && currentUser.timezone) {
        timezoneSelect.value = currentUser.timezone;
    }

    const activeToggle = document.getElementById('profile-active');
    if (activeToggle) activeToggle.checked = currentUser.is_active !== false;

    // Strategic goals
    const goalsEl = document.getElementById('profile-strategic-goals');
    if (goalsEl && currentUser.strategic_goals) {
        try {
            const parsed = JSON.parse(currentUser.strategic_goals);
            goalsEl.value = Array.isArray(parsed) ? parsed.join('\n') : currentUser.strategic_goals;
        } catch {
            goalsEl.value = currentUser.strategic_goals;
        }
    }

    // Load history
    loadBriefingHistory();
}

// ─── Profile Save ───
async function saveProfile(event) {
    event.preventDefault();
    showLoading(true);

    // Parse strategic goals from textarea (one per line) into JSON array
    const goalsRaw = document.getElementById('profile-strategic-goals')?.value || '';
    const goalsArray = goalsRaw.split('\n').map(g => g.trim()).filter(g => g.length > 0);

    const profileData = {
        name: document.getElementById('profile-name')?.value,
        calendar_id: document.getElementById('profile-calendar')?.value || 'primary',
        send_time: document.getElementById('profile-time')?.value || '07:00',
        timezone: document.getElementById('profile-timezone')?.value || 'Asia/Dubai',
        is_active: document.getElementById('profile-active')?.checked ?? true,
        strategic_goals: JSON.stringify(goalsArray),
    };

    try {
        const response = await fetch(`${CONFIG.apiBase}/user-profile`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(profileData),
        });

        if (response.ok) {
            const data = await response.json();
            currentUser = { ...currentUser, ...profileData };
            updateUserUI();
            showToast('✅ Settings saved successfully!');
        } else {
            showToast('❌ Failed to save settings. Please try again.');
        }
    } catch (err) {
        showToast('❌ Network error. Please check your connection.');
    }

    showLoading(false);
}

// ─── Logout ───
async function handleLogout(event) {
    if (event) event.preventDefault();
    closeUserMenu();

    try {
        await fetch(`${CONFIG.apiBase}/auth-logout`, {
            method: 'POST',
            credentials: 'include',
        });
    } catch (err) {
        // Continue with logout even if server call fails
    }

    // Also sign out from Supabase Auth
    if (supabaseClient) {
        try { await supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
    }

    currentUser = null;
    localStorage.removeItem('meetprep-session');
    showPage('landing-page');
    showToast('Signed out successfully');
}

// ─── Disconnect Account ───
async function handleDisconnect() {
    if (!confirm('Are you sure? This will delete your account and all data. This cannot be undone.')) {
        return;
    }

    showLoading(true);

    try {
        const response = await fetch(`${CONFIG.apiBase}/user-disconnect`, {
            method: 'POST',
            credentials: 'include',
        });

        if (response.ok) {
            currentUser = null;
            localStorage.removeItem('meetprep-session');
            showPage('landing-page');
            showToast('✅ Account deleted and all providers disconnected.');
        } else {
            showToast('❌ Failed to disconnect. Please try again.');
        }
    } catch (err) {
        showToast('❌ Network error. Please check your connection.');
    }

    showLoading(false);
}

// ─── Briefing History ───
async function loadBriefingHistory() {
    try {
        const response = await fetch(`${CONFIG.apiBase}/briefing-history`, {
            credentials: 'include',
        });

        if (response.ok) {
            const data = await response.json();
            renderHistory(data.logs || []);

            // Update briefs count
            const successCount = (data.logs || []).filter(l => l.status === 'success').length;
            setElementText('briefs-count', successCount.toString());
        }
    } catch (err) {
        console.error('Failed to load history:', err);
    }
}

function renderHistory(logs) {
    const container = document.getElementById('history-list');
    if (!container) return;

    if (logs.length === 0) {
        container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📊</span>
        <h3>No briefs yet</h3>
        <p>Your briefing history will appear here once your first daily brief is generated.</p>
      </div>
    `;
        return;
    }

    container.innerHTML = logs.map(log => `
    <div class="history-item">
      <div class="history-item-left">
        <span class="history-status ${log.status}"></span>
        <div>
          <div class="history-date">${formatDate(log.generated_at)}</div>
          <div class="history-detail">${log.status === 'success' ? 'Brief sent successfully' : `Failed: ${log.error_message || 'Unknown error'}`}</div>
        </div>
      </div>
      <div class="history-meetings">${log.meeting_count || 0} meeting${log.meeting_count !== 1 ? 's' : ''}</div>
    </div>
  `).join('');
}

// ─── Utility Functions ───
function setElementText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setElementSrc(id, src) {
    const el = document.getElementById(id);
    if (el) el.src = src;
}

function setElementValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

function formatTime(timeStr) {
    if (!timeStr) return '7:00 AM';
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${minutes} ${ampm}`;
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

function generateAvatarUrl(name) {
    // Generate a simple gradient avatar
    const colors = ['FD5811', '152E47', 'e84d0e', '1a3a5c', 'ff7a3d'];
    const color = colors[name.length % colors.length];
    const initial = (name.charAt(0) || '?').toUpperCase();
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="#${color}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Inter,sans-serif" font-size="32" font-weight="600" fill="white">${initial}</text></svg>`)}`;
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.toggle('show', show);
}

function showToast(message) {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (toast && msgEl) {
        msgEl.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }
}

// ─── Generate Brief Now ───
async function handleGenerateBrief() {
    const btn = document.getElementById('generate-brief-btn');
    const resultEl = document.getElementById('generate-brief-result');
    const textEl = btn?.querySelector('.btn-generate-text');
    const iconEl = btn?.querySelector('.btn-generate-icon');
    const loadingEl = btn?.querySelector('.btn-generate-loading');

    // Show loading state
    if (btn) btn.disabled = true;
    if (textEl) textEl.style.display = 'none';
    if (iconEl) iconEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'inline-flex';
    if (resultEl) resultEl.style.display = 'none';

    try {
        const response = await fetch(`${CONFIG.apiBase}/generate-brief`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            if (data.meeting_count === 0) {
                showResult(resultEl, 'info', `📅 ${data.message}`);
            } else {
                showResult(resultEl, 'success',
                    `✅ ${data.message}<br>📧 Check your inbox for the full brief!` +
                    (data.meetings ? `<br><br>📋 Meetings covered:<br>• ${data.meetings.join('<br>• ')}` : '')
                );
            }
            // Refresh the briefs count
            loadBriefingHistory();
        } else {
            showResult(resultEl, 'error', `❌ ${data.error || 'Something went wrong. Please try again.'}`);
        }
    } catch (err) {
        showResult(resultEl, 'error', '❌ Network error. Please check your connection and try again.');
    }

    // Reset button
    if (btn) btn.disabled = false;
    if (textEl) textEl.style.display = 'inline';
    if (iconEl) iconEl.style.display = 'inline';
    if (loadingEl) loadingEl.style.display = 'none';
}

function showResult(el, type, message) {
    if (!el) return;
    el.className = `generate-result result-${type}`;
    el.innerHTML = message;
    el.style.display = 'block';
}

// ─── Generate Priorities Now ───
async function handleGeneratePriorities() {
    const btn = document.getElementById('generate-priorities-btn');
    const resultEl = document.getElementById('generate-priorities-result');
    const displayEl = document.getElementById('priorities-display');
    const textEl = btn?.querySelector('.btn-generate-text');
    const iconEl = btn?.querySelector('.btn-generate-icon');
    const loadingEl = btn?.querySelector('.btn-generate-loading');

    // Show loading state
    if (btn) btn.disabled = true;
    if (textEl) textEl.style.display = 'none';
    if (iconEl) iconEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'inline-flex';
    if (resultEl) resultEl.style.display = 'none';
    if (displayEl) displayEl.style.display = 'none';

    try {
        const response = await fetch(`${CONFIG.apiBase}/generate-priorities`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            showResult(resultEl, 'success',
                `✅ ${data.message}<br>` +
                `📊 Analyzed: ${data.dataSources?.calendarEvents || 0} calendar events, ` +
                `${data.dataSources?.emailsProcessed || 0} emails, ` +
                `${data.dataSources?.tasksReviewed || 0} tasks`
            );

            // Display the priorities inline
            if (displayEl && data.priorities) {
                displayEl.innerHTML = renderPrioritiesMarkdown(data.priorities, data.metrics);
                displayEl.style.display = 'block';
            }

            loadBriefingHistory();
        } else {
            showResult(resultEl, 'error', `❌ ${data.error || 'Something went wrong. Please try again.'}`);
        }
    } catch (err) {
        showResult(resultEl, 'error', '❌ Network error. Please check your connection and try again.');
    }

    // Reset button
    if (btn) btn.disabled = false;
    if (textEl) textEl.style.display = 'inline';
    if (iconEl) iconEl.style.display = 'inline';
    if (loadingEl) loadingEl.style.display = 'none';
}

function renderPrioritiesMarkdown(markdown, metrics) {
    // Convert markdown to HTML for inline display
    let html = markdown
        .replace(/### (.*)/g, '<h4 class="priorities-h4">$1</h4>')
        .replace(/## (.*)/g, '<h3 class="priorities-h3">$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.*)/gm, '<li>$1</li>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>.*?<\/li>\n?)+/gs, match => `<ul>${match}</ul>`);

    // Wrap remaining lines as paragraphs
    html = html.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (/^<(h[34]|ul|li|strong)/.test(trimmed)) return line;
        return `<p>${trimmed}</p>`;
    }).join('\n');

    // Build metrics bar
    const metricsHtml = metrics ? `
        <div class="priorities-metrics">
            <div class="priorities-metric">
                <span class="priorities-metric-value">${parseFloat((metrics.meetingLoad || 0).toFixed(1))}h</span>
                <span class="priorities-metric-label">Meetings</span>
            </div>
            <div class="priorities-metric">
                <span class="priorities-metric-value">${parseFloat((metrics.availableFocusHours || 0).toFixed(1))}h</span>
                <span class="priorities-metric-label">Focus</span>
            </div>
            <div class="priorities-metric">
                <span class="priorities-metric-value">${metrics.pendingDecisions || 0}</span>
                <span class="priorities-metric-label">Decisions</span>
            </div>
            <div class="priorities-metric">
                <span class="priorities-metric-value">${metrics.overdueItems || 0}</span>
                <span class="priorities-metric-label">Overdue</span>
            </div>
        </div>
    ` : '';

    return metricsHtml + `<div class="priorities-content">${html}</div>`;
}

// ─── Inbox Summary ───
async function handleInboxSummary() {
    const btn = document.getElementById('generate-inbox-btn');
    const resultEl = document.getElementById('generate-inbox-result');
    const displayEl = document.getElementById('inbox-display');
    const textEl = btn?.querySelector('.btn-generate-text');
    const iconEl = btn?.querySelector('.btn-generate-icon');
    const loadingEl = btn?.querySelector('.btn-generate-loading');

    // Show loading state
    if (btn) btn.disabled = true;
    if (textEl) textEl.style.display = 'none';
    if (iconEl) iconEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'inline-flex';
    if (resultEl) resultEl.style.display = 'none';
    if (displayEl) displayEl.style.display = 'none';

    try {
        const response = await fetch(`${CONFIG.apiBase}/inbox-summary`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            showResult(resultEl, 'success', `✅ ${data.message}`);

            if (displayEl && data.categories) {
                displayEl.innerHTML = renderInboxSummary(data.categories, data.summary, data.generatedAt);
                displayEl.style.display = 'block';
            }
        } else {
            showResult(resultEl, 'error', `❌ ${data.error || 'Something went wrong. Please try again.'}`);
        }
    } catch (err) {
        showResult(resultEl, 'error', '❌ Network error. Please check your connection and try again.');
    }

    // Reset button
    if (btn) btn.disabled = false;
    if (textEl) textEl.style.display = 'inline';
    if (iconEl) iconEl.style.display = 'inline';
    if (loadingEl) loadingEl.style.display = 'none';
}

function renderInboxSummary(categories, summary, generatedAt) {
    const categoryConfig = {
        highPriority: {
            label: 'High Priority',
            icon: '🔴',
            colorClass: 'inbox-cat-high',
            description: 'Urgent — needs immediate attention',
        },
        actionRequired: {
            label: 'Action Required',
            icon: '🟠',
            colorClass: 'inbox-cat-action',
            description: 'Requires a decision, reply, or task',
        },
        followUp: {
            label: 'Follow-Up',
            icon: '🔵',
            colorClass: 'inbox-cat-follow',
            description: 'Ongoing threads to monitor',
        },
        deadlines: {
            label: 'Deadlines',
            icon: '🟡',
            colorClass: 'inbox-cat-deadline',
            description: 'Time-sensitive with specific dates',
        },
    };

    // Summary bar
    const total = (summary?.highPriority || 0) + (summary?.actionRequired || 0) +
        (summary?.followUp || 0) + (summary?.deadlines || 0);

    let html = `
        <div class="inbox-summary-bar">
            <div class="inbox-summary-stat">
                <span class="inbox-stat-value">${total}</span>
                <span class="inbox-stat-label">Total</span>
            </div>
            <div class="inbox-summary-stat inbox-stat-high">
                <span class="inbox-stat-value">${summary?.highPriority || 0}</span>
                <span class="inbox-stat-label">High Priority</span>
            </div>
            <div class="inbox-summary-stat inbox-stat-action">
                <span class="inbox-stat-value">${summary?.actionRequired || 0}</span>
                <span class="inbox-stat-label">Action</span>
            </div>
            <div class="inbox-summary-stat inbox-stat-follow">
                <span class="inbox-stat-value">${summary?.followUp || 0}</span>
                <span class="inbox-stat-label">Follow-Up</span>
            </div>
            <div class="inbox-summary-stat inbox-stat-deadline">
                <span class="inbox-stat-value">${summary?.deadlines || 0}</span>
                <span class="inbox-stat-label">Deadlines</span>
            </div>
        </div>
    `;

    // Render each category
    for (const [key, config] of Object.entries(categoryConfig)) {
        const emails = categories[key] || [];
        if (emails.length === 0) continue;

        html += `
            <div class="inbox-category ${config.colorClass}">
                <div class="inbox-category-header">
                    <span class="inbox-category-icon">${config.icon}</span>
                    <div>
                        <h3 class="inbox-category-title">${config.label} <span class="inbox-category-count">${emails.length}</span></h3>
                        <p class="inbox-category-desc">${config.description}</p>
                    </div>
                </div>
                <div class="inbox-email-list">
                    ${emails.map(email => `
                        <a href="${email.mailLink || email.gmailLink}" target="_blank" rel="noopener noreferrer" class="inbox-email-item">
                            <div class="inbox-email-top">
                                <span class="inbox-email-from">${escapeHtml(email.from)}</span>
                                <span class="inbox-email-date">${email.date}</span>
                            </div>
                            <div class="inbox-email-subject">${escapeHtml(email.subject)}</div>
                            <div class="inbox-email-snippet">${escapeHtml(email.snippet)}</div>
                        </a>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Empty state
    if (total === 0) {
        html += `
            <div class="inbox-empty">
                <span class="inbox-empty-icon">🎉</span>
                <h3>Inbox Zero!</h3>
                <p>No important emails in the last 24 hours. Enjoy your focus time!</p>
            </div>
        `;
    }

    // Footer
    if (generatedAt) {
        html += `<div class="inbox-footer">Generated ${generatedAt}</div>`;
    }

    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    checkSession();
});
