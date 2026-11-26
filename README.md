# Whistle

Whistle was a mobile sports prediction product for NBA and NFL games. Players joined a game, answered short questions about the next play or a period, and competed on a leaderboard. Featured games added prize pools and eligibility rules.

This is an independently sanitized archive of the retired application. The original service is inactive. Explore the self-contained interactive portfolio replay at [finnternet.com/work/whistle](https://finnternet.com/work/whistle/).

## Architecture

- **Mobile:** Expo SDK 54, React Native, Expo Router, TypeScript and NativeWind.
- **Game backend:** Node.js, Express, Firebase Admin and Firestore. NBA live feeds, ESPN NFL feeds and optional EntitySport capture feed question generation and resolution.
- **Native delivery:** Firebase Cloud Messaging, actionable iOS notification extensions and Android notification support.
- **Operations:** an administration app, Mixpanel analytics, Sentry reporting, stored game replay and simulation scripts.

Questions move through open, closed and resolved states. Correct predictions earn weighted points; questions with more choices are worth more. The backend includes eligibility and tied-winner payout planning for featured competitions.

## Running your own copy

Use your own accounts and configuration. This repository does not include working production credentials, customer data, historical database exports, provider logs, signed app builds or the original promotional videos.

1. Use Yarn 1.x and a Node.js version supported by the installed Expo SDK. Install the root, `backend` and `admin` dependencies separately.
2. Copy `.env.example` to an ignored local environment file. Configure Firebase, authentication, your API domain and any optional integrations you choose to enable.
3. Supply your own Firebase native files at the paths referenced in `app.config.js`: `google-services.json`, `google-services.dev.json`, `GoogleService-Info.plist` and `GoogleService-Info.dev.plist`.
4. Configure your own Expo/EAS project and Apple/Google application identities. EAS updates are disabled in this archive. The example `eas.json` contains build profiles without submission credentials.
5. Configure the backend's `FIREBASE_SERVICE_ACCOUNT` as documented by its environment loader. Keep all private service-account material server-side. Configure the required signing secret and optional sports-feed, email, push and analytics services using your own accounts.
6. Supply your own licensed onboarding clip and promotional media if reusing those flows. The broadcast clip was excluded; its onboarding source is `null`. Retained native onboarding GIFs show the original notification UI.
7. Run `yarn dev` for the Expo development client. In `backend`, use `yarn build` to compile or configure a local environment and run its development script. The original backend tunnel identity was removed.

The `admin` application has separate dependencies and environment requirements. Inspect its package scripts and Firebase permissions before use. Static privacy/support/terms pages and competition sponsor details need your own organization-specific content before a deployment.

This archive retains historical implementation decisions and is not a deployment-ready service. No live provider or production database validation was performed as part of publication.

## Historical limitations

Review authorization before connecting this archive to any real data. In particular, the historical Firestore user-create rule permits caller-supplied fields while administrative access trusts an `isAdmin` field. User creation must reject privileged fields or administrative roles must be assigned by a trusted server. This policy was preserved for source review and is not safe to deploy unchanged. The example email API also needs authentication, input validation and abuse controls before deployment. Email credentials now remain in server environment variables rather than Expo client configuration.

## Archive changes

The retained main-branch history was rewritten in a separate clone. Credentials and native provider configuration, operational reports, exported game fixtures, private contacts, old native build artifacts and unreviewable promotional recordings were removed. Commit email addresses were replaced with a public GitHub noreply identity. Original dates and code authorship names were retained.

The source application's private checkout and its history were not modified. The canonical portfolio replay uses synthetic participants and game data, and does not contact the retired service.

## License and assets

Application source is licensed under the [MIT License](LICENSE). Team names, team logos, third-party fonts, packages and other third-party material remain subject to their own rights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source license does not grant rights to sports trademarks, broadcasts or third-party artwork.
