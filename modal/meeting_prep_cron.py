"""
Meeting Preparation Automation™ — Modal.com Cron Job
====================================================
Runs daily, processes all active users, generates AI meeting briefs, sends via email.

Deploy: modal deploy meeting_prep_cron.py
Test:   modal run meeting_prep_cron.py::generate_briefs
"""

import modal
import os
import json
import base64
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ─── Modal App Setup ───
app = modal.App("meeting-prep-automation")

image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "google-auth",
    "google-auth-oauthlib",
    "google-api-python-client",
    "openai",
    "supabase",
    "httpx",
    "msal",
)

# ─── Secrets ───
# Store these in Modal dashboard: modal secret create meeting-prep-secrets
secrets = modal.Secret.from_name("meeting-prep-secrets")


@app.function(
    image=image,
    secrets=[secrets],
    schedule=modal.Cron("0 * * * *"),  # Run every hour, check per-user send times
    timeout=600,
)
def generate_briefs():
    """Main cron entry point — runs hourly, processes users whose send_time matches."""
    from supabase import create_client

    supabase = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )

    # Get all active users
    result = supabase.table("users").select("*").eq("is_active", True).execute()
    users = result.data or []

    now_utc = datetime.now(timezone.utc)
    processed = 0

    for user in users:
        try:
            # Check if it's the right time for this user
            if not is_send_time(user, now_utc):
                continue

            print(f"Processing user: {user['email']}")
            process_user(supabase, user)
            processed += 1

        except Exception as e:
            print(f"Error processing {user['email']}: {e}")
            # Log the failure
            supabase.table("briefing_logs").insert({
                "user_id": user["id"],
                "meeting_count": 0,
                "status": "failed",
                "error_message": str(e)[:500],
            }).execute()

    print(f"Processed {processed}/{len(users)} users")
    return {"processed": processed, "total_users": len(users)}


def is_send_time(user: dict, now_utc: datetime) -> bool:
    """Check if current UTC hour matches user's preferred send time in their timezone."""
    import pytz

    user_tz_name = user.get("timezone", "Asia/Dubai")
    send_time_str = user.get("send_time", "07:00:00")

    try:
        # Simple hour-based check
        send_hour = int(send_time_str.split(":")[0])

        # Get current hour in user's timezone
        # Using offset calculation since pytz may not be available
        tz_offsets = {
            "Asia/Dubai": 4,
            "Asia/Singapore": 8,
            "Asia/Manila": 8,
            "America/New_York": -5,
            "America/Los_Angeles": -8,
            "America/Chicago": -6,
            "Europe/London": 0,
            "Europe/Paris": 1,
            "Australia/Sydney": 11,
            "Pacific/Auckland": 12,
        }

        offset = tz_offsets.get(user_tz_name, 4)  # Default to Dubai
        user_hour = (now_utc.hour + offset) % 24

        return user_hour == send_hour

    except Exception:
        return False


def process_user(supabase, user: dict):
    """Process a single user — detect provider, fetch meetings, generate brief, send email."""

    # Detect provider
    if user.get("google_access_token"):
        process_user_google(supabase, user)
    elif user.get("microsoft_access_token"):
        process_user_microsoft(supabase, user)
    else:
        raise Exception("No valid provider credentials")


