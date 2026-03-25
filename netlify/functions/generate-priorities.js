// Generate Priorities — On-demand Top 5 Priority Alignment
// Pulls Calendar, Gmail/Outlook, Google Tasks/To Do → AI generates daily priorities
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

        // 3. Set up provider client & fetch data
        let oauth2Client = null;
        let graphClient = null;
        let calendarData, emailData, taskData;

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

            [calendarData, emailData, taskData] = await Promise.all([
                fetchCalendarEvents(oauth2Client, user.calendar_id || 'primary'),
                fetchPriorityEmails(oauth2Client),
                fetchGoogleTasks(oauth2Client),
            ]);
        } else {
            graphClient = await msGraph.createGraphClient(user, supabase);

            [calendarData, emailData, taskData] = await Promise.all([
                fetchCalendarEventsMicrosoft(graphClient),
                fetchPriorityEmailsMicrosoft(graphClient),
                fetchTasksMicrosoft(graphClient),
            ]);
        }

        // 4. Process each data source
        const processedCalendar = processCalendarEvents(calendarData);
        const processedEmails = processEmails(emailData);
        const processedTasks = processTasks(taskData);

        // 5. Build AI context
        const strategicGoals = parseStrategicGoals(user.strategic_goals);
        const context = buildAIContext(processedCalendar, processedEmails, processedTasks, strategicGoals, user.name || 'Executive');

        // 6. Generate priorities via AI
        const aiOutput = await generateAIPriorities(context);

        // 7. Format and email the report
        const report = formatPriorityReport(aiOutput, context, user);

        if (provider === 'google') {
            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
            const rawEmail = createRawEmail(user.email, report.subject, report.html);
            await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawEmail } });
        } else {
            await msGraph.sendEmail(graphClient, user.email, report.subject, report.html);
        }

        // 8. Log success
        await supabase.from('briefing_logs').insert({
            user_id: userId,
            meeting_count: processedCalendar.summary.totalEvents,
            status: 'success',
            error_message: 'Priority alignment generated',
            sent_at: new Date().toISOString(),
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                message: 'Priority report generated and sent to your email!',
                priorities: aiOutput,
                metrics: context.dayHealth,
                dataSources: {
                    calendarEvents: processedCalendar.summary.totalEvents,
                    emailsProcessed: processedEmails.summary.totalEmails,
                    tasksReviewed: processedTasks.summary.totalTasks,
                },
            }),
        };
    } catch (err) {
        console.error('Generate priorities error:', err);

        await supabase.from('briefing_logs').insert({
            user_id: userId,
            meeting_count: 0,
            status: 'failed',
            error_message: `Priority generation: ${err.message?.substring(0, 500)}`,
        }).catch(() => {});

        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to generate priorities. Please try again or reconnect your account.' }),
        };
    }
};

// ═══════════════════════════════════════════════
//  Data Fetching
// ═══════════════════════════════════════════════

async function fetchCalendarEvents(auth, calendarId) {
    try {
        const calendar = google.calendar({ version: 'v3', auth });
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfRange = new Date(startOfDay.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days

        const res = await calendar.events.list({
            calendarId,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfRange.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 50,
        });
        return res.data.items || [];
    } catch (err) {
        console.log('Calendar fetch error:', err.message);
        return [];
    }
}

async function fetchPriorityEmails(auth) {
    try {
        const gmail = google.gmail({ version: 'v1', auth });
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0].replace(/-/g, '/');

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: `(is:unread OR is:starred OR is:important) after:${threeDaysAgo}`,
            maxResults: 30,
        });

        const messages = res.data.messages || [];
        const emails = [];
        const idsToFetch = messages.slice(0, 30);
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
                        (full.data.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
                        return {
                            id: full.data.id,
                            threadId: full.data.threadId,
                            subject: headers.Subject || 'No Subject',
                            from: headers.From || '',
                            date: headers.Date || '',
                            snippet: full.data.snippet || '',
                            labelIds: full.data.labelIds || [],
                        };
                    })
                )
            );
            for (const result of results) {
                if (result.status === 'fulfilled') emails.push(result.value);
            }
        }
        return emails;
    } catch (err) {
        console.log('Gmail fetch error:', err.message);
        return [];
    }
}

