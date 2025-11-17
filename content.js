const RECORDING_STATE_KEY = 'recordingState';

let shadowHost = null;
let shadowRoot = null;
let isPanelVisible = false;
let panelRefs = null;

const panelState = {
  isRecording: false,
  statusText: 'Ready to capture audio.',
  chunkCount: 0,
  sessionId: null,
  summary: '',
  transcript: '',
  chatMessages: [],
};

const PANEL_HTML = `
  <div id="meetingPanel">
    <div class="header">
      <span class="title">AI Meeting Summarizer</span>
      <div class="controls">
        <button id="minBtn" title="Minimize/Maximize" aria-label="Minimize Panel">—</button>
        <button id="closeBtn" title="Close Panel" aria-label="Close Panel">✕</button>
      </div>
    </div>

    <div class="section" id="recordingSection">
      <h4>🎙️ Recording Controls</h4>
      <div class="btn-group">
        <button id="startRecBtn" class="primary-btn">Start Recording</button>
        <button id="stopRecBtn" class="danger-btn" disabled>Stop Recording</button>
      </div>
      <p class="status-line"><strong>Status:</strong> <span id="statusText">Ready</span></p>
      <p class="status-line"><strong>Chunks:</strong> <span id="chunkCount">0</span></p>
      <p class="status-line"><strong>Session:</strong> <span id="sessionIdText">—</span></p>
    </div>

    <div class="section">
      <h4>📝 Summary</h4>
      <div class="placeholder" id="summaryArea">
        The summary will appear here after the recording stops...
      </div>
      <div class="placeholder transcript" id="transcriptArea">
        Transcript will appear here after processing.
      </div>
    </div>

    <div class="section">
      <h4>🤖 Chatbot</h4>
      <div id="chatMessages" class="chat-messages"></div>
      <div class="chat-input-row">
        <input id="chatInput" class="chat-input" placeholder="Ask questions about the meeting..." />
        <button id="sendChatBtn" class="primary-btn" disabled>Send</button>
      </div>
    </div>
  </div>
`;

bootstrapPanelState();

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) {
    return;
  }

  switch (message.action) {
    case 'TOGGLE_PANEL':
      togglePanel();
      break;
    case 'SHOW_PANEL':
      showPanel();
      break;
    case 'UPDATE_STATUS':
      applyStatusUpdate(message);
      break;
    case 'SUMMARY_READY':
      handleSummaryReady(message);
      break;
    case 'CHAT_RESPONSE':
      handleChatResponse(message);
      break;
    default:
      break;
  }
});

async function bootstrapPanelState() {
  chrome.storage.local.get([RECORDING_STATE_KEY], (result) => {
    const storedState = result[RECORDING_STATE_KEY];
    if (storedState) {
      panelState.isRecording = Boolean(storedState.isRecording);
      panelState.chunkCount = storedState.chunkCounter ?? 0;
      panelState.sessionId = storedState.sessionId ?? null;
      panelState.summary = storedState.lastSummary ?? panelState.summary;
      panelState.transcript = storedState.lastTranscript ?? panelState.transcript;
    }
    refreshPanelUI();
  });
}

