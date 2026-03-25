// Session check — Verify JWT and return current user data
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

// Only return safe, frontend-needed columns
const SAFE_USER_COLUMNS = 'id, email, name, avatar_url, calendar_id, send_time, timezone, is_active, strategic_goals, updated_at, google_access_token, microsoft_access_token';

exports.handler = async (event) => {
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;

    if (!jwtSecret) {
        console.error('auth-session: Missing JWT_SECRET and ENCRYPTION_KEY');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: null, _debug: 'no_jwt_secret' }) };
    }

    try {
        // Parse cookies
        const rawCookie = event.headers.cookie || '';
        const cookies = cookie.parse(rawCookie);
        const token = cookies.meetprep_session;

        if (!token) {
            const cookieKeys = Object.keys(cookies);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: null, _debug: 'no_token', _cookieKeys: cookieKeys, _rawCookieLength: rawCookie.length }),
            };
        }

        // Verify JWT
        const decoded = jwt.verify(token, jwtSecret);

        // Fetch user data from Supabase with explicit column list
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        const { data: user, error } = await supabase
            .from('users')
            .select(SAFE_USER_COLUMNS)
            .eq('id', decoded.userId)
            .single();

        if (error || !user) {
            console.error('auth-session query failed:', error?.message || 'no user found', 'userId:', decoded.userId);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: null, _debug: 'query_failed', _errorMsg: error?.message, _errorCode: error?.code, _userId: decoded.userId }),
            };
        }

        // Compute provider connection flags, strip token columns before response
        const google_connected = !!user.google_access_token;
        const microsoft_connected = !!user.microsoft_access_token;
        delete user.google_access_token;
        delete user.microsoft_access_token;

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
            body: JSON.stringify({ user: null, _debug: 'jwt_or_exception', _errorMsg: err.message }),
        };
    }
};
