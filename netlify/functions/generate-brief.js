// Generate Brief Now — On-demand meeting brief generation
// Replicates the Modal.com cron logic as a Netlify function
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
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

        // 3. Set up provider client & fetch calendar events
        let oauth2Client = null;
        let graphClient = null;
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);
        const calendarId = user.calendar_id || 'primary';
        let allEvents = [];

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

            const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            const eventsRes = await calendar.events.list({
                calendarId,
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });
            allEvents = eventsRes.data.items || [];
        } else {
            graphClient = await msGraph.createGraphClient(user, supabase);
            const msEvents = await msGraph.fetchCalendarEvents(graphClient, startOfDay.toISOString(), endOfDay.toISOString());
            allEvents = msEvents.map(e => msGraph.normalizeGraphEvent(e, user.email));
        }

        // 4. Filter to real meetings (with attendees, not cancelled)
        const meetings = allEvents.filter(
            (e) => e.attendees && e.attendees.length > 0 && e.status !== 'cancelled'
        );

        if (meetings.length === 0) {
            // Log it
            await supabase.from('briefing_logs').insert({
                user_id: userId,
                meeting_count: 0,
                status: 'success',
                error_message: 'No meetings with attendees found today',
                sent_at: new Date().toISOString(),
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    message: 'No meetings with attendees found today. No brief needed!',
                    meeting_count: 0,
                }),
            };
        }

        // 5. Set up mail and file services
        const gmail = provider === 'google' ? google.gmail({ version: 'v1', auth: oauth2Client }) : null;
        const drive = provider === 'google' ? google.drive({ version: 'v3', auth: oauth2Client }) : null;
        const calendar = provider === 'google' ? google.calendar({ version: 'v3', auth: oauth2Client }) : null;

        // 6. Process meetings in parallel (cap at 5 to stay within timeout)
        const meetingsToProcess = meetings.slice(0, 5);
        const results = await Promise.allSettled(
            meetingsToProcess.map(meeting =>
                processMeeting(meeting, gmail, drive, calendar, calendarId, user, provider, graphClient)
            )
        );

        const meetingBriefs = results.map((result, i) => {
            if (result.status === 'fulfilled') return result.value;
            const meeting = meetingsToProcess[i];
            console.error(`Error processing meeting "${meeting.summary}":`, result.reason?.message);
            return {
                subject: meeting.summary || 'Unknown Meeting',
                brief: `Could not generate brief for this meeting.`,
                meeting,
                start_time: meeting.start?.dateTime || meeting.start?.date || '',
                attendees: meeting.attendees || [],
                context: { emails: 0, documents: 0, previous_meetings: 0 },
            };
        });

        // 7. Compose HTML email
        const emailHtml = composeEmail(meetingBriefs, user);

        // 8. Send via email provider
        if (provider === 'google') {
            const rawEmail = createRawEmail(user.email, emailHtml.subject, emailHtml.html);
            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: rawEmail },
            });
        } else {
            await msGraph.sendEmail(graphClient, user.email, emailHtml.subject, emailHtml.html);
        }

        // 9. Log success
        await supabase.from('briefing_logs').insert({
            user_id: userId,
            meeting_count: meetings.length,
            status: 'success',
            sent_at: new Date().toISOString(),
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                message: `Brief sent! ${meetings.length} meeting${meetings.length !== 1 ? 's' : ''} covered.`,
                meeting_count: meetings.length,
                meetings: meetings.map((m) => m.summary),
            }),
        };
    } catch (err) {
        console.error('Generate brief error:', err);

        // Log failure (guarded — don't let logging crash the error handler)
        await supabase.from('briefing_logs').insert({
            user_id: userId,
            meeting_count: 0,
            status: 'failed',
            error_message: err.message?.substring(0, 500),
        }).catch(logErr => console.error('Failed to log briefing error:', logErr.message));

        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to generate brief. Please try again or reconnect your account.' }),
        };
    }
};

// ═══════════════════════════════════════════════
//  Helper Functions
// ═══════════════════════════════════════════════

async function processMeeting(meeting, gmail, drive, calendar, calendarId, user, provider, graphClient) {
    const subject = meeting.summary || 'Untitled Meeting';
    const description = meeting.description || '';
    const attendees = (meeting.attendees || []).map((a) => ({
        email: a.email || '',
        name: a.displayName || (a.email || '').split('@')[0],
        status: a.responseStatus || 'unknown',
        organizer: a.organizer || false,
        self: a.self || false,
    }));

    // Detect self domain
    const selfAttendee = attendees.find((a) => a.self);
    const selfDomain = selfAttendee ? selfAttendee.email.split('@').pop() : '';
    const external = attendees.filter((a) => a.email.split('@').pop() !== selfDomain && selfDomain);
    const internal = attendees.filter((a) => a.email.split('@').pop() === selfDomain || !selfDomain);

    // Extract keywords
    const keywords = extractKeywords(subject, description);

    // Search related emails (parallel)
    const [relatedEmails, relatedDocs, previousMeetings] = await Promise.all([
        provider === 'google'
            ? searchRelatedEmails(gmail, keywords, attendees)
            : searchRelatedEmailsMicrosoft(graphClient, keywords, attendees),
        provider === 'google'
            ? searchDriveDocuments(drive, keywords)
            : msGraph.searchFiles(graphClient, keywords, 6),
        provider === 'google'
            ? searchPreviousMeetings(calendar, subject, calendarId)
            : searchPreviousMeetingsMicrosoft(graphClient, subject),
    ]);

    // Generate AI brief
    const aiBrief = await generateAiBrief({
        subject,
        description,
        start_time: meeting.start?.dateTime || meeting.start?.date || '',
        end_time: meeting.end?.dateTime || meeting.end?.date || '',
        attendees,
        internal,
        external,
        meeting_type: detectMeetingType(subject, external),
        related_emails: relatedEmails,
        related_docs: relatedDocs,
        previous_meetings: previousMeetings,
        location: meeting.location || '',
        hangoutLink: meeting.hangoutLink || '',
    });

    return {
        subject,
        brief: aiBrief,
        meeting,
        start_time: meeting.start?.dateTime || meeting.start?.date || '',
        end_time: meeting.end?.dateTime || meeting.end?.date || '',
        attendees,
        context: {
            emails: relatedEmails.length,
            documents: relatedDocs.length,
            previous_meetings: previousMeetings.length,
        },
    };
}

function detectMeetingType(subject, external) {
    const s = subject.toLowerCase();
    if (s.includes('interview')) return 'interview';
    if (s.includes('standup') || s.includes('stand-up')) return 'standup';
    if (s.includes('1:1') || s.includes('one on one') || s.includes('1-1')) return 'one-on-one';
    if (s.includes('review')) return 'review';
    if (s.includes('planning') || s.includes('sprint')) return 'planning';
    if (s.includes('demo') || s.includes('presentation')) return 'presentation';
    if (s.includes('kickoff') || s.includes('kick-off')) return 'kickoff';
    if (external.length > 0) return 'external';
    return 'general';
}

function extractKeywords(subject, description) {
    const stopWords = new Set(['meeting', 'call', 'sync', 'standup', 'review', 'discussion', 'update', 'the', 'and', 'for', 'with']);
    const words = subject.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/);
    const keywords = words.filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase())).slice(0, 5);

    if (description) {
        const descClean = description.replace(/<[^>]*>/g, ' ');
        const descWords = descClean.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/);
        keywords.push(...descWords.filter((w) => w.length > 4).slice(0, 5));
    }

    return keywords.slice(0, 8).join(' ');
}

async function searchRelatedEmails(gmail, keywords, attendees) {
    try {
        const attendeeEmails = attendees.filter((a) => !a.self).map((a) => a.email).slice(0, 5);
        const queryParts = [];
        if (keywords) queryParts.push(`(${keywords})`);
        if (attendeeEmails.length) queryParts.push(`(${attendeeEmails.map((e) => `from:${e}`).join(' OR ')})`);

        const afterDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0].replace(/-/g, '/');
        const query = queryParts.join(' OR ') + ` after:${afterDate}`;

        const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 8 });
        const messages = res.data.messages || [];

        const results = await Promise.allSettled(
            messages.slice(0, 8).map(msg =>
                gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From', 'Date'],
                }).then(full => {
                    const headers = {};
                    (full.data.payload?.headers || []).forEach((h) => { headers[h.name] = h.value; });
                    return {
                        subject: headers.Subject || 'No Subject',
                        from: headers.From || '',
                        date: headers.Date || '',
                        snippet: full.data.snippet || '',
                    };
                })
            )
        );
        return results.filter(r => r.status === 'fulfilled').map(r => r.value);
    } catch (err) {
        console.log('Gmail search error:', err.message);
        return [];
    }
}

