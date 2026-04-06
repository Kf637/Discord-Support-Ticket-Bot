# Discord Support Ticket Bot (JavaScript)

This bot automatically posts an **Open Support Ticket** button in your configured panel channel.
When a user submits the ticket form, the bot creates a private ticket channel, stores ticket data in SQLite, and handles close/transcript workflows.

## Features

- Automatically posts the ticket panel in `TICKET_PANEL_CHANNEL_ID` on startup
- Modal form with 2 fields:
  - Reported user username/userID (optional)
  - Issue description (required)
- Creates private ticket channels in `TICKET_CATEGORY_ID`
- 6-character ticket IDs (example: `3GO3HL`)
- Ticket IDs are guaranteed unique across both open and closed tickets
- Adds a **Close Ticket** button in every ticket channel
- Members with `SUPPORT_ROLE_ID` can close tickets; if unset, Discord administrators can close tickets
- Close flow asks optional:
  - Created reason
  - Closed reason
- Stores transcripts in `data/transcripts`
- Sends close logs + transcript attachment to `TRANSCRIPTS_CHANNEL_ID`
- Optional transcript DM to ticket owner on close (`DM_TRANSCRIPT_USER_ON_TICKET_CLOSE`)
- Optional auto-delete of local transcript files (`AUTO_DELETE_TRANSCRIPTS`)
- SQLite persistence for open/closed tickets in `data/data.db`
- SQL-pattern input sanitization for ticket and close modal inputs
- Staff slash command `/ticketshow user:<@user|userID>` to view a user's closed tickets
- Staff slash command `/blacklist add user:<@user|userID> reason:<text>` to add or update blacklist entries
- Staff slash commands `/blacklist remove user:<@user|userID>` and `/blacklist list`
- Users in `blacklisted` are blocked from opening tickets (reason is shown to them)

## Requirements

- Node.js 18+
- A Discord bot token with your bot invited to the server

Recommended bot permissions:

- View Channels
- Send Messages
- Read Message History
- Attach Files
- Manage Channels

## Environment Variables

Create `.env` from `.env.example` and set:

- `DISCORD_TOKEN` (required)
- `TICKET_CATEGORY_ID` (required)
- `TICKET_PANEL_CHANNEL_ID` (required)
- `TRANSCRIPTS_CHANNEL_ID` (required)
- `SUPPORT_ROLE_ID` (optional; when unset, close-ticket/staff checks fall back to Discord administrators)
- `ONE_OPEN_TICKET_PER_USER` (optional, default: `true`)
- `DM_TRANSCRIPT_USER_ON_TICKET_CLOSE` (optional, default: `false`)
- `AUTO_DELETE_TRANSCRIPTS` (optional, default: `false`)
- `BLACKLIST_USAGE_ALLOWED_ROLEID` (optional, default: `false`)
  - If this is a valid role ID, only that role can use `/blacklist` subcommands (`add`, `remove`, `list`)
  - If this is unset/`false`/invalid, all `/blacklist` subcommands fall back to `SUPPORT_ROLE_ID`

## Install and Run

```bash
npm install
npm start
```

## Ticket Flow

1. Bot starts and ensures panel message exists in `TICKET_PANEL_CHANNEL_ID`.
2. User clicks **Open Support Ticket**.
3. User submits form.
4. Bot creates private ticket channel and writes a row to `open_tickets`.
5. Support clicks **Close Ticket** and submits optional close reasons.
6. Bot generates transcript txt in `data/transcripts`.
7. Bot sends close embed + transcript file to `TRANSCRIPTS_CHANNEL_ID`.
8. Bot optionally DMs transcript file to ticket owner.
9. Bot moves record from `open_tickets` to `closed_tickets` and deletes channel.

## Staff Slash Commands

### `/ticketshow`

- Command: `/ticketshow user:<@user|userID>`
- Access: users with `SUPPORT_ROLE_ID`; if `SUPPORT_ROLE_ID` is unset, Discord administrators
- Input: accepts either a user mention (for example `<@123...>`) or a raw Discord user ID
- Output: embed response listing closed tickets for that user from `closed_tickets`, including:
  - `ticket_id`
  - `link_to_discord_message` (or no message link when unavailable)
- Pagination: when more than 20 tickets exist, results are shown 20 per page with **Previous/Next** buttons (single page shown at a time).

The bot auto-registers slash commands in connected guilds on startup.

### `/blacklist`

- Root command with subcommands:
  - `/blacklist add user:<@user|userID> reason:<text>`
  - `/blacklist remove user:<@user|userID>`
  - `/blacklist list`
- Input for `user`: accepts either a mention (for example `<@123...>`) or a raw Discord user ID.
- Access rules:
  - If `BLACKLIST_USAGE_ALLOWED_ROLEID` is a valid role ID, only that role can use `/blacklist add`, `/blacklist remove`, and `/blacklist list`.
  - If `BLACKLIST_USAGE_ALLOWED_ROLEID` is unset/`false`/invalid, all `/blacklist` subcommands require support access (`SUPPORT_ROLE_ID`, or Discord administrators when `SUPPORT_ROLE_ID` is unset).
- Behavior:
  - `add` inserts or updates the row for that user.
  - `remove` deletes the row if present.
  - `list` returns current blacklisted users with reason, staff user, and timestamp.
- Effect on ticketing:
  - Users present in `blacklisted` cannot open tickets via button/modal and receive an ephemeral reason message.

## Transcript Notes

- Transcript file includes:
  - Ticket ID
  - Date/time format legend at the top: `DD-MM-YYYY HH:MM (24-hour UTC)`
  - Transcript generated timestamp
  - Full channel message history
- Message timestamps are formatted as `DD-MM-YYYY HH:MM` (24-hour UTC).
- Transcript file does not include created/closed reason lines.
- Log embed in `TRANSCRIPTS_CHANNEL_ID` includes created/closed reasons.

## Database

Database path: `data/data.db`

On startup, the bot automatically migrates `data/tickets.db` to `data/data.db` if the new file does not already exist.

### `open_tickets`

- `discord_user_id`
- `channel_id`
- `ticket_id`
- `info` (JSON: `reportTarget`, `issueDescription`)
- `created_at`

### `closed_tickets`

- `ticket_id`
- `discord_user_id` (ticket owner)
- `closed_by` (support member user ID)
- `info` (JSON: `createdReason`, `closedReason`)
- `created_at`
- `closed_at`
- `link_to_discord_message` (URL of the transcript/log message posted in `TRANSCRIPTS_CHANNEL_ID`, or `null` if unavailable)

### `blacklisted`

- `discord_user_id` (unique)
- `reason`
- `blacklisted_by` (staff member user ID who added/updated the row)
- `created_at`

## Operational Notes

- Ticket channel names are lowercase (`ticket-xxxxxx`) due to Discord naming rules.
- If `ONE_OPEN_TICKET_PER_USER=true`, users can only have one active ticket at a time.
- If transcript DM fails, ticket closing continues and server logs/transcripts are still produced.
- If `AUTO_DELETE_TRANSCRIPTS=true`, local transcript files in `data/transcripts` are deleted automatically after close flow finishes.
