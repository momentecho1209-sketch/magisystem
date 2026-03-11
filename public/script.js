const PANELS = ['casper', 'balthasar', 'melchior'];
const NAMES = {
  casper: 'CASPER — ChatGPT',
  balthasar: 'BALTHASAR — Gemini',
  melchior: 'MELCHIOR — Claude',
};

let results = {};

async function submitQuestion() {
  const textarea = document.getElementById('question');
  const question = textarea.value.trim();
  if (!question) return;

  const submitBtn = document.getElementById('submit');
  submitBtn.disabled = true;
  results = {};

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
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    if (data.error) {
      throw new Error(data.error);
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
    submitBtn.disabled = false;
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

// Allow Ctrl+Enter to submit
document.getElementById('question').addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    submitQuestion();
  }
});
