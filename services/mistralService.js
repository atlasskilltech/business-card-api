const axios = require('axios');
const fs = require('fs');

class MistralService {
  constructor() {
    this.apiKey = process.env.MISTRAL_API_KEY;
    this.apiUrl = 'https://api.mistral.ai/v1/chat/completions';
    this.model = 'pixtral-12b-2409'; // Mistral's vision model
  }

  async extractCardInfo(imagePath) {
    try {
      console.log('🔍 Reading image file:', imagePath);
      
      // Read image file and convert to base64
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      console.log('✅ Image converted to base64, size:', imageBuffer.length, 'bytes');

      // Determine mime type
      const ext = imagePath.split('.').pop().toLowerCase();
      const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'webp': 'image/webp'
      };
      const mimeType = mimeTypes[ext] || 'image/jpeg';
      console.log('📄 Detected mime type:', mimeType);

      // Prepare the prompt for business card extraction
      const prompt = `You are an expert at extracting information from business cards. Analyze this business card image and extract the following information in JSON format ONLY (no other text):

{
  "name": "Full name of the person",
  "email": "Email address",
  "phone": "Phone number",
  "company": "Company/Organization name",
  "job_title": "Job title or position",
  "address": "Physical address",
  "website": "Website URL"
}

IMPORTANT RULES:
- Return ONLY valid JSON, no markdown formatting, no explanation
- If a field is not found, use empty string ""
- Extract complete information accurately
- Format phone numbers consistently
- For websites, include full URL if available
- Be precise and thorough

Analyze the business card now:`;

      console.log('🚀 Sending request to Mistral AI...');
      
      // Make API request to Mistral Vision API using axios
      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image_url',
                  image_url: `data:${mimeType};base64,${base64Image}`
                }
              ]
            }
          ],
          temperature: 0.1, // Low temperature for consistent extraction
          max_tokens: 500
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          timeout: 30000 // 30 second timeout
        }
      );

      console.log('✅ Received response from Mistral AI');

      // Extract the text response
      const generatedText = response.data?.choices?.[0]?.message?.content;
      
      if (!generatedText) {
        throw new Error('No response from Mistral AI');
      }

      console.log('📝 Raw Mistral response:', generatedText);

      // Clean the response - remove markdown code blocks if present
      let cleanedText = generatedText.trim();
      cleanedText = cleanedText.replace(/```json\n?/g, '');
      cleanedText = cleanedText.replace(/```\n?/g, '');
      cleanedText = cleanedText.trim();

      // Parse JSON from response
      const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('❌ Could not find JSON in response:', cleanedText);
        throw new Error('Could not extract JSON from response');
      }

      const extractedData = JSON.parse(jsonMatch[0]);
      console.log('✅ Parsed JSON data:', extractedData);

      // Clean and validate data
      const cleanedData = {
        name: this.cleanString(extractedData.name),
        email: this.cleanEmail(extractedData.email),
        phone: this.cleanPhone(extractedData.phone),
        company: this.cleanString(extractedData.company),
        job_title: this.cleanString(extractedData.job_title),
        address: this.cleanString(extractedData.address),
        website: this.cleanWebsite(extractedData.website)
      };

      console.log('🎉 Final cleaned data:', cleanedData);

      return {
        success: true,
        data: cleanedData
      };

    } catch (error) {
      console.error('❌ Mistral extraction error:', error.message);
      console.error('Error details:', error.response?.data || error.stack);
      
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

  cleanString(str) {
    if (!str || str === 'null' || str === 'undefined' || str === 'N/A' || str === 'n/a') return '';
    return str.trim();
  }

  cleanEmail(email) {
    if (!email || email === 'null' || email === 'undefined' || email === 'N/A') return '';
    email = email.trim().toLowerCase();
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) ? email : '';
  }

  cleanPhone(phone) {
    if (!phone || phone === 'null' || phone === 'undefined' || phone === 'N/A') return '';
    // Remove extra spaces and format
    return phone.trim().replace(/\s+/g, ' ');
  }

  cleanWebsite(website) {
    if (!website || website === 'null' || website === 'undefined' || website === 'N/A') return '';
    website = website.trim().toLowerCase();
    // Add https:// if missing
    if (website && !website.startsWith('http')) {
      website = 'https://' + website.replace(/^www\./, '');
    }
    return website;
  }
}

module.exports = new MistralService();
