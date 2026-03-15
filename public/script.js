const PANELS = ['casper', 'balthasar', 'melchior'];
const NAMES = {
  casper: 'CASPER — ChatGPT',
  balthasar: 'BALTHASAR — Gemini',
  melchior: 'MELCHIOR — Claude',
};

let results = {};
let unlocked = false;

// --- Turnstile ---
const TURNSTILE_SITE_KEY = '0x4AAAAAACpwCj4LwTPGtiF1';
let turnstileWidgetId = null;
let turnstileReady = false;

function initTurnstile() {
  if (turnstileWidgetId !== null || !window.turnstile) return;
  turnstileWidgetId = turnstile.render('#turnstile-container', {
    sitekey: TURNSTILE_SITE_KEY,
    size: 'invisible',
    callback: () => { turnstileReady = true; },
  });
}

function getTurnstileToken() {
  if (!window.turnstile || turnstileWidgetId === null) return null;
  return turnstile.getResponse(turnstileWidgetId);
}

function resetTurnstile() {
  if (window.turnstile && turnstileWidgetId !== null) {
    turnstile.reset(turnstileWidgetId);
    turnstileReady = false;
  }
}

// Init when Turnstile SDK loads
if (window.turnstile) {
  initTurnstile();
} else {
  window.addEventListener('load', () => setTimeout(initTurnstile, 500));
}

// --- Rate limit tracking (client-side, persisted via sessionStorage) ---
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 5;
let cooldownTimer = null;

function loadRateState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('magi_rate') || '{}');
    return {
      timestamps: (saved.timestamps || []).filter(t => Date.now() - t < RATE_WINDOW),
      cooldownEnd: saved.cooldownEnd || 0,
    };
  } catch { return { timestamps: [], cooldownEnd: 0 }; }
}

function saveRateState(timestamps, cooldownEnd) {
  sessionStorage.setItem('magi_rate', JSON.stringify({ timestamps, cooldownEnd }));
}

let { timestamps: queryTimestamps, cooldownEnd } = loadRateState();

function getRemainingQueries() {
  if (unlocked) return Infinity;
  if (Date.now() < cooldownEnd) return 0;
  return RATE_MAX - queryTimestamps.length;
}

function getResetTime() {
  if (Date.now() < cooldownEnd) {
    return Math.ceil((cooldownEnd - Date.now()) / 1000);
  }
  return 0;
}

function updateCooldownDisplay() {
  const el = document.getElementById('cooldown-bar');
  if (!el) return;

  if (unlocked) {
    el.style.display = 'none';
    return;
  }

  const remaining = getRemainingQueries();
  const resetSec = getResetTime();

  if (remaining > 0) {
    el.style.display = 'none';
    if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    return;
  }

  el.style.display = 'flex';
  document.getElementById('cooldown-time').textContent = resetSec;

  if (!cooldownTimer) {
    cooldownTimer = setInterval(() => {
      const sec = getResetTime();
      if (sec <= 0) {
        el.style.display = 'none';
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        document.getElementById('submit').disabled = false;
      } else {
        document.getElementById('cooldown-time').textContent = sec;
      }
    }, 1000);
  }
}

async function submitQuestion() {
  const textarea = document.getElementById('question');
  const question = textarea.value.trim().slice(0, 300);
  if (!question) return;

  // Client-side rate check
  if (!unlocked && getRemainingQueries() <= 0) {
    updateCooldownDisplay();
    return;
  }

  const submitBtn = document.getElementById('submit');
  submitBtn.disabled = true;
  results = {};

  // Disable share button during analysis
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.disabled = true;

  // Reset panels
  PANELS.forEach(id => {
    const panel = document.getElementById(`panel-${id}`);
    panel.className = 'magi-panel analyzing';
    document.getElementById(`status-${id}`).textContent = 'ANALYZING...';
    document.getElementById(`judgment-${id}`).textContent = '...';
  });

  // Reset result bar
  const resultBar = document.getElementById('result-bar');
  resultBar.className = 'result-bar';
  document.getElementById('result-text').textContent = 'PROCESSING...';

  try {
    // Get Turnstile token
    const cfToken = getTurnstileToken();

    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, cfToken }),
    });
    const data = await res.json();

    if (data.error) {
      if (res.status === 429 && data.resetIn) {
        // Server-side rate limit hit
        queryTimestamps.push(Date.now());
        saveRateState(queryTimestamps, cooldownEnd);
        updateCooldownDisplay();
      }
      throw new Error(data.error);
    }

    // Record successful query
    if (!unlocked) {
      queryTimestamps.push(Date.now());
      if (queryTimestamps.length >= RATE_MAX) {
        cooldownEnd = Date.now() + RATE_WINDOW;
        queryTimestamps.length = 0;
      }
      saveRateState(queryTimestamps, cooldownEnd);
      updateCooldownDisplay();
    }

    // Stagger the reveal for dramatic effect
    const entries = [
      ['casper', data.casper],
      ['balthasar', data.balthasar],
      ['melchior', data.melchior],
    ];

    for (let i = 0; i < entries.length; i++) {
      await delay(400 + Math.random() * 300);
      const [id, result] = entries[i];
      revealPanel(id, result);
    }

    await delay(300);
    showFinalResult();
  } catch (err) {
    PANELS.forEach(id => {
      const panel = document.getElementById(`panel-${id}`);
      panel.className = 'magi-panel error';
      document.getElementById(`status-${id}`).textContent = 'ERROR';
      document.getElementById(`judgment-${id}`).textContent = 'ERR';
    });
    document.getElementById('result-text').textContent = `ERROR: ${err.message}`;
  } finally {
    resetTurnstile();
    if (!unlocked && getRemainingQueries() <= 0) {
      updateCooldownDisplay();
    } else {
      submitBtn.disabled = false;
    }
  }
}

