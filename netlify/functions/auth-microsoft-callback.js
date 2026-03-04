// Microsoft OAuth Callback — Exchange code for tokens, UPDATE existing user's Microsoft fields
const msal = require('@azure/msal-node');
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

    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
    const redirectUri = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/auth-microsoft-callback`;

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
        const msalConfig = {
            auth: {
                clientId: process.env.MICROSOFT_CLIENT_ID,
                clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
                authority: 'https://login.microsoftonline.com/common',
            },
        };
        const cca = new msal.ConfidentialClientApplication(msalConfig);

        const tokenResponse = await cca.acquireTokenByCode({
            code,
            scopes: [
                'User.Read', 'Calendars.Read', 'Mail.Read',
                'Mail.Send', 'Files.Read.All', 'Tasks.Read',
            ],
            redirectUri,
        });

        // 3. Extract refresh token from MSAL cache
        const cache = cca.getTokenCache().serialize();
        const cacheData = JSON.parse(cache);
        const refreshTokens = Object.values(cacheData.RefreshToken || {});
        const refreshToken = refreshTokens.length > 0 ? refreshTokens[0].secret : null;

        // 4. Update existing user's Microsoft fields
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        const updateData = {
            microsoft_access_token: tokenResponse.accessToken,
            microsoft_token_expiry: tokenResponse.expiresOn
                ? new Date(tokenResponse.expiresOn).toISOString()
                : null,
            updated_at: new Date().toISOString(),
        };

        if (refreshToken) {
            updateData.microsoft_refresh_token = refreshToken;
        }

        const { error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', userId);

        if (error) throw error;

        // 5. Redirect — user already has a session cookie
        return {
            statusCode: 302,
            headers: { Location: '/?microsoft=connected' },
        };
    } catch (error) {
        console.error('Microsoft auth callback error:', error);
        return {
            statusCode: 302,
            headers: { Location: `/?auth=error&reason=${encodeURIComponent(error.message)}` },
        };
    }
};
