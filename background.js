// background.js
const BACKEND_BASE_URL = 'http://localhost:5000';
const CHUNK_INTERVAL_MS = 20_000;
const RECORDING_STATE_KEY = 'recordingState';
const MAX_UPLOAD_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;

const defaultRecordingState = {
  sessionId: null,
  chunkCounter: 0,
  isRecording: false,
  tabId: null,
  lastSummary: null,
  lastTranscript: null,
};

const recordingStateCache = { ...defaultRecordingState };

const recorderState = {
  isActive: false,
  isStopping: false,
  hasDocument: false,
};

const pendingChunkUploads = new Set();
let finalizePromise = null;

initializeRecordingStateCache();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message || {};

  // Offscreen-origin messages are handled here; the offscreen script will set `source: 'offscreen'`
  if (message?.source === 'offscreen') {
    handleOffscreenEvent(message);
    sendResponse?.({ success: true });
    return true;
  }

  const handler = getActionHandler(action, message);

  if (!handler) {
    return false;
  }

  handler
    .then((result = {}) => sendResponse({ success: true, ...result }))
    .catch((error) => {
      console.error(`${action} failed`, error);
      broadcastMessage({
        action: 'UPDATE_STATUS',
        status: `Error: ${error.message}`,
        chunkCount: recordingStateCache.chunkCounter,
        sessionId: recordingStateCache.sessionId,
        level: 'error',
      });
      sendResponse({ success: false, error: error.message });
    });

  return true;
});

function getActionHandler(action, payload) {
  switch (action) {
    case 'START_RECORDING':
      return handleStartRecording();
    case 'STOP_RECORDING':
      return handleStopRecording();
    case 'CHAT_QUERY':
      return handleChatQuery(payload?.query);
    case 'TOGGLE_PANEL':
      return Promise.resolve();
    default:
      return null;
  }
}

function initializeRecordingStateCache() {
  chrome.storage.local.get([RECORDING_STATE_KEY], (result) => {
    const stored = result[RECORDING_STATE_KEY];
    if (stored) {
      Object.assign(recordingStateCache, { ...defaultRecordingState, ...stored });
    }
  });
}

async function handleStartRecording() {
  if (recorderState.isActive) {
    throw new Error('Recording already in progress.');
  }

  const tabId = await getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab available to capture.');
  }

  await ensureOffscreenDocument();

  const streamId = await getTabStreamId(tabId);
  const sessionId = generateSessionId();

  await persistRecordingState({
    sessionId,
    chunkCounter: 0,
    isRecording: true,
    tabId,
    lastSummary: null,
    lastTranscript: null,
  });

  ensurePanelVisible(tabId);

  // request offscreen to start recording — it will use the provided streamId
  await requestOffscreenStart({ sessionId, streamId, tabId, chunkIntervalMs: CHUNK_INTERVAL_MS });

  recorderState.isActive = true;
  recorderState.isStopping = false;

  broadcastMessage({
    action: 'UPDATE_STATUS',
    status: 'Recording started…',
    chunkCount: 0,
    sessionId,
    isRecording: true,
  });

  return { sessionId };
}

async function handleStopRecording() {
  await stopRecordingFlow('Stop requested. Finalizing session…');
  return {};
}

