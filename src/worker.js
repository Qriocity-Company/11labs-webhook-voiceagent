export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- CORS / preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const model = url.searchParams.get("model") || env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agentId = url.searchParams.get("agent_id") || env.ELEVENLABS_AGENT_ID;

      if (!env.ELEVENLABS_API_KEY || !agentId) {
        return new Response("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID", { status: 500 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      try {
        // Open upstream WS to ElevenLabs with header auth (NOT query param)
        const upstreamResp = await fetch(
          `https://api.elevenlabs.io/v1/convai/ws?model=${encodeURIComponent(model)}&agent_id=${encodeURIComponent(agentId)}`,
          {
            headers: {
              "Upgrade": "websocket",
              "Connection": "Upgrade",
              "xi-api-key": env.ELEVENLABS_API_KEY,
            },
          }
        );

        const upstream = upstreamResp.webSocket;
        if (!upstream) {
          server.close(1011, "Upstream refused WebSocket");
          return new Response("Upstream refused WebSocket", { status: 502 });
        }
        upstream.accept();

        // Bi-directional piping
        server.addEventListener("message", (evt) => {
          try { upstream.send(evt.data); } catch {}
        });
        upstream.addEventListener("message", (evt) => {
          try { server.send(evt.data); } catch {}
        });

        // Close/error symmetry
        server.addEventListener("close", () => { try { upstream.close(); } catch {} });
        upstream.addEventListener("close", () => { try { server.close(); } catch {} });
        server.addEventListener("error", () => { try { upstream.close(); } catch {} });
        upstream.addEventListener("error", () => { try { server.close(); } catch {} });

        // Keep-alive ping (some networks drop idle WS ~30–60s)
        const keepAlive = async () => {
          try { server.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch {}
        };
        const interval = setInterval(keepAlive, 25000);
        ctx.waitUntil((async () => {
          await new Promise((r) => server.addEventListener("close", r, { once: true }));
          clearInterval(interval);
        })());

        return new Response(null, { status: 101, webSocket: client });
      } catch (e) {
        try { server.close(1011, "Proxy error"); } catch {}
        return new Response("Proxy error: " + e.message, { status: 502 });
      }
    }

    // Small helper for your frontend to grab WS URL + query
    if (url.pathname.startsWith("/realtime/")) {
      const project = decodeURIComponent(url.pathname.split("/").pop() || "");
      const model = env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agent_id = env.ELEVENLABS_AGENT_ID || "";
      const ws = `${url.protocol === "http:" ? "ws" : "wss"}://${url.host}/ws`;
      return new Response(JSON.stringify({ ws, query: { model, agent_id, project } }), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    }

    return new Response("Not found", {
      status: 404,
      headers: { "access-control-allow-origin": "*" },
    });
  }
}
