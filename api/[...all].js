// api/[...all].js
import app from '../server.js';

export default function handler(req, res) {
  // Build the path from the catch-all segments
  const segs = req.query?.all;
  const pathFromAll = segs
    ? '/' + (Array.isArray(segs) ? segs.join('/') : segs)
    : '/';

  // Keep original query string but strip the helper "all=" param if present
  const rawQs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const qs = rawQs
    .replace(/(^\?|\&)all=[^&]*/g, '$1')
    .replace(/\?&/, '?')
    .replace(/\?$/, '');

  // Your Express app expects /api/* paths — rebuild that URL precisely
  req.url = '/api' + pathFromAll + (qs || '');

  // Cheap global CORS preflight (optional; your app already does CORS)
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
