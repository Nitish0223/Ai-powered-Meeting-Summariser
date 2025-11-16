
let shadowHost = null;
let isPanelVisible = false;
let isRecording = false;

console.log('content.js loaded');

const PANEL_HTML = `
    <div id="meetingPanel">
        <div class="header">
            <span class="title">AI Meeting Summarizer</span>
            <div class="controls">
                <!-- Minimize Button: Use minus for 'minimize', plus for 'maximize' state -->
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
        </div>

        <div class="section">
            <h4>📝 Summary</h4>
            <div class="placeholder" id="summaryArea">
                The summary will appear here after the recording stops...
            </div>
        </div>

        <div class="section">
            <h4>🤖 Chatbot</h4>
            <input class="chat-input" placeholder="Ask questions about the meeting..." />
        </div>
    </div>
`;



function updateUIState(panel) {
    const startBtn = panel.querySelector('#startRecBtn');
    const stopBtn = panel.querySelector('#stopRecBtn');

    if (isRecording) {
        panel.classList.add('recording-active');
        startBtn.disabled = true;
        stopBtn.disabled = false;
        startBtn.textContent = 'Listening...';
    } else {
        panel.classList.remove('recording-active');
        startBtn.disabled = false;
        stopBtn.disabled = true;
        startBtn.textContent = 'Start Recording';
    }
}


async function createPanel() {
    if (shadowHost) return;

  
    shadowHost = document.createElement('div');
    document.body.appendChild(shadowHost);

   
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    
    
    try {
        const cssUrl = chrome.runtime.getURL('panel.css');
        const link = document.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', cssUrl);
        shadowRoot.appendChild(link);
    } catch (error) {
        console.error('Failed to inject panel.css. Check web_accessible_resources in manifest.', error);
    }

  
    shadowRoot.insertAdjacentHTML('beforeend', PANEL_HTML);


    const panel = shadowRoot.getElementById('meetingPanel');


    updateUIState(panel);


    shadowRoot.getElementById('closeBtn').onclick = () => {
        shadowHost.style.display = 'none';
        isPanelVisible = false;
    };

    
    const minBtn = shadowRoot.getElementById('minBtn');
    minBtn.onclick = () => {
        const isMin = panel.classList.toggle('minimized');
        minBtn.textContent = isMin ? '+' : '—';
        minBtn.title = isMin ? 'Maximize' : 'Minimize';
    };

    
    shadowRoot.getElementById('startRecBtn').onclick = () => {
        isRecording = true;
        console.log('Recording Started!');
        updateUIState(panel);
    };

    shadowRoot.getElementById('stopRecBtn').onclick = () => {
        isRecording = false;
        console.log('Recording Stopped. Summarizing...');
      
        updateUIState(panel);
        panel.querySelector('#summaryArea').textContent = "Summary is ready! Here is the crisp outline of the key topics and decisions from the meeting.";
    };

    
    const headerHandle = shadowRoot.querySelector('.header');
    if (headerHandle) {
        makeDraggable(panel, headerHandle);
    }

    console.log('[AI Helper] UI Panel created and initialized.');
}


function togglePanel() {
    if (!shadowHost) {
        createPanel();
        isPanelVisible = true;
        return;
    }
    
    isPanelVisible = !isPanelVisible;
    shadowHost.style.display = isPanelVisible ? 'block' : 'none';
    console.log(`Panel visibility toggled: ${isPanelVisible}`);
}


chrome.runtime.onMessage.addListener((msg) => {
    console.log('Received message:', msg.action);
    
    if (msg.action === 'TOGGLE_PANEL') {
        togglePanel();
    }
});



function makeDraggable(element, handle) {
    let active = false;
    let xOffset = 0;
    let yOffset = 0;
    
    handle.addEventListener('mousedown', dragStart, false);
    document.addEventListener('mouseup', dragEnd, false);
    document.addEventListener('mousemove', drag, false);

    function dragStart(e) {
        const rect = element.getBoundingClientRect();
        xOffset = e.clientX - rect.left;
        yOffset = e.clientY - rect.top;

        if (e.target === handle || handle.contains(e.target)) {
            active = true;
            e.preventDefault(); 
        }
    }

    function dragEnd(e) {
        active = false;
    }

    function drag(e) {
        if (active) {
            e.preventDefault();
            
            const currentX = e.clientX - xOffset;
            const currentY = e.clientY - yOffset;
            
            const bodyRect = document.body.getBoundingClientRect();
            const posX = currentX - bodyRect.left;
            const posY = currentY - bodyRect.top;

            setTranslate(posX, posY, element);
        }
    }

    function setTranslate(xPos, yPos, el) {
    
        el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
    }
}