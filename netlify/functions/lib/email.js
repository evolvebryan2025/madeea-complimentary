// Shared email helpers for Netlify functions

/**
 * Create a base64url-encoded raw email for the Gmail API.
 */
function createRawEmail(to, subject, htmlBody) {
    const boundary = 'boundary_' + Date.now();
    const email = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        '',
        htmlBody,
        `--${boundary}--`,
    ].join('\r\n');

    return Buffer.from(email).toString('base64url');
}

module.exports = { createRawEmail };