async function fetchGoogleTasks(auth) {
    try {
        const tasks = google.tasks({ version: 'v1', auth });

        // Get default task list
        const listRes = await tasks.tasklists.list({ maxResults: 10 });
        const taskLists = listRes.data.items || [];
        if (taskLists.length === 0) return [];

        const allTasks = [];
        // Fetch tasks from all lists (up to 3 lists)
        for (const list of taskLists.slice(0, 3)) {
            try {
                const tasksRes = await tasks.tasks.list({
                    tasklist: list.id,
                    showCompleted: false,
                    showHidden: false,
                    maxResults: 20,
                });
                const items = (tasksRes.data.items || []).map(t => ({
                    ...t,
                    listName: list.title,
                }));
                allTasks.push(...items);
            } catch (e) {
                // Skip list errors
            }
        }
        return allTasks;
    } catch (err) {
        console.log('Tasks fetch error:', err.message);
        return [];
    }
}

// ═══════════════════════════════════════════════
//  Microsoft Data Fetching
// ═══════════════════════════════════════════════

async function fetchCalendarEventsMicrosoft(graphClient) {
    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfRange = new Date(startOfDay.getTime() + 3 * 24 * 60 * 60 * 1000);

        const msEvents = await msGraph.fetchCalendarEvents(graphClient, startOfDay.toISOString(), endOfRange.toISOString());
        // Normalize to Google event shape for processCalendarEvents
        return msEvents.map(e => msGraph.normalizeGraphEvent(e, ''));
    } catch (err) {
        console.log('Microsoft Calendar fetch error:', err.message);
        return [];
    }
}

async function fetchPriorityEmailsMicrosoft(graphClient) {
    try {
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
        const filter = `receivedDateTime ge ${threeDaysAgo} and (importance eq 'high' or isRead eq false)`;
        const msEmails = await msGraph.fetchEmails(graphClient, filter, 30);

        // Normalize to the shape that processEmails expects
        return msEmails.map(e => ({
            id: e.id,
            threadId: e.conversationId || e.id,
            subject: e.subject || 'No Subject',
            from: e.from?.emailAddress?.address
                ? `${e.from.emailAddress.name || ''} <${e.from.emailAddress.address}>`
                : 'Unknown',
            date: e.receivedDateTime || '',
            snippet: e.bodyPreview || '',
            labelIds: [
                ...(e.importance === 'high' ? ['IMPORTANT'] : []),
                ...(!e.isRead ? ['UNREAD'] : []),
                ...(e.flag?.flagStatus === 'flagged' ? ['STARRED'] : []),
            ],
        }));
    } catch (err) {
        console.log('Microsoft Mail fetch error:', err.message);
        return [];
    }
}

async function fetchTasksMicrosoft(graphClient) {
    try {
        const tasks = await msGraph.fetchTasks(graphClient);
        // Normalize to the shape that processTasks expects
        return tasks.map(t => ({
            title: t.title || 'Untitled',
            notes: t.notes || '',
            due: t.due || null,
            listName: t.listName || 'Tasks',
        }));
    } catch (err) {
        console.log('Microsoft Tasks fetch error:', err.message);
        return [];
    }
}

// ═══════════════════════════════════════════════
//  Data Processing
// ═══════════════════════════════════════════════

function processCalendarEvents(events) {
    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);

    const processed = events.map(event => {
        const startTime = new Date(event.start?.dateTime || event.start?.date);
        const endTime = new Date(event.end?.dateTime || event.end?.date);
        const isAllDay = !event.start?.dateTime;
        const durationHours = (endTime - startTime) / (1000 * 60 * 60);

        let timeCategory = 'later';
        if (startTime < todayEnd) timeCategory = 'today';
        else if (startTime < tomorrowEnd) timeCategory = 'tomorrow';

        const summary = (event.summary || '').toLowerCase();
        const attendees = event.attendees || [];

        let meetingType = 'general';
        let prioritySignal = 'normal';

        if (summary.includes('board') || summary.includes('investor')) {
            meetingType = 'board/investor'; prioritySignal = 'critical';
        } else if (summary.includes('1:1') || summary.includes('one on one') || summary.includes('1-1')) {
            meetingType = '1:1'; prioritySignal = 'high';
        } else if (summary.includes('review') || summary.includes('decision')) {
            meetingType = 'decision'; prioritySignal = 'high';
        } else if (summary.includes('all hands') || summary.includes('town hall')) {
            meetingType = 'company-wide'; prioritySignal = 'high';
        } else if (summary.includes('deadline') || summary.includes('due')) {
            meetingType = 'deadline'; prioritySignal = 'critical';
        } else if (summary.includes('interview')) {
            meetingType = 'interview'; prioritySignal = 'high';
        } else if (summary.includes('standup') || summary.includes('sync')) {
            meetingType = 'recurring'; prioritySignal = 'normal';
        }

        return {
            title: event.summary || 'Untitled',
            startTime: startTime.toISOString(),
            startTimeFormatted: startTime.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
            timeCategory,
            isAllDay,
            durationHours: Math.round(durationHours * 10) / 10,
            meetingType,
            prioritySignal,
            attendeeCount: attendees.length,
        };
    });

    const todayEvents = processed.filter(e => e.timeCategory === 'today');
    const todayMeetingHours = todayEvents.reduce((sum, e) => sum + e.durationHours, 0);

    return {
        events: processed,
        todayEvents,
        summary: {
            totalEvents: processed.length,
            todayCount: todayEvents.length,
            todayMeetingHours: Math.round(todayMeetingHours * 10) / 10,
            criticalCount: processed.filter(e => e.prioritySignal === 'critical').length,
            highPriorityCount: processed.filter(e => e.prioritySignal === 'high').length,
            availableHours: Math.round(Math.max(0, 8 - todayMeetingHours) * 10) / 10,
        },
        criticalMeetings: processed.filter(e => e.prioritySignal === 'critical'),
        highPriorityMeetings: processed.filter(e => e.prioritySignal === 'high'),
    };
}

