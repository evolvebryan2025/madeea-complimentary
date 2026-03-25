// Logout — Clear session cookie
const cookie = require('cookie');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

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
};
