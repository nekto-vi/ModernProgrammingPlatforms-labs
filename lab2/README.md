# Task List

## Run locally

Use Node.js 22 for local checks (the application runtime itself supports Node.js 18 or newer). Copy `.env.example` to `.env`, set `ADMIN_EMAIL`, and configure SMTP. Then run:

```sh
npm ci
npm test
npm run lint
npm start
```

The initial administrator is created from `ADMIN_EMAIL` at startup. Administrators invite accounts and choose one of three roles: `admin`, `editor`, or `reader`. The app sends a one-time sign-in link that expires after 10 minutes. A successful login creates a server-side session that expires after 7 days.

SMTP is required for sign-in and invitations. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`; set `AUTH_BASE_URL` to the public application URL. Access-link requests return the same response for known and unknown email addresses. Login requests are limited to 5 per 15 minutes by IP and email, verification attempts to 10 per 15 minutes by IP, and invitations to 10 per 15 minutes by IP and email.

For Docker, configure `.env` and run `docker compose up --build`. Production cookies are marked `Secure`; serve the app over HTTPS. Do not commit `.env` or SMTP credentials.

## Automated checks

`npm test` runs API and security tests with a temporary SQLite database and mocked email delivery. `npm run lint` runs ESLint. GitHub Actions runs both checks on pushes and pull requests.