async function ensurePanel() {
  if (shadowHost) {
    return;
  }

  shadowHost = document.createElement('div');
  shadowHost.id = 'ai-meeting-panel-host';
  shadowHost.style.position = 'fixed';
  shadowHost.style.top = '96px';
  shadowHost.style.right = '24px';
  shadowHost.style.zIndex = '2147483647';
  shadowHost.style.display = 'none';
  shadowHost.style.width = '360px';
  shadowHost.style.maxWidth = '90vw';
  document.body.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: 'open' });

  try {
    const cssUrl = chrome.runtime.getURL('panel.css');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssUrl;
    shadowRoot.appendChild(link);
  } catch (error) {
    console.error('Failed to inject panel.css', error);
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = PANEL_HTML;
  shadowRoot.appendChild(wrapper);

  panelRefs = {
    panel: shadowRoot.getElementById('meetingPanel'),
    startBtn: shadowRoot.getElementById('startRecBtn'),
    stopBtn: shadowRoot.getElementById('stopRecBtn'),
    statusText: shadowRoot.getElementById('statusText'),
    chunkCount: shadowRoot.getElementById('chunkCount'),
    sessionIdText: shadowRoot.getElementById('sessionIdText'),
    summaryArea: shadowRoot.getElementById('summaryArea'),
    transcriptArea: shadowRoot.getElementById('transcriptArea'),
    chatMessages: shadowRoot.getElementById('chatMessages'),
    chatInput: shadowRoot.getElementById('chatInput'),
    sendChatBtn: shadowRoot.getElementById('sendChatBtn'),
    closeBtn: shadowRoot.getElementById('closeBtn'),
    minBtn: shadowRoot.getElementById('minBtn'),
  };

  attachPanelEvents();
  refreshPanelUI();
}

function attachPanelEvents() {
  if (!panelRefs) {
    return;
  }

  panelRefs.closeBtn.addEventListener('click', hidePanel);

  panelRefs.minBtn.addEventListener('click', () => {
    const minimized = panelRefs.panel.classList.toggle('minimized');
    panelRefs.minBtn.textContent = minimized ? '+' : '—';
    panelRefs.minBtn.title = minimized ? 'Maximize' : 'Minimize';
  });

  panelRefs.startBtn.addEventListener('click', async () => {
    await handleActionRequest('START_RECORDING', {
      onStart: () => {
        panelState.isRecording = true;
        panelState.statusText = 'Starting recording…';
      },
    });
  });

  panelRefs.stopBtn.addEventListener('click', async () => {
    await handleActionRequest('STOP_RECORDING', {
      onStart: () => {
        panelState.isRecording = false;
        panelState.statusText = 'Stopping recording…';
      },
    });
  });

  panelRefs.sendChatBtn.addEventListener('click', handleChatSubmit);
  panelRefs.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleChatSubmit();
    }
  });

  const headerHandle = panelRefs.panel.querySelector('.header');
  if (headerHandle) {
    makeDraggable(panelRefs.panel, headerHandle);
  }
}

async function handleActionRequest(action, { onStart } = {}) {
  try {
    panelRefs.startBtn.disabled = true;
    panelRefs.stopBtn.disabled = true;
    onStart?.();
    refreshPanelUI();
    await sendActionToBackground(action);
  } catch (error) {
    console.error(`${action} failed`, error);
    panelState.statusText = `Error: ${error.message}`;
  } finally {
    refreshPanelUI();
  }
}

function handleChatSubmit() {
  if (!panelRefs) {
    return;
  }

  const query = panelRefs.chatInput.value.trim();
  if (!query) {
    return;
  }

  addChatMessage('user', query);
  panelRefs.chatInput.value = '';
  panelRefs.sendChatBtn.disabled = true;

  sendActionToBackground('CHAT_QUERY', { query })
    .catch((error) => {
      addChatMessage('ai', `⚠️ ${error.message}`);
      panelRefs.sendChatBtn.disabled = false;
    });
}

function addChatMessage(sender, text) {
  panelState.chatMessages.push({ sender, text });
  if (panelState.chatMessages.length > 30) {
    panelState.chatMessages.shift();
  }
  renderChatMessages();
}

function applyStatusUpdate(message) {
  if (!message) {
    return;
  }

  if (typeof message.isRecording === 'boolean') {
    panelState.isRecording = message.isRecording;
  }
  if (typeof message.chunkCount === 'number') {
    panelState.chunkCount = message.chunkCount;
  }
  if (message.sessionId) {
    panelState.sessionId = message.sessionId;
  }
  if (message.status) {
    panelState.statusText = message.status;
  }

  refreshPanelUI();
}

