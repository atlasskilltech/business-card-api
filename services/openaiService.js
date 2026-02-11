// services/openaiService.js
// ✅ NO RETRIES — returns immediately on success OR failure (single attempt)
// Drop-in replacement for mistralService

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Extract business card info from image — SINGLE ATTEMPT, NO RETRIES
 * Returns immediately on success. Only fails fast on real errors.
 *
 * @param {string} imagePath - Local file path to uploaded image
 * @returns {{ success, data, fallback, rateLimited, error }}
 */
const extractCardInfo = async (imagePath) => {

  // ── 1. Validate API key ──────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    return {
      success: false,
      error: 'OpenAI API key not configured. Set OPENAI_API_KEY in backend/.env — get one at https://platform.openai.com/api-keys',
    };
  }

  if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
    return {
      success: false,
      error: 'OpenAI API key invalid (must start with sk-). Check OPENAI_API_KEY in backend/.env',
    };
  }

  // ── 2. Resolve & validate file path ─────────────────────────────────────
  const resolvedPath = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(process.cwd(), imagePath);

  if (!fs.existsSync(resolvedPath)) {
    return { success: false, error: `Image file not found: ${resolvedPath}` };
  }

  // ── 3. Read image ────────────────────────────────────────────────────────
  const imageBuffer = fs.readFileSync(resolvedPath);
  const mimeType    = detectMimeType(resolvedPath, imageBuffer);
  const base64Image = imageBuffer.toString('base64');

  console.log(`🤖 OpenAI GPT-4o Vision — single attempt (no retries)`);
  console.log(`   File : ${path.basename(resolvedPath)}`);
  console.log(`   Size : ${Math.round(imageBuffer.length / 1024)} KB`);
  console.log(`   MIME : ${mimeType}`);

  // ── 4. Call OpenAI — ONE TIME ONLY ──────────────────────────────────────
  let response;
  try {
    response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert business card OCR assistant. ' +
            'Extract contact information accurately. ' +
            'Respond with valid JSON only. No markdown. No explanation.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: 'high',
              },
            },
            {
              type: 'text',
              text: `Extract all contact information from this business card.

Return ONLY this JSON object — no markdown, no code blocks, no explanation:
{
  "name": "full name",
  "email": "email address",
  "phone": "primary phone number",
  "company": "company or organization",
  "job_title": "job title or designation",
  "address": "full address",
  "website": "website URL"
}

- Use empty string "" for any field not found on the card
- Include country code in phone if visible`,
            },
          ],
        },
      ],
    });
  } catch (apiError) {
    // ── API call failed — classify error, NO RETRY ───────────────────────
    console.error('❌ OpenAI API error:', apiError.message);

    if (apiError.status === 429 || apiError.message?.includes('rate_limit') || apiError.message?.includes('Rate limit')) {
      return { success: false, rateLimited: true, error: 'OpenAI rate limit exceeded. Try again in a moment.' };
    }
    if (apiError.status === 401 || apiError.message?.includes('Incorrect API key')) {
      return { success: false, error: 'Invalid OpenAI API key. Check OPENAI_API_KEY in .env' };
    }
    if (apiError.status === 402 || apiError.message?.includes('insufficient_quota')) {
      return { success: false, rateLimited: true, error: 'OpenAI account out of credits. Add credits at https://platform.openai.com/account/billing' };
    }

    // Any other API error — return fallback so user can fill manually
    return { success: true, fallback: true, data: emptyCard(), error: apiError.message };
  }

  // ── 5. Got response — parse immediately, return, DONE ───────────────────
  const rawText = response.choices[0]?.message?.content?.trim();
  console.log('📝 OpenAI response:', rawText);

  if (!rawText) {
    return { success: true, fallback: true, data: emptyCard(), error: 'Empty response from OpenAI' };
  }

  const cardData = parseCardJSON(rawText);
  console.log('✅ Extraction complete — returning data immediately (no retry)');

  // ✅ RETURN RIGHT HERE — nothing else runs after a successful extraction
  return {
    success: true,
    data: cardData,
    fallback: false,
    rateLimited: false,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const emptyCard = () => ({
  name: '', email: '', phone: '',
  company: '', job_title: '',
  address: '', website: '',
});

/**
 * Detect MIME type via magic bytes first (handles iOS HEIC files)
 */
const detectMimeType = (filePath, buffer) => {
  if (buffer.length >= 12) {
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF)
      return 'image/jpeg';
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47)
      return 'image/png';
    // WebP: 52 49 46 46
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46)
      return 'image/webp';
    // HEIC/HEIF (iOS): 'ftyp' at byte 4
    if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
      console.log('⚠️  HEIC/HEIF detected — remapping to image/jpeg for OpenAI');
      return 'image/jpeg';
    }
  }

  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',  '.webp': 'image/webp',
    '.heic': 'image/jpeg', '.heif': 'image/jpeg',
    '.gif': 'image/gif',   '.bmp': 'image/bmp',
  };
  return map[path.extname(filePath).toLowerCase()] || 'image/jpeg';
};

/**
 * Parse JSON from OpenAI response — strips markdown fences if present
 */
const parseCardJSON = (text) => {
  try {
    let cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];

    const parsed = JSON.parse(cleaned);
    const f = (v) => (v == null ? '' : String(v).trim());

    return {
      name:      f(parsed.name),
      email:     f(parsed.email),
      phone:     f(parsed.phone),
      company:   f(parsed.company),
      job_title: f(parsed.job_title),
      address:   f(parsed.address),
      website:   f(parsed.website),
    };
  } catch (err) {
    console.error('⚠️  JSON parse failed:', err.message, '| raw:', text);
    return emptyCard();
  }
};

module.exports = { extractCardInfo };
