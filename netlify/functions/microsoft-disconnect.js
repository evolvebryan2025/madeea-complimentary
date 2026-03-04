// Disconnect Microsoft — Clear tokens without deleting account
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
    const cookies = cookie.parse(event.headers.cookie || '');
    const token = cookies.meetprep_session;

    if (!token) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

    try {
        const decoded = jwt.verify(token, jwtSecret);
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

        // Clear Microsoft fields from user record
        // (Microsoft doesn't have a simple token revocation endpoint like Google)
        await supabase.from('users').update({
            microsoft_access_token: null,
            microsoft_refresh_token: null,
            microsoft_token_expiry: null,
            updated_at: new Date().toISOString(),
        }).eq('id', decoded.userId);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true }),
        };
    } catch (err) {
        console.error('Microsoft disconnect error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to disconnect Microsoft' }) };
    }
};
