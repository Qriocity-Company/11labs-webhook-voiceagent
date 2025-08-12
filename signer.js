// signer.js
import fetch from 'node-fetch';

export async function getSignedWsUrl({ agentId, base = 'api.elevenlabs.io', apiKey }) {
  const url = `https://${base}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const r = await fetch(url, { headers: { 'xi-api-key': apiKey } });
  const text = await r.text();
  if (!r.ok) throw new Error(`signed-url ${r.status}: ${text}`);
  const j = JSON.parse(text);
  if (!j?.signed_url) throw new Error(`no signed_url in response: ${text}`);
  return j.signed_url; // e.g. wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...&conversation_signature=...
}
