# soup-nazi-agent

> No messages for you.

A communication gating layer for AI agents. Prevents prompt injection by controlling what content an agent can see based on approved sender lists.

## What it does

- Shows the agent an inbox of **who** sent a message, not **what** they said
- Only approved senders (email addresses, phone numbers) unlock message content
- Wraps iMessage, email, and other communication APIs
- Dashboard + database (Supabase/Vercel) for managing approved senders

## Status

🚧 Early design phase