function handleSummaryReady(message) {
  applyStatusUpdate({
    status: message.status,
    chunkCount: message.totalChunks,
    sessionId: message.sessionId,
    isRecording: false,
  });

  panelState.summary = message.summary ?? panelState.summary;
  panelState.transcript = message.transcript ?? panelState.transcript;

  panelState.chatMessages = [];
  addChatMessage('ai', 'Summary ready! Ask me anything about this meeting.');
  panelRefs?.sendChatBtn && (panelRefs.sendChatBtn.disabled = false);

  refreshPanelUI();
}

function handleChatResponse(message) {
  if (message.error) {
    addChatMessage('ai', `⚠️ ${message.error}`);
  } else if (message.response) {
    addChatMessage('ai', message.response);
  }

  if (panelRefs) {
    panelRefs.sendChatBtn.disabled = false;
    panelRefs.chatInput.focus();
  }
}

function refreshPanelUI() {
  if (!panelRefs) {
    return;
  }

  panelRefs.panel.classList.toggle('recording-active', panelState.isRecording);
  panelRefs.startBtn.disabled = panelState.isRecording;
  panelRefs.stopBtn.disabled = !panelState.isRecording;
  panelRefs.startBtn.textContent = panelState.isRecording ? 'Listening…' : 'Start Recording';
  panelRefs.statusText.textContent = panelState.statusText;
  panelRefs.chunkCount.textContent = panelState.chunkCount.toString();
  panelRefs.sessionIdText.textContent = panelState.sessionId ?? '—';
  panelRefs.summaryArea.textContent = panelState.summary || 'The summary will appear here after the recording stops...';
  panelRefs.transcriptArea.textContent = panelState.transcript || 'Transcript will appear here once processing completes.';
  panelRefs.sendChatBtn.disabled = !panelState.summary || panelState.isRecording;
  renderChatMessages();
}

function renderChatMessages() {
  if (!panelRefs) {
    return;
  }

  panelRefs.chatMessages.innerHTML = '';
  panelState.chatMessages.forEach((msg) => {
    const div = document.createElement('div');
    div.className = `chat-message ${msg.sender}`;
    div.textContent = msg.text;
    panelRefs.chatMessages.appendChild(div);
  });

  panelRefs.chatMessages.scrollTop = panelRefs.chatMessages.scrollHeight;
}

function togglePanel() {
  if (isPanelVisible) {
    hidePanel();
  } else {
    showPanel();
  }
}

async function showPanel() {
  await ensurePanel();
  if (!shadowHost) {
    return;
  }
  shadowHost.style.display = 'block';
  isPanelVisible = true;
  refreshPanelUI();
}

function hidePanel() {
  if (!shadowHost) {
    return;
  }
  shadowHost.style.display = 'none';
  isPanelVisible = false;
}

function sendActionToBackground(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.success === false) {
        reject(new Error(response.error || 'Request failed.'));
        return;
      }
      resolve(response || {});
    });
  });
}

function makeDraggable(element, handle) {
  let active = false;
  let xOffset = 0;
  let yOffset = 0;

  handle.addEventListener('mousedown', dragStart, false);
  document.addEventListener('mouseup', dragEnd, false);
  document.addEventListener('mousemove', drag, false);

  function dragStart(event) {
    const rect = element.getBoundingClientRect();
    xOffset = event.clientX - rect.left;
    yOffset = event.clientY - rect.top;

    if (event.target === handle || handle.contains(event.target)) {
      active = true;
      event.preventDefault();
    }
  }

  function dragEnd() {
    active = false;
  }

  function drag(event) {
    if (!active) {
      return;
    }
    event.preventDefault();

    const currentX = event.clientX - xOffset;
    const currentY = event.clientY - yOffset;

    const bodyRect = document.body.getBoundingClientRect();
    const posX = currentX - bodyRect.left;
    const posY = currentY - bodyRect.top;

    element.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
  }
}