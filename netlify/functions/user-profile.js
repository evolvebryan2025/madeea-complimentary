// User Profile — Update user preferences
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

// Helper: extract user ID from JWT session
function getUserIdFromCookie(event) {
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
    const cookies = cookie.parse(event.headers.cookie || '');
    const token = cookies.meetprep_session;
    if (!token) return null;

    try {
        const decoded = jwt.verify(token, jwtSecret);
        return decoded.userId;
    } catch {
        return null;
    }
}

exports.handler = async (event) => {
    const userId = getUserIdFromCookie(event);

    if (!userId) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Not authenticated' }),
        };
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // GET — Return user profile
    if (event.httpMethod === 'GET') {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (error) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to fetch profile' }),
            };
        }

        // Remove sensitive fields
        delete user.google_access_token;
        delete user.google_refresh_token;
        delete user.google_token_expiry;
        delete user.microsoft_access_token;
        delete user.microsoft_refresh_token;
        delete user.microsoft_token_expiry;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user }),
        };
    }

    // PUT — Update user profile
    if (event.httpMethod === 'PUT') {
        try {
            const body = JSON.parse(event.body);

            // Only allow updating specific fields
            const allowedFields = ['name', 'calendar_id', 'send_time', 'timezone', 'is_active', 'theme_preference', 'strategic_goals'];
            const updates = {};

            for (const field of allowedFields) {
                if (body[field] !== undefined) {
                    updates[field] = body[field];
                }
            }

            const { error } = await supabase
                .from('users')
                .update(updates)
                .eq('id', userId);

            if (error) throw error;

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true }),
            };
        } catch (err) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to update profile' }),
            };
        }
    }

    return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
    };
};
