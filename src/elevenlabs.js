import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';

// Update your pushToElevenLabs function in src/elevenlabs.js:

export async function pushToElevenLabs({
    apiKey,
    mode,
    voiceId,
    convaiWebhookUrl,
    convaiWebhookSecret,
    kbTitle,
    kbText,
    outDir
}) {
    console.log(`🚀 Pushing to ElevenLabs - Mode: ${mode}`);
    console.log('KB Data:', { 
        title: kbTitle, 
        textLength: kbText?.length,
        hasWebhookUrl: !!convaiWebhookUrl 
    });

    if (mode === 'convai') {
        if (!convaiWebhookUrl) {
            throw new Error('ELEVENLABS_CONVAI_WEBHOOK URL is required for ConvAI mode');
        }

        console.log(`📡 Sending knowledge base to webhook: ${convaiWebhookUrl}`);
        
        const payload = {
            title: kbTitle,
            knowledge_base: kbText,
            timestamp: new Date().toISOString(),
            mode: 'convai'
        };

        // Create signature if secret is provided
        let headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'ElevenLabs-KB-Pusher/1.0'
        };

        if (convaiWebhookSecret) {
            const timestamp = Math.floor(Date.now() / 1000);
            const message = `${timestamp}.${JSON.stringify(payload)}`;
            const signature = crypto.createHmac('sha256', convaiWebhookSecret)
                .update(message)
                .digest('hex');
            
            headers['elevenlabs-signature'] = `t=${timestamp},v0=${signature}`;
            console.log('🔐 Added webhook signature');
        }

        try {
            console.log('📤 Sending webhook request...');
            const response = await fetch(convaiWebhookUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const responseText = await response.text();
            console.log('📥 Webhook response:', {
                status: response.status,
                statusText: response.statusText,
                body: responseText
            });

            if (!response.ok) {
                throw new Error(`Webhook request failed: ${response.status} ${response.statusText} - ${responseText}`);
            }

            console.log('✅ Knowledge base sent to ConvAI webhook successfully');
            
            return {
                mode: 'convai',
                success: true,
                response: {
                    status: response.status,
                    message: 'Knowledge base updated via webhook',
                    title: kbTitle,
                    contentLength: kbText.length
                }
            };

        } catch (error) {
            console.error('❌ Webhook request failed:', error);
            throw new Error(`Failed to send knowledge base to ConvAI: ${error.message}`);
        }
    }

    if (mode === 'tts') {
        console.log('🎵 Processing TTS mode...');
        
        if (!voiceId) {
            throw new Error('ELEVENLABS_VOICE_ID is required for TTS mode');
        }
        
        const fileName = await ttsToFile({
            apiKey,
            voiceId,
            title: kbTitle,
            text: kbText,
            outDir
        });
        
        return {
            mode: 'tts',
            success: true,
            file: `/media/${fileName}`,
            message: 'TTS file generated successfully'
        };
    }

    throw new Error(`Unknown mode: ${mode}`);
}

export async function ttsToFile({ apiKey, voiceId, title, text, outDir }) {
    await fs.mkdir(outDir, { recursive: true });
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: `[${title}] Knowledge Base:\n\n${text}`,
            model_id: 'eleven_multilingual_v2',
            optimize_streaming_latency: 0,
            voice_settings: { stability: 0.3, similarity_boost: 0.75 }
        })
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`TTS failed: ${res.status} ${t}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const fileName = `${title.replace(/\s+/g, '_')}.mp3`;
    await fs.writeFile(path.join(outDir, fileName), buf);
    return fileName;
}

export function makeRealtimeSessionPayload({ project, kbTitle, kbText, model, agentId }) {
    return {
        provider: 'elevenlabs',
        ws: 'wss://api.elevenlabs.io/v1/convai/ws', // swap if your endpoint differs
        query: { model: model || 'eleven_flash_v2', agent_id: agentId || '' },
        initial_knowledge_base: { title: kbTitle, text: kbText },
        meta: { project }
    };
}