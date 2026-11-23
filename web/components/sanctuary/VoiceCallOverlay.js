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

const PHONE_TITLE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
const MIC_SPEAK_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
const STOP_SEND_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;
const MIC_ON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path></svg>`;
const MIC_OFF_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line></svg>`;
const SPEAKER_ON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
const SPEAKER_OFF_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
const HANGUP_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>`;

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
    maxWidth: '420px',
    onClose: () => {
      if (!closed) {
        closed = true;
        cleanupAudioHardware();
      }
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${PHONE_TITLE_SVG}<span>Voice Call</span>`;

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
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Call controls');

  function makeCallControl({ label, svg, discClass = '', toggleKey = '', pressed = null }) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'voice-call-action';
    if (toggleKey) {
      btn.dataset.callToggle = toggleKey;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    const disc = doc.createElement('span');
    disc.className = discClass ? `voice-call-btn-disc ${discClass}` : 'voice-call-btn-disc';
    disc.setAttribute('aria-hidden', 'true');
    disc.innerHTML = svg;
    const lbl = doc.createElement('span');
    lbl.className = 'voice-call-btn-label';
    lbl.textContent = label;
    btn.append(disc, lbl);
    return { btn, disc, lbl };
  }

  const recordCtrl = makeCallControl({ label: 'Tap to Speak', svg: MIC_SPEAK_SVG });
  const muteCtrl = makeCallControl({ label: 'Mute', svg: MIC_ON_SVG, toggleKey: 'mute', pressed: false });
  const speakerCtrl = makeCallControl({ label: 'Speaker', svg: SPEAKER_ON_SVG, toggleKey: 'speaker', pressed: true });
  const hangupCtrl = makeCallControl({ label: 'End Call', svg: HANGUP_SVG, discClass: 'hangup' });
  const recordBtn = recordCtrl.btn;
  const muteBtn = muteCtrl.btn;
  const speakerBtn = speakerCtrl.btn;
  const hangupBtn = hangupCtrl.btn;

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
  modal.card.append(heading, container);

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
    transcriptBox.classList.add('is-visible');
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
      recordCtrl.lbl.textContent = 'Send Turn';
      recordCtrl.disc.innerHTML = STOP_SEND_SVG;
      recordCtrl.disc.classList.add('is-recording');
      statusEl.textContent = 'Recording...';
    } else {
      recorder?.stop?.();
      isRecording = false;
      recordCtrl.lbl.textContent = 'Tap to Speak';
      recordCtrl.disc.innerHTML = MIC_SPEAK_SVG;
      recordCtrl.disc.classList.remove('is-recording');
    }
  });

  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    mediaStream?.getAudioTracks?.().forEach((t) => { t.enabled = !isMuted; });
    muteBtn.setAttribute('aria-pressed', isMuted ? 'true' : 'false');
    muteCtrl.disc.innerHTML = isMuted ? MIC_OFF_SVG : MIC_ON_SVG;
  });

  speakerBtn.addEventListener('click', () => {
    speakerOn = !speakerOn;
    if (!speakerOn) activeAudio?.pause?.();
    speakerBtn.setAttribute('aria-pressed', speakerOn ? 'true' : 'false');
    speakerCtrl.disc.innerHTML = speakerOn ? SPEAKER_ON_SVG : SPEAKER_OFF_SVG;
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
