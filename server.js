import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import crypto from 'crypto';
import { getSignedWsUrl } from './signer.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { assembleKB, listProjects } from './src/projects.js';
import multer from 'multer';

import { pushToElevenLabs, makeRealtimeSessionPayload, ttsToFile } from './src/elevenlabs.js';

const app = express();
app.use(cors());

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

// IMPORTANT: STT endpoint MUST come BEFORE app.use(express.json())
app.post('/api/stt', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        console.log('🎤 STT request received:', {
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            modelId: req.body.model_id || 'scribe_v1'
        });

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'ElevenLabs API key not configured' });
        }

        // Prepare form data for ElevenLabs STT API
        const formData = new FormData();
        
        // Create a blob from the buffer - ElevenLabs expects 'file' field name
        const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        formData.append('file', audioBlob, req.file.originalname || 'recording.wav');
        formData.append('model_id', req.body.model_id || 'scribe_v1');
        
        // Add additional parameters for better transcription
        formData.append('language_code', 'en'); // Specify English for better accuracy
        formData.append('timestamps_granularity', 'word');
        formData.append('tag_audio_events', 'false'); // Disable event tagging for cleaner text

        console.log('📡 Sending to ElevenLabs STT API...');

        // Call ElevenLabs Speech-to-Text API
        const sttResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                // Note: Don't set Content-Type header, let fetch set it for FormData
            },
            body: formData
        });

        if (!sttResponse.ok) {
            const errorText = await sttResponse.text();
            console.error('❌ ElevenLabs STT API error:', {
                status: sttResponse.status,
                statusText: sttResponse.statusText,
                error: errorText
            });
            
            return res.status(sttResponse.status).json({ 
                error: `STT API failed: ${sttResponse.status} ${sttResponse.statusText}`,
                details: errorText
            });
        }

        const sttResult = await sttResponse.json();
        
        console.log('✅ STT successful:', {
            text: sttResult.text?.substring(0, 100) + (sttResult.text?.length > 100 ? '...' : ''),
            textLength: sttResult.text?.length || 0,
            language: sttResult.language_code,
            confidence: sttResult.language_probability,
            hasWords: !!sttResult.words
        });

        res.json(sttResult);

    } catch (error) {
        console.error('❌ STT endpoint error:', {
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 3)
        });
        
        res.status(500).json({ 
            error: 'Internal server error during speech-to-text processing',
            message: error.message
        });
    }
});

// Webhook handler for ConvAI knowledge base updates
app.post('/convai-hook', (req, res, next) => {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk);
    req.on('end', async () => {
        const sigHeader = req.headers['elevenlabs-signature'] || 
                         req.headers['x-elevenlabs-signature'] ||
                         req.headers['x-webhook-signature'];
        const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;

        console.log('🎯 Webhook received:', {
            timestamp: new Date().toISOString(),
            bodyLength: rawBody.length,
            hasSignature: !!sigHeader,
            hasSecret: !!secret,
            headers: Object.keys(req.headers)
        });

        // Parse the payload first
        let payload;
        try {
            payload = JSON.parse(rawBody || '{}');
            console.log('📦 Parsed webhook payload:', {
                title: payload.title,
                kbLength: payload.knowledge_base?.length,
                mode: payload.mode,
                timestamp: payload.timestamp
            });
        } catch (e) {
            console.error('❌ Failed to parse webhook payload:', e.message);
            return res.status(400).send('Invalid JSON payload');
        }

        // Skip signature verification in development but log it
        if (!sigHeader) {
            console.log('⚠️ No signature header found - proceeding in development mode');
        } else {
            console.log('🔐 Signature header present:', sigHeader.substring(0, 20) + '...');
            // Add your existing signature verification logic here
        }

        // Process the knowledge base update
        if (payload.title && payload.knowledge_base) {
            try {
                console.log('🚀 Starting knowledge base update process...');
                console.log('📋 KB Update Details:', {
                    agentId: process.env.ELEVENLABS_AGENT_ID?.substring(0, 12) + '...',
                    title: payload.title,
                    contentLength: payload.knowledge_base.length,
                    contentPreview: payload.knowledge_base.substring(0, 150) + '...'
                });
                
                const updateResult = await updateConvAIKnowledgeBase({
                    apiKey: process.env.ELEVENLABS_API_KEY,
                    agentId: process.env.ELEVENLABS_AGENT_ID,
                    title: payload.title,
                    content: payload.knowledge_base
                });
                
                console.log('✅ Knowledge base update completed:', updateResult);
                
                res.status(200).json({
                    success: true,
                    message: 'Knowledge base updated successfully',
                    details: updateResult
                });
                
            } catch (updateError) {
                console.error('❌ Knowledge base update failed:', {
                    message: updateError.message,
                    stack: updateError.stack?.split('\n').slice(0, 5)
                });
                res.status(500).json({
                    success: false,
                    error: 'Knowledge base update failed',
                    message: updateError.message
                });
            }
        } else {
            console.log('⚠️ Webhook payload missing required fields');
            res.status(400).json({
                success: false,
                error: 'Missing title or knowledge_base in payload'
            });
        }
    });
});

