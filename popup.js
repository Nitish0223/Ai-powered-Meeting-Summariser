const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status-text');
const chunkInfo = document.getElementById('chunk-info');
const summaryOutput = document.getElementById('final-summary-output');
const summarySection = document.getElementById('summary-section');

const statusView = document.getElementById('status-view');
const chatView = document.getElementById('chat-view');
const viewChatBtn = document.getElementById('view-chat-btn');
const viewStatusBtn = document.getElementById('view-status-btn');

const chatHistory = document.getElementById('chat-history');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');

let isRecording = false;
let sessionTranscript = '';

const showView = (viewId) => {
  statusView.style.display = 'none';
  chatView.style.display = 'none';
  document.getElementById(viewId).style.display = 'block';
};

const sendMessageToServiceWorker = (action, data = {}) => {
  chrome.runtime.sendMessage({ action, ...data }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(
        'Message send warning (expected for async flow):',
        chrome.runtime.lastError.message
      );
    }
  });
};

const updateUI = () => {
  recordBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  recordBtn.textContent = isRecording ? 'Recording...' : 'Start Recording';
  stopBtn.classList.toggle('stop', !isRecording);
};

recordBtn.addEventListener('click', () => {
  const allowed = confirmRecordingPermission();
  if (!allowed) {
    statusText.textContent = 'Permission required to record audio.';
    isRecording = false;
    updateUI();
    return;
  }

  isRecording = true;
  summarySection.style.display = 'none';
  showView('status-view');
  statusText.textContent = 'Recording started. Waiting for chunks...';
  chunkInfo.textContent = '';
  updateUI();
  sendMessageToServiceWorker('START_RECORDING');
});

stopBtn.addEventListener('click', () => {
  isRecording = false;
  updateUI();
  statusText.textContent = 'Stopping recording...';
  summarySection.style.display = 'none';
  sendMessageToServiceWorker('STOP_RECORDING');
});

viewChatBtn.addEventListener('click', () => {
  showView('chat-view');
  chatInput.focus();
});

viewStatusBtn.addEventListener('click', () => {
  showView('status-view');
});

sendChatBtn.addEventListener('click', () => {
  const query = chatInput.value.trim();
  if (!query) return;

  appendChat('user', query);
  chatInput.value = '';
  sendChatBtn.disabled = true;

  sendMessageToServiceWorker('CHAT_QUERY', { query });
});

chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendChatBtn.click();
  }
});

function confirmRecordingPermission() {
  return window.confirm(
    'AI Meeting Summarizer needs to record audio from this tab. Do you allow recording?'
  );
}

const appendChat = (sender, text) => {
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('chat-message', sender);

  const senderLabel = sender === 'user' ? 'You: ' : 'AI: ';

  messageDiv.innerHTML = `<span style="font-weight: bold; margin-right: 4px;">${senderLabel}</span>${text}`;

  chatHistory.appendChild(messageDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;
};

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'UPDATE_STATUS') {
    statusText.textContent = message.status;
    if (message.chunkCount !== undefined) {
      chunkInfo.textContent = `Chunks processed: ${message.chunkCount}`;
    }
  } else if (message.action === 'SUMMARY_READY') {
    summaryOutput.textContent = message.summary;
    sessionTranscript = message.transcript;

    statusText.textContent = message.status;
    summarySection.style.display = 'block';

    chatHistory.innerHTML = '';
    appendChat(
      'ai',
      'Hello! The meeting summary is ready. Ask me a question about the transcript!'
    );

    sendChatBtn.disabled = false;
    showView('status-view');
  } else if (message.action === 'CHAT_RESPONSE') {
    appendChat('ai', message.response);
    sendChatBtn.disabled = false;
    chatInput.focus();
  }
});

updateUI();
