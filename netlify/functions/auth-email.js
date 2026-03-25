// Bridge Supabase Auth to our JWT cookie session
// Frontend signs in via Supabase Auth, then calls this to get our meetprep_session cookie
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Validate required environment variables upfront
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    const jwtSecret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        console.error('auth-email: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured: missing Supabase credentials' }) };
    }
    if (!jwtSecret) {
        console.error('auth-email: Missing JWT_SECRET and ENCRYPTION_KEY env vars');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured: missing JWT secret' }) };
    }

    let parsed;
    try {
        parsed = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { access_token } = parsed;
    if (!access_token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing access_token' }) };
    }

    try {
        // 1. Verify the Supabase Auth token server-side
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const { data: userData, error: authError } = await supabase.auth.getUser(access_token);

        if (authError) {
            console.error('auth-email: Supabase getUser error:', authError.message);
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token. Please sign in again.' }) };
        }

        const authUser = userData?.user;
        if (!authUser) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No user found for this token' }) };
        }

        // Reject unverified email
        if (!authUser.email_confirmed_at) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Please verify your email first. Check your inbox for the confirmation link.' }) };
        }

        // 2. Find or create user in public.users
        const { data: existingUser, error: selectErr } = await supabase
            .from('users')
            .select('id')
            .eq('email', authUser.email)
            .single();

        if (selectErr && selectErr.code !== 'PGRST116') {
            // PGRST116 = "no rows found" which is fine (we'll create the user)
            console.error('auth-email: user lookup error:', selectErr.message, selectErr.code);
        }

        let userId;

        if (existingUser) {
            userId = existingUser.id;
        } else {
            const { data: newUser, error: insertErr } = await supabase
                .from('users')
                .insert({
                    email: authUser.email,
                    name: authUser.user_metadata?.name || authUser.email.split('@')[0],
                    updated_at: new Date().toISOString(),
                })
                .select('id')
                .single();

            if (insertErr) {
                console.error('auth-email: user insert error:', insertErr.message, insertErr.code, insertErr.details);
                return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create user record. Please try again.' }) };
            }
            if (!newUser) {
                console.error('auth-email: insert returned no user data');
                return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create user record: no data returned' }) };
            }
            userId = newUser.id;
        }

        // 3. Issue our standard JWT cookie (same format all functions expect)
        const sessionToken = jwt.sign(
            { userId, email: authUser.email },
            jwtSecret,
            { expiresIn: '30d' }
        );

        const isSecure = process.env.URL?.startsWith('https') || event.headers?.['x-forwarded-proto'] === 'https';
        const sessionCookie = cookie.serialize('meetprep_session', sessionToken, {
            httpOnly: true,
            secure: isSecure,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60,
            path: '/',
        });

        console.log('auth-email: session created for userId:', userId, 'email:', authUser.email);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            multiValueHeaders: { 'Set-Cookie': [sessionCookie] },
            body: JSON.stringify({ success: true }),
        };
    } catch (err) {
        console.error('auth-email unexpected error:', err.message, err.stack);
        return { statusCode: 500, body: JSON.stringify({ error: 'Authentication failed. Please try again.' }) };
    }
};
