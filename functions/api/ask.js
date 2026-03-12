const SYSTEM_PROMPT = `You are a judge in a decision-making system. The user will ask a question. You must:
1. Decide YES or NO.
2. Provide a brief reason (2-3 sentences max).

Respond in this exact JSON format:
{"judgment": "YES" or "NO", "reason": "Your brief reason here"}

Always respond in the same language as the user's question. Do not include anything outside the JSON.`;

const RATE_MAX = 5;
const RATE_WINDOW = 60; // seconds

// --- Rate limiting via KV ---
async function checkRateLimit(kv, ip) {
  const key = `rate:${ip}`;
  const data = await kv.get(key, 'json');

  if (!data) {
    // First request
    await kv.put(key, JSON.stringify({ count: 1 }), { expirationTtl: RATE_WINDOW });
    return { allowed: true, remaining: RATE_MAX - 1 };
  }

  if (data.cooldownUntil) {
    const now = Math.floor(Date.now() / 1000);
    if (now < data.cooldownUntil) {
      return { allowed: false, resetIn: data.cooldownUntil - now };
    }
    // Cooldown expired, reset
    await kv.put(key, JSON.stringify({ count: 1 }), { expirationTtl: RATE_WINDOW });
    return { allowed: true, remaining: RATE_MAX - 1 };
  }

  const newCount = data.count + 1;

  if (newCount >= RATE_MAX) {
    // Hit the limit — start cooldown
    const cooldownUntil = Math.floor(Date.now() / 1000) + RATE_WINDOW;
    await kv.put(key, JSON.stringify({ count: 0, cooldownUntil }), { expirationTtl: RATE_WINDOW + 5 });
    return { allowed: true, remaining: 0 }; // Allow this last request, then lock
  }

  // Refresh TTL with updated count
  await kv.put(key, JSON.stringify({ count: newCount }), { expirationTtl: RATE_WINDOW });
  return { allowed: true, remaining: RATE_MAX - newCount };
}

// --- Check unlock status ---
async function isUnlocked(kv, ip) {
  const val = await kv.get(`unlock:${ip}`);
  return val === 'true';
}

// --- OpenRouter API call ---
async function callOpenRouter(apiKey, model, question) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
      max_tokens: 200,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err}`);
  }

  const data = await res.json();
  return parseResponse(data.choices[0].message.content);
}

function parseResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        judgment: parsed.judgment.toUpperCase().includes('YES') ? 'YES' : 'NO',
        reason: parsed.reason || 'No reason provided.',
      };
    }
  } catch (e) {
    // fallback
  }
  const upper = text.toUpperCase();
  return {
    judgment: upper.includes('YES') ? 'YES' : 'NO',
    reason: text.slice(0, 200),
  };
}

function mockResponse(name) {
  const isYes = Math.random() > 0.5;
  return {
    judgment: isYes ? 'YES' : 'NO',
    reason: `[MOCK] ${name} - APIキーが未設定のためモック応答です。`,
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.MAGI_KV;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  // Check unlock status — skip rate limit if unlocked
  const unlocked = kv ? await isUnlocked(kv, ip) : false;

  if (!unlocked && kv) {
    const limit = await checkRateLimit(kv, ip);
    if (!limit.allowed) {
      return new Response(
        JSON.stringify({
          error: `リクエスト制限に達しました。${limit.resetIn}秒後に再試行してください。`,
          resetIn: limit.resetIn,
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { question } = body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return new Response(
      JSON.stringify({ error: 'Question is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const sanitized = question.trim().slice(0, 300);
  const apiKey = env.OPENROUTER_API_KEY;

  const models = {
    casper: 'openai/gpt-4o-mini',
    balthasar: 'google/gemini-2.0-flash-001',
    melchior: 'anthropic/claude-3-haiku',
  };

  const results = {};
  const promises = Object.entries(models).map(async ([key, model]) => {
    try {
      if (!apiKey) {
        results[key] = mockResponse(model);
      } else {
        results[key] = await callOpenRouter(apiKey, model, sanitized);
      }
    } catch (e) {
      if (e.message?.includes('402') || e.message?.includes('429')) {
        results[key] = mockResponse(`${model} [クレジット不足]`);
      } else {
        results[key] = { judgment: 'ERROR', reason: e.message || 'Unknown error' };
      }
    }
  });

  await Promise.all(promises);

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
}
