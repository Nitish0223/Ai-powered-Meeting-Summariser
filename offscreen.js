
let mediaRecorder = null;
let currentSessionId = null;
let chunkCounter = 0;
let _stream = null;
let _chunkIntervalMs = 20000; // default

function sendOffscreenMessage(payload) {
  try {
    chrome.runtime.sendMessage({ source: 'offscreen', ...payload }, () => void chrome.runtime.lastError);
  } catch (e) {
    console.error('Failed to send message to background', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.action === 'OFFSCREEN_START') {
        await startRecordingOffscreen(msg);
        sendResponse?.({ success: true });
      } else if (msg.action === 'OFFSCREEN_STOP') {
        await stopRecordingOffscreen();
        sendResponse?.({ success: true });
      } else {
        sendResponse?.({ success: false, error: 'Unknown offscreen action' });
      }
    } catch (err) {
      // Send a robust error object back to background so it can show to user
      const errorPayload = {
        message: err?.message || String(err),
        name: err?.name || 'Error',
        stack: err?.stack || null,
      };
      console.error('offscreen message handler error', errorPayload);
      sendOffscreenMessage({ type: 'RECORDER_ERROR', error: errorPayload });
      sendResponse?.({ success: false, error: errorPayload.message });
    }
  })();
  return true; // indicates we will call sendResponse asynchronously
});

async function startRecordingOffscreen({ sessionId, streamId, tabId, chunkIntervalMs }) {
  if (!streamId) throw new Error('Missing streamId for offscreen start.');

  if (mediaRecorder) {
    // stop previous cleanly before re-starting
    await stopRecordingOffscreen();
  }

  currentSessionId = sessionId;
  chunkCounter = 0;
  _chunkIntervalMs = chunkIntervalMs || _chunkIntervalMs;

  // Build constraints for tab capture streamId (Chrome-specific)
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  };

  try {
    _stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Wrap and rethrow so outer handler sends RECORDER_ERROR
    const pretty = new Error(`getUserMedia failed: ${err?.name || ''} ${err?.message || ''}`);
    pretty.original = err;
    throw pretty;
  }

  // Choose a safe mimeType: try preferred, fallback to browser default
  const tryMimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    ''
  ];

  let chosenMime = '';
  for (const m of tryMimeTypes) {
    try {
      if (!m) { chosenMime = ''; break; }
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
        chosenMime = m;
        break;
      }
    } catch (e) {
      // continue to next option
    }
  }

  const options = chosenMime ? { mimeType: chosenMime } : undefined;

  try {
    mediaRecorder = new MediaRecorder(_stream, options);
  } catch (err) {
    // If creating MediaRecorder fails, provide details and cleanup stream
    _stream.getTracks().forEach(t => t.stop());
    _stream = null;
    const ex = new Error(`MediaRecorder creation failed: ${err?.name || ''} ${err?.message || ''}`);
    ex.original = err;
    throw ex;
  }

  mediaRecorder.ondataavailable = async (ev) => {
    try {
      if (!ev.data || ev.data.size === 0) return;
      chunkCounter += 1;
      const ab = await ev.data.arrayBuffer();
      sendOffscreenMessage({
        type: 'CHUNK_READY',
        sessionId: currentSessionId,
        chunkOrder: chunkCounter,
        chunk: ab,
      });
    } catch (e) {
      console.error('ondataavailable error', e);
      sendOffscreenMessage({ type: 'RECORDER_ERROR', error: { message: 'Chunk processing failed', stack: e?.stack || null } });
    }
  };

  mediaRecorder.onstop = () => {
    sendOffscreenMessage({
      type: 'RECORDER_STOPPED',
      sessionId: currentSessionId,
    });
  };

  mediaRecorder.onerror = (ev) => {
    const errObj = ev?.error ? { message: ev.error.message, name: ev.error.name } : { message: 'Unknown MediaRecorder error' };
    console.error('MediaRecorder error event', errObj);
    sendOffscreenMessage({ type: 'RECORDER_ERROR', error: errObj });
  };

  // start and ensure the timeslice is a positive integer
  const timeSlice = Math.max(1000, Number(_chunkIntervalMs) || 20000);
  try {
    mediaRecorder.start(timeSlice);
    sendOffscreenMessage({ type: 'RECORDER_STARTED', sessionId: currentSessionId, mimeType: options?.mimeType ?? 'default' });
  } catch (err) {
    console.error('mediaRecorder.start() failed', err);
    sendOffscreenMessage({ type: 'RECORDER_ERROR', error: { message: 'mediaRecorder.start failed', stack: err?.stack || null } });
    throw err;
  }
}

async function stopRecordingOffscreen() {
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      // give mediaRecorder time to emit final dataavailable
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (e) {
    console.warn('mediaRecorder.stop() error', e);
  }

  if (_stream) {
    try {
      _stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn('stream.stop error', e);
    }
    _stream = null;
  }

  mediaRecorder = null;
  currentSessionId = null;
  chunkCounter = 0;
}
