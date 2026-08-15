const fetch = require('node-fetch');

// Free-tier providers, tried in order if one fails/rate-limits.
// Add your keys as env vars: GROQ_API_KEY, GEMINI_API_KEY
const PROVIDERS = [
  {
    name: 'groq',
    enabled: () => !!process.env.GROQ_API_KEY,
    call: async (prompt) => {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          response_format: { type: 'json_object' }
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Groq request failed');
      return data.choices[0].message.content;
    }
  },
  {
    name: 'gemini',
    enabled: () => !!process.env.GEMINI_API_KEY,
    call: async (prompt) => {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
          })
        }
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Gemini request failed');
      return data.candidates[0].content.parts[0].text;
    }
  }
];

function buildPrompt(transcriptSegments, videoDuration) {
  // Compact transcript: "[start-end] text" per line, keeps token count low
  const transcriptText = transcriptSegments
    .map(s => `[${s.start}-${s.end}] ${s.text}`)
    .join('\n');

  return `You are an expert short-form video editor. Below is a timestamped transcript of a ${Math.round(videoDuration)}s video.

Identify the 5 BEST moments to turn into standalone vertical Shorts.

STRICT DURATION RULE: every clip MUST be between 25 and 60 seconds long (end - start). Never pick a moment shorter than 25 seconds — if a great line is short, WIDEN the clip to include the setup/reaction around it so it's self-contained AND at least 25 seconds. Prefer 30-45 seconds as the sweet spot. Do not exceed 60 seconds.

Each clip should make sense on its own without the rest of the video — include enough surrounding context (a question before the answer, a reaction after the punchline, etc.) rather than cutting right at the interesting word.

For each moment, pick a real start/end timestamp from the transcript (do not invent timestamps outside the transcript's range) and classify it into ONE category: "hook", "funny", "surprising", "educational", "emotional".

Respond ONLY with valid JSON in this exact shape, no other text:
{
  "clips": [
    {
      "start": 12.5,
      "end": 45.0,
      "category": "funny",
      "title": "short punchy title for this clip",
      "reason": "one sentence on why this moment works as a short",
      "viral_score": 8
    }
  ]
}

Transcript:
${transcriptText}`;
}

// Safety net in case the LLM doesn't fully respect the duration instructions:
// widen any clip under MIN_DURATION by pulling in surrounding transcript
// context symmetrically, and trim anything over MAX_DURATION.
const MIN_DURATION = 25;
const MAX_DURATION = 60;

function enforceDurationBounds(clips, videoDuration) {
  return clips.map(clip => {
    let { start, end } = clip;
    let dur = end - start;

    if (dur < MIN_DURATION) {
      const need = MIN_DURATION - dur;
      start = Math.max(0, start - need / 2);
      end = Math.min(videoDuration, start + MIN_DURATION);
      // if we hit the video's start/end boundary, pull the rest from the other side
      start = Math.max(0, end - MIN_DURATION);
    } else if (dur > MAX_DURATION) {
      end = start + MAX_DURATION;
    }

    return { ...clip, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
  });
}

async function analyzeTranscript(transcriptSegments, videoDuration) {
  const prompt = buildPrompt(transcriptSegments, videoDuration);
  const errors = [];

  for (const provider of PROVIDERS) {
    if (!provider.enabled()) continue;
    try {
      const raw = await provider.call(prompt);
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed.clips || !Array.isArray(parsed.clips)) {
        throw new Error('Malformed response: missing clips array');
      }
      const clips = enforceDurationBounds(parsed.clips.slice(0, 5), videoDuration);
      return { provider: provider.name, clips };
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`);
      continue; // try next provider
    }
  }

  throw new Error(`All providers failed:\n${errors.join('\n')}`);
}

module.exports = { analyzeTranscript };
