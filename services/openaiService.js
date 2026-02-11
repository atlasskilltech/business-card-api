// services/openaiService.js
// Drop-in replacement for mistralService
// Uses OpenAI GPT-4o Vision to extract business card info

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Extract business card information from image
 * Same interface as mistralService.extractCardInfo()
 *
 * @param {string} imagePath - Local file path to the uploaded image
 * @returns {Object} { success, data, fallback, rateLimited, error }
 */
const extractCardInfo = async (imagePath) => {
  try {
    // Validate API key first
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ OPENAI_API_KEY is not set');
      return {
        success: false,
        error: 'OpenAI API key is not configured. Please set OPENAI_API_KEY in backend/.env',
      };
    }

    if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
      console.error('❌ OPENAI_API_KEY appears invalid');
      return {
        success: false,
        error: 'OpenAI API key appears invalid (should start with sk-). Get one at https://platform.openai.com/api-keys',
      };
    }

    // Validate image file exists
    if (!fs.existsSync(imagePath)) {
      console.error('❌ Image file not found:', imagePath);
      return {
        success: false,
        error: `Image file not found at path: ${imagePath}`,
      };
    }

    // Read image and convert to base64
    console.log('📖 Reading image from disk:', imagePath);
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = getMimeType(imagePath);

    console.log(`🤖 Sending to OpenAI GPT-4o Vision (${mimeType}, ${Math.round(imageBuffer.length / 1024)}KB)...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert business card OCR assistant. Extract all visible contact information from business card images with high accuracy. Always return valid JSON only. Never include markdown, code blocks, or explanations.',
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

Return ONLY this JSON object with no other text:
{
  "name": "full name of the person",
  "email": "email address",
  "phone": "primary phone number",
  "company": "company or organization name",
  "job_title": "job title or designation",
  "address": "full address if present",
  "website": "website URL"
}

Rules:
- Return ONLY the JSON, no markdown, no code blocks, no explanation
- Use empty string "" for any field not found on the card
- Include country code in phone numbers if visible`,
            },
          ],
        },
      ],
    });

    const rawText = response.choices[0]?.message?.content?.trim();
    console.log('📝 OpenAI raw response:', rawText);

    if (!rawText) {
      return {
        success: false,
        error: 'Empty response from OpenAI',
      };
    }

    // Parse JSON from response
    const cardData = parseCardJSON(rawText);
    console.log('✅ OpenAI extraction successful:', cardData);

    return {
      success: true,
      data: cardData,
      fallback: false,
      rateLimited: false,
    };

  } catch (error) {
    console.error('❌ OpenAI extractCardInfo error:', error);

    // Rate limit (429)
    if (error.status === 429 || error.message?.includes('rate_limit') || error.message?.includes('quota')) {
      return {
        success: false,
        rateLimited: true,
        error: 'OpenAI rate limit exceeded. Please wait a moment and try again.',
      };
    }

    // Auth error (401)
    if (error.status === 401 || error.message?.includes('Incorrect API key')) {
      return {
        success: false,
        error: 'OpenAI API key is invalid. Please check OPENAI_API_KEY in backend/.env. Get a key at https://platform.openai.com/api-keys',
      };
    }

    // Insufficient credits (402)
    if (error.status === 402 || error.message?.includes('insufficient_quota')) {
      return {
        success: false,
        rateLimited: true,
        error: 'OpenAI account has insufficient credits. Please add credits at https://platform.openai.com/account/billing',
      };
    }

    // Network or unknown error — return fallback empty card so user can fill manually
    console.log('⚠️  Returning fallback empty card due to error:', error.message);
    return {
      success: true,
      fallback: true,
      data: {
        name: '', email: '', phone: '',
        company: '', job_title: '',
        address: '', website: '',
      },
      error: error.message,
    };
  }
};

/**
 * Parse and clean JSON from OpenAI response
 * Handles markdown code blocks the model sometimes wraps around JSON
 */
const parseCardJSON = (text) => {
  try {
    // Strip markdown code fences if present
    let cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    // Extract JSON object if there's surrounding text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];

    const parsed = JSON.parse(cleaned);

    return {
      name:      cleanField(parsed.name),
      email:     cleanField(parsed.email),
      phone:     cleanField(parsed.phone),
      company:   cleanField(parsed.company),
      job_title: cleanField(parsed.job_title),
      address:   cleanField(parsed.address),
      website:   cleanField(parsed.website),
    };
  } catch (err) {
    console.error('⚠️  JSON parse failed, returning empty card. Raw text was:', text);
    return {
      name: '', email: '', phone: '',
      company: '', job_title: '',
      address: '', website: '',
    };
  }
};

const cleanField = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.bmp':  'image/bmp',
  };
  return map[ext] || 'image/jpeg';
};

module.exports = { extractCardInfo };
