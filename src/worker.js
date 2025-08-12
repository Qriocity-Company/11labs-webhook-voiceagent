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
    
    // WebSocket proxy with keepalive and connection management
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
      
      console.log("🚀 Starting WebSocket proxy with keepalive:", {
        agentId: agentId.substring(0, 12) + "...",
        project,
        model,
        timestamp: new Date().toISOString()
      });
      
      // Accept client socket first
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      
      // Connection management variables
      let pingInterval;
      let healthCheckInterval;
      let lastActivity = Date.now();
      let connectionStartTime = Date.now();
      let isConnected = false;
      
      const base = env.ELEVENLABS_BASE || 'api.elevenlabs.io';
      
      // Cleanup function
      const cleanup = () => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (healthCheckInterval) {
          clearInterval(healthCheckInterval);
          healthCheckInterval = null;
        }
        console.log("🧹 Cleaned up intervals");
      };
      
      // Step 1: Get signed URL using regular HTTP fetch
      let signedUrl;
      try {
        console.log("🔐 Getting signed URL for ConvAI...");
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
        console.error("❌ Error getting signed URL:", e.message);
        // Fallback to public agent endpoint
        signedUrl = `wss://${base}/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
        console.log("🔄 Using public agent fallback");
      }
      
      // Step 2: Connect to ElevenLabs
      console.log("🔗 Connecting to ElevenLabs:", signedUrl.split('?')[0]);
      
      try {
        const wsHeaders = {
          "Upgrade": "websocket",
          "Connection": "Upgrade", 
          "Sec-WebSocket-Version": "13"
        };
        
        // Add API key for public agent connections
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
        
        // Convert WSS URL to HTTPS for fetch
        const httpsUrl = signedUrl.replace('wss://', 'https://');
        console.log("🔄 Converting WSS to HTTPS:", httpsUrl.split('?')[0]);
        
        const upstreamResp = await fetch(httpsUrl, {
          headers: wsHeaders
        });
        
        console.log("📡 WebSocket upgrade response:", upstreamResp.status, upstreamResp.statusText);
        
        if (upstreamResp.status !== 101) {
          let errorBody = "";
          try { 
            errorBody = await upstreamResp.text(); 
          } catch {}
          
          console.error(`❌ WebSocket upgrade failed: ${upstreamResp.status} ${errorBody}`);
          
          const errorMessage = upstreamResp.status === 403 
            ? "Authentication failed - check API key and agent permissions"
            : upstreamResp.status === 404
            ? "Agent not found - verify agent ID"
            : `Connection failed: ${upstreamResp.status} ${errorBody}`;
          
          cleanup();
          server.send(JSON.stringify({ 
            type: "error", 
            text: errorMessage,
            status: upstreamResp.status,
            details: errorBody
          }));
          server.close(1008, "Connection failed");
          return new Response(errorMessage, { status: upstreamResp.status });
        }
        
        const upstream = upstreamResp.webSocket;
        if (!upstream) {
          console.error("❌ No WebSocket in response");
          cleanup();
          server.send(JSON.stringify({
            type: "error",
            text: "Invalid WebSocket upgrade response"
          }));
          server.close(1011, "Invalid WebSocket upgrade");
          return new Response("Invalid WebSocket upgrade", { status: 502 });
        }
        
        upstream.accept();
        isConnected = true;
        lastActivity = Date.now();
        connectionStartTime = Date.now();
        
        console.log("✅ WebSocket connection established successfully");
        
        // Send connection success message
        server.send(JSON.stringify({
          type: "info",
          text: "Connected to ElevenLabs ConvAI",
          project,
          agent_id: agentId.substring(0, 12) + "...",
          timestamp: new Date().toISOString()
        }));
        
        // *** KEEPALIVE SYSTEM ***
        
        // Send ping every 25 seconds to keep connection alive
        pingInterval = setInterval(() => {
          if (upstream.readyState === 1) { // OPEN
            try {
              console.log("🏓 Sending keepalive ping to ElevenLabs");
              upstream.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
              lastActivity = Date.now();
            } catch (e) {
              console.error("⚠️ Ping failed:", e.message);
              cleanup();
            }
          } else {
            console.log("🔌 Upstream not open, stopping ping");
            cleanup();
          }
        }, 25000); // 25 seconds
        
        // Health check every 45 seconds
        healthCheckInterval = setInterval(() => {
          const timeSinceLastActivity = Date.now() - lastActivity;
          const connectionDuration = Date.now() - connectionStartTime;
          
          console.log("🔍 Health check:", {
            timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000) + "s",
            connectionDuration: Math.round(connectionDuration / 1000) + "s",
            upstreamState: upstream.readyState === 1 ? "OPEN" : "CLOSED",
            serverState: server.readyState === 1 ? "OPEN" : "CLOSED"
          });
          
          // If no activity for 90 seconds, close connection
          if (timeSinceLastActivity > 90000) {
            console.log("💀 Connection appears inactive, closing");
            cleanup();
            server.send(JSON.stringify({
              type: "error",
              text: "Connection timeout due to inactivity"
            }));
            server.close(1000, "Inactivity timeout");
            return;
          }
          
          // Send connection stats every 2 minutes
          if (connectionDuration > 0 && connectionDuration % 120000 < 45000) {
            server.send(JSON.stringify({
              type: "info",
              text: `Connection active for ${Math.round(connectionDuration / 60000)} minutes`,
              stats: {
                duration: connectionDuration,
                lastActivity: timeSinceLastActivity
              }
            }));
          }
        }, 45000); // 45 seconds
        
        // *** MESSAGE FORWARDING ***
        
        // ElevenLabs → Client
        upstream.addEventListener("message", (evt) => {
          try {
            lastActivity = Date.now(); // Update activity timestamp
            const data = evt.data;
            
            if (typeof data === 'string') {
              try {
                const parsed = JSON.parse(data);
                
                // Handle pong responses
                if (parsed.type === 'pong') {
                  console.log("🏓 Received pong from ElevenLabs");
                  return;
                }
                
                // Extract and normalize audio data
                const audioB64 = parsed?.audio_base_64 || 
                               parsed?.audio_event?.audio_base_64 || 
                               parsed?.data?.audio_base_64;
                
                if (audioB64) {
                  const mime = parsed?.mime || 
                             parsed?.audio_event?.mime || 
                             parsed?.data?.mime || 
                             'audio/mpeg';
                  
                  console.log("🔊 Forwarding audio to client:", audioB64.length, "bytes");
                  
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
        
        // Client → ElevenLabs
        server.addEventListener("message", (evt) => {
          try {
            lastActivity = Date.now(); // Update activity timestamp
            const data = evt.data;
            
            if (upstream.readyState === 1) { // OPEN
              if (typeof data === 'string') {
                try {
                  const message = JSON.parse(data);
                  
                  // Handle client ping
                  if (message.type === 'ping') {
                    console.log("🏓 Received ping from client, sending pong");
                    server.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
                    return;
                  }
                  
                  // Convert client messages to ElevenLabs ConvAI format
                  if (message.user_audio_chunk) {
                    const audioData = message.user_audio_chunk.audio_base_64 || message.user_audio_chunk;
                    const elevenLabsMessage = { user_audio_chunk: audioData };
                    console.log("🎤 Forwarding audio to ElevenLabs");
                    upstream.send(JSON.stringify(elevenLabsMessage));
                    
                  } else if (message.type === 'user_message' && message.text) {
                    const elevenLabsMessage = {
                      type: 'user_message',
                      text: message.text
                    };
                    console.log("💬 Forwarding text to ElevenLabs:", message.text.substring(0, 50) + "...");
                    upstream.send(JSON.stringify(elevenLabsMessage));
                    
                  } else {
                    console.log("📤 Forwarding message:", message.type || 'unknown');
                    upstream.send(data);
                  }
                } catch (parseError) {
                  upstream.send(data);
                }
              } else {
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
        
        // *** CONNECTION CLEANUP HANDLERS ***
        
        const safeClose = (ws, reason = "") => { 
          try { 
            if (ws && ws.readyState === 1) {
              ws.close();
            }
            if (reason) console.log("🔌 Closed:", reason);
          } catch {} 
        };
        
        server.addEventListener("close", (evt) => {
          const duration = Date.now() - connectionStartTime;
          console.log("🔌 Client disconnected:", {
            code: evt.code, 
            reason: evt.reason,
            duration: Math.round(duration / 1000) + "s"
          });
          cleanup();
          safeClose(upstream, "client closed");
          isConnected = false;
        });
        
        server.addEventListener("error", (evt) => {
          console.error("❌ Client error:", evt);
          cleanup();
          safeClose(upstream, "client error");
          isConnected = false;
        });
        
        upstream.addEventListener("close", (evt) => {
          const duration = Date.now() - connectionStartTime;
          console.log("🔌 ElevenLabs closed:", {
            code: evt.code, 
            reason: evt.reason,
            duration: Math.round(duration / 1000) + "s"
          });
          cleanup();
          safeClose(server, "upstream closed");
          isConnected = false;
        });
        
        upstream.addEventListener("error", (evt) => {
          console.error("❌ ElevenLabs error:", evt);
          cleanup();
          safeClose(server, "upstream error");
          isConnected = false;
        });
        
      } catch (connectionError) {
        console.error("❌ WebSocket connection failed:", connectionError.message);
        cleanup();
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
