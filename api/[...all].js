// api/[...all].js  (this file lives in /api)
import app from '../server.js';

export default function handler(req, res) {
  // Strip the external /api prefix Vercel uses
  // /api/projects -> /projects, /api -> /
  req.url = req.url.replace(/^\/api(\/|$)/, '/');

  // Optional: drop the helper `all=` param Vercel adds for catch-all
  try {
    const u = new URL(req.url, 'http://internal');
    u.searchParams.delete('all');
    req.url = u.pathname + (u.search || '');
  } catch {}

  // Basic CORS for OPTIONS at the edge (your app also sets CORS)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, xi-api-key, elevenlabs-signature, x-elevenlabs-signature, x-webhook-signature'
    );
    res.status(200).end();
    return;
  }

  return app(req, res);
}
