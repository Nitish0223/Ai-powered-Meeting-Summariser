let chunkCounter = 0;
const CHUNK_SIZE_MS = 15000;
const sessionStore = new Map();

const DUMMY_SUMMARY =
  'The meeting focused on Q4 roadmap adjustments. Key decisions included prioritizing the new user onboarding flow (Project Phoenix) and postponing the refactoring of the authentication module until Q1 next year. Sarah committed to providing the final design mockups by Friday, and the budget was approved for a new cloud service provider evaluation.';
const DUMMY_TRANSCRIPT =
  "User A: Okay, let's discuss the Q4 roadmap. User B: I think we need to prioritize Project Phoenix, the new onboarding flow. User C: I agree. Let's postpone auth refactoring until Q1. User A: Approved. Sarah, can you provide design mockups by Friday? User B: Yes, I can commit to that. User A: Great. Also, budget approved for the new cloud service evaluation.";
const DUMMY_CHAT_RESPONSES = {
  DEFAULT:
    "I'm a mock AI! Based on the dummy transcript, I can tell you about project priorities or commitments.",
  SARAH: 'Sarah committed to providing the final design mockups by Friday.',
  REFACTOR:
    'The refactoring of the authentication module was postponed until Q1 next year.',
  PRIORITY:
    'The team prioritized Project Phoenix (the new user onboarding flow) in the Q4 roadmap.',
};

function mockStartBackendSession() {
  const sessionId = `mock-session-${Date.now()}`;
  sessionStore.set(sessionId, {
    chunks: [],
    status: 'ACTIVE',
    transcript: DUMMY_TRANSCRIPT,
    summary: null,
  });
  return sessionId;
}

async function mockSendChunkToBackend(sessionId, order) {
  await new Promise((resolve) => setTimeout(resolve, 300));

  const session = sessionStore.get(sessionId);
  if (session) {
    session.chunks.push({ order, transcribed: true });
    sessionStore.set(sessionId, session);
  }

  chrome.runtime.sendMessage({
    action: 'UPDATE_STATUS',
    status: `Chunk ${order} transcribed.`,
    chunkCount: order,
  });
}

async function mockStopRecordingAndSummarize(sessionId) {
  chrome.runtime.sendMessage({
    action: 'UPDATE_STATUS',
    status: 'Processing all transcripts and generating summary (1s delay)...',
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const session = sessionStore.get(sessionId);
  if (session) {
    session.summary = DUMMY_SUMMARY;
    session.status = 'COMPLETED';
    sessionStore.set(sessionId, session);
  }

  chrome.runtime.sendMessage({
    action: 'SUMMARY_READY',
    summary: DUMMY_SUMMARY,
    transcript: DUMMY_TRANSCRIPT,
    status: '✅ Summary ready! Chatbot enabled.',
  });
}

async function mockHandleChatQuery(query) {
  let response = DUMMY_CHAT_RESPONSES.DEFAULT;
  const lowerQuery = query.toLowerCase();

  if (lowerQuery.includes('sarah') || lowerQuery.includes('mockups')) {
    response = DUMMY_CHAT_RESPONSES.SARAH;
  } else if (lowerQuery.includes('refactor') || lowerQuery.includes('auth')) {
    response = DUMMY_CHAT_RESPONSES.REFACTOR;
  } else if (
    lowerQuery.includes('priority') ||
    lowerQuery.includes('phoenix')
  ) {
    response = DUMMY_CHAT_RESPONSES.PRIORITY;
  }

  await new Promise((resolve) => setTimeout(resolve, 300));

  chrome.runtime.sendMessage({
    action: 'CHAT_RESPONSE',
    response: response,
    query: query,
  });
}

let currentSessionId = null;
let activeChunkInterval = null;

async function startRecording() {
  try {
    currentSessionId = mockStartBackendSession();
    chunkCounter = 0;

    activeChunkInterval = setInterval(() => {
      chunkCounter++;
      mockSendChunkToBackend(currentSessionId, chunkCounter);
    }, CHUNK_SIZE_MS);
  } catch (error) {
    console.error('Error during recording start simulation:', error);
    chrome.runtime.sendMessage({
      action: 'UPDATE_STATUS',
      status: `Error: ${error.message}`,
    });
  }
}

function stopRecording() {
  if (activeChunkInterval) {
    clearInterval(activeChunkInterval);
    activeChunkInterval = null;
  }
  mockStopRecordingAndSummarize(currentSessionId);
  currentSessionId = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_RECORDING') {
    startRecording();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'STOP_RECORDING') {
    stopRecording();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'CHAT_QUERY') {
    mockHandleChatQuery(message.query);
    sendResponse({ success: true });
    return true;
  }

  return false;
});
