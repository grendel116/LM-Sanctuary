import {
  resolveProgramAvatarUrl,
  resolveSanctuaryMediaUrl,
  saveVoiceCallTranscript,
  sendChat,
  startVoiceCall,
  synthesizeSpeech,
  transcribeVoiceAudio,
} from '../../queries/sanctuary.js';
import { createClassicModalDialog } from './SanctuaryDialog.js';

/**
 * Real-time Kokoro ONNX + faster-whisper Voice Call modal dialog.
 */
export function openVoiceCallOverlay({
  programId = 'sebile',
  programName = 'Program',
  sessionId = 'default',
  model = '',
  onSaved,
} = {}) {
  const doc = globalThis.document;
  const win = globalThis.window;

  const modal = createClassicModalDialog({
    id: 'voice-call-dialog',
    title: `Voice Call — ${programName}`,
    maxWidth: '440px',
    onClose: () => {
      if (!closed) {
        closed = true;
        cleanupAudioHardware();
      }
    },
  });

  const container = doc.createElement('div');
  container.className = 'voice-call-card';

  const avatarWrap = doc.createElement('div');
  avatarWrap.className = 'voice-call-avatar-container';

  const ring1 = doc.createElement('div');
  ring1.className = 'voice-call-pulse-ring ring1';
  const ring2 = doc.createElement('div');
  ring2.className = 'voice-call-pulse-ring ring2';

  const avatar = doc.createElement('img');
  avatar.className = 'voice-call-avatar';
  avatar.src = resolveProgramAvatarUrl(programId);
  avatar.alt = programName;

  avatarWrap.appendChild(ring1);
  avatarWrap.appendChild(ring2);
  avatarWrap.appendChild(avatar);

  const nameHeading = doc.createElement('div');
  nameHeading.className = 'voice-call-program-name';
  nameHeading.textContent = programName;

  const statusEl = doc.createElement('p');
  statusEl.className = 'voice-call-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.textContent = 'Connecting call...';

  const canvas = doc.createElement('canvas');
  canvas.className = 'voice-call-visualizer';
  canvas.width = 280;
  canvas.height = 56;

  const transcriptBox = doc.createElement('div');
  transcriptBox.className = 'voice-call-transcript';
  const transcriptTurns = doc.createElement('div');
  transcriptTurns.className = 'voice-call-transcript-turns';
  transcriptBox.appendChild(transcriptTurns);

  const controls = doc.createElement('div');
  controls.className = 'voice-call-controls';

  const recordBtn = doc.createElement('button');
  recordBtn.type = 'button';
  recordBtn.className = 'voice-call-btn';
  recordBtn.textContent = 'Hold / Tap to Speak';

  const muteBtn = doc.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'voice-call-btn';
  muteBtn.textContent = 'Mute';

  const speakerBtn = doc.createElement('button');
  speakerBtn.type = 'button';
  speakerBtn.className = 'voice-call-btn';
  speakerBtn.textContent = 'Speaker: On';

  const hangupBtn = doc.createElement('button');
  hangupBtn.type = 'button';
  hangupBtn.className = 'voice-call-btn hangup';
  hangupBtn.textContent = 'End Call';

  controls.appendChild(recordBtn);
  controls.appendChild(muteBtn);
  controls.appendChild(speakerBtn);
  controls.appendChild(hangupBtn);

  container.appendChild(avatarWrap);
  container.appendChild(nameHeading);
  container.appendChild(statusEl);
  container.appendChild(canvas);
  container.appendChild(transcriptBox);
  container.appendChild(controls);
  modal.card.appendChild(container);

  let isMuted = false;
  let speakerOn = true;
  let isRecording = false;
  let closed = false;
  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let rafId = null;
  let activeAudio = null;
  const startedAt = Date.now();
  const turns = [];

  function appendTurn(speaker, text) {
    turns.push({ speaker, text });
    const line = doc.createElement('p');
    line.className = 'voice-call-transcript-turn';
    const who = doc.createElement('span');
    who.className = `turn-speaker ${speaker === 'user' ? 'user' : 'program'}`;
    who.textContent = speaker === 'user' ? 'You: ' : `${programName}: `;
    const span = doc.createElement('span');
    span.textContent = text;
    line.appendChild(who);
    line.appendChild(span);
    transcriptTurns.appendChild(line);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  function cleanupAudioHardware() {
    if (rafId) {
      win?.cancelAnimationFrame?.(rafId);
      rafId = null;
    }
    try {
      recorder?.stop?.();
    } catch {
      // Ignore already-stopped recorder
    }
    mediaStream?.getTracks?.().forEach((t) => t.stop());
    mediaStream = null;
    activeAudio?.pause?.();
    activeAudio = null;
    audioCtx?.close?.().catch?.(() => {});
    audioCtx = null;
  }

  function resolveAccentColor() {
    try {
      const val = globalThis.getComputedStyle?.(doc.documentElement)?.getPropertyValue('--primary-accent')?.trim();
      return val || '#9370db';
    } catch {
      return '#9370db';
    }
  }

  function drawMeter() {
    if (closed || !analyser) return;
    const ctx2d = canvas.getContext?.('2d');
    if (!ctx2d) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    const barW = Math.max(2, Math.floor(canvas.width / 24));
    const accent = resolveAccentColor();
    for (let i = 0; i < 24; i += 1) {
      const mag = (data[i * 2] || 0) / 255;
      const h = Math.max(4, mag * (canvas.height - 8));
      ctx2d.fillStyle = accent;
      ctx2d.fillRect(i * (barW + 2), (canvas.height - h) / 2, barW, h);
    }
    rafId = win?.requestAnimationFrame?.(drawMeter);
  }

  async function processRecordedAudio(blob) {
    if (closed || !blob || blob.size === 0) return;
    statusEl.textContent = 'Transcribing...';
    try {
      const stt = await transcribeVoiceAudio(blob);
      const userText = (stt?.text || '').trim();
      if (!userText) {
        statusEl.textContent = 'Listening ready';
        return;
      }
      appendTurn('user', userText);
      statusEl.textContent = `${programName} is thinking...`;

      const chatRes = await sendChat({
        session_id: `${sessionId}_voice`,
        message: userText,
        is_voice_call: true,
        model: model || undefined,
      });
      const reply = (chatRes?.response || '').trim();
      if (!reply) {
        statusEl.textContent = 'Ready';
        return;
      }
      appendTurn('program', reply);

      if (speakerOn) {
        statusEl.textContent = `${programName} speaking...`;
        try {
          const tts = await synthesizeSpeech(`vc_${Date.now()}`, reply);
          if (tts?.audio_url && !closed) {
            activeAudio = new globalThis.Audio(resolveSanctuaryMediaUrl(tts.audio_url));
            await new Promise((resolve) => {
              activeAudio.onended = resolve;
              activeAudio.onerror = resolve;
              void activeAudio.play?.()?.catch?.(resolve);
            });
          }
        } catch {
          // Proceed cleanly if TTS fails on host
        }
      }
      if (!closed) statusEl.textContent = 'Ready — tap to speak';
    } catch (err) {
      if (!closed) statusEl.textContent = err?.message || 'Voice turn error';
    }
  }

  recordBtn.addEventListener('click', () => {
    if (!mediaStream || isMuted) return;
    if (!isRecording) {
      chunks = [];
      recorder = new globalThis.MediaRecorder(mediaStream);
      recorder.ondataavailable = (ev) => {
        if (ev.data?.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        chunks = [];
        void processRecordedAudio(blob);
      };
      recorder.start();
      isRecording = true;
      recordBtn.textContent = 'Stop & Send Turn';
      statusEl.textContent = 'Recording...';
    } else {
      recorder?.stop?.();
      isRecording = false;
      recordBtn.textContent = 'Tap to Speak';
    }
  });

  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    mediaStream?.getAudioTracks?.().forEach((t) => { t.enabled = !isMuted; });
    muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
  });

  speakerBtn.addEventListener('click', () => {
    speakerOn = !speakerOn;
    if (!speakerOn) activeAudio?.pause?.();
    speakerBtn.textContent = speakerOn ? 'Speaker: On' : 'Speaker: Muted';
  });

  async function endAndSave() {
    if (closed) return;
    closed = true;
    cleanupAudioHardware();
    if (turns.length > 0) {
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const transcriptPayload = JSON.stringify({
        duration: `${elapsedSec}s`,
        turns,
      });
      try {
        await saveVoiceCallTranscript(transcriptPayload, sessionId);
        await onSaved?.();
      } catch {
        // Best-effort save
      }
    }
    modal.close();
  }

  hangupBtn.addEventListener('click', () => void endAndSave());

  modal.open();

  void (async () => {
    try {
      await startVoiceCall(sessionId);
      if (globalThis.navigator?.mediaDevices?.getUserMedia) {
        mediaStream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
        const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (AudioCtx) {
          audioCtx = new AudioCtx();
          const source = audioCtx.createMediaStreamSource(mediaStream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 128;
          source.connect(analyser);
          drawMeter();
        }
        statusEl.textContent = 'Connected — tap to speak';
      } else {
        statusEl.textContent = 'Microphone unavailable in this context';
        recordBtn.disabled = true;
      }
    } catch (err) {
      statusEl.textContent = err?.message || 'Unable to start voice call';
    }
  })();

  return {
    dialog: modal.dialog,
    close: modal.close,
    shell: modal,
    endAndSave,
  };
}
