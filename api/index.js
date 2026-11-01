// Vercel entry point. Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, since
// Vercel has no disk that survives between requests.
process.env.TZ = 'Asia/Kolkata';

const { openDb, dbOptionsFromEnv } = require('../src/db');
const { createApp, appOptionsFromEnv } = require('../src/app');

const options = dbOptionsFromEnv();
if (!options.url) {
  throw new Error('TURSO_DATABASE_URL is not set. Add it in the Vercel project settings.');
}

const dbReady = openDb(options);
// Surface connection errors on the first request rather than crashing at load.
dbReady.catch((err) => console.error('Database connection failed:', err));

module.exports = createApp(dbReady, appOptionsFromEnv());
