// User Disconnect — Delete account and revoke Google tokens
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method not allowed' };
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

        // Get user's tokens to revoke
        const { data: user } = await supabase
            .from('users')
            .select('google_access_token, microsoft_access_token')
            .eq('id', decoded.userId)
            .single();

        // Try to revoke Google token
        if (user?.google_access_token) {
            try {
                const oauth2Client = new google.auth.OAuth2();
                await oauth2Client.revokeToken(user.google_access_token);
            } catch (revokeErr) {
                console.log('Token revocation failed (may already be expired):', revokeErr.message);
            }
        }

        // Delete user (cascades to briefing_logs)
        await supabase.from('users').delete().eq('id', decoded.userId);

        // Clear session cookie
        const clearCookie = cookie.serialize('meetprep_session', '', {
            httpOnly: true,
            secure: process.env.URL?.startsWith('https') || false,
            sameSite: 'lax',
            maxAge: 0,
            path: '/',
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            multiValueHeaders: { 'Set-Cookie': [clearCookie] },
            body: JSON.stringify({ success: true }),
        };
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to disconnect' }),
        };
    }
};
