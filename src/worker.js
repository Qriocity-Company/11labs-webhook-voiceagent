export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Health check
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
      
      const model = url.searchParams.get("model") || env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agentId = url.searchParams.get("agent_id") || env.ELEVENLABS_AGENT_ID;
      
      // Validation
      if (!env.ELEVENLABS_API_KEY) {
        console.error("Missing ELEVENLABS_API_KEY");
        return new Response("Missing API key", { status: 500 });
      }
      
      if (!agentId) {
        console.error("Missing ELEVENLABS_AGENT_ID");
        return new Response("Missing agent ID", { status: 500 });
      }
      
      console.log("Starting connection process:");
      console.log("- Agent ID:", agentId);
      console.log("- API Key prefix:", env.ELEVENLABS_API_KEY.substring(0, 8) + "...");
      
      // Accept client socket first
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      
      // Step 1: Get signed URL for private agent
      let signedUrl;
      try {
        console.log("Getting signed URL...");
        const signedUrlResponse = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
          {
            method: "GET",
            headers: {
              "xi-api-key": env.ELEVENLABS_API_KEY,
              "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(5000)
          }
        );
        
        if (!signedUrlResponse.ok) {
          const errorText = await signedUrlResponse.text();
          console.error("Failed to get signed URL:", signedUrlResponse.status, errorText);
          
          // If signed URL fails, try public agent approach
          console.log("Trying as public agent...");
          signedUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        } else {
          const signedUrlData = await signedUrlResponse.json();
          signedUrl = signedUrlData.signed_url;
          console.log("Got signed URL successfully");
        }
      } catch (e) {
        console.error("Error getting signed URL:", e.message);
        // Fallback to public agent
        signedUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        console.log("Using public agent fallback");
      }
      
      // Step 2: Connect to ElevenLabs WebSocket using correct endpoint
      console.log("Connecting to:", signedUrl);
      
      let upstreamResp;
      try {
        upstreamResp = await fetch(signedUrl, {
          headers: {
            // Essential WebSocket headers
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Version": "13",
            
            // Copy client's WebSocket key and extensions
            ...(request.headers.get("sec-websocket-key") && {
              "Sec-WebSocket-Key": request.headers.get("sec-websocket-key")
            }),
            ...(request.headers.get("sec-websocket-extensions") && {
              "Sec-WebSocket-Extensions": request.headers.get("sec-websocket-extensions")
            }),
            
            // If using public agent approach, include API key
            ...(signedUrl.includes("conversation?agent_id=") && !signedUrl.includes("token=") && {
              "xi-api-key": env.ELEVENLABS_API_KEY
            })
          },
          signal: AbortSignal.timeout(8000)
        });
        
        console.log("Upstream response status:", upstreamResp.status);
        console.log("Upstream response headers:", Object.fromEntries(upstreamResp.headers));
        
        if (upstreamResp.status !== 101) {
          let errorBody = "";
          try { 
            errorBody = await upstreamResp.text(); 
          } catch {}
          
          console.error(`WebSocket upgrade failed with ${upstreamResp.status}:`, errorBody);
          
          const errorMessage = upstreamResp.status === 403 
            ? "Authentication failed - check API key and agent permissions"
            : upstreamResp.status === 404
            ? "Agent not found - check agent ID"
            : `Connection failed ${upstreamResp.status}: ${errorBody}`;
          
          server.send(JSON.stringify({ 
            type: "error", 
            text: errorMessage,
            status: upstreamResp.status,
            details: errorBody
          }));
          server.close(1008, "Connection failed");
          return new Response(errorMessage, { status: upstreamResp.status });
        }
        
      } catch (e) {
        console.error("WebSocket connection error:", e.message);
        server.send(JSON.stringify({ 
          type: "error", 
          text: `Connection timeout: ${e.message}` 
        }));
        server.close(1011, "Connection timeout");
        return new Response("Connection timeout", { status: 504 });
      }
      
      const upstream = upstreamResp.webSocket;
      if (!upstream) {
        console.error("No WebSocket in response despite 101 status");
        server.send(JSON.stringify({
          type: "error",
          text: "Invalid WebSocket upgrade response"
        }));
        server.close(1011, "Invalid WebSocket upgrade");
        return new Response("Invalid WebSocket upgrade", { status: 502 });
      }
      
      upstream.accept();
      console.log("WebSocket connection established successfully");
      
      // Forward messages: upstream → client
      upstream.addEventListener("message", (evt) => {
        try { 
          console.log("Forwarding message from upstream to client");
          server.send(evt.data); 
        } catch (e) {
          console.error("Error forwarding upstream message:", e);
        }
      });
      
      // Forward messages: client → upstream
      server.addEventListener("message", (evt) => {
        try { 
          console.log("Forwarding message from client to upstream");
          upstream.send(evt.data); 
        } catch (e) {
          console.error("Error forwarding client message:", e);
        }
      });
      
      // Handle connection cleanup
      const safeClose = (ws, reason = "") => { 
        try { 
          ws.close();
          console.log("Closed WebSocket:", reason);
        } catch {} 
      };
      
      server.addEventListener("close", (evt) => {
        console.log("Client WebSocket closed:", evt.code, evt.reason);
        safeClose(upstream, "client closed");
      });
      
      server.addEventListener("error", (evt) => {
        console.error("Client WebSocket error:", evt);
        safeClose(upstream, "client error");
      });
      
      upstream.addEventListener("close", (evt) => {
        console.log("Upstream WebSocket closed:", evt.code, evt.reason);
        safeClose(server, "upstream closed");
      });
      
      upstream.addEventListener("error", (evt) => {
        console.error("Upstream WebSocket error:", evt);
        safeClose(server, "upstream error");
      });
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    return new Response("Not found", { status: 404 });
  }
}