function processEmails(emails) {
    const processed = emails.map(email => {
        const senderMatch = email.from.match(/([^<]+)?<?([^>]+@([^>]+))>?/);
        const senderName = (senderMatch?.[1] || '').trim() || email.from.split('@')[0];
        const senderEmail = senderMatch?.[2] || email.from;
        const labelIds = email.labelIds || [];
        const isStarred = labelIds.includes('STARRED');
        const isImportant = labelIds.includes('IMPORTANT');
        const isUnread = labelIds.includes('UNREAD');

        const subjectLower = (email.subject || '').toLowerCase();
        let urgencyLevel = 'normal';
        let category = 'general';

        if (subjectLower.includes('urgent') || subjectLower.includes('asap') || subjectLower.includes('immediately') || subjectLower.includes('critical')) {
            urgencyLevel = 'critical';
        } else if (subjectLower.includes('important') || subjectLower.includes('action required') || subjectLower.includes('deadline') || subjectLower.includes('reminder')) {
            urgencyLevel = 'high';
        } else if (isImportant || isStarred) {
            urgencyLevel = 'high';
        }

        if (subjectLower.includes('approve') || subjectLower.includes('approval') || subjectLower.includes('sign')) {
            category = 'approval-needed';
        } else if (subjectLower.includes('decision') || subjectLower.includes('choose') || subjectLower.includes('option')) {
            category = 'decision-needed';
        } else if (subjectLower.includes('fyi') || subjectLower.includes('update') || subjectLower.includes('newsletter')) {
            category = 'informational';
        } else if (subjectLower.includes('question') || subjectLower.includes('help') || subjectLower.includes('request')) {
            category = 'request';
        } else if (subjectLower.includes('meeting') || subjectLower.includes('invite')) {
            category = 'meeting-related';
        } else if (subjectLower.includes('report') || subjectLower.includes('status') || subjectLower.includes('weekly')) {
            category = 'report';
        }

        return {
            subject: email.subject,
            senderName,
            senderEmail,
            snippet: email.snippet,
            isStarred,
            isImportant,
            isUnread,
            urgencyLevel,
            category,
            requiresAction: ['approval-needed', 'decision-needed', 'request'].includes(category),
        };
    });

    const urgencyOrder = { critical: 0, high: 1, normal: 2 };
    processed.sort((a, b) => urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel]);

    return {
        emails: processed,
        actionableEmails: processed.filter(e => e.requiresAction),
        summary: {
            totalEmails: processed.length,
            unreadCount: processed.filter(e => e.isUnread).length,
            actionableCount: processed.filter(e => e.requiresAction).length,
            criticalCount: processed.filter(e => e.urgencyLevel === 'critical').length,
            highPriorityCount: processed.filter(e => e.urgencyLevel === 'high').length,
            byCategory: {
                approvalNeeded: processed.filter(e => e.category === 'approval-needed').length,
                decisionNeeded: processed.filter(e => e.category === 'decision-needed').length,
                requests: processed.filter(e => e.category === 'request').length,
            },
        },
        criticalEmails: processed.filter(e => e.urgencyLevel === 'critical'),
        highPriorityEmails: processed.filter(e => e.urgencyLevel === 'high'),
    };
}