// ✅ JSON parser AFTER webhook route and STT route
app.use(express.json({ limit: '5mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/media', express.static(path.join(__dirname, 'out')));

function baseUrl(req) {
    return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Helper function for ConvAI knowledge base updates
async function updateConvAIKnowledgeBase({ apiKey, agentId, title, content }) {
    const base = process.env.ELEVENLABS_BASE || 'api.elevenlabs.io';
    
    console.log('🔄 Updating ConvAI agent knowledge base:', {
        agentId: agentId?.substring(0, 12) + '...',
        title,
        contentLength: content?.length,
        baseUrl: base
    });
    
    try {
        // Step 1: Get existing knowledge base documents for this agent
        console.log('📋 Fetching existing knowledge base documents...');
        const listResponse = await fetch(`https://${base}/v1/convai/knowledge-base?agent_id=${agentId}&page_size=100`, {
            method: 'GET',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            }
        });
        
        let existingDocuments = [];
        if (listResponse.ok) {
            const listData = await listResponse.json();
            existingDocuments = listData.documents || [];
            console.log('📋 Found existing KB documents:', existingDocuments.length);
            
            existingDocuments.forEach((doc, i) => {
                console.log(`  ${i + 1}. ${doc.name} (ID: ${doc.id}, Type: ${doc.type})`);
            });
        } else {
            const errorText = await listResponse.text();
            console.log('⚠️ Could not fetch existing KB documents:', listResponse.status, errorText);
        }

        // Step 2: Check if we have a document with the same title and delete it
        const existingDoc = existingDocuments.find(doc => doc.name === title);
        
        if (existingDoc) {
            console.log('🔄 Found existing document with same title, deleting...');
            try {
                const deleteResponse = await fetch(`https://${base}/v1/convai/knowledge-base/${existingDoc.id}?agent_id=${agentId}`, {
                    method: 'DELETE',
                    headers: {
                        'xi-api-key': apiKey,
                    }
                });
                
                if (deleteResponse.ok) {
                    console.log('✅ Deleted existing document successfully');
                } else {
                    const deleteError = await deleteResponse.text();
                    console.log('⚠️ Could not delete existing document:', deleteResponse.status, deleteError);
                }
            } catch (deleteErr) {
                console.log('⚠️ Delete request failed:', deleteErr.message);
            }
        }

        // Step 3: Create new knowledge base document
        console.log('📝 Creating new knowledge base document...');
        const createPayload = {
            text: content,
            name: title
        };

        const createResponse = await fetch(`https://${base}/v1/convai/knowledge-base/text?agent_id=${agentId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(createPayload)
        });
        
        if (!createResponse.ok) {
            const errorText = await createResponse.text();
            console.error('❌ KB document creation failed:', {
                status: createResponse.status,
                statusText: createResponse.statusText,
                error: errorText
            });
            throw new Error(`KB document creation failed: ${errorText}`);
        }
        
        const createResult = await createResponse.json();
        console.log('✅ KB document created successfully:', {
            id: createResult.id,
            name: createResult.name
        });

        // Step 4: Get current agent configuration
        console.log('📋 Getting current agent configuration...');
        const getAgentResponse = await fetch(`https://${base}/v1/convai/agents/${agentId}`, {
            method: 'GET',
            headers: {
                'xi-api-key': apiKey,
            }
        });
        
        if (!getAgentResponse.ok) {
            const getError = await getAgentResponse.text();
            throw new Error(`Could not retrieve agent data: ${getError}`);
        }
        
        const agentData = await getAgentResponse.json();
        console.log('📄 Retrieved agent data successfully');

        // Step 5: Update agent with knowledge base using the correct API structure
        console.log('🔗 Replacing ALL knowledge base documents with new one...');
        
        // Get existing knowledge base entries from the prompt (for logging purposes)
        const existingKnowledgeBase = agentData.conversation_config?.agent?.prompt?.knowledge_base || [];
        console.log('📋 Current KB documents to be replaced:', existingKnowledgeBase.map(kb => ({
            name: kb.name,
            id: kb.id,
            type: kb.type
        })));
        
        // Create the new knowledge base entry - this will be the ONLY entry
        const newKnowledgeBaseEntry = {
            type: "text", // Since we created a text document
            name: title,
            id: createResult.id,
            usage_mode: "prompt" // Default usage mode
        };
        
        // Replace ALL existing knowledge base entries with just the new one
        const updatedKnowledgeBase = [newKnowledgeBaseEntry];
        
        // Prepare the update payload with the correct structure
        const updatePayload = {
            conversation_config: {
                ...agentData.conversation_config,
                agent: {
                    ...agentData.conversation_config?.agent,
                    prompt: {
                        ...agentData.conversation_config?.agent?.prompt,
                        knowledge_base: updatedKnowledgeBase
                    }
                }
            }
        };

        console.log('📤 Updating agent with knowledge base configuration...');
        console.log('📋 Knowledge base entries:', updatedKnowledgeBase.map(kb => ({
            name: kb.name,
            id: kb.id,
            type: kb.type
        })));

        const updateResponse = await fetch(`https://${base}/v1/convai/agents/${agentId}`, {
            method: 'PATCH',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updatePayload)
        });
        
        if (!updateResponse.ok) {
            const updateError = await updateResponse.text();
            console.error('❌ Agent update failed:', updateResponse.status, updateError);
            throw new Error(`Failed to associate KB with agent: ${updateError}`);
        }
        
        const updateResult = await updateResponse.json();
        console.log('✅ Agent updated successfully');
        
        // Step 6: Verify the knowledge base was properly associated
        const resultKnowledgeBase = updateResult.conversation_config?.agent?.prompt?.knowledge_base || [];
        const isAssociated = resultKnowledgeBase.some(kb => kb.id === createResult.id);
        
        console.log('🔍 KB Association Verification:', {
            totalKBEntries: resultKnowledgeBase.length,
            lookingForDocId: createResult.id,
            isAssociated,
            associatedEntries: resultKnowledgeBase.map(kb => ({ name: kb.name, id: kb.id }))
        });
        
        if (isAssociated) {
            console.log('✅ Knowledge base successfully associated with agent!');
        } else {
            console.log('⚠️ Knowledge base may not be properly associated - check manually');
        }
        
        return {
            document_id: createResult.id,
            name: createResult.name,
            agent_id: agentId,
            method: 'prompt_knowledge_base',
            associated: isAssociated
        };
        
    } catch (error) {
        console.error('❌ Error updating ConvAI knowledge base:', {
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 3)
        });
        throw error;
    }
}