async function searchDriveDocuments(drive, keywords) {
    try {
        if (!keywords) return [];
        const keywordList = keywords.split(/\s+/).slice(0, 3);
        // Sanitize keywords to prevent Drive query injection
        const q = keywordList
            .map((k) => k.replace(/[\\'"]/g, ''))
            .filter((k) => k.length > 0)
            .map((k) => `fullText contains '${k}'`)
            .join(' or ');
        if (!q) return [];

        const res = await drive.files.list({
            q,
            pageSize: 6,
            fields: 'files(id, name, mimeType, webViewLink, modifiedTime, owners)',
        });

        const mimeLabels = {
            'application/vnd.google-apps.document': 'Google Doc',
            'application/vnd.google-apps.spreadsheet': 'Google Sheet',
            'application/vnd.google-apps.presentation': 'Google Slides',
            'application/pdf': 'PDF',
        };

        return (res.data.files || []).map((f) => ({
            name: f.name || '',
            type: mimeLabels[f.mimeType] || 'Document',
            link: f.webViewLink || '',
            modified: f.modifiedTime || '',
            owner: f.owners?.[0]?.displayName || '',
        }));
    } catch (err) {
        console.log('Drive search error:', err.message);
        return [];
    }
}

async function searchRelatedEmailsMicrosoft(graphClient, keywords, attendees) {
    try {
        const attendeeEmails = attendees.filter(a => !a.self).map(a => a.email).slice(0, 5);
        const searchParts = [];
        if (keywords) searchParts.push(keywords);
        if (attendeeEmails.length) searchParts.push(attendeeEmails.join(' '));
        const searchQuery = searchParts.join(' ');
        if (!searchQuery) return [];

        const results = await msGraph.searchEmails(graphClient, searchQuery, 8);
        return results.map(e => msGraph.normalizeGraphEmail(e));
    } catch (err) {
        console.log('Microsoft email search error:', err.message);
        return [];
    }
}

async function searchPreviousMeetingsMicrosoft(graphClient, subject) {
    try {
        const timeMin = new Date(Date.now() - 60 * 86400000).toISOString();
        const timeMax = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

        const result = await graphClient
            .api('/me/calendarView')
            .query({
                startDateTime: timeMin,
                endDateTime: timeMax,
                $orderby: 'start/dateTime',
                $top: 5,
                $filter: `contains(subject,'${(subject.split(/\s+/)[0] || '').replace(/[^a-zA-Z0-9 ]/g, '')}')`,
            })
            .select('subject,start,attendees')
            .get();

        return (result.value || []).map(e => ({
            subject: e.subject || '',
            date: e.start?.dateTime || '',
            attendee_count: (e.attendees || []).length,
            description: '',
        }));
    } catch (err) {
        console.log('Microsoft calendar search error:', err.message);
        // Fallback: try without filter (filter may not be supported on calendarView)
        try {
            const events = await msGraph.fetchCalendarEvents(
                graphClient,
                new Date(Date.now() - 60 * 86400000).toISOString(),
                new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
            );
            const firstWord = (subject.split(/\s+/)[0] || '').toLowerCase();
            return events
                .filter(e => (e.subject || '').toLowerCase().includes(firstWord))
                .slice(0, 5)
                .map(e => ({
                    subject: e.subject || '',
                    date: e.start?.dateTime || '',
                    attendee_count: (e.attendees || []).length,
                    description: '',
                }));
        } catch {
            return [];
        }
    }
}

async function searchPreviousMeetings(calendar, subject, calendarId) {
    try {
        const timeMin = new Date(Date.now() - 60 * 86400000).toISOString();
        const timeMax = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
        const firstWord = subject.split(/\s+/)[0] || '';

        const res = await calendar.events.list({
            calendarId,
            timeMin,
            timeMax,
            q: firstWord,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 5,
        });

        return (res.data.items || []).map((e) => ({
            subject: e.summary || '',
            date: e.start?.dateTime || e.start?.date || '',
            attendee_count: (e.attendees || []).length,
            description: (e.description || '').substring(0, 200),
        }));
    } catch (err) {
        console.log('Calendar search error:', err.message);
        return [];
    }
}

async function generateAiBrief(ctx) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = `You are a sharp executive assistant. Write a concise meeting preparation brief in clean HTML (inline styles only, no markdown).

OUTPUT FORMAT — Use this exact HTML structure. Be specific, not generic. Only include sections that have real data. Keep it SHORT.

<div>
  <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px 0;">[1-2 sentence summary: what this meeting is about and the expected outcome. Be specific to the actual meeting topic.]</p>

  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;font-size:13px;color:#888;width:120px;vertical-align:top;">Attendees</td>
      <td style="padding:8px 12px;font-size:14px;color:#333;">[List names with roles if known, e.g. "Bella Niño (External), Prince Andam (Organizer)"]</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#888;vertical-align:top;">Objective</td>
      <td style="padding:8px 12px;font-size:14px;color:#333;">[One clear sentence about the goal]</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;font-size:13px;color:#888;vertical-align:top;">Key Topics</td>
      <td style="padding:8px 12px;font-size:14px;color:#333;">[Bullet list of 2-4 specific discussion points, based on meeting title, description, and related emails/docs]</td>
    </tr>
  </table>

  [ONLY if there are related emails or docs, add this section:]
  <div style="background:#f0f4ff;border-radius:6px;padding:12px 16px;margin-bottom:12px;">
    <div style="font-size:12px;font-weight:600;color:#667eea;text-transform:uppercase;margin-bottom:8px;">Context Found</div>
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#444;line-height:1.7;">
      <li>[Summarize key point from email/doc in one sentence]</li>
    </ul>
  </div>

  [ONLY if you can identify specific action items, add:]
  <div style="background:#f0faf0;border-radius:6px;padding:12px 16px;">
    <div style="font-size:12px;font-weight:600;color:#38a169;text-transform:uppercase;margin-bottom:8px;">Preparation Checklist</div>
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#444;line-height:1.7;">
      <li>[Specific thing to prepare — be concrete, not vague]</li>
    </ul>
  </div>
</div>

RULES:
- Output ONLY the HTML above. No markdown. No explanation outside the HTML.
- Be SPECIFIC to this meeting. Never write generic filler like "priorities may include project updates."
- If you don't have enough info for a section, SKIP IT entirely. Don't make things up.
- Keep the whole brief under 200 words.
- Use the attendee names and email context to be specific.`;

    const attendeeList = ctx.attendees
        .filter(a => !a.self)
        .map(a => `${a.name} (${a.email})${a.organizer ? ' [Organizer]' : ''} — RSVP: ${a.status}`)
        .join('\n');

    const userMessage = `Meeting: ${ctx.subject}
Time: ${ctx.start_time} → ${ctx.end_time}
Location: ${ctx.location || 'Virtual'}${ctx.hangoutLink ? ` | Link: ${ctx.hangoutLink}` : ''}
Type: ${ctx.meeting_type}

Attendees:
${attendeeList || 'None listed'}

Description: ${ctx.description || 'None'}

Recent emails from/about these people (last 14 days):
${ctx.related_emails.length ? ctx.related_emails.slice(0, 4).map(e => `• "${e.subject}" from ${e.from} — ${e.snippet}`).join('\n') : 'None found'}

Related documents:
${ctx.related_docs.length ? ctx.related_docs.slice(0, 3).map(d => `• ${d.name} (${d.type}) — ${d.link}`).join('\n') : 'None found'}

Previous similar meetings:
${ctx.previous_meetings.length ? ctx.previous_meetings.slice(0, 2).map(m => `• "${m.subject}" on ${m.date}`).join('\n') : 'None found'}`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: 1000,
    });

    return response.choices[0].message.content;
}