function processTasks(tasks) {
    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);

    const processed = tasks.map(task => {
        let dueDate = null;
        let isOverdue = false;
        let isDueToday = false;
        let isDueThisWeek = false;

        if (task.due) {
            dueDate = new Date(task.due);
            isOverdue = dueDate < now;
            isDueToday = dueDate < todayEnd && !isOverdue;
            isDueThisWeek = dueDate < weekEnd && !isDueToday && !isOverdue;
        }

        const title = (task.title || '').toLowerCase();
        let prioritySignal = 'normal';
        let category = 'general';

        if (isOverdue) {
            prioritySignal = 'critical';
        } else if (isDueToday) {
            prioritySignal = 'high';
        } else if (title.includes('urgent') || title.includes('critical') || title.includes('asap')) {
            prioritySignal = 'critical';
        } else if (title.includes('important') || title.includes('priority') || isDueThisWeek) {
            prioritySignal = 'high';
        }

        if (title.includes('review') || title.includes('approve') || title.includes('sign')) {
            category = 'approval';
        } else if (title.includes('prepare') || title.includes('draft') || title.includes('write')) {
            category = 'preparation';
        } else if (title.includes('call') || title.includes('meet') || title.includes('discuss')) {
            category = 'communication';
        } else if (title.includes('decide') || title.includes('choose') || title.includes('finalize')) {
            category = 'decision';
        } else if (title.includes('follow up') || title.includes('check')) {
            category = 'follow-up';
        }

        return {
            title: task.title || 'Untitled Task',
            notes: task.notes || '',
            listName: task.listName || 'Tasks',
            dueDate: dueDate?.toISOString() || null,
            dueDateFormatted: dueDate ? dueDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'No due date',
            isOverdue,
            isDueToday,
            isDueThisWeek,
            prioritySignal,
            category,
        };
    });

    const priorityOrder = { critical: 0, high: 1, normal: 2 };
    processed.sort((a, b) => {
        if (priorityOrder[a.prioritySignal] !== priorityOrder[b.prioritySignal]) {
            return priorityOrder[a.prioritySignal] - priorityOrder[b.prioritySignal];
        }
        if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
    });

    return {
        tasks: processed,
        summary: {
            totalTasks: processed.length,
            overdueCount: processed.filter(t => t.isOverdue).length,
            dueTodayCount: processed.filter(t => t.isDueToday).length,
            dueThisWeekCount: processed.filter(t => t.isDueThisWeek).length,
            criticalCount: processed.filter(t => t.prioritySignal === 'critical').length,
            highPriorityCount: processed.filter(t => t.prioritySignal === 'high').length,
        },
        overdueTasks: processed.filter(t => t.isOverdue),
        todayTasks: processed.filter(t => t.isDueToday),
        criticalTasks: processed.filter(t => t.prioritySignal === 'critical'),
    };
}

// ═══════════════════════════════════════════════
//  AI Generation
// ═══════════════════════════════════════════════