function revealPanel(id, result) {
  const panel = document.getElementById(`panel-${id}`);
  const status = document.getElementById(`status-${id}`);
  const judgment = document.getElementById(`judgment-${id}`);

  results[id] = result;

  if (result.judgment === 'ERROR') {
    panel.className = 'magi-panel error';
    status.textContent = 'ERROR';
    judgment.textContent = 'ERR';
  } else {
    const isYes = result.judgment === 'YES';
    panel.className = `magi-panel ${isYes ? 'yes' : 'no'}`;
    status.textContent = 'COMPLETE';
    judgment.textContent = isYes ? 'YES' : 'NO';
  }
}

function showFinalResult() {
  const votes = PANELS.map(id => results[id]?.judgment).filter(j => j && j !== 'ERROR');
  const yesCount = votes.filter(v => v === 'YES').length;
  const noCount = votes.filter(v => v === 'NO').length;

  const resultBar = document.getElementById('result-bar');
  const resultText = document.getElementById('result-text');

  if (yesCount > noCount) {
    resultBar.className = 'result-bar approved';
    resultText.textContent = `APPROVED — ${yesCount}:${noCount}`;
  } else if (noCount > yesCount) {
    resultBar.className = 'result-bar denied';
    resultText.textContent = `DENIED — ${yesCount}:${noCount}`;
  } else {
    resultBar.className = 'result-bar split';
    resultText.textContent = `SPLIT DECISION — ${yesCount}:${noCount}`;
  }

  // Enable share button
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.disabled = false;
}

function showDetail(id) {
  const result = results[id];
  if (!result) return;

  const modal = document.getElementById('modal');
  const header = document.getElementById('modal-header');
  const body = document.getElementById('modal-body');

  header.textContent = NAMES[id];
  body.textContent = `JUDGMENT: ${result.judgment}\n\n${result.reason}`;

  modal.classList.add('active');
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modal').classList.remove('active');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Share on X ---
let shareImageBlob = null;
let shareTextContent = '';

async function shareResult() {
  const captureArea = document.getElementById('capture-area');
  if (!captureArea || typeof html2canvas === 'undefined') return;

  const btn = document.getElementById('share-btn');
  const originalText = btn.textContent;
  btn.textContent = 'CAPTURING...';
  btn.disabled = true;

  try {
    // Show question as static text for capture, hide textarea+button
    const question = document.getElementById('question').value.trim();
    const captureQ = document.getElementById('capture-question');
    const inputWrapper = document.getElementById('input-wrapper');
    captureQ.textContent = question;
    captureQ.style.display = 'block';
    inputWrapper.style.display = 'none';

    const canvas = await html2canvas(captureArea, {
      backgroundColor: '#0a0a0a',
      scale: 2,
    });

    // Restore input
    captureQ.style.display = 'none';
    inputWrapper.style.display = 'flex';

    const resultText = document.getElementById('result-text').textContent;
    const siteUrl = location.origin;
    shareTextContent = `[MAGI SYSTEM — OUTPUT]\n\n> INQUIRY: ${question}\n> RESULT: ${resultText}\n\n${siteUrl}\n#MAGI_AI`;
    shareImageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

    // Show modal with preview
    const preview = document.getElementById('share-preview');
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    preview.innerHTML = '';
    preview.appendChild(img);

    document.getElementById('share-text-preview').textContent = shareTextContent;
    document.getElementById('copy-image-btn').textContent = 'COPY IMAGE';
    document.getElementById('copy-image-btn').classList.remove('success');
    document.getElementById('share-modal').classList.add('active');
  } catch (e) {
    // Restore input on error
    document.getElementById('capture-question').style.display = 'none';
    document.getElementById('input-wrapper').style.display = 'flex';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function copyImageToClipboard() {
  if (!shareImageBlob) return;
  const btn = document.getElementById('copy-image-btn');
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': shareImageBlob })
    ]);
    btn.textContent = 'COPIED!';
    btn.classList.add('success');
  } catch {
    // Fallback: download
    const link = document.createElement('a');
    link.download = 'magi-result.png';
    link.href = URL.createObjectURL(shareImageBlob);
    link.click();
    URL.revokeObjectURL(link.href);
    btn.textContent = 'SAVED!';
    btn.classList.add('success');
  }
}

function openXShare() {
  const url = `https://x.com/intent/post?text=${encodeURIComponent(shareTextContent)}`;
  window.open(url, '_blank');
}

function closeShareModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('share-modal').classList.remove('active');
}

// Restore cooldown display on page load
updateCooldownDisplay();
if (getRemainingQueries() <= 0) {
  document.getElementById('submit').disabled = true;
}

// Allow Ctrl+Enter to submit
document.getElementById('question').addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    submitQuestion();
  }
});

// --- Hidden keyword input ---
(function() {
  const ghost = document.getElementById('ghost-input');
  if (!ghost) return;

  ghost.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const keyword = ghost.value.trim();
      ghost.value = '';
      if (!keyword) return;

      try {
        const res = await fetch('/api/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword }),
        });
        const data = await res.json();
        if (data.success) {
          unlocked = true;
          const cooldown = document.getElementById('cooldown-bar');
          if (cooldown) cooldown.style.display = 'none';
          if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
          document.getElementById('submit').disabled = false;
          ghost.style.borderColor = 'var(--green-primary)';
          setTimeout(() => { ghost.style.borderColor = ''; }, 1500);
        }
      } catch (e) {
        // silent fail
      }
    }
  });
})();
