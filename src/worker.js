export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // Must be a WS upgrade from browser
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const model = url.searchParams.get("model") || env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agentId = url.searchParams.get("agent_id") || env.ELEVENLABS_AGENT_ID;

      if (!env.ELEVENLABS_API_KEY || !agentId) {
        return new Response("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID", { status: 500 });
      }

      // Accept client socket
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      try {
        // Open upstream WS to ElevenLabs with header auth
        const upstreamResp = await fetch(
          `https://api.elevenlabs.io/v1/convai/ws?model=${encodeURIComponent(model)}&agent_id=${encodeURIComponent(agentId)}`,
          { headers: { Upgrade: "websocket", "xi-api-key": env.ELEVENLABS_API_KEY } }
        );

        const upstream = upstreamResp.webSocket;
        if (!upstream) {
          server.close(1011, "Upstream refused WebSocket");
          return new Response("Upstream refused WebSocket", { status: 502 });
        }
        upstream.accept();

        // pipe: browser -> elevenlabs
        server.addEventListener("message", (evt) => {
          try { upstream.send(evt.data); } catch {}
        });
        // pipe: elevenlabs -> browser
        upstream.addEventListener("message", (evt) => {
          try { server.send(evt.data); } catch {}
        });

        server.addEventListener("close", () => { try { upstream.close(); } catch {} });
        upstream.addEventListener("close", () => { try { server.close(); } catch {} });
        server.addEventListener("error", () => { try { upstream.close(); } catch {} });
        upstream.addEventListener("error", () => { try { server.close(); } catch {} });

        return new Response(null, { status: 101, webSocket: client });
      } catch (e) {
        server.close(1011, "Proxy error");
        return new Response("Proxy error: " + e.message, { status: 502 });
      }
    }

    // (Optional) simple config endpoint for your frontend
    if (url.pathname.startsWith("/realtime/")) {
      const project = decodeURIComponent(url.pathname.split("/").pop() || "");
      const model = env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agent_id = env.ELEVENLABS_AGENT_ID || "";
      const ws = `${url.protocol === "http:" ? "ws" : "wss"}://${url.host}/ws`;
      return new Response(JSON.stringify({ ws, query: { model, agent_id, project } }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    }

    return new Response("Not found", { status: 404 });
  }
}
