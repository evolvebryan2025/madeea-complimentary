// Microsoft OAuth — "Connect Microsoft" step (requires existing session)
const msal = require('@azure/msal-node');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

exports.handler = async (event) => {
    // 1. Require existing session
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
    const cookies = cookie.parse(event.headers.cookie || '');
    const token = cookies.meetprep_session;

    if (!token) {
        return { statusCode: 302, headers: { Location: '/?auth=error&reason=not_logged_in' } };
    }

    let userId;
    try {
        const decoded = jwt.verify(token, jwtSecret);
        userId = decoded.userId;
    } catch {
        return { statusCode: 302, headers: { Location: '/?auth=error&reason=invalid_session' } };
    }

    // 2. Build Microsoft OAuth URL with userId in signed state
    const redirectUri = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/auth-microsoft-callback`;

    const msalConfig = {
        auth: {
            clientId: process.env.MICROSOFT_CLIENT_ID,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
            authority: 'https://login.microsoftonline.com/common',
        },
    };
    const cca = new msal.ConfidentialClientApplication(msalConfig);

    const scopes = [
        'openid',
        'profile',
        'email',
        'offline_access',
        'User.Read',
        'Calendars.Read',
        'Mail.Read',
        'Mail.Send',
        'Files.Read.All',
        'Tasks.Read',
    ];

    // Sign the state for security
    const state = jwt.sign({ userId }, jwtSecret, { expiresIn: '10m' });

    const authUrl = await cca.getAuthCodeUrl({
        scopes,
        redirectUri,
        state,
        prompt: 'consent',
    });

    return {
        statusCode: 302,
        headers: { Location: authUrl },
    };
};
