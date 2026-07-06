'use strict';

/**
 * AI column→field mapping (optional). Used as the PRIMARY mapper when the user
 * has configured a Gemini API key; otherwise the deterministic mapper is used.
 *
 * It only ever PROPOSES a mapping — the deterministic planner/validators remain
 * the sole gate before any write. The model sees column headers + a few sample
 * values + the existing Firestore field names; never the whole sheet.
 *
 * callGemini is injected so this is unit-testable without a network call.
 */

const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

function buildPrompt(headers, sampleRows, existingFields) {
  const samples = sampleRows.slice(0, 5).map((r) => r.values || r);
  return [
    'You map spreadsheet columns to Firestore document fields.',
    'Return ONLY JSON: {"map":{"<header>":{"field":"<fieldName>","excluded":<bool>}}}.',
    'Prefer matching an EXISTING field when a column clearly corresponds to it.',
    'Use camelCase for new field names. Set excluded:true for helper/notes columns that should not sync.',
    'Use dot notation (e.g. "price.amount") only when a column clearly belongs nested.',
    `Existing Firestore fields: ${JSON.stringify(existingFields)}`,
    `Columns: ${JSON.stringify(headers)}`,
    `Sample rows: ${JSON.stringify(samples)}`,
  ].join('\n');
}

/** Default network caller (real Gemini). Kept tiny; injected in tests. */
async function defaultCallGemini(apiKey, prompt) {
  const res = await fetch(`${DEFAULT_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * @returns {Promise<object|null>} a validated fieldMap, or null on any failure
 * (caller then falls back to the deterministic map).
 */
async function aiFieldMap({ apiKey, headers, sampleRows, existingFields, callGemini = defaultCallGemini }) {
  if (!apiKey) return null;
  try {
    const raw = await callGemini(apiKey, buildPrompt(headers, sampleRows, existingFields));
    const parsed = JSON.parse(raw);
    const src = parsed && parsed.map ? parsed.map : parsed;
    if (!src || typeof src !== 'object') return null;
    const map = {};
    for (const h of headers) {
      if (h === '_sheetSyncId') continue;
      const e = src[h];
      // Validate every entry; anything malformed → skip (deterministic fills it).
      if (e && typeof e.field === 'string' && /^[a-zA-Z][\w.]*$/.test(e.field)) {
        map[h] = { field: e.field, excluded: Boolean(e.excluded), source: 'ai' };
      }
    }
    return Object.keys(map).length ? map : null;
  } catch (_e) {
    return null; // fail closed → deterministic mapping
  }
}

module.exports = { aiFieldMap, buildPrompt };
