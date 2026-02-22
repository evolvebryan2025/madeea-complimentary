// Session check — Verify JWT and return current user data
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

exports.handler = async (event) => {
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;

    if (!jwtSecret) {
        console.error('auth-session: Missing JWT_SECRET and ENCRYPTION_KEY');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: null, _debug: 'missing jwt secret' }) };
    }

    try {
        // Parse cookies
        const rawCookie = event.headers.cookie || '';
        const cookies = cookie.parse(rawCookie);
        const token = cookies.meetprep_session;

        console.log('auth-session: cookie header present:', !!rawCookie, 'has meetprep_session:', !!token);

        if (!token) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: null, _debug: 'no cookie' }),
            };
        }

        // Verify JWT
        const decoded = jwt.verify(token, jwtSecret);
        console.log('auth-session: JWT decoded, userId:', decoded.userId);

        // Fetch full user data from Supabase
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        const { data: user, error } = await supabase
            .from('users')
            .select('id, email, name, avatar_url, calendar_id, send_time, timezone, is_active, theme_preference, strategic_goals, google_access_token, created_at')
            .eq('id', decoded.userId)
            .single();

        if (error || !user) {
            console.error('auth-session query failed:', error?.message || 'no user found', 'userId:', decoded.userId, 'code:', error?.code);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: null, _debug: 'query failed: ' + (error?.message || 'no user') }),
            };
        }

        // Compute google_connected flag, strip raw token
        const google_connected = !!user.google_access_token;
        delete user.google_access_token;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: { ...user, google_connected } }),
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