function composeEmail(meetingBriefs, user) {
    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    const total = meetingBriefs.length;

    function fmtTime(iso) {
        try {
            return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        } catch { return 'TBD'; }
    }

    function fmtDuration(start, end) {
        try {
            const ms = new Date(end) - new Date(start);
            const mins = Math.round(ms / 60000);
            if (mins < 60) return `${mins} min`;
            const hrs = Math.floor(mins / 60);
            const rem = mins % 60;
            return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
        } catch { return ''; }
    }

    let meetingCards = '';
    for (let i = 0; i < meetingBriefs.length; i++) {
        const b = meetingBriefs[i];
        const hangout = b.meeting?.hangoutLink || '';
        const location = b.meeting?.location || '';
        const duration = fmtDuration(b.start_time, b.end_time);
        const attendeeNames = b.attendees.filter(a => !a.self).map(a => a.name).slice(0, 6).join(', ');

        meetingCards += `
    <!-- Meeting ${i + 1} -->
    <div style="margin-bottom: 32px;">
      <div style="display:flex;align-items:center;margin-bottom:16px;">
        <div style="background:#FD5811;color:white;width:40px;height:40px;border-radius:10px;display:inline-block;text-align:center;line-height:40px;font-size:18px;font-weight:700;margin-right:14px;flex-shrink:0;">${i + 1}</div>
        <div>
          <div style="font-size:18px;font-weight:700;color:#152E47;margin-bottom:2px;">${b.subject}</div>
          <div style="font-size:13px;color:#888;">
            ${fmtTime(b.start_time)}${duration ? ` · ${duration}` : ''}${attendeeNames ? ` · ${attendeeNames}` : ''}
          </div>
        </div>
      </div>
      ${hangout || location ? `<div style="margin-bottom:14px;font-size:13px;">${hangout ? `<a href="${hangout}" style="color:#FD5811;text-decoration:none;margin-right:16px;">🎥 Join Video Call</a>` : ''}${location ? `<span style="color:#888;">📍 ${location}</span>` : ''}</div>` : ''}
      <div style="border: 1px solid #eef0f5; border-radius: 10px; padding: 20px; background: #fafbfd;">
        ${b.brief}
      </div>
    </div>`;

        if (i < meetingBriefs.length - 1) {
            meetingCards += `<hr style="border:none;border-top:1px solid #eef0f5;margin:0 0 32px 0;">`;
        }
    }

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f0f2f5;margin:0;padding:0;">
  <div style="max-width:680px;margin:0 auto;padding:24px 16px;">
    <!-- Orange Accent Bar -->
    <div style="background:#FD5811;height:4px;border-radius:14px 14px 0 0;"></div>

    <!-- Header -->
    <div style="background:#152E47;padding:28px 32px;color:white;">
      <img src="https://madeeas.com/wp-content/uploads/2025/09/foooter-logo-1024x143.png" alt="MadeEA" style="height:28px;margin-bottom:16px;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;margin-bottom:4px;">Meeting Preparation Brief</div>
      <div style="font-size:22px;font-weight:700;">${today}</div>
      <div style="font-size:14px;opacity:0.85;margin-top:6px;">${total} meeting${total !== 1 ? 's' : ''} on your calendar today</div>
    </div>

    <!-- Body -->
    <div style="background:white;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
      ${meetingCards}
    </div>

    <!-- Footer -->
    <div style="background:#f8f9fc;border-radius:0 0 14px 14px;padding:20px 32px;border-top:1px solid #eee;">
      <div style="text-align:center;font-size:11px;color:#aaa;">
        Powered by <a href="https://madeeas.com" style="color:#FD5811;text-decoration:none;font-weight:600;">MadeEA</a> · Meeting Preparation Automation
      </div>
    </div>
  </div>
</body></html>`;

    return {
        subject: `Meeting Brief: ${total} meeting${total !== 1 ? 's' : ''} today - ${today}`,
        html,
    };
}

// createRawEmail is imported from ./lib/email.js
