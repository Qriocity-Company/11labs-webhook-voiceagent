export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    }

    // Frontend helper → returns proxy ws URL + query the FE should use
    if (url.pathname.startsWith("/realtime/")) {
      const project = decodeURIComponent(url.pathname.split("/").pop() || "");
      const model = env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agent_id = env.ELEVENLABS_AGENT_ID || "";
      const ws = `${url.protocol === "http:" ? "ws" : "wss"}://${url.host}/ws`;
      return new Response(
        JSON.stringify({ ws, query: { model, agent_id, project } }),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
      );
    }

    // WebSocket proxy
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const model   = url.searchParams.get("model")    || env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agentId = url.searchParams.get("agent_id") || env.ELEVENLABS_AGENT_ID;

      if (!env.ELEVENLABS_API_KEY || !agentId) {
        return new Response("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID", { status: 500 });
      }

      // Accept client socket first
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      // Connect to ElevenLabs WS
      const upstreamUrl =
        `https://api.elevenlabs.io/v1/convai/ws?model=${encodeURIComponent(model)}&agent_id=${encodeURIComponent(agentId)}`;

      let upstreamResp;
      try {
        upstreamResp = await fetch(upstreamUrl, {
          // critical headers for Workers WS client
          headers: {
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "xi-api-key": env.ELEVENLABS_API_KEY,
            // If ElevenLabs requires a subprotocol, uncomment next line:
            // "Sec-WebSocket-Protocol": "convai"
          },
          // Don’t let this hang forever
          signal: AbortSignal.timeout(3000),

        });
          console.log("Upstream response status:", upstreamResp.status);
          console.log("Upstream response headers:", [...upstreamResp.headers.entries()]);
      } catch (e) {
        server.send(JSON.stringify({ type: "error", text: "Upstream fetch failed: " + e.message }));
        server.close(1011, "Upstream fetch failed");
        return new Response("Upstream fetch failed", { status: 502 });
      }

      const upstream = upstreamResp.webSocket;
      if (!upstream) {
        // Log status/body for debugging
        let body = "";
        try { body = await upstreamResp.text(); } catch {}
        server.send(JSON.stringify({
          type: "error",
          text: `Upstream refused WS: ${upstreamResp.status} ${upstreamResp.statusText} :: ${body?.slice(0, 300)}`
        }));
        server.close(1011, "Upstream refused WebSocket");
        return new Response("Upstream refused WebSocket", { status: 502 });
      }

      upstream.accept();

      // pipe upstream → client
      upstream.addEventListener("message", (evt) => {
        try { server.send(evt.data); } catch {}
      });
      // pipe client → upstream
      server.addEventListener("message", (evt) => {
        try { upstream.send(evt.data); } catch {}
      });

      const safeClose = (ws) => { try { ws.close(); } catch {} };

      server.addEventListener("close", () => safeClose(upstream));
      server.addEventListener("error", () => safeClose(upstream));
      upstream.addEventListener("close", () => safeClose(server));
      upstream.addEventListener("error", () => safeClose(server));

      // IMPORTANT: return the 101 upgrade
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }
}
