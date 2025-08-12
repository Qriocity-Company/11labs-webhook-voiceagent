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
    
    // WebSocket proxy - FIXED approach for Cloudflare Workers
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
      
      // *** CRITICAL FIX: Use direct WebSocket connection, not fetch() ***
      const base = env.ELEVENLABS_BASE || 'api.elevenlabs.io';
      
      // Step 1: Get signed URL using regular HTTP fetch
      let signedUrl;
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
          console.log("⚠️ Signed URL failed:", signedUrlResponse.status, errorText);
          // Fallback to public agent endpoint
          signedUrl = `wss://${base}/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        }
      } catch (e) {
        console.error("Error getting signed URL:", e.message);
        // Fallback to public agent endpoint
        signedUrl = `wss://${base}/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        console.log("Using public agent fallback");
      }
      
      // Step 2: Connect directly to ElevenLabs using WebSocket constructor
      console.log("Connecting to ElevenLabs:", signedUrl.split('?')[0]);
      
      try {
        // *** KEY FIX: Use direct fetch to WSS endpoint to get WebSocket ***
        const wsHeaders = {
          "Upgrade": "websocket",
          "Connection": "Upgrade", 
          "Sec-WebSocket-Version": "13"
        };
        
        // Add API key for public agent connections (those without token)
        if (signedUrl.includes("conversation?agent_id=") && !signedUrl.includes("token=") && !signedUrl.includes("conversation_signature=")) {
          wsHeaders["xi-api-key"] = env.ELEVENLABS_API_KEY;
        }
        
        // Copy essential client WebSocket headers
        const clientWsKey = request.headers.get("sec-websocket-key");
        if (clientWsKey) {
          wsHeaders["Sec-WebSocket-Key"] = clientWsKey;
        }
        
        const clientWsExt = request.headers.get("sec-websocket-extensions");
        if (clientWsExt) {
          wsHeaders["Sec-WebSocket-Extensions"] = clientWsExt;
        }
        
        // This is the correct way to establish WebSocket connection in Workers
        const upstreamResp = await fetch(signedUrl, {
          headers: wsHeaders
        });
        
        console.log("WebSocket upgrade response:", upstreamResp.status, upstreamResp.statusText);
        
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
            status: upstreamResp.status,
            details: errorBody
          }));
          server.close(1008, "Connection failed");
          return new Response(errorMessage, { status: upstreamResp.status });
        }
        
        // Get the WebSocket from the response
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
        
        // Accept the upstream WebSocket
        upstream.accept();
        console.log("✅ WebSocket connection established");
        
        // Send connection success message
        server.send(JSON.stringify({
          type: "info",
          text: "Connected to ElevenLabs ConvAI",
          project,
          agent_id: agentId.substring(0, 12) + "..."
        }));
        
        // Message forwarding: ElevenLabs → Client
        upstream.addEventListener("message", (evt) => {
          try {
            const data = evt.data;
            
            // Handle string messages (JSON)
            if (typeof data === 'string') {
              try {
                const parsed = JSON.parse(data);
                
                // Extract and normalize audio data
                const audioB64 = parsed?.audio_base_64 || 
                               parsed?.audio_event?.audio_base_64 || 
                               parsed?.data?.audio_base_64;
                
                if (audioB64) {
                  const mime = parsed?.mime || 
                             parsed?.audio_event?.mime || 
                             parsed?.data?.mime || 
                             'audio/mpeg';
                  
                  console.log("📡 Forwarding audio to client:", audioB64.length, "bytes");
                  
                  // Send normalized audio format
                  server.send(JSON.stringify({
                    type: 'audio',
                    audio_base_64: audioB64,
                    mime
                  }));
                  return;
                }
                
                // Log interesting message types (skip metadata noise)
                if (!parsed.conversation_initiation_metadata && 
                    !parsed.conversation_initiation_metadata_event &&
                    parsed.type && !['ping', 'pong'].includes(parsed.type)) {
                  console.log("📨 Message type:", parsed.type);
                }
              } catch (parseError) {
                console.log("📨 Non-JSON message from upstream");
              }
            }
            
            // Forward all messages as-is to client
            server.send(data);
            
          } catch (e) {
            console.error("❌ Error forwarding upstream message:", e.message);
          }
        });
        
        // Message forwarding: Client → ElevenLabs
        server.addEventListener("message", (evt) => {
          try {
            const data = evt.data;
            
            if (upstream.readyState === 1) { // WebSocket.OPEN
              if (typeof data === 'string') {
                try {
                  const message = JSON.parse(data);
                  
                  // Convert client messages to ElevenLabs ConvAI format
                  if (message.user_audio_chunk) {
                    // Audio from client
                    const audioData = message.user_audio_chunk.audio_base_64 || message.user_audio_chunk;
                    const elevenLabsMessage = { user_audio_chunk: audioData };
                    console.log("🎤 Forwarding audio to ElevenLabs");
                    upstream.send(JSON.stringify(elevenLabsMessage));
                    
                  } else if (message.type === 'user_message' && message.text) {
                    // Text from client
                    const elevenLabsMessage = {
                      type: 'user_message',
                      text: message.text
                    };
                    console.log("💬 Forwarding text to ElevenLabs:", message.text.substring(0, 50) + "...");
                    upstream.send(JSON.stringify(elevenLabsMessage));
                    
                  } else {
                    // Other messages - forward as-is
                    console.log("📤 Forwarding message:", message.type || 'unknown');
                    upstream.send(data);
                  }
                } catch (parseError) {
                  // Non-JSON - forward as-is
                  upstream.send(data);
                }
              } else {
                // Binary data - forward as-is
                upstream.send(data);
              }
            } else {
              console.log("⚠️ Attempted to send to closed upstream");
              server.send(JSON.stringify({
                type: 'error',
                text: 'Connection to ElevenLabs lost'
              }));
            }
          } catch (e) {
            console.error("❌ Error forwarding client message:", e.message);
          }
        });
        
        // Connection cleanup handlers
        const safeClose = (ws, reason = "") => { 
          try { 
            if (ws.readyState === 1) { // OPEN
              ws.close();
            }
            if (reason) console.log("🔌 Closed:", reason);
          } catch {} 
        };
        
        server.addEventListener("close", (evt) => {
          console.log("🔌 Client disconnected:", evt.code, evt.reason);
          safeClose(upstream, "client closed");
        });
        
        server.addEventListener("error", (evt) => {
          console.error("❌ Client error:", evt);
          safeClose(upstream, "client error");
        });
        
        upstream.addEventListener("close", (evt) => {
          console.log("🔌 ElevenLabs closed:", evt.code, evt.reason);
          safeClose(server, "upstream closed");
        });
        
        upstream.addEventListener("error", (evt) => {
          console.error("❌ ElevenLabs error:", evt);
          safeClose(server, "upstream error");
        });
        
      } catch (connectionError) {
        console.error("❌ WebSocket connection failed:", connectionError.message);
        server.send(JSON.stringify({ 
          type: "error", 
          text: `Connection failed: ${connectionError.message}` 
        }));
        server.close(1011, "Connection failed");
        return new Response("Connection failed", { status: 502 });
      }
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    return new Response("Not found", { status: 404 });
  }
}
