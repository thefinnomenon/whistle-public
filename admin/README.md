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

## Next Steps

- [ ] Add game creation form
- [ ] Add game edit page
- [ ] Add questions management
- [ ] Add authentication (Firebase Auth)
