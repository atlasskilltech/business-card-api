const axios = require('axios');
const fs = require('fs');

class GeminiService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;

    // ✅ FREE + VISION supported
    this.apiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent';
  }

  async extractCardInfo(imagePath) {
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');

      const ext = imagePath.split('.').pop().toLowerCase();
      const mimeTypes = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp'
      };
      const mimeType = mimeTypes[ext] || 'image/jpeg';

      const prompt = `
Extract business card details and return ONLY valid JSON.

JSON format:
{
  "name": "",
  "email": "",
  "phone": "",
  "company": "",
  "job_title": "",
  "address": "",
  "website": ""
}

Rules:
- No markdown
- No explanation
- Empty string if missing
`;

      const response = await axios.post(
        `${this.apiUrl}?key=${this.apiKey}`,
        {
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Image
                  }
                }
              ]
            }
          ]
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const text =
        response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) throw new Error('Empty Gemini response');

      const json = JSON.parse(text);

      return {
        success: true,
        data: {
          name: this.cleanString(json.name),
          email: this.cleanEmail(json.email),
          phone: this.cleanPhone(json.phone),
          company: this.cleanString(json.company),
          job_title: this.cleanString(json.job_title),
          address: this.cleanString(json.address),
          website: this.cleanWebsite(json.website)
        }
      };

    } catch (error) {
      console.error(
        'Gemini extraction error:',
        error.response?.data || error.message
      );

      return {
        success: false,
        error: error.message,
        data: {
          name: '',
          email: '',
          phone: '',
          company: '',
          job_title: '',
          address: '',
          website: ''
        }
      };
    }
  }

  cleanString(v) {
    return v && v !== 'null' ? String(v).trim() : '';
  }

  cleanEmail(v) {
    if (!v) return '';
    v = v.toLowerCase().trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
  }

  cleanPhone(v) {
    return v ? v.replace(/\s+/g, ' ').trim() : '';
  }

  cleanWebsite(v) {
    if (!v) return '';
    if (!v.startsWith('http')) {
      v = 'https://' + v.replace(/^www\./, '');
    }
    return v;
  }
}

module.exports = new GeminiService();
