// Inbox Summary — AI-powered email categorization
// Replicates the n8n "Executive Summary Inbox" workflow as a Netlify function
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const OpenAI = require('openai');
const msGraph = require('./lib/microsoft-graph');
const { getUserIdFromCookie } = require('./lib/auth');
const { createRawEmail } = require('./lib/email');

// ─── Main Handler ───
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const userId = getUserIdFromCookie(event);
    if (!userId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    try {
        // 1. Get user with tokens
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (userErr || !user) {
            return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
        }

        // 2. Detect provider
        const provider = user.google_access_token ? 'google' : user.microsoft_access_token ? 'microsoft' : null;
        if (!provider) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No Google or Microsoft connection found. Please connect an account.' }) };
        }

        // 3. Fetch emails based on provider
        let emails = [];
        let oauth2Client = null;
        let gmail = null;
        let graphClient = null;

        if (provider === 'google') {
            oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2Client.setCredentials({
                access_token: user.google_access_token,
                refresh_token: user.google_refresh_token,
                expiry_date: user.google_token_expiry ? new Date(user.google_token_expiry).getTime() : null,
            });
            try {
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);
                if (credentials.access_token !== user.google_access_token) {
                    await supabase.from('users').update({
                        google_access_token: credentials.access_token,
                        google_token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
                    }).eq('id', userId);
                }
            } catch (refreshErr) {
                console.error('Google token refresh failed:', refreshErr.message);
                if (refreshErr.message?.includes('invalid_grant') || refreshErr.message?.includes('Token has been expired')) {
                    await supabase.from('users').update({ google_access_token: null, google_refresh_token: null, google_token_expiry: null }).eq('id', userId);
                    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Google connection expired. Please reconnect your Google account in Settings.' }) };
                }
            }

            gmail = google.gmail({ version: 'v1', auth: oauth2Client });
            const after24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const afterDate = Math.floor(after24h.getTime() / 1000);

            const messagesRes = await gmail.users.messages.list({
                userId: 'me',
                q: `(is:important OR is:starred OR is:unread) after:${afterDate}`,
                maxResults: 30,
            });
            const messageIds = messagesRes.data.messages || [];

            // Fetch emails in parallel (batches of 10) for performance
            const idsToFetch = messageIds.slice(0, 30);
            const batchSize = 10;
            for (let i = 0; i < idsToFetch.length; i += batchSize) {
                const batch = idsToFetch.slice(i, i + batchSize);
                const results = await Promise.allSettled(
                    batch.map(msg =>
                        gmail.users.messages.get({
                            userId: 'me',
                            id: msg.id,
                            format: 'metadata',
                            metadataHeaders: ['Subject', 'From', 'Date'],
                        }).then(full => {
                            const headers = {};
                            (full.data.payload?.headers || []).forEach((h) => {
                                headers[h.name.toLowerCase()] = h.value;
                            });
                            return {
                                id: msg.id,
                                threadId: full.data.threadId,
                                subject: headers['subject'] || 'No Subject',
                                from: headers['from'] || 'Unknown',
                                date: headers['date'] || '',
                                snippet: full.data.snippet || '',
                                text: (full.data.snippet || '').substring(0, 500),
                                labels: full.data.labelIds || [],
                                mailLink: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
                            };
                        })
                    )
                );
                for (const result of results) {
                    if (result.status === 'fulfilled') {
                        emails.push(result.value);
                    } else {
                        console.log('Error fetching email:', result.reason?.message);
                    }
                }
            }
        } else {
            graphClient = await msGraph.createGraphClient(user, supabase);
            const after24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const filter = `receivedDateTime ge ${after24h} and (importance eq 'high' or isRead eq false)`;
            const msEmails = await msGraph.fetchEmails(graphClient, filter, 30);

            emails = msEmails.map(e => ({
                id: e.id || '',
                threadId: e.conversationId || e.id || '',
                subject: e.subject || 'No Subject',
                from: e.from?.emailAddress?.address
                    ? `${e.from.emailAddress.name || ''} <${e.from.emailAddress.address}>`
                    : 'Unknown',
                date: e.receivedDateTime || '',
                snippet: e.bodyPreview || '',
                text: (e.body?.content || e.bodyPreview || '').substring(0, 500),
                labels: [
                    ...(e.importance === 'high' ? ['IMPORTANT'] : []),
                    ...(!e.isRead ? ['UNREAD'] : []),
                    ...(e.flag?.flagStatus === 'flagged' ? ['STARRED'] : []),
                ],
                mailLink: e.webLink || '',
            }));
        }

        if (emails.length === 0) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    message: 'No important emails in the last 24 hours. Inbox Zero!',
                    totalEmails: 0,
                    categories: {
                        highPriority: [],
                        actionRequired: [],
                        followUp: [],
                        deadlines: [],
                    },
                }),
            };
        }

        // 5. Use OpenAI to classify each email into categories
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // Build a batch classification prompt for efficiency
        const emailSummaries = emails.map((e, i) => (
            `[Email ${i + 1}]\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\nBody Preview: ${e.text.substring(0, 200)}`
        )).join('\n\n');

        const classificationResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are an email classifier for a busy executive. Classify each email into EXACTLY ONE category:

- highPriority: Urgent, from leadership/VIPs, critical business matters, legal/financial
- actionRequired: Requires a decision, approval, signature, reply, or specific action
- followUp: Part of ongoing threads, waiting for replies, check back later
- deadlines: Mentions specific dates, time-sensitive, due dates, ASAP requests

If an email doesn't clearly fit, choose the MOST relevant category based on intent.

Respond in this exact JSON format (no markdown, no explanation):
[{"index":1,"category":"highPriority"},{"index":2,"category":"actionRequired"},...]

Classify ALL emails. Use 1-based indexing matching [Email N].`
                },
                {
                    role: 'user',
                    content: `Classify these ${emails.length} emails:\n\n${emailSummaries}`
                }
            ],
            temperature: 0.2,
            max_tokens: 1000,
        });

        // 6. Parse AI classification
        let classifications = [];
        try {
            const raw = classificationResponse.choices[0].message.content.trim();
            // Remove markdown code fences if present
            const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            classifications = JSON.parse(cleaned);
        } catch (parseErr) {
            console.error('Classification parse error:', parseErr.message);
            // Fallback: assign all as highPriority
            classifications = emails.map((_, i) => ({ index: i + 1, category: 'highPriority' }));
        }

        // 7. Sort emails into categories
        const categories = {
            highPriority: [],
            actionRequired: [],
            followUp: [],
            deadlines: [],
        };

        const validCategories = ['highPriority', 'actionRequired', 'followUp', 'deadlines'];

        for (const classification of classifications) {
            const idx = classification.index - 1;
            const cat = validCategories.includes(classification.category) ? classification.category : 'highPriority';

            if (idx >= 0 && idx < emails.length) {
                const email = emails[idx];

                // Clean up the "from" field for display
                const fromClean = email.from.replace(/<[^>]+>/g, '').trim() || email.from;

                // Parse date for clean display
                let dateFormatted = '';
                try {
                    const d = new Date(email.date);
                    dateFormatted = d.toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                    });
                } catch {
                    dateFormatted = email.date;
                }

                categories[cat].push({
                    id: email.id,
                    threadId: email.threadId,
                    subject: email.subject,
                    from: fromClean,
                    date: dateFormatted,
                    snippet: email.snippet.substring(0, 150),
                    mailLink: email.mailLink || '',
                });
            }
        }

        const totalCategorized = Object.values(categories).reduce((sum, arr) => sum + arr.length, 0);

        // 8. Compose and send email
        const emailHtml = composeInboxEmail(categories, totalCategorized, emails.length);

        if (provider === 'google') {
            const rawEmail = createRawEmail(user.email, emailHtml.subject, emailHtml.html);
            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: rawEmail },
            });
        } else {
            await msGraph.sendEmail(graphClient, user.email, emailHtml.subject, emailHtml.html);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                message: `Inbox summary sent to your email! Scanned ${emails.length} emails, categorized ${totalCategorized} items.`,
                totalEmails: emails.length,
                categorizedCount: totalCategorized,
                generatedAt: new Date().toLocaleString(),
                categories,
                summary: {
                    highPriority: categories.highPriority.length,
                    actionRequired: categories.actionRequired.length,
                    followUp: categories.followUp.length,
                    deadlines: categories.deadlines.length,
                },
            }),
        };
    } catch (err) {
        console.error('Inbox summary error:', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to generate inbox summary. Please try again or reconnect your account.' }),
        };
    }
};

// ═══════════════════════════════════════════════
//  Email Helpers
// ═══════════════════════════════════════════════

function composeInboxEmail(categories, totalCategorized, totalScanned) {
    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

    const categoryConfig = {
        highPriority: { label: 'High Priority', emoji: '🔴', color: '#e53e3e', bg: '#fff5f5' },
        actionRequired: { label: 'Action Required', emoji: '🟠', color: '#dd6b20', bg: '#fffaf0' },
        followUp: { label: 'Follow Up', emoji: '🔵', color: '#3182ce', bg: '#ebf8ff' },
        deadlines: { label: 'Deadlines', emoji: '⏰', color: '#805ad5', bg: '#faf5ff' },
    };

    let categoryCards = '';

    for (const [key, config] of Object.entries(categoryConfig)) {
        const items = categories[key];
        if (!items || items.length === 0) continue;

        let rows = '';
        for (const item of items) {
            rows += `
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #eef0f5;">
                <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:4px;">
                  <a href="${item.mailLink}" style="color:#1a1a2e;text-decoration:none;">${item.subject}</a>
                </div>
                <div style="font-size:12px;color:#888;margin-bottom:4px;">${item.from} · ${item.date}</div>
                <div style="font-size:13px;color:#555;line-height:1.4;">${item.snippet}</div>
              </td>
            </tr>`;
        }

        categoryCards += `
        <div style="margin-bottom:28px;">
          <div style="display:flex;align-items:center;margin-bottom:12px;">
            <span style="font-size:16px;margin-right:8px;">${config.emoji}</span>
            <span style="font-size:16px;font-weight:700;color:${config.color};">${config.label}</span>
            <span style="background:${config.bg};color:${config.color};font-size:12px;font-weight:600;padding:2px 10px;border-radius:12px;margin-left:10px;">${items.length}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;border:1px solid #eef0f5;border-radius:8px;overflow:hidden;">
            ${rows}
          </table>
        </div>`;
    }

    if (!categoryCards) {
        categoryCards = `<div style="text-align:center;padding:40px 20px;color:#888;font-size:15px;">No important emails in the last 24 hours. Inbox Zero! 🎉</div>`;
    }

    // Summary bar
    const summaryBar = `
    <div style="display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap;">
      ${Object.entries(categoryConfig).map(([key, config]) => `
        <div style="flex:1;min-width:120px;background:${config.bg};border-radius:8px;padding:12px 16px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:${config.color};">${categories[key]?.length || 0}</div>
          <div style="font-size:11px;color:#888;margin-top:2px;">${config.label}</div>
        </div>
      `).join('')}
    </div>`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f0f2f5;margin:0;padding:0;">
  <div style="max-width:680px;margin:0 auto;padding:24px 16px;">
    <!-- Orange Accent Bar -->
    <div style="background:#FD5811;height:4px;border-radius:14px 14px 0 0;"></div>

    <!-- Header -->
    <div style="background:#152E47;padding:28px 32px;color:white;">
      <img src="https://madeeas.com/wp-content/uploads/2025/09/foooter-logo-1024x143.png" alt="MadeEA" style="height:28px;margin-bottom:16px;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;margin-bottom:4px;">Executive Inbox Summary</div>
      <div style="font-size:22px;font-weight:700;">${today}</div>
      <div style="font-size:14px;opacity:0.85;margin-top:6px;">${totalScanned} emails scanned · ${totalCategorized} categorized</div>
    </div>

    <!-- Body -->
    <div style="background:white;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
      ${summaryBar}
      ${categoryCards}
    </div>

    <!-- Footer -->
    <div style="background:#f8f9fc;border-radius:0 0 14px 14px;padding:20px 32px;border-top:1px solid #eee;">
      <div style="text-align:center;font-size:11px;color:#aaa;">
        Powered by <a href="https://madeeas.com" style="color:#FD5811;text-decoration:none;font-weight:600;">MadeEA</a> · Executive Inbox Summary
      </div>
    </div>
  </div>
</body></html>`;

    return {
        subject: `Inbox Summary: ${totalCategorized} items across ${Object.values(categories).filter(a => a.length > 0).length} categories - ${today}`,
        html,
    };
}

// createRawEmail is imported from ./lib/email.js
