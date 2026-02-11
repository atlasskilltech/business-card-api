const axios = require('axios');
const fs = require('fs');

class MistralService {
  constructor() {
    this.apiKey = process.env.MISTRAL_API_KEY;
    this.apiUrl = 'https://api.mistral.ai/v1/chat/completions';
    this.model = 'pixtral-12b-2409'; // Mistral's vision model
  }

  async extractCardInfo(imagePath) {
    // Check if API key is configured
    if (!this.apiKey || this.apiKey === 'your_mistral_api_key' || this.apiKey === 'your-mistral-api-key') {
      console.log('⚠️  Mistral API key not configured - using fallback extraction');
      return this.fallbackExtraction(imagePath);
    }

    // Try with retries
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔍 Reading image file (attempt ${attempt}/${maxRetries}):`, imagePath);
        
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
        const prompt = `Extract business card info and return JSON only:
        {
          "name": "",
          "email": "",
          "phone": "",
          "company": "",
          "job_title": "",
          "address": "",
          "website": ""
        }`;

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
            temperature: 0.1,
            max_tokens: 250
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`
            },
            timeout: 30000
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
        lastError = error;
        console.error(`❌ Mistral extraction error (attempt ${attempt}/${maxRetries}):`, error.message);
        
        // Check for rate limit
        if (error.response?.status === 429 || error.response?.data?.code === '1300') {
          console.log('⚠️  Rate limit exceeded');
          console.log('Error details:', error.response?.data);
          
          if (attempt < maxRetries) {
            // Wait before retry (exponential backoff)
            const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
            console.log(`⏳ Waiting ${waitTime/1000} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            // All retries exhausted, use fallback
            console.log('❌ Rate limit - all retries exhausted, using fallback');
            return {
              success: false,
              error: 'Rate limit exceeded. Please try again in a few minutes or upgrade your Mistral API plan.',
              rateLimited: true,
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
        
        // Check for invalid API key
        if (error.response?.status === 401) {
          console.error('❌ Invalid API key');
          return {
            success: false,
            error: 'Invalid Mistral API key',
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
        
        // Other errors - retry
        if (attempt < maxRetries) {
          console.log(`⏳ Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        
        console.error('Error details:', error.response?.data || error.stack);
      }
    }
    
    // All retries failed
    console.log('❌ All retries failed, using fallback extraction');
    return this.fallbackExtraction(imagePath);
  }

  // Fallback extraction when Mistral API is not available
  async fallbackExtraction(imagePath) {
    console.log('📋 Using fallback extraction (manual entry required)');
    
    // Return empty data structure - user will need to fill in manually
    return {
      success: true,
      data: {
        name: '',
        email: '',
        phone: '',
        company: '',
        job_title: '',
        address: '',
        website: ''
      },
      fallback: true,
      message: 'AI extraction unavailable. Please fill in the card information manually.'
    };
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
