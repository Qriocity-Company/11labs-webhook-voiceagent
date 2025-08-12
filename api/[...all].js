// api/[...all].js
import app from '../../server.js';

export default function handler(req, res) {
  // CORS for all responses (incl. preflight)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, xi-api-key, elevenlabs-signature, x-elevenlabs-signature, x-webhook-signature'
  );
  if (req.method === 'OPTIONS') return res.status(200).end();

  // strip /api so /api/projects -> /projects (your Express routes)
  req.url = req.url.replace(/^\/api(\/|$)/, '/');

  return app(req, res); // hand off to Express
}