async function handleChatQuery(query) {
  if (!query || !query.trim()) {
    throw new Error('Query text is required.');
  }

  const sessionId = recordingStateCache.sessionId;
  if (!sessionId) {
    broadcastMessage({
      action: 'CHAT_RESPONSE',
      error: 'There is no completed session to chat about yet.',
      query,
    });
    return {};
  }

  try {
    const response = await uploadWithRetry(`${BACKEND_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, query }),
    });

    const payload = await parseJsonSafely(response);
    broadcastMessage({
      action: 'CHAT_RESPONSE',
      response: payload?.response ?? 'No response returned from the server.',
      query,
      sessionId,
    });
  } catch (error) {
    console.error('CHAT_QUERY failed', error);
    broadcastMessage({
      action: 'CHAT_RESPONSE',
      error: error.message,
      query,
      sessionId,
    });
  }

  return {};
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0]?.id ?? null);
    });
  });
}

function ensurePanelVisible(tabId) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'SHOW_PANEL' }, () => {
    if (chrome.runtime.lastError) {
      console.debug('Unable to show panel automatically:', chrome.runtime.lastError.message);
    }
  });
}

async function handleChunkUpload(blob, sessionId, order) {
  const formData = new FormData();
  formData.append('sessionId', sessionId);
  formData.append('order', order.toString());
  formData.append('chunk', blob, `chunk-${order}.webm`);

  try {
    const response = await uploadWithRetry(`${BACKEND_BASE_URL}/upload-chunk`, {
      method: 'POST',
      body: formData,
    });

    const payload = await parseJsonSafely(response);
    broadcastMessage({
      action: 'UPDATE_STATUS',
      status: payload?.message ?? `Chunk ${order} uploaded.`,
      chunkCount: order,
      sessionId,
      isRecording: true,
    });
  } catch (error) {
    console.error(`Chunk ${order} upload failed`, error);
    broadcastMessage({
      action: 'UPDATE_STATUS',
      status: `Chunk ${order} failed: ${error.message}`,
      chunkCount: order,
      sessionId,
      level: 'error',
    });
    await stopRecordingFlow('Chunk upload failed. Stopping recording.');
  }
}

async function stopRecordingFlow(statusMessage) {
  if (!recordingStateCache.isRecording && !recorderState.isActive) {
    return;
  }

  broadcastMessage({
    action: 'UPDATE_STATUS',
    status: statusMessage ?? 'Stopping recording…',
    chunkCount: recordingStateCache.chunkCounter,
    sessionId: recordingStateCache.sessionId,
    isRecording: false,
  });

  await persistRecordingState({ isRecording: false, tabId: null });

  if (recorderState.isActive && !recorderState.isStopping) {
    recorderState.isStopping = true;
    try {
      await requestOffscreenStop(statusMessage);
    } catch (error) {
      console.error('Failed to stop offscreen recorder', error);
      handleOffscreenError({ message: error.message });
    }
  } else if (!recorderState.isActive) {
    finalizeRecording();
  }
}

function finalizeRecording() {
  if (finalizePromise) {
    return finalizePromise;
  }

  finalizePromise = (async () => {
    await Promise.allSettled([...pendingChunkUploads]);

    const sessionId = recordingStateCache.sessionId;
    const totalChunks = recordingStateCache.chunkCounter;

    if (!sessionId) {
      await closeOffscreenDocument();
      return;
    }

    try {
      const response = await uploadWithRetry(`${BACKEND_BASE_URL}/upload-final`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, totalChunks }),
      });

      const payload = await parseJsonSafely(response);
      const summary = payload?.summary ?? 'Summary will be available shortly.';
      const transcript = payload?.transcript ?? '';

      await persistRecordingState({
        isRecording: false,
        chunkCounter: 0,
        lastSummary: summary,
        lastTranscript: transcript,
        tabId: null,
      });

      broadcastMessage({
        action: 'SUMMARY_READY',
        summary,
        transcript,
        status: '✅ Summary ready! Chatbot enabled.',
        sessionId,
        totalChunks,
      });
    } catch (error) {
      console.error('Failed to finalize session', error);
      broadcastMessage({
        action: 'UPDATE_STATUS',
        status: `Failed to finalize session: ${error.message}`,
        chunkCount: totalChunks,
        sessionId,
        level: 'error',
      });
    } finally {
      recorderState.isActive = false;
      recorderState.isStopping = false;
      await closeOffscreenDocument();
    }
  })
    .finally(() => {
      pendingChunkUploads.clear();
      finalizePromise = null;
    });

  return finalizePromise;
}

function broadcastMessage(payload) {
  chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);

  const targetTabId = recordingStateCache.tabId;
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, payload, () => void chrome.runtime.lastError);
  }
}

function persistRecordingState(partial = {}) {
  const nextState = { ...recordingStateCache, ...partial };
  Object.assign(recordingStateCache, nextState);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [RECORDING_STATE_KEY]: nextState }, resolve);
  });
}

function uploadWithRetry(url, options, attempts = MAX_UPLOAD_ATTEMPTS) {
  let attempt = 0;
  let lastError = null;

  const execute = async () => {
    attempt += 1;
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw lastError;
      }
      const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      await wait(delay);
      return execute();
    }
  };

  return execute();
}

function wait(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function generateSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureOffscreenDocument() {
  if (recorderState.hasDocument) return;

  try {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) {
      recorderState.hasDocument = true;
      return;
    }

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture audio via MediaRecorder with persistent state.',
    });

    recorderState.hasDocument = true;
    console.log('Offscreen document created.');
  } catch (err) {
    console.error('Failed creating offscreen document', err, chrome.runtime.lastError);
    throw new Error('Unable to create offscreen document: ' + (err?.message || chrome.runtime.lastError?.message || 'unknown'));
  }
}

async function closeOffscreenDocument() {
  if (!recorderState.hasDocument) return;

  const hasDoc = await chrome.offscreen.hasDocument?.();
  if (!hasDoc) {
    recorderState.hasDocument = false;
    return;
  }

  await chrome.offscreen.closeDocument();
  recorderState.hasDocument = false;
}

function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
      consumerTabId: tabId,
    }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!streamId) {
        reject(new Error('Unable to obtain stream ID for the active tab.'));
        return;
      }
      resolve(streamId);
    });
  });
}

function requestOffscreenStart({ sessionId, streamId, tabId, chunkIntervalMs = CHUNK_INTERVAL_MS }) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_START',
      sessionId,
      streamId,
      tabId,
      chunkIntervalMs,
    }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('requestOffscreenStart runtime.lastError', chrome.runtime.lastError.message);
        // still resolve; offscreen will start and will report status via messages
      }
      resolve(resp);
    });
  });
}

function requestOffscreenStop(reason) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_STOP',
      reason,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('requestOffscreenStop runtime.lastError', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

/* ---------- Offscreen event handling ---------- */

function handleOffscreenEvent(message) {
  switch (message.type) {
    case 'CHUNK_READY':
      onOffscreenChunk(message);
      break;
    case 'RECORDER_STOPPED':
      onOffscreenStopped(message);
      break;
    case 'RECORDER_ERROR':
      handleOffscreenError(message.error);
      break;
    default:
      break;
  }
}

function onOffscreenChunk(message) {
  const { sessionId, chunkOrder, chunk } = message;
  if (!chunk || !sessionId) return;

  const blob = new Blob([chunk], { type: 'audio/webm' });
  persistRecordingState({ chunkCounter: chunkOrder });
  const uploadPromise = handleChunkUpload(blob, sessionId, chunkOrder);
  pendingChunkUploads.add(uploadPromise);
  uploadPromise.finally(() => pendingChunkUploads.delete(uploadPromise));
}

function onOffscreenStopped(message) {
  recorderState.isActive = false;
  recorderState.isStopping = false;
  finalizeRecording();
}

function handleOffscreenError(error = {}) {
  recorderState.isActive = false;
  recorderState.isStopping = false;
  const status = error?.message ? `Recorder error: ${error.message}` : 'Recorder stopped unexpectedly.';
  broadcastMessage({
    action: 'UPDATE_STATUS',
    status,
    chunkCount: recordingStateCache.chunkCounter,
    sessionId: recordingStateCache.sessionId,
    level: 'error',
  });
  finalizeRecording();
}
