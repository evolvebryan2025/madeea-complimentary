// Shared Microsoft Graph API utilities for Meeting Prep
const { Client } = require('@microsoft/microsoft-graph-client');

/**
 * Create an authenticated Microsoft Graph client with auto-refresh.
 * Refreshes token if expired, saves new token to Supabase.
 */
async function createGraphClient(user, supabase) {
    let accessToken = user.microsoft_access_token;

    // Check if token is expired or about to expire (5 min buffer)
    const expiry = user.microsoft_token_expiry
        ? new Date(user.microsoft_token_expiry).getTime()
        : 0;
    const isExpired = Date.now() > expiry - 5 * 60 * 1000;

    if (isExpired && user.microsoft_refresh_token) {
        try {
            const tokenEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
            const params = new URLSearchParams({
                client_id: process.env.MICROSOFT_CLIENT_ID,
                client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                refresh_token: user.microsoft_refresh_token,
                grant_type: 'refresh_token',
                scope: 'User.Read Calendars.Read Mail.Read Mail.Send Files.Read.All Tasks.Read offline_access',
            });

            const response = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
            });

            const tokenData = await response.json();

            if (tokenData.access_token) {
                accessToken = tokenData.access_token;

                const updateData = {
                    microsoft_access_token: accessToken,
                    microsoft_token_expiry: tokenData.expires_in
                        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
                        : null,
                };
                if (tokenData.refresh_token) {
                    updateData.microsoft_refresh_token = tokenData.refresh_token;
                }
                await supabase.from('users').update(updateData).eq('id', user.id);
            }
        } catch (refreshErr) {
            console.error('Microsoft token refresh failed:', refreshErr.message);
            if (refreshErr.message?.includes('invalid_grant') || refreshErr.message?.includes('AADSTS')) {
                // Clear revoked tokens and signal reconnect needed
                await supabase.from('users').update({
                    microsoft_access_token: null,
                    microsoft_refresh_token: null,
                    microsoft_token_expiry: null,
                }).eq('id', user.id);
                const err = new Error('Microsoft connection expired. Please reconnect your Microsoft account in Settings.');
                err.code = 'TOKEN_REVOKED';
                throw err;
            }
            // For other errors, continue with existing token — might still be valid
        }
    }

    const graphClient = Client.init({
        authProvider: (done) => done(null, accessToken),
    });

    return graphClient;
}

// ─── Calendar ───────────────────────────────────────────────

async function fetchCalendarEvents(graphClient, startTime, endTime) {
    try {
        const result = await graphClient
            .api('/me/calendarView')
            .query({
                startDateTime: startTime,
                endDateTime: endTime,
                $orderby: 'start/dateTime',
                $top: 50,
            })
            .select('subject,start,end,attendees,location,bodyPreview,webLink,onlineMeetingUrl,onlineMeeting,isOrganizer,organizer,isCancelled,body')
            .get();
        return result.value || [];
    } catch (err) {
        console.log('Microsoft Calendar fetch error:', err.message);
        return [];
    }
}

/**
 * Normalize a Microsoft Graph calendar event to match the Google Calendar event shape.
 * This lets existing processing logic work unchanged.
 */
function normalizeGraphEvent(msEvent, userEmail) {
    const attendees = (msEvent.attendees || []).map(a => ({
        email: a.emailAddress?.address || '',
        displayName: a.emailAddress?.name || '',
        responseStatus: mapResponseStatus(a.status?.response),
        self: (a.emailAddress?.address || '').toLowerCase() === (userEmail || '').toLowerCase(),
        organizer: msEvent.organizer?.emailAddress?.address?.toLowerCase() === (a.emailAddress?.address || '').toLowerCase(),
    }));

    return {
        summary: msEvent.subject || '',
        description: msEvent.bodyPreview || msEvent.body?.content || '',
        start: { dateTime: msEvent.start?.dateTime, timeZone: msEvent.start?.timeZone },
        end: { dateTime: msEvent.end?.dateTime, timeZone: msEvent.end?.timeZone },
        attendees,
        status: msEvent.isCancelled ? 'cancelled' : 'confirmed',
        hangoutLink: msEvent.onlineMeetingUrl || msEvent.onlineMeeting?.joinUrl || '',
        location: msEvent.location?.displayName || '',
    };
}

function mapResponseStatus(msStatus) {
    const map = {
        accepted: 'accepted',
        declined: 'declined',
        tentativelyAccepted: 'tentative',
        none: 'needsAction',
        notResponded: 'needsAction',
    };
    return map[msStatus] || 'needsAction';
}

// ─── Mail (Read) ────────────────────────────────────────────