function parseStrategicGoals(goalsStr) {
    if (!goalsStr) return ['Maximize productivity', 'Focus on high-impact work', 'Meet all deadlines'];
    try {
        const parsed = JSON.parse(goalsStr);
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    // Treat as newline-separated text
    return goalsStr.split('\n').map(g => g.trim()).filter(g => g.length > 0);
}

function buildAIContext(calendar, emails, tasks, strategicGoals, executiveName) {
    return {
        executive: {
            name: executiveName,
            strategicGoals,
            priorityWeights: { urgency: 0.3, impact: 0.35, strategicAlignment: 0.25, stakeholderImportance: 0.1 },
        },
        calendar: {
            summary: calendar.summary,
            criticalMeetings: calendar.criticalMeetings.slice(0, 5),
            highPriorityMeetings: calendar.highPriorityMeetings.slice(0, 5),
            todaySchedule: calendar.todayEvents.slice(0, 10),
        },
        emails: {
            summary: emails.summary,
            criticalEmails: emails.criticalEmails.slice(0, 5),
            actionableEmails: emails.actionableEmails.slice(0, 8),
        },
        tasks: {
            summary: tasks.summary,
            overdueTasks: tasks.overdueTasks.slice(0, 5),
            todayTasks: tasks.todayTasks.slice(0, 5),
            criticalTasks: tasks.criticalTasks.slice(0, 5),
        },
        dayHealth: {
            meetingLoad: calendar.summary.todayMeetingHours || 0,
            availableFocusHours: calendar.summary.availableHours || 8,
            pendingDecisions: (emails.summary.byCategory?.decisionNeeded || 0) + tasks.tasks.filter(t => t.category === 'decision').length,
            overdueItems: tasks.summary.overdueCount || 0,
            criticalItems: (calendar.summary.criticalCount || 0) + (emails.summary.criticalCount || 0) + (tasks.summary.criticalCount || 0),
        },
    };
}

async function generateAIPriorities(context) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = `You are an elite executive chief of staff AI that helps busy executives identify their TOP 5 PRIORITIES for the day. Your role is to cut through the noise and surface what truly matters.

Your analysis must be:
- DECISIVE: Give clear, actionable priorities, not suggestions
- STRATEGIC: Align priorities with stated strategic goals
- REALISTIC: Consider available time and meeting load
- IMPACTFUL: Focus on high-leverage activities

OUTPUT FORMAT (use exactly this structure):

## TODAY'S TOP 5 PRIORITIES

For each priority (numbered 1-5):
### [#]. [Priority Title]
**Why Now:** [1 sentence on urgency/importance]
**Action:** [Specific action to take]
**Time Needed:** [Estimated minutes/hours]
**Strategic Alignment:** [Which strategic goal this supports]

## CRITICAL ALERTS
[List any overdue items, critical meetings, or urgent decisions that need immediate attention - max 3 items]

## DAY SNAPSHOT
- Meeting Load: [X hours] | Focus Time: [Y hours]
- Pending Decisions: [count]
- Overdue Items: [count]
- Emails Requiring Action: [count]

## STRATEGIC RECOMMENDATION
[One paragraph on how to approach the day for maximum impact, considering the executive's strategic goals]

PRINCIPLES FOR PRIORITY SELECTION:
1. Overdue items and deadlines come first
2. High-stakes decisions and approvals take precedence
3. External commitments (clients, board, partners) are non-negotiable
4. Strategic initiatives should get protected focus time
5. Delegate or defer low-impact tasks

Be direct and confident. Executives need clarity, not options.`;

    const userMessage = `Analyze the following data and generate today's TOP 5 PRIORITIES for ${context.executive.name}.

STRATEGIC GOALS:
${context.executive.strategicGoals.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Priority Weights: Urgency=${context.executive.priorityWeights.urgency}, Impact=${context.executive.priorityWeights.impact}, Strategic Alignment=${context.executive.priorityWeights.strategicAlignment}, Stakeholder Importance=${context.executive.priorityWeights.stakeholderImportance}

TODAY'S CALENDAR (${context.calendar.summary.todayCount || 0} meetings, ${context.calendar.summary.todayMeetingHours || 0} hours):
${context.calendar.todaySchedule.map(e => `- ${e.startTimeFormatted}: ${e.title} (${e.durationHours}h) [${e.meetingType}] - Priority: ${e.prioritySignal}`).join('\n') || 'No meetings today'}

CRITICAL MEETINGS (next 3 days):
${context.calendar.criticalMeetings.map(e => `- ${e.startTimeFormatted}: ${e.title} - ${e.attendeeCount} attendees`).join('\n') || 'None'}

EMAIL STATUS (${context.emails.summary.unreadCount || 0} unread, ${context.emails.summary.actionableCount || 0} require action):
Approvals Needed: ${context.emails.summary.byCategory?.approvalNeeded || 0}
Decisions Needed: ${context.emails.summary.byCategory?.decisionNeeded || 0}
Requests: ${context.emails.summary.byCategory?.requests || 0}

CRITICAL/URGENT EMAILS:
${context.emails.criticalEmails.map(e => `- [${e.urgencyLevel.toUpperCase()}] From: ${e.senderName} — Subject: ${e.subject} — Category: ${e.category}`).join('\n') || 'None'}

ACTIONABLE EMAILS:
${context.emails.actionableEmails.map(e => `- [${e.category}] ${e.subject} - from ${e.senderName}`).join('\n') || 'None'}

TASK STATUS (${context.tasks.summary.totalTasks || 0} open tasks):
Overdue: ${context.tasks.summary.overdueCount || 0}
Due Today: ${context.tasks.summary.dueTodayCount || 0}
Due This Week: ${context.tasks.summary.dueThisWeekCount || 0}

OVERDUE TASKS:
${context.tasks.overdueTasks.map(t => `- ${t.title} (was due: ${t.dueDateFormatted})`).join('\n') || 'None - great job!'}

DUE TODAY:
${context.tasks.todayTasks.map(t => `- ${t.title} [${t.category}]`).join('\n') || 'None'}

CRITICAL TASKS:
${context.tasks.criticalTasks.map(t => `- ${t.title} - Due: ${t.dueDateFormatted}`).join('\n') || 'None'}

DAY HEALTH METRICS:
- Meeting Load: ${context.dayHealth.meetingLoad} hours
- Available Focus Time: ${context.dayHealth.availableFocusHours} hours
- Pending Decisions: ${context.dayHealth.pendingDecisions}
- Overdue Items: ${context.dayHealth.overdueItems}
- Critical Items Total: ${context.dayHealth.criticalItems}

Based on this analysis, generate ${context.executive.name}'s TOP 5 PRIORITIES for today. Be decisive and strategic.`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: 1500,
    });

    return response.choices[0].message.content;
}