def process_user_google(supabase, user: dict):
    """Process a Google-connected user."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = get_google_credentials(user)
    if not creds:
        raise Exception("No valid Google credentials")

    if creds.token != user.get("google_access_token"):
        supabase.table("users").update({
            "google_access_token": creds.token,
            "google_token_expiry": creds.expiry.isoformat() if creds.expiry else None,
        }).eq("id", user["id"]).execute()

    calendar_service = build("calendar", "v3", credentials=creds)
    meetings = get_todays_meetings(calendar_service, user.get("calendar_id", "primary"))

    if not meetings:
        print(f"  No meetings today for {user['email']}")
        supabase.table("briefing_logs").insert({
            "user_id": user["id"],
            "meeting_count": 0,
            "status": "success",
            "error_message": "No meetings today",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        return

    real_meetings = [
        m for m in meetings
        if m.get("attendees") and m.get("status") != "cancelled"
    ]

    if not real_meetings:
        print(f"  No real meetings today for {user['email']}")
        return

    gmail_service = build("gmail", "v1", credentials=creds)
    drive_service = build("drive", "v3", credentials=creds)

    meeting_briefs = []
    for meeting in real_meetings:
        try:
            brief = process_single_meeting(
                meeting, calendar_service, gmail_service, drive_service, creds, user
            )
            meeting_briefs.append(brief)
        except Exception as e:
            print(f"  Error processing meeting '{meeting.get('summary', 'Unknown')}': {e}")
            meeting_briefs.append({
                "subject": meeting.get("summary", "Unknown Meeting"),
                "brief": f"Error generating brief: {str(e)}",
                "meeting": meeting,
            })

    html_email = compose_email(meeting_briefs, user)
    send_email(gmail_service, user["email"], html_email["subject"], html_email["html"])

    supabase.table("briefing_logs").insert({
        "user_id": user["id"],
        "meeting_count": len(real_meetings),
        "status": "success",
        "sent_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    print(f"  ✅ Sent brief with {len(real_meetings)} meetings to {user['email']}")


def process_user_microsoft(supabase, user: dict):
    """Process a Microsoft-connected user."""
    import httpx

    access_token = get_microsoft_access_token(supabase, user)
    if not access_token:
        raise Exception("No valid Microsoft credentials")

    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}

    # 1. Fetch today's calendar events
    now = datetime.now(timezone.utc)
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)

    cal_url = (
        f"https://graph.microsoft.com/v1.0/me/calendarView"
        f"?startDateTime={start_of_day.isoformat()}"
        f"&endDateTime={end_of_day.isoformat()}"
        f"&$orderby=start/dateTime"
        f"&$top=50"
        f"&$select=subject,start,end,attendees,location,bodyPreview,onlineMeetingUrl,onlineMeeting,isOrganizer,organizer,isCancelled"
    )

    with httpx.Client(timeout=30) as client:
        cal_resp = client.get(cal_url, headers=headers)
        cal_resp.raise_for_status()
        ms_events = cal_resp.json().get("value", [])

    # Normalize events to Google shape
    meetings = []
    user_email = user.get("email", "")
    for ev in ms_events:
        normalized = normalize_ms_event(ev, user_email)
        meetings.append(normalized)

    if not meetings:
        print(f"  No meetings today for {user['email']}")
        supabase.table("briefing_logs").insert({
            "user_id": user["id"],
            "meeting_count": 0,
            "status": "success",
            "error_message": "No meetings today",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        return

    real_meetings = [
        m for m in meetings
        if m.get("attendees") and m.get("status") != "cancelled"
    ]

    if not real_meetings:
        print(f"  No real meetings today for {user['email']}")
        return

    # 2. Process each meeting
    meeting_briefs = []
    for meeting in real_meetings:
        try:
            brief = process_single_meeting_microsoft(meeting, headers, user)
            meeting_briefs.append(brief)
        except Exception as e:
            print(f"  Error processing meeting '{meeting.get('summary', 'Unknown')}': {e}")
            meeting_briefs.append({
                "subject": meeting.get("summary", "Unknown Meeting"),
                "brief": f"Error generating brief: {str(e)}",
                "meeting": meeting,
            })

    # 3. Compose and send email
    html_email = compose_email(meeting_briefs, user)
    send_email_microsoft(headers, user["email"], html_email["subject"], html_email["html"])

    supabase.table("briefing_logs").insert({
        "user_id": user["id"],
        "meeting_count": len(real_meetings),
        "status": "success",
        "sent_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    print(f"  ✅ Sent brief with {len(real_meetings)} meetings to {user['email']}")


def get_google_credentials(user: dict):
    """Get valid Google credentials, refreshing if necessary."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    creds = Credentials(
        token=user.get("google_access_token"),
        refresh_token=user.get("google_refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    )

    if creds.expired and creds.refresh_token:
        creds.refresh(Request())

    return creds


def get_todays_meetings(calendar_service, calendar_id: str = "primary") -> list:
    """Fetch all calendar events for today."""
    now = datetime.now(timezone.utc)
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)

    events_result = calendar_service.events().list(
        calendarId=calendar_id,
        timeMin=start_of_day.isoformat(),
        timeMax=end_of_day.isoformat(),
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    return events_result.get("items", [])


def process_single_meeting(meeting, calendar_service, gmail_service, drive_service, creds, user):
    """Gather all context for a single meeting and generate AI brief."""

    subject = meeting.get("summary", "Untitled Meeting")
    description = meeting.get("description", "")
    attendees = meeting.get("attendees", [])

    # Extract meeting metadata
    start_time = meeting.get("start", {}).get("dateTime", meeting.get("start", {}).get("date", ""))
    end_time = meeting.get("end", {}).get("dateTime", meeting.get("end", {}).get("date", ""))

    attendee_list = []
    for a in attendees:
        attendee_list.append({
            "email": a.get("email", ""),
            "name": a.get("displayName", a.get("email", "").split("@")[0]),
            "status": a.get("responseStatus", "unknown"),
            "organizer": a.get("organizer", False),
            "self": a.get("self", False),
        })

    # Determine self domain
    self_domain = ""
    for a in attendee_list:
        if a["self"]:
            self_domain = a["email"].split("@")[-1]
            break

    external = [a for a in attendee_list if a["email"].split("@")[-1] != self_domain and self_domain]
    internal = [a for a in attendee_list if a["email"].split("@")[-1] == self_domain or not self_domain]

    # Detect meeting type
    meeting_type = detect_meeting_type(subject, external)

    # Extract keywords
    keywords = extract_keywords(subject, description)

    # Search related emails (last 14 days)
    related_emails = search_related_emails(gmail_service, keywords, attendee_list)

    # Search Google Drive for related documents
    related_docs = search_drive_documents(drive_service, keywords)

    # Search previous meetings
    previous_meetings = search_previous_meetings(calendar_service, subject, user.get("calendar_id", "primary"))

    # Generate AI brief
    ai_brief = generate_ai_brief(
        subject=subject,
        description=description,
        start_time=start_time,
        end_time=end_time,
        attendees=attendee_list,
        external_attendees=external,
        internal_attendees=internal,
        meeting_type=meeting_type,
        related_emails=related_emails,
        related_docs=related_docs,
        previous_meetings=previous_meetings,
        meeting=meeting,
    )

    return {
        "subject": subject,
        "brief": ai_brief,
        "meeting": meeting,
        "start_time": start_time,
        "end_time": end_time,
        "attendees": attendee_list,
        "context": {
            "emails": len(related_emails),
            "documents": len(related_docs),
            "previous_meetings": len(previous_meetings),
        },
    }


def detect_meeting_type(subject: str, external: list) -> str:
    """Detect the type of meeting from its subject."""
    subject_lower = subject.lower()
    if "interview" in subject_lower:
        return "interview"
    elif "standup" in subject_lower or "stand-up" in subject_lower:
        return "standup"
    elif "1:1" in subject_lower or "one on one" in subject_lower or "1-1" in subject_lower:
        return "one-on-one"
    elif "review" in subject_lower:
        return "review"
    elif "planning" in subject_lower or "sprint" in subject_lower:
        return "planning"
    elif "demo" in subject_lower or "presentation" in subject_lower:
        return "presentation"
    elif "kickoff" in subject_lower or "kick-off" in subject_lower:
        return "kickoff"
    elif external:
        return "external"
    return "general"


def extract_keywords(subject: str, description: str) -> str:
    """Extract meaningful keywords from meeting subject and description."""
    import re

    stop_words = {"meeting", "call", "sync", "standup", "review", "discussion", "update", "the", "and", "for", "with"}

    words = re.sub(r"[^a-zA-Z0-9\s]", " ", subject).split()
    keywords = [w for w in words if len(w) > 3 and w.lower() not in stop_words][:5]

    if description:
        desc_clean = re.sub(r"<[^>]*>", " ", description)
        desc_words = re.sub(r"[^a-zA-Z0-9\s]", " ", desc_clean).split()
        keywords.extend([w for w in desc_words if len(w) > 4][:5])

    return " ".join(keywords[:8])


def search_related_emails(gmail_service, keywords: str, attendees: list) -> list:
    """Search Gmail for emails related to meeting topics or from attendees."""
    try:
        # Build search query
        attendee_emails = [a["email"] for a in attendees if not a.get("self")][:5]
        query_parts = []

        if keywords:
            query_parts.append(f"({keywords})")
        if attendee_emails:
            from_query = " OR ".join([f"from:{e}" for e in attendee_emails])
            query_parts.append(f"({from_query})")

        query = " OR ".join(query_parts)

        # Only last 14 days
        after_date = (datetime.now() - timedelta(days=14)).strftime("%Y/%m/%d")
        query += f" after:{after_date}"

        results = gmail_service.users().messages().list(
            userId="me", q=query, maxResults=8
        ).execute()

        messages = results.get("messages", [])
        emails = []

        for msg in messages[:8]:
            full_msg = gmail_service.users().messages().get(
                userId="me", id=msg["id"], format="metadata",
                metadataHeaders=["Subject", "From", "Date"]
            ).execute()

            headers = {h["name"]: h["value"] for h in full_msg.get("payload", {}).get("headers", [])}
            emails.append({
                "subject": headers.get("Subject", "No Subject"),
                "from": headers.get("From", ""),
                "date": headers.get("Date", ""),
                "snippet": full_msg.get("snippet", ""),
            })

        return emails

    except Exception as e:
        print(f"  Gmail search error: {e}")
        return []


def search_drive_documents(drive_service, keywords: str) -> list:
    """Search Google Drive for documents related to meeting topics."""
    try:
        if not keywords:
            return []

        # Build search query
        keyword_list = keywords.split()[:3]
        q_parts = [f"fullText contains '{k}'" for k in keyword_list if k]
        query = " or ".join(q_parts)

        results = drive_service.files().list(
            q=query,
            pageSize=6,
            fields="files(id, name, mimeType, webViewLink, modifiedTime, owners)",
        ).execute()

        files = results.get("files", [])
        return [
            {
                "name": f.get("name", ""),
                "type": get_mime_label(f.get("mimeType", "")),
                "link": f.get("webViewLink", ""),
                "modified": f.get("modifiedTime", ""),
                "owner": f.get("owners", [{}])[0].get("displayName", "") if f.get("owners") else "",
            }
            for f in files
        ]

    except Exception as e:
        print(f"  Drive search error: {e}")
        return []


def get_mime_label(mime_type: str) -> str:
    """Convert MIME type to human-readable label."""
    labels = {
        "application/vnd.google-apps.document": "Google Doc",
        "application/vnd.google-apps.spreadsheet": "Google Sheet",
        "application/vnd.google-apps.presentation": "Google Slides",
        "application/pdf": "PDF",
    }
    return labels.get(mime_type, "Document")


def search_previous_meetings(calendar_service, subject: str, calendar_id: str = "primary") -> list:
    """Search for previous meetings with similar subjects."""
    try:
        # Look back 60 days
        time_min = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        time_max = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0).isoformat()

        events = calendar_service.events().list(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            q=subject.split()[0] if subject else "",
            singleEvents=True,
            orderBy="startTime",
            maxResults=5,
        ).execute()

        return [
            {
                "subject": e.get("summary", ""),
                "date": e.get("start", {}).get("dateTime", e.get("start", {}).get("date", "")),
                "attendee_count": len(e.get("attendees", [])),
                "description": (e.get("description", "") or "")[:200],
            }
            for e in events.get("items", [])
        ]

    except Exception as e:
        print(f"  Calendar search error: {e}")
        return []


def generate_ai_brief(**kwargs) -> str:
    """Generate meeting preparation brief using OpenAI."""
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    system_prompt = """You are an elite executive assistant AI that creates concise, high-impact meeting preparation briefs. Your briefs help busy executives walk into every meeting fully prepared.

YOUR BRIEF MUST INCLUDE:

## 🎯 Meeting Snapshot
One paragraph: what this meeting is about, why it matters, expected outcome.

## 👥 Key Attendees
For each key attendee:
- Name, role/context
- Their likely priorities
- Suggested talking points

## 📋 Objectives & Decision Points
- Primary objective
- Specific decisions needed
- Questions to answer

## 📚 Background Context
- History from previous meetings
- Key points from related emails
- Important context from documents

## 📎 Required Documents
- Links to relevant files

## ⚠️ Potential Concerns
- Issues that might come up
- Sensitivities and risks

## ✅ Recommended Preparation
- Things to review before the meeting
- Data points to have ready

GUIDELINES:
- Be concise but thorough
- Focus on actionable insights
- Use bullet points for readability
- If context is limited, say what's unknown"""

    # Build context message
    meeting = kwargs.get("meeting", {})
    user_message = f"""Create a meeting preparation brief for:

📅 MEETING: {kwargs.get('subject', 'Meeting')}
Type: {kwargs.get('meeting_type', 'general')}
Time: {kwargs.get('start_time', 'TBD')} to {kwargs.get('end_time', 'TBD')}
Location: {meeting.get('location', 'Not specified')}
Conference: {meeting.get('hangoutLink', 'No link')}

👥 ATTENDEES ({len(kwargs.get('attendees', []))} people):
Internal: {json.dumps([{'name': a['name'], 'email': a['email'], 'status': a['status']} for a in kwargs.get('internal_attendees', [])], indent=2)}
External: {json.dumps([{'name': a['name'], 'email': a['email'], 'status': a['status']} for a in kwargs.get('external_attendees', [])], indent=2)}

📝 DESCRIPTION:
{kwargs.get('description', 'No description')}

📧 RELATED EMAILS ({len(kwargs.get('related_emails', []))} found):
{json.dumps(kwargs.get('related_emails', [])[:5], indent=2)}

📎 RELATED DOCUMENTS ({len(kwargs.get('related_docs', []))} found):
{json.dumps(kwargs.get('related_docs', [])[:5], indent=2)}

🔄 PREVIOUS MEETINGS ({len(kwargs.get('previous_meetings', []))} found):
{json.dumps(kwargs.get('previous_meetings', [])[:3], indent=2)}

Generate a comprehensive but scannable meeting preparation brief."""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.7,
            max_tokens=2000,
        )
        return response.choices[0].message.content

    except Exception as e:
        return f"AI brief generation failed: {str(e)}"