async function fetchEmails(graphClient, filter, maxResults = 30) {
    try {
        let apiCall = graphClient
            .api('/me/messages')
            .top(maxResults)
            .select('id,subject,from,receivedDateTime,bodyPreview,importance,isRead,flag,body,webLink,conversationId')
            .orderby('receivedDateTime desc');

        if (filter) {
            apiCall = apiCall.filter(filter);
        }

        const result = await apiCall.get();
        return result.value || [];
    } catch (err) {
        console.log('Microsoft Mail fetch error:', err.message);
        return [];
    }
}

async function searchEmails(graphClient, searchQuery, maxResults = 8) {
    try {
        // Escape double quotes to prevent OData $search injection
        const safeQuery = searchQuery.replace(/"/g, '\\"');
        const result = await graphClient
            .api('/me/messages')
            .query({ $search: `"${safeQuery}"` })
            .top(maxResults)
            .select('id,subject,from,receivedDateTime,bodyPreview,importance,webLink')
            .get();
        return result.value || [];
    } catch (err) {
        console.log('Microsoft Mail search error:', err.message);
        return [];
    }
}

/**
 * Normalize a Microsoft Graph email to match the shape used by the app.
 */
function normalizeGraphEmail(msEmail) {
    return {
        id: msEmail.id || '',
        subject: msEmail.subject || 'No Subject',
        from: msEmail.from?.emailAddress?.address || msEmail.from?.emailAddress?.name || '',
        date: msEmail.receivedDateTime || '',
        snippet: msEmail.bodyPreview || '',
        mailLink: msEmail.webLink || '',
    };
}

// ─── Mail (Send) ────────────────────────────────────────────

async function sendEmail(graphClient, toEmail, subject, htmlBody) {
    try {
        await graphClient.api('/me/sendMail').post({
            message: {
                subject,
                body: { contentType: 'HTML', content: htmlBody },
                toRecipients: [
                    { emailAddress: { address: toEmail } },
                ],
            },
        });
    } catch (err) {
        console.error('Microsoft sendMail error:', err.message);
        throw err;
    }
}

// ─── OneDrive (Files) ──────────────────────────────────────

async function searchFiles(graphClient, keywords, maxResults = 6) {
    try {
        const result = await graphClient
            .api(`/me/drive/root/search(q='${encodeURIComponent(keywords)}')`)
            .top(maxResults)
            .select('name,webUrl,lastModifiedDateTime,createdBy,file')
            .get();
        return (result.value || []).map(f => ({
            name: f.name || '',
            type: getFileType(f.name),
            link: f.webUrl || '',
            modified: f.lastModifiedDateTime || '',
            owner: f.createdBy?.user?.displayName || '',
        }));
    } catch (err) {
        console.log('OneDrive search error:', err.message);
        return [];
    }
}

function getFileType(filename) {
    if (!filename) return 'Document';
    const ext = filename.split('.').pop().toLowerCase();
    const types = {
        docx: 'Word Document', doc: 'Word Document',
        xlsx: 'Excel Spreadsheet', xls: 'Excel Spreadsheet',
        pptx: 'PowerPoint', ppt: 'PowerPoint',
        pdf: 'PDF', txt: 'Text File',
    };
    return types[ext] || 'Document';
}

// ─── Microsoft To Do ────────────────────────────────────────

async function fetchTasks(graphClient) {
    try {
        const listsResult = await graphClient
            .api('/me/todo/lists')
            .top(10)
            .get();
        const lists = listsResult.value || [];
        if (lists.length === 0) return [];

        const allTasks = [];
        for (const list of lists.slice(0, 3)) {
            try {
                const tasksResult = await graphClient
                    .api(`/me/todo/lists/${list.id}/tasks`)
                    .filter("status ne 'completed'")
                    .top(20)
                    .select('title,body,dueDateTime,importance,status')
                    .get();
                const tasks = (tasksResult.value || []).map(t => ({
                    title: t.title || 'Untitled',
                    notes: t.body?.content || '',
                    listName: list.displayName || 'Tasks',
                    due: t.dueDateTime?.dateTime || null,
                    status: t.status,
                }));
                allTasks.push(...tasks);
            } catch {
                // Skip this list if access fails
            }
        }
        return allTasks;
    } catch (err) {
        console.log('Microsoft To Do fetch error:', err.message);
        return [];
    }
}

module.exports = {
    createGraphClient,
    fetchCalendarEvents,
    normalizeGraphEvent,
    fetchEmails,
    searchEmails,
    normalizeGraphEmail,
    sendEmail,
    searchFiles,
    fetchTasks,
};
