const UNLOCK_MAX_ATTEMPTS = 3;
const UNLOCK_BLOCK_TIME = 300; // 5 minutes in seconds
const UNLOCK_TTL = 3600;       // unlock lasts 1 hour (auto-reset)

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text.trim());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.MAGI_KV;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (!kv) {
    return new Response(
      JSON.stringify({ success: false }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Check if IP is blocked from too many attempts
  const attemptKey = `unlock-attempt:${ip}`;
  const attemptData = await kv.get(attemptKey, 'json');

  if (attemptData && attemptData.blocked) {
    return new Response(
      JSON.stringify({ success: false }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { keyword } = body;
  if (!keyword || typeof keyword !== 'string') {
    return new Response(
      JSON.stringify({ success: false }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Hash the input keyword
  const inputHash = await sha256(keyword);

  // Get valid keyword hashes from env
  const validHashes = (env.UNLOCK_KEYWORD_HASHES || '')
    .split(',')
    .map(h => h.trim())
    .filter(h => h.length > 0);

  if (validHashes.includes(inputHash)) {
    // Correct keyword — unlock this IP
    await kv.put(`unlock:${ip}`, 'true', { expirationTtl: UNLOCK_TTL });
    await kv.delete(attemptKey);

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Wrong keyword — track attempts
  const currentAttempts = attemptData ? attemptData.count : 0;
  const newCount = currentAttempts + 1;

  if (newCount >= UNLOCK_MAX_ATTEMPTS) {
    // Block this IP
    await kv.put(attemptKey, JSON.stringify({ count: newCount, blocked: true }), {
      expirationTtl: UNLOCK_BLOCK_TIME,
    });
  } else {
    await kv.put(attemptKey, JSON.stringify({ count: newCount }), {
      expirationTtl: UNLOCK_BLOCK_TIME,
    });
  }

  return new Response(
    JSON.stringify({ success: false }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