// ═══════════════════════════════════════════════
//  Report Formatting & Email
// ═══════════════════════════════════════════════

function formatPriorityReport(aiOutput, context, user) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    // Convert markdown to basic HTML
    let contentHtml = (aiOutput || '')
        .replace(/### (.*)/g, '<h3 style="color:#152E47;font-size:16px;font-weight:700;margin:18px 0 8px 0;">$1</h3>')
        .replace(/## (.*)/g, '<h2 style="color:#152E47;font-size:20px;font-weight:700;margin:24px 0 12px 0;padding-top:16px;border-top:2px solid #FD5811;">$1</h2>')
        .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#152E47;">$1</strong>')
        .replace(/^- (.*)/gm, '<li style="margin:4px 0;font-size:14px;color:#444;">$1</li>')
        .replace(/\n\n/g, '</p><p style="margin:8px 0;font-size:14px;color:#444;line-height:1.6;">')
        .replace(/\n/g, '<br>');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f0f2f5;margin:0;padding:0;">
  <div style="max-width:680px;margin:0 auto;padding:24px 16px;">
    <!-- Orange Accent Bar -->
    <div style="background:#FD5811;height:4px;border-radius:14px 14px 0 0;"></div>

    <!-- Header -->
    <div style="background:#152E47;padding:28px 32px;color:white;">
      <img src="https://madeeas.com/wp-content/uploads/2025/09/foooter-logo-1024x143.png" alt="MadeEA" style="height:28px;margin-bottom:16px;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;margin-bottom:4px;">Executive Priority Alignment</div>
      <div style="font-size:22px;font-weight:700;">${dateStr}</div>
      <div style="font-size:14px;opacity:0.85;margin-top:6px;">Daily Clarity. Zero Decision Fatigue.</div>
    </div>

    <!-- Body -->
    <div style="background:white;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
      <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;">
        <div style="flex:1;min-width:120px;background:#f8f9fc;padding:14px;border-radius:8px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#FD5811;">${context.dayHealth.meetingLoad}h</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;">Meeting Load</div>
        </div>
        <div style="flex:1;min-width:120px;background:#f8f9fc;padding:14px;border-radius:8px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#152E47;">${context.dayHealth.availableFocusHours}h</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;">Focus Time</div>
        </div>
        <div style="flex:1;min-width:120px;background:#f8f9fc;padding:14px;border-radius:8px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#FD5811;">${context.dayHealth.pendingDecisions}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;">Decisions</div>
        </div>
        <div style="flex:1;min-width:120px;background:#f8f9fc;padding:14px;border-radius:8px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:${context.dayHealth.overdueItems > 0 ? '#dc3545' : '#28a745'};">${context.dayHealth.overdueItems}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;">Overdue</div>
        </div>
      </div>
      <div style="font-size:14px;color:#444;line-height:1.6;">
        ${contentHtml}
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#f8f9fc;border-radius:0 0 14px 14px;padding:20px 32px;border-top:1px solid #eee;">
      <div style="text-align:center;font-size:12px;color:#888;">
        <strong>Data Sources:</strong> Calendar: ${context.calendar.summary.totalEvents} events | Emails: ${context.emails.summary.totalEmails} messages | Tasks: ${context.tasks.summary.totalTasks} items
      </div>
      <div style="text-align:center;font-size:11px;color:#aaa;margin-top:8px;">
        Powered by <a href="https://madeeas.com" style="color:#FD5811;text-decoration:none;font-weight:600;">MadeEA</a> · Executive Priority Alignment
      </div>
    </div>
  </div>
</body></html>`;

    return {
        subject: `Your Top 5 Priorities - ${dateStr}`,
        html,
    };
}

// createRawEmail is imported from ./lib/email.js
