// Session check — Verify JWT and return current user data
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

exports.handler = async (event) => {
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;

    if (!jwtSecret) {
        console.error('auth-session: Missing JWT_SECRET and ENCRYPTION_KEY');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: null }) };
    }

    try {
        // Parse cookies
        const rawCookie = event.headers.cookie || '';
        const cookies = cookie.parse(rawCookie);
        const token = cookies.meetprep_session;

        if (!token) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: null }),
            };
        }

        // Verify JWT
        const decoded = jwt.verify(token, jwtSecret);

        // Fetch user data — use select('*') to avoid failing on missing columns
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', decoded.userId)
            .single();

        if (error || !user) {
            console.error('auth-session query failed:', error?.message || 'no user found', 'userId:', decoded.userId);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: null }),
            };
        }

        // Compute provider connection flags, then strip ALL token fields before response
        const google_connected = !!user.google_access_token;
        const microsoft_connected = !!user.microsoft_access_token;
        delete user.google_access_token;
        delete user.google_refresh_token;
        delete user.google_token_expiry;
        delete user.microsoft_access_token;
        delete user.microsoft_refresh_token;
        delete user.microsoft_token_expiry;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user: {
                    ...user,
                    google_connected,
                    microsoft_connected,
                    any_provider_connected: google_connected || microsoft_connected,
                },
            }),
        };
    } catch (err) {
        console.error('auth-session error:', err.message);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: null }),
        };
    }
};
