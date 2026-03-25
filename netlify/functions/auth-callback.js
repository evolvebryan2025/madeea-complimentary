// Google OAuth Callback — Exchange code for tokens, UPDATE existing user's Google fields
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
    const code = event.queryStringParameters?.code;
    const state = event.queryStringParameters?.state;

    if (!code || !state) {
        return {
            statusCode: 302,
            headers: { Location: '/?auth=error&reason=missing_params' },
        };
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/auth-callback`;
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;

    // 1. Verify the signed state to get userId
    let userId;
    try {
        const decoded = jwt.verify(state, jwtSecret);
        userId = decoded.userId;
    } catch {
        return {
            statusCode: 302,
            headers: { Location: '/?auth=error&reason=invalid_state' },
        };
    }

    try {
        // 2. Exchange authorization code for tokens
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // 3. Get Google profile for avatar
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data: profile } = await oauth2.userinfo.get();

        // 4. Update existing user's Google fields
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        // Keep existing refresh token if Google didn't return a new one
        const updateData = {
            avatar_url: profile.picture || null,
            google_access_token: tokens.access_token,
            google_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
            updated_at: new Date().toISOString(),
        };

        if (tokens.refresh_token) {
            updateData.google_refresh_token = tokens.refresh_token;
        }

        const { error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', userId);

        if (error) throw error;

        // 5. Redirect — user already has a session cookie
        return {
            statusCode: 302,
            headers: { Location: '/?google=connected' },
        };
    } catch (error) {
        console.error('Auth callback error:', error);
        return {
            statusCode: 302,
            headers: { Location: '/?auth=error&reason=oauth_failed' },
        };
    }
};