def compose_email(meeting_briefs: list, user: dict) -> dict:
    """Compose the final HTML email with all meeting briefs."""
    today = datetime.now().strftime("%A, %B %d, %Y")
    total = len(meeting_briefs)

    def format_time(iso_str):
        try:
            dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
            return dt.strftime("%-I:%M %p")
        except:
            return "TBD"

    meeting_cards = ""
    for brief_data in meeting_briefs:
        meeting = brief_data.get("meeting", {})
        brief_text = brief_data.get("brief", "")
        context = brief_data.get("context", {})

        # Convert markdown-ish brief to HTML
        brief_html = brief_text.replace("\n", "<br>")
        brief_html = brief_html.replace("## ", "<h3 style='color: #667eea; margin-top: 20px;'>")
        brief_html = brief_html.replace("**", "<strong>")

        start = brief_data.get("start_time", "")
        hangout = meeting.get("hangoutLink", "")

        meeting_cards += f"""
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px; margin-bottom: 15px; color: white;">
            <h2 style="margin: 0 0 10px 0; font-size: 20px;">🗓️ {brief_data.get('subject', 'Meeting')}</h2>
            <div style="font-size: 14px; opacity: 0.9;">
                ⏰ {format_time(start)} • 👥 {len(brief_data.get('attendees', []))} attendees
                • 📧 {context.get('emails', 0)} emails • 📎 {context.get('documents', 0)} docs
            </div>
            {'<div style="margin-top: 10px;"><a href="' + hangout + '" style="background: rgba(255,255,255,0.2); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none;">🎥 Join Meeting</a></div>' if hangout else ''}
        </div>
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea; margin-bottom: 40px;">
            <div style="line-height: 1.8; color: #333;">
                {brief_html}
            </div>
        </div>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        """

    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; margin: 0; padding: 20px;">
        <div style="max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 2px 20px rgba(0,0,0,0.08); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center;">
                <h1 style="margin: 0 0 8px 0; font-size: 26px;">📅 Meeting Preparation Brief</h1>
                <p style="margin: 0; font-size: 16px; opacity: 0.9;">{today}</p>
                <p style="margin: 8px 0 0 0; font-size: 14px; opacity: 0.8;">You have <strong>{total}</strong> meeting{'s' if total != 1 else ''} today</p>
            </div>
            <div style="padding: 25px;">
                {meeting_cards}
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                <p style="margin: 0; color: #888; font-size: 12px;">
                    Generated by Meeting Preparation Automation<br>
                    Powered by MadeEA | <a href="mailto:hello@madeeas.com" style="color: #667eea;">hello@madeeas.com</a>
                </p>
            </div>
        </div>
    </body>
    </html>
    """

    return {
        "subject": f"Meeting Prep Brief: {total} meeting{'s' if total != 1 else ''} today - {today}",
        "html": html,
    }


def send_email(gmail_service, to_email: str, subject: str, html_body: str):
    """Send email via Gmail API."""
    message = MIMEMultipart("alternative")
    message["to"] = to_email
    message["subject"] = subject

    html_part = MIMEText(html_body, "html")
    message.attach(html_part)

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    gmail_service.users().messages().send(
        userId="me", body={"raw": raw}
    ).execute()


# ═══════════════════════════════════════════════
#  Microsoft-Specific Functions
# ═══════════════════════════════════════════════

def get_microsoft_access_token(supabase, user: dict) -> str:
    """Get a valid Microsoft access token, refreshing if expired."""
    import httpx

    access_token = user.get("microsoft_access_token")
    refresh_token = user.get("microsoft_refresh_token")
    expiry_str = user.get("microsoft_token_expiry")

    # Check if token is expired (5 min buffer)
    is_expired = True
    if expiry_str:
        try:
            expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
            is_expired = datetime.now(timezone.utc) > expiry - timedelta(minutes=5)
        except Exception:
            pass

    if is_expired and refresh_token:
        try:
            token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
            data = {
                "client_id": os.environ["MICROSOFT_CLIENT_ID"],
                "client_secret": os.environ["MICROSOFT_CLIENT_SECRET"],
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
                "scope": "User.Read Calendars.Read Mail.Read Mail.Send Files.Read.All Tasks.Read offline_access",
            }

            with httpx.Client(timeout=15) as client:
                resp = client.post(token_url, data=data)
                resp.raise_for_status()
                token_data = resp.json()

            if token_data.get("access_token"):
                access_token = token_data["access_token"]
                update_data = {
                    "microsoft_access_token": access_token,
                }
                if token_data.get("expires_in"):
                    new_expiry = datetime.now(timezone.utc) + timedelta(seconds=token_data["expires_in"])
                    update_data["microsoft_token_expiry"] = new_expiry.isoformat()
                if token_data.get("refresh_token"):
                    update_data["microsoft_refresh_token"] = token_data["refresh_token"]

                supabase.table("users").update(update_data).eq("id", user["id"]).execute()

        except Exception as e:
            print(f"  Microsoft token refresh error: {e}")

    return access_token


def normalize_ms_event(ms_event: dict, user_email: str) -> dict:
    """Normalize a Microsoft Graph calendar event to Google Calendar shape."""
    response_map = {
        "accepted": "accepted",
        "declined": "declined",
        "tentativelyAccepted": "tentative",
        "none": "needsAction",
        "notResponded": "needsAction",
    }

    attendees = []
    for a in ms_event.get("attendees", []):
        email_addr = (a.get("emailAddress", {}).get("address", "") or "").lower()
        attendees.append({
            "email": a.get("emailAddress", {}).get("address", ""),
            "displayName": a.get("emailAddress", {}).get("name", ""),
            "responseStatus": response_map.get(
                (a.get("status", {}) or {}).get("response", ""), "needsAction"
            ),
            "self": email_addr == (user_email or "").lower(),
            "organizer": (
                (ms_event.get("organizer", {}).get("emailAddress", {}).get("address", "") or "").lower()
                == email_addr
            ),
        })

    return {
        "summary": ms_event.get("subject", ""),
        "description": ms_event.get("bodyPreview", ""),
        "start": {"dateTime": (ms_event.get("start") or {}).get("dateTime", "")},
        "end": {"dateTime": (ms_event.get("end") or {}).get("dateTime", "")},
        "attendees": attendees,
        "status": "cancelled" if ms_event.get("isCancelled") else "confirmed",
        "hangoutLink": ms_event.get("onlineMeetingUrl") or (ms_event.get("onlineMeeting") or {}).get("joinUrl", ""),
        "location": (ms_event.get("location") or {}).get("displayName", ""),
    }


def process_single_meeting_microsoft(meeting: dict, headers: dict, user: dict) -> dict:
    """Gather context for a single meeting using Microsoft Graph and generate AI brief."""
    import httpx

    subject = meeting.get("summary", "Untitled Meeting")
    description = meeting.get("description", "")
    attendees = meeting.get("attendees", [])

    start_time = meeting.get("start", {}).get("dateTime", "")
    end_time = meeting.get("end", {}).get("dateTime", "")

    attendee_list = []
    for a in attendees:
        attendee_list.append({
            "email": a.get("email", ""),
            "name": a.get("displayName", a.get("email", "").split("@")[0]),
            "status": a.get("responseStatus", "unknown"),
            "organizer": a.get("organizer", False),
            "self": a.get("self", False),
        })

    self_domain = ""
    for a in attendee_list:
        if a["self"]:
            self_domain = a["email"].split("@")[-1]
            break

    external = [a for a in attendee_list if a["email"].split("@")[-1] != self_domain and self_domain]
    internal = [a for a in attendee_list if a["email"].split("@")[-1] == self_domain or not self_domain]

    meeting_type = detect_meeting_type(subject, external)
    keywords = extract_keywords(subject, description)

    # Search related emails via Microsoft Graph
    related_emails = search_related_emails_microsoft(headers, keywords, attendee_list)
    related_docs = search_drive_documents_microsoft(headers, keywords)
    previous_meetings = []  # Calendar search with filter is limited in Graph; skip for cron

    ai_brief = generate_ai_brief(
        subject=subject,
        description=description,
        start_time=start_time,
        end_time=end_time,
        attendees=attendee_list,
        external_attendees=external,
        internal_attendees=internal,
        meeting_type=meeting_type,
        related_emails=related_emails,
        related_docs=related_docs,
        previous_meetings=previous_meetings,
        meeting=meeting,
    )

    return {
        "subject": subject,
        "brief": ai_brief,
        "meeting": meeting,
        "start_time": start_time,
        "end_time": end_time,
        "attendees": attendee_list,
        "context": {
            "emails": len(related_emails),
            "documents": len(related_docs),
            "previous_meetings": len(previous_meetings),
        },
    }


def search_related_emails_microsoft(headers: dict, keywords: str, attendees: list) -> list:
    """Search Microsoft Outlook for related emails."""
    import httpx
    from urllib.parse import quote

    try:
        attendee_emails = [a["email"] for a in attendees if not a.get("self")][:5]
        search_parts = []
        if keywords:
            search_parts.append(keywords)
        if attendee_emails:
            search_parts.extend(attendee_emails)
        search_query = " ".join(search_parts)
        if not search_query:
            return []

        url = (
            f"https://graph.microsoft.com/v1.0/me/messages"
            f"?$search=\"{quote(search_query)}\""
            f"&$top=8"
            f"&$select=id,subject,from,receivedDateTime,bodyPreview"
        )

        with httpx.Client(timeout=15) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()
            messages = resp.json().get("value", [])

        return [
            {
                "subject": m.get("subject", "No Subject"),
                "from": (m.get("from", {}).get("emailAddress", {}).get("address", "") or
                         m.get("from", {}).get("emailAddress", {}).get("name", "")),
                "date": m.get("receivedDateTime", ""),
                "snippet": m.get("bodyPreview", ""),
            }
            for m in messages
        ]

    except Exception as e:
        print(f"  Microsoft email search error: {e}")
        return []


def search_drive_documents_microsoft(headers: dict, keywords: str) -> list:
    """Search OneDrive for related documents."""
    import httpx
    from urllib.parse import quote

    try:
        if not keywords:
            return []

        url = (
            f"https://graph.microsoft.com/v1.0/me/drive/root/search(q='{quote(keywords)}')"
            f"?$top=6"
            f"&$select=name,webUrl,lastModifiedDateTime,createdBy,file"
        )

        with httpx.Client(timeout=15) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()
            files = resp.json().get("value", [])

        ext_types = {
            "docx": "Word Document", "doc": "Word Document",
            "xlsx": "Excel Spreadsheet", "xls": "Excel Spreadsheet",
            "pptx": "PowerPoint", "ppt": "PowerPoint",
            "pdf": "PDF", "txt": "Text File",
        }

        results = []
        for f in files:
            name = f.get("name", "")
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            results.append({
                "name": name,
                "type": ext_types.get(ext, "Document"),
                "link": f.get("webUrl", ""),
                "modified": f.get("lastModifiedDateTime", ""),
                "owner": (f.get("createdBy", {}).get("user", {}).get("displayName", "") or ""),
            })
        return results

    except Exception as e:
        print(f"  OneDrive search error: {e}")
        return []


def send_email_microsoft(headers: dict, to_email: str, subject: str, html_body: str):
    """Send email via Microsoft Graph API."""
    import httpx

    url = "https://graph.microsoft.com/v1.0/me/sendMail"
    payload = {
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html_body},
            "toRecipients": [
                {"emailAddress": {"address": to_email}},
            ],
        },
    }

    with httpx.Client(timeout=30) as client:
        resp = client.post(url, headers=headers, json=payload)
        resp.raise_for_status()


# ─── Manual Trigger for Testing ───
@app.local_entrypoint()
def main():
    """Run manually: modal run meeting_prep_cron.py"""
    result = generate_briefs.remote()
    print(f"Result: {result}")
