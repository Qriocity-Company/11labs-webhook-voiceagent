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
    
    // WebSocket proxy - this is the main fix
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      
      const model = url.searchParams.get("model") || env.ELEVENLABS_MODEL || "eleven_flash_v2";
      const agentId = url.searchParams.get("agent_id") || env.ELEVENLABS_AGENT_ID;
      const project = url.searchParams.get("project") || "default";
      
      // Validation
      if (!env.ELEVENLABS_API_KEY) {
        console.error("Missing ELEVENLABS_API_KEY");
        return new Response("Missing API key", { status: 500 });
      }
      
      if (!agentId) {
        console.error("Missing ELEVENLABS_AGENT_ID");
        return new Response("Missing agent ID", { status: 500 });
      }
      
      console.log("Starting WebSocket proxy:", {
        agentId: agentId.substring(0, 12) + "...",
        project,
        model
      });
      
      // Accept client socket first
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      
      // Get signed URL for ElevenLabs ConvAI
      let signedUrl;
      const base = env.ELEVENLABS_BASE || 'api.elevenlabs.io';
      
      try {
        console.log("Getting signed URL for ConvAI...");
        const signedUrlResponse = await fetch(
          `https://${base}/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
          {
            method: "GET",
            headers: {
              "xi-api-key": env.ELEVENLABS_API_KEY,
              "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(5000)
          }
        );
        
        if (signedUrlResponse.ok) {
          const signedUrlData = await signedUrlResponse.json();
          signedUrl = signedUrlData.signed_url;
          console.log("✅ Got signed URL successfully");
        } else {
          const errorText = await signedUrlResponse.text();
          console.log("⚠️ Signed URL failed, trying public agent approach:", signedUrlResponse.status, errorText);
          // Fallback to public agent endpoint
          signedUrl = `wss://${base}/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        }
      } catch (e) {
        console.error("Error getting signed URL:", e.message);
        // Fallback to public agent endpoint
        signedUrl = `wss://${base}/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        console.log("Using public agent fallback");
      }
      
      // Connect to ElevenLabs ConvAI WebSocket
      console.log("Connecting to ElevenLabs:", signedUrl.split('?')[0]);
      
      let upstreamResp;
      try {
        const headers = {
          "Upgrade": "websocket",
          "Connection": "Upgrade", 
          "Sec-WebSocket-Version": "13"
        };
        
        // Add API key for public agent connections
        if (signedUrl.includes("conversation?agent_id=") && !signedUrl.includes("token=")) {
          headers["xi-api-key"] = env.ELEVENLABS_API_KEY;
        }
        
        // Copy client WebSocket headers
        const clientWsKey = request.headers.get("sec-websocket-key");
        const clientWsExt = request.headers.get("sec-websocket-extensions");
        
        if (clientWsKey) headers["Sec-WebSocket-Key"] = clientWsKey;
        if (clientWsExt) headers["Sec-WebSocket-Extensions"] = clientWsExt;
        
        upstreamResp = await fetch(signedUrl, {
          headers,
          signal: AbortSignal.timeout(8000)
        });
        
        console.log("Upstream response:", upstreamResp.status, upstreamResp.statusText);
        
        if (upstreamResp.status !== 101) {
          let errorBody = "";
          try { 
            errorBody = await upstreamResp.text(); 
          } catch {}
          
          console.error(`WebSocket upgrade failed: ${upstreamResp.status} ${errorBody}`);
          
          const errorMessage = upstreamResp.status === 403 
            ? "Authentication failed - check API key and agent permissions"
            : upstreamResp.status === 404
            ? "Agent not found - verify agent ID"
            : `Connection failed: ${upstreamResp.status} ${errorBody}`;
          
          server.send(JSON.stringify({ 
            type: "error", 
            text: errorMessage,
            status: upstreamResp.status
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
        console.error("No WebSocket in response");
        server.send(JSON.stringify({
          type: "error",
          text: "Invalid WebSocket upgrade response"
        }));
        server.close(1011, "Invalid WebSocket upgrade");
        return new Response("Invalid WebSocket upgrade", { status: 502 });
      }
      
      upstream.accept();
      console.log("✅ WebSocket connection established");
      
      // Send connection success message
      server.send(JSON.stringify({
        type: "info",
        text: "Connected to ElevenLabs ConvAI",
        project,
        agent_id: agentId
      }));
      
      // Message forwarding: ElevenLabs → Client
      upstream.addEventListener("message", (evt) => {
        try {
          const data = evt.data;
          
          // Handle different data types
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              
              // Extract audio data from various possible locations
              const audioB64 = parsed?.audio_base_64 || 
                             parsed?.audio_event?.audio_base_64 || 
                             parsed?.data?.audio_base_64;
              
              if (audioB64) {
                const mime = parsed?.mime || 
                           parsed?.audio_event?.mime || 
                           parsed?.data?.mime || 
                           'audio/mpeg';
                
                console.log("Forwarding audio to client:", audioB64.length, "bytes");
                
                // Normalize audio format for client
                server.send(JSON.stringify({
                  type: 'audio',
                  audio_base_64: audioB64,
                  mime
                }));
                return;
              }
              
              // Log non-audio messages (excluding noisy metadata)
              if (!parsed.conversation_initiation_metadata && 
                  !parsed.conversation_initiation_metadata_event &&
                  parsed.type && !['ping', 'pong'].includes(parsed.type)) {
                console.log("Forwarding message type:", parsed.type);
              }
            } catch (parseError) {
              console.log("Non-JSON message from upstream");
            }
          }
          
          // Forward message as-is
          server.send(data);
          
        } catch (e) {
          console.error("Error forwarding upstream message:", e.message);
        }
      });
      
      // Message forwarding: Client → ElevenLabs
      server.addEventListener("message", (evt) => {
        try {
          const data = evt.data;
          
          if (upstream.readyState === WebSocket.READY_STATE_OPEN) {
            if (typeof data === 'string') {
              try {
                const message = JSON.parse(data);
                
                // Handle different message types from client
                if (message.user_audio_chunk) {
                  // Voice message - convert to ElevenLabs format
                  const elevenLabsMessage = {
                    user_audio_chunk: message.user_audio_chunk.audio_base_64 || message.user_audio_chunk
                  };
                  console.log("Forwarding audio chunk to ElevenLabs");
                  upstream.send(JSON.stringify(elevenLabsMessage));
                  
                } else if (message.type === 'user_message' && message.text) {
                  // Text message
                  const elevenLabsMessage = {
                    type: 'user_message',
                    text: message.text
                  };
                  console.log("Forwarding text message to ElevenLabs");
                  upstream.send(JSON.stringify(elevenLabsMessage));
                  
                } else {
                  // Other message types - forward as-is
                  console.log("Forwarding message type:", message.type || 'unknown');
                  upstream.send(data);
                }
              } catch (parseError) {
                // Non-JSON data - forward as-is
                upstream.send(data);
              }
            } else {
              // Binary data - forward as-is
              upstream.send(data);
            }
          } else {
            console.log("Attempted to send to closed upstream connection");
            server.send(JSON.stringify({
              type: 'error',
              text: 'Connection to ElevenLabs lost'
            }));
          }
        } catch (e) {
          console.error("Error forwarding client message:", e.message);
        }
      });
      
      // Connection cleanup handlers
      const safeClose = (ws, reason = "") => { 
        try { 
          if (ws.readyState === WebSocket.READY_STATE_OPEN) {
            ws.close();
          }
          if (reason) console.log("Closed WebSocket:", reason);
        } catch {} 
      };
      
      server.addEventListener("close", (evt) => {
        console.log("Client disconnected:", evt.code, evt.reason);
        safeClose(upstream, "client closed");
      });
      
      server.addEventListener("error", (evt) => {
        console.error("Client WebSocket error:", evt);
        safeClose(upstream, "client error");
      });
      
      upstream.addEventListener("close", (evt) => {
        console.log("ElevenLabs connection closed:", evt.code, evt.reason);
        safeClose(server, "upstream closed");
      });
      
      upstream.addEventListener("error", (evt) => {
        console.error("ElevenLabs WebSocket error:", evt);
        safeClose(server, "upstream error");
      });
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    return new Response("Not found", { status: 404 });
  }
}
