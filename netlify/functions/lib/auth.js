// Shared authentication helpers for all Netlify functions
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

/**
 * Extract user ID from the meetprep_session JWT cookie.
 * Returns null if no valid session exists.
 */
function getUserIdFromCookie(event) {
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
    if (!jwtSecret) return null;
    const cookies = cookie.parse(event.headers.cookie || '');
    const token = cookies.meetprep_session;
    if (!token) return null;
    try {
        return jwt.verify(token, jwtSecret).userId;
    } catch {
        return null;
    }
}

module.exports = { getUserIdFromCookie };