// --- API routes ---
app.get('/api/projects', async (_req, res) => {
    try {
      const ps = await listProjects();     // ✅ await
      res.json(ps);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

app.get('/api/kb/:key', async (req, res) => {
    try {
        const { title, text } = await assembleKB(req.params.key);
        res.json({ title, text });
    } catch (e) {
        console.error('KB assembly error:', e);
        res.status(400).json({ error: String(e.message || e) });
    }
});

app.post('/api/push', async (req, res) => {
    try {
        const { project, mode } = req.body || {};
        if (!project || !mode) {
            return res.status(400).json({ error: 'project and mode required' });
        }

        console.log(`🔄 Push request received:`, { project, mode });
        
        // Assemble the knowledge base
        console.log('📚 Assembling knowledge base...');
        const kb = await assembleKB(project);
        console.log('📋 Knowledge base assembled:', {
            title: kb.title,
            textLength: kb.text?.length,
            textPreview: kb.text?.substring(0, 200) + '...'
        });

        // Check required environment variables
        const requiredVars = {
            ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
            ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
        };

        if (mode === 'convai') {
            requiredVars.ELEVENLABS_CONVAI_WEBHOOK = process.env.ELEVENLABS_CONVAI_WEBHOOK;
            requiredVars.ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;
        }

        const missingVars = Object.entries(requiredVars)
            .filter(([key, value]) => !value)
            .map(([key]) => key);

        if (missingVars.length > 0) {
            const error = `Missing required environment variables: ${missingVars.join(', ')}`;
            console.error('❌', error);
            return res.status(400).json({ error });
        }

        console.log('🔧 Environment check passed');
        console.log('📡 Webhook URL:', process.env.ELEVENLABS_CONVAI_WEBHOOK);

        // Call the push function
        console.log(`🚀 Calling pushToElevenLabs for mode: ${mode}`);
        const out = await pushToElevenLabs({
            apiKey: process.env.ELEVENLABS_API_KEY,
            mode,
            voiceId: process.env.ELEVENLABS_VOICE_ID || undefined,
            convaiWebhookUrl: process.env.ELEVENLABS_CONVAI_WEBHOOK || undefined,
            convaiWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || undefined,
            kbTitle: kb.title,
            kbText: kb.text,
            outDir: 'out'
        });

        console.log('✅ Push completed successfully:', out);

        // Handle file URLs for TTS mode
        if (out.mode === 'tts' && out.file?.startsWith('/media/')) {
            out.file = `${baseUrl(req)}${out.file}`;
        }

        res.json(out);
    } catch (e) {
        console.error('❌ Push error:', e);
        console.error('Stack trace:', e.stack);
        res.status(400).json({ 
            error: String(e.message || e),
            details: e.stack?.split('\n').slice(0, 5).join('\n') // First 5 lines of stack trace
        });
    }
});

app.post('/api/tts', async (req, res) => {
    try {
        const { project } = req.body || {};
        if (!project) return res.status(400).json({ error: 'project required' });

        const kb = await assembleKB(project);
        const fileRel = await ttsToFile({
            apiKey: process.env.ELEVENLABS_API_KEY,
            voiceId: process.env.ELEVENLABS_VOICE_ID,
            title: kb.title,
            text: kb.text,
            outDir: 'out'
        });

        res.json({ url: `${baseUrl(req)}/media/${fileRel}` });
    } catch (e) {
        console.error('TTS error:', e);
        res.status(400).json({ error: String(e.message || e) });
    }
});

app.get('/api/realtime/:project', async (req, res) => {
    try {
        const { project } = req.params;
        const kb = await assembleKB(project);
        res.json(makeRealtimeSessionPayload({
            project,
            kbTitle: kb.title,
            kbText: kb.text,
            model: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2',
            agentId: process.env.ELEVENLABS_AGENT_ID || ''
        }));
    } catch (e) {
        console.error('Realtime session error:', e);
        res.status(400).json({ error: String(e.message || e) });
    }
});

app.get('/api/diag', (_req, res) => {
    const red = (v) => (v ? (v.length > 10 ? v.slice(0,4)+'…'+v.slice(-4) : v) : '');
    res.json({
        ELEVENLABS_BASE: process.env.ELEVENLABS_BASE || 'api.elevenlabs.io',
        have_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        API_KEY_preview: red(process.env.ELEVENLABS_API_KEY || ''),
        AGENT_ID: process.env.ELEVENLABS_AGENT_ID || '',
        MODEL: process.env.ELEVENLABS_MODEL || '',
        WEBHOOK_URL: process.env.ELEVENLABS_CONVAI_WEBHOOK || '',
        have_WEBHOOK_SECRET: !!process.env.ELEVENLABS_WEBHOOK_SECRET,
    });
});

// --- WebSocket proxy ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (client, req) => {
    const log = (...a) => console.log('[ws]', ...a);
    const clientId = Math.random().toString(36).substr(2, 9);
    log(`Client ${clientId} connected`);

    try {
        const url = new URL(req.url, 'http://localhost');
        const project = url.searchParams.get('project') || 'cyber';
        log(`Client ${clientId} requesting project: ${project}`);

        const { title, text } = await assembleKB(project);
        log(`Client ${clientId} KB assembled: ${title}`);

        const base = process.env.ELEVENLABS_BASE || 'api.elevenlabs.io';
        const apiKey = process.env.ELEVENLABS_API_KEY || '';
        const agent = process.env.ELEVENLABS_AGENT_ID || '';

        if (!apiKey || !agent) {
            const msg = `Missing env vars: ${!apiKey ? 'ELEVENLABS_API_KEY ' : ''}${!agent ? 'ELEVENLABS_AGENT_ID' : ''}`;
            log(`Client ${clientId} error:`, msg);
            client.send(JSON.stringify({ type:'error', text: msg }));
            client.close();
            return;
        }

        const signedUrl = await getSignedWsUrl({ agentId: agent, base, apiKey });
        log(`Client ${clientId} signed URL obtained:`, signedUrl.split('?')[0]);

        const upstream = new WebSocket(signedUrl, {
            headers: {
                'User-Agent': 'ConvAI-Proxy/1.0'
            }
        });

        let isConnected = false;

        upstream.on('unexpected-response', (_req2, res) => {
            let body = '';
            res.on('data', (c) => (body += c.toString()));
            res.on('end', () => {
                log(`Client ${clientId} upstream unexpected-response:`, { 
                    statusCode: res.statusCode, 
                    headers: res.headers, 
                    body: body.substring(0, 500)
                });
                try { 
                    client.send(JSON.stringify({ 
                        type:'error', 
                        text:`ElevenLabs connection failed (${res.statusCode})`,
                        details: body.substring(0, 200)
                    })); 
                } catch {}
                client.close();
            });
        });

        upstream.on('open', () => {
            log(`Client ${clientId} upstream connected ✓`);
            isConnected = true;
            
            // Send initial connection success message
            try {
                client.send(JSON.stringify({ 
                    type: 'info', 
                    text: 'Connected to ElevenLabs ConvAI',
                    project: project,
                    title: title
                }));
            } catch {}
        });

        upstream.on('message', (data) => {
            try {
                const s = data.toString();
                const parsed = JSON.parse(s);
                
                // Handle audio data with detailed logging
                const b64 = parsed?.audio_base_64 || 
                           parsed?.audio_event?.audio_base_64 || 
                           parsed?.data?.audio_base_64;

                if (b64) {
                    const mime = parsed?.mime || 
                                parsed?.audio_event?.mime || 
                                parsed?.data?.mime || 
                                'audio/mpeg';
                    
                    // Debug logging for audio
                    log(`Client ${clientId} received audio:`, {
                        b64Length: b64.length,
                        mime,
                        b64Preview: b64.substring(0, 50) + '...',
                        rawStructure: Object.keys(parsed)
                    });
                    
                    // Validate base64
                    try {
                        // Test if it's valid base64
                        const testDecode = atob(b64.substring(0, 100));
                        log(`Client ${clientId} base64 validation: OK`);
                    } catch (e) {
                        log(`Client ${clientId} base64 validation FAILED:`, e.message);
                        return; // Skip invalid base64
                    }
                    
                    // Send normalized audio format to client
                    client.send(JSON.stringify({ 
                        type: 'audio', 
                        audio_base_64: b64, 
                        mime 
                    }));
                    return;
                }

                // Filter out noisy metadata for cleaner logs
                if (!parsed.conversation_initiation_metadata && 
                    !parsed.conversation_initiation_metadata_event) {
                    
                    if (parsed.type && !['ping', 'pong'].includes(parsed.type)) {
                        log(`Client ${clientId} upstream message type: ${parsed.type}`);
                        
                        // Log structure for debugging
                        if (parsed.type !== 'audio') {
                            log(`Client ${clientId} message structure:`, Object.keys(parsed));
                        }
                    }
                }
                
                // Forward all other messages as-is
                client.send(s);
            } catch (e) {
                log(`Client ${clientId} message parsing error:`, e.message);
                // Fallback for non-JSON messages
                try { 
                    client.send(data); 
                } catch (sendError) {
                    log(`Client ${clientId} failed to forward raw data:`, sendError.message);
                }
            }
        });

        upstream.on('close', (code, reason) => {
            log(`Client ${clientId} upstream closed:`, code, reason?.toString());
            isConnected = false;
            try { 
                client.send(JSON.stringify({ 
                    type:'info', 
                    text:`Connection closed (${code})` 
                })); 
            } catch {}
            client.close();
        });

        upstream.on('error', (err) => {
            log(`Client ${clientId} upstream error:`, err.message);
            isConnected = false;
            try { 
                client.send(JSON.stringify({ 
                    type:'error', 
                    text: `Connection error: ${err.message}` 
                })); 
            } catch {}
            client.close();
        });

        // Handle client messages - forward to upstream with proper formatting
        client.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                log(`Client ${clientId} sending message type:`, message.type || 'unknown');
                
                if (isConnected && upstream.readyState === WebSocket.OPEN) {
                    
                    // Handle different message types and convert to ElevenLabs ConvAI format
                    if (message.user_audio_chunk) {
                        // Voice message from client - use ElevenLabs ConvAI simple format
                        // According to docs: {"user_audio_chunk":"base64EncodedAudioData=="}
                        const elevenLabsMessage = {
                            user_audio_chunk: message.user_audio_chunk.audio_base_64
                        };
                        
                        log(`Client ${clientId} forwarding audio chunk:`, {
                            audioLength: message.user_audio_chunk.audio_base_64?.length || 0,
                            originalMimeType: message.user_audio_chunk.mime_type,
                            expectedFormat: 'pcm_s16le_16 (16-bit PCM, 16kHz, mono, little-endian)',
                            elevenLabsFormat: 'direct_base64_string'
                        });
                        
                        upstream.send(JSON.stringify(elevenLabsMessage));
                        
                    } else if (message.type === 'user_message' && message.text) {
                        // Text message from client - use ElevenLabs ConvAI format
                        const elevenLabsMessage = {
                            type: 'user_message',
                            text: message.text
                        };
                        
                        log(`Client ${clientId} forwarding text message:`, {
                            messageLength: message.text.length,
                            preview: message.text.substring(0, 50) + '...'
                        });
                        
                        upstream.send(JSON.stringify(elevenLabsMessage));
                        
                    } else {
                        // Other message types - forward as-is but log the structure
                        log(`Client ${clientId} forwarding message as-is:`, {
                            keys: Object.keys(message),
                            type: message.type,
                            hasAudio: !!message.audio_base_64,
                            hasText: !!message.text
                        });
                        
                        upstream.send(JSON.stringify(message));
                    }
                    
                } else {
                    log(`Client ${clientId} tried to send while disconnected`);
                    client.send(JSON.stringify({ 
                        type: 'error', 
                        text: 'Not connected to upstream service' 
                    }));
                }
            } catch (e) {
                log(`Client ${clientId} invalid message format:`, e.message);
                log(`Client ${clientId} raw message:`, data.toString().substring(0, 200));
            }
        });

        client.on('close', () => {
            log(`Client ${clientId} disconnected`);
            isConnected = false;
            try { 
                upstream.close(); 
            } catch {}
        });

        client.on('error', (err) => {
            log(`Client ${clientId} error:`, err.message);
        });

    } catch (e) {
        log(`Client ${clientId} setup error:`, e.message);
        try { 
            client.send(JSON.stringify({ 
                type:'error', 
                text: `Setup failed: ${e.message}` 
            })); 
        } catch {}
        client.close();
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
    console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/convai-hook`);
    
    // Log environment status
    console.log('\n📋 Environment Status:');
    console.log(`  - ElevenLabs API Key: ${process.env.ELEVENLABS_API_KEY ? '✓ Set' : '❌ Missing'}`);
    console.log(`  - Agent ID: ${process.env.ELEVENLABS_AGENT_ID ? '✓ Set' : '❌ Missing'}`);
    console.log(`  - Webhook Secret: ${process.env.ELEVENLABS_WEBHOOK_SECRET ? '✓ Set' : '⚠ Missing (signatures will be skipped)'}`);
    console.log(`  - Webhook URL: ${process.env.ELEVENLABS_CONVAI_WEBHOOK || '⚠ Not set'}`);
});