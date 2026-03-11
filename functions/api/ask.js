const SYSTEM_PROMPT = `You are a judge in a decision-making system. The user will ask a question. You must:
1. Decide YES or NO.
2. Provide a brief reason (2-3 sentences max).

Respond in this exact JSON format:
{"judgment": "YES" or "NO", "reason": "Your brief reason here"}

Always respond in the same language as the user's question. Do not include anything outside the JSON.`;

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

// Rate limiting using Cloudflare KV (simple in-memory fallback)
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 5;

  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > windowMs) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > maxRequests) return false;
  return true;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Rate limit
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response(
      JSON.stringify({ error: 'リクエスト制限に達しました。1分後に再試行してください。' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
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

  const sanitized = question.trim().slice(0, 500);
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
