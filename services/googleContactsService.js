const { google } = require('googleapis');
const googleAuthService = require('./googleAuthService');

class GoogleContactsService {
  async syncContact(userId, contactData) {
    try {
      // Get valid tokens
      const tokens = await googleAuthService.ensureValidToken(userId);
      const authClient = googleAuthService.getAuthClient(tokens);

      // Initialize People API
      const people = google.people({ version: 'v1', auth: authClient });

      // Prepare contact resource
      const contactResource = this.buildContactResource(contactData);

      // Create contact
      const response = await people.people.createContact({
        requestBody: contactResource
      });

      return {
        success: true,
        contactId: response.data.resourceName,
        data: response.data
      };

    } catch (error) {
      console.error('Google Contacts sync error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateContact(userId, googleContactId, contactData) {
    try {
      const tokens = await googleAuthService.ensureValidToken(userId);
      const authClient = googleAuthService.getAuthClient(tokens);

      const people = google.people({ version: 'v1', auth: authClient });

      // Get current contact to get etag
      const current = await people.people.get({
        resourceName: googleContactId,
        personFields: 'names,emailAddresses,phoneNumbers,organizations,addresses,urls'
      });

      const contactResource = this.buildContactResource(contactData);

      // Update contact
      const response = await people.people.updateContact({
        resourceName: googleContactId,
        updatePersonFields: 'names,emailAddresses,phoneNumbers,organizations,addresses,urls',
        requestBody: {
          ...contactResource,
          etag: current.data.etag
        }
      });

      return {
        success: true,
        data: response.data
      };

    } catch (error) {
      console.error('Google Contacts update error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async checkDuplicate(userId, email) {
    try {
      const tokens = await googleAuthService.ensureValidToken(userId);
      const authClient = googleAuthService.getAuthClient(tokens);

      const people = google.people({ version: 'v1', auth: authClient });

      // Search for contacts with this email
      const response = await people.people.searchContacts({
        query: email,
        readMask: 'names,emailAddresses'
      });

      if (response.data.results && response.data.results.length > 0) {
        return {
          isDuplicate: true,
          contactId: response.data.results[0].person.resourceName
        };
      }

      return { isDuplicate: false };

    } catch (error) {
      console.error('Duplicate check error:', error);
      return { isDuplicate: false };
    }
  }

  buildContactResource(contactData) {
    const resource = {};

    // Name
    if (contactData.name) {
      resource.names = [{
        displayName: contactData.name,
        familyName: contactData.name.split(' ').pop(),
        givenName: contactData.name.split(' ')[0]
      }];
    }

    // Email
    if (contactData.email) {
      resource.emailAddresses = [{
        value: contactData.email,
        type: 'work'
      }];
    }

    // Phone
    if (contactData.phone) {
      resource.phoneNumbers = [{
        value: contactData.phone,
        type: 'work'
      }];
    }

    // Organization
    if (contactData.company || contactData.job_title) {
      resource.organizations = [{
        name: contactData.company || '',
        title: contactData.job_title || '',
        type: 'work'
      }];
    }

    // Address
    if (contactData.address) {
      resource.addresses = [{
        formattedValue: contactData.address,
        type: 'work'
      }];
    }

    // Website
    if (contactData.website) {
      resource.urls = [{
        value: contactData.website,
        type: 'work'
      }];
    }

    // Notes
    if (contactData.notes) {
      resource.biographies = [{
        value: contactData.notes,
        contentType: 'TEXT_PLAIN'
      }];
    }

    return resource;
  }

  async batchSyncContacts(userId, contacts) {
    const results = [];

    for (const contact of contacts) {
      const result = await this.syncContact(userId, contact);
      results.push({
        contactId: contact.id,
        success: result.success,
        googleContactId: result.contactId || null,
        error: result.error || null
      });

      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
  }
}

module.exports = new GoogleContactsService();