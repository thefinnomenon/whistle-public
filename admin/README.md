# Whistle Admin Dashboard

Next.js admin dashboard for managing Whistle games and questions.

## Getting Started

1. Make sure you have the `.env.local` file with Firebase credentials (already created)

2. Install dependencies (already done):
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

## Features

- View all games
- Create and edit games
- Manage questions for each game
- Real-time updates from Firestore

## Structure

- `app/` - Next.js 15 App Router pages
- `lib/` - Firebase configuration and utilities
- `components/` - Reusable React components

## Firebase Setup

The admin dashboard shares the same Firestore database as the React Native app. All configuration is in `.env.local`.

## Mixpanel Analytics Dashboard

The admin page at `/analytics` reads canonical question lifecycle metrics from the backend endpoint:

- `GET /api/admin/mixpanel/summary?range=7d|30d`

This endpoint is admin-protected and reads Mixpanel export data for:

- `question_created`
- `question_sent`
- `question_opened`
- `question_answered`
- `question_resolved`

### Required backend env vars

Set these in `backend/.env.development` and production secrets:

```bash
# Preferred for Export API:
MIXPANEL_API_SECRET=...
# Optional legacy alias:
MIXPANEL_PROJECT_SECRET=...
# Optional explicit Basic auth value:
# MIXPANEL_EXPORT_AUTH_BASIC=Basic base64(username:password)
# Service account (may not work for Export API in all projects):
MIXPANEL_SERVICE_ACCOUNT_USERNAME=...
MIXPANEL_SERVICE_ACCOUNT_SECRET=...
# Optional override
MIXPANEL_EXPORT_BASE_URL=https://data.mixpanel.com/api/2.0/export
```

### Notes

- Backend response is cached for 60 seconds to reduce Mixpanel API load.
- `latency_bucket` is expected on canonical events. If missing, backend derives bucket from `push_delivery_latency_ms` or `latency_at_answer_ms`.

## Next Steps

- [ ] Add game creation form
- [ ] Add game edit page
- [ ] Add questions management
- [ ] Add authentication (Firebase Auth)
