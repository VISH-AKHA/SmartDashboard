// Configuration
const CONFIDENCE_THRESHOLD = 0.6;
const FRAME_REQUIRED_FOR_TRIGGER = 15; // Requires continuous detection to trigger
const FRAME_REQUIRED_FOR_LIFETIME = 30; // Frames to wait before clearing card

// Define the action states for specific objects
const INTEREST_OBJECTS = {
    'person': { title: 'User Present', desc: 'Active session monitored. System awake.', class: 'card-person pulse' },
    'cell phone': { title: 'Distraction Alert', desc: 'Focus diminished. Consider putting the device away.', class: 'card-cell-phone' },
    'bottle': { title: 'Hydration Reminder', desc: 'Stay hydrated to maintain cognitive performance.', class: 'card-bottle' },
    'laptop': { title: 'Coding Mode Active', desc: 'Deep work environment initialized.', class: 'card-laptop' },
    'book': { title: 'Study Session', desc: 'Focus timer active for optimal reading retention.', class: 'card-book' },
    'cup': { title: 'Break Recommendation', desc: 'Time for a brief mental reset and stretch.', class: 'card-cup' }
};

const COLOR_MAP = {
    'person': '#00ff88',
    'cell phone': '#ff4444',
    'bottle': '#00ddff',
    'laptop': '#aa00ff',
    'book': '#ffaa00',
    'cup': '#ff007f'
};

// State variables
let model = null;
let isDetecting = true;
let showBoxes = true;
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 0;

// Object tracking memory for smoothing
const visualMemory = {};

// DOM Elements
const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const loadingOverlay = document.getElementById('loading-overlay');
const camStatusObj = { ind: document.getElementById('cam-status'), text: document.getElementById('cam-text') };
const modelStatusObj = { ind: document.getElementById('model-status'), text: document.getElementById('model-text') };
const detectedListEl = document.getElementById('detected-list');
const fpsText = document.getElementById('fps-text');
const actionsContainer = document.getElementById('actions-container');
const historyList = document.getElementById('history-list');

// Event Listeners for Toggles
document.getElementById('toggle-detection').addEventListener('change', (e) => {
    isDetecting = e.target.checked;
    if (!isDetecting) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        detectedListEl.innerText = 'Paused';
    }
});

document.getElementById('toggle-boxes').addEventListener('change', (e) => showBoxes = e.target.checked);

async function init() {
    try {
        await setupCamera();
        setIndicator(camStatusObj, 'green', 'Live');
    } catch (e) {
        setIndicator(camStatusObj, 'red', 'Error');
        console.error(e);
        loadingOverlay.innerHTML = '<p style="color:#ff4444">Camera access denied or failed.</p>';
        return;
    }

    try {
        model = await cocoSsd.load();
        setIndicator(modelStatusObj, 'green', 'Loaded');
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.style.display = 'none', 500);
        
        // Start loop
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        requestAnimationFrame(detectionLoop);
    } catch (e) {
        setIndicator(modelStatusObj, 'red', 'Failed');
        console.error('Failed to load model:', e);
        loadingOverlay.innerHTML = '<p style="color:#ff4444">Failed to load AI model.</p>';
    }
}

async function setupCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
    });
    video.srcObject = stream;

    return new Promise((resolve) => {
        video.onloadedmetadata = () => resolve(video);
    });
}

function setIndicator(obj, color, text) {
    obj.ind.className = `indicator ${color}`;
    obj.text.innerText = text;
}

function updateFPS() {
    const now = performance.now();
    frameCount++;
    if (now - lastFrameTime >= 1000) {
        fps = frameCount;
        frameCount = 0;
        lastFrameTime = now;
        fpsText.innerText = fps;
    }
}

async function detectionLoop() {
    if (isDetecting && video.readyState === 4) {
        updateFPS();
        // Prevent canvas size mismatch
        if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        }

        const predictions = await model.detect(video);
        processPredictions(predictions);
    }
    requestAnimationFrame(detectionLoop);
}

function processPredictions(predictions) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Top 3 highest confidence over threshold
    const validPredictions = predictions
        .filter(p => p.score >= CONFIDENCE_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    
    const currentFrameClasses = new Set(validPredictions.map(p => p.class));

    if (showBoxes) {
        // Since video is scaled X(-1) in CSS, we must map drawing coordinates
        validPredictions.forEach(pred => {
            const [x, y, width, height] = pred.bbox;
            const text = `${pred.class} ${Math.round(pred.score * 100)}%`;
            const color = COLOR_MAP[pred.class] || '#ffffff';
            
            // Adjust X for mirrored canvas overlay matching the video scaling
            const mirroredX = canvas.width - x - width;

            // Draw bounding box
            ctx.shadowColor = color;
            ctx.shadowBlur = 15;
            ctx.strokeStyle = color;
            ctx.lineWidth = 3;
            ctx.strokeRect(mirroredX, y, width, height);

            // Background for text
            ctx.shadowBlur = 0;
            ctx.fillStyle = color;
            const textWidth = ctx.measureText(text).width + 10;
            const labelY = y > 25 ? y - 25 : y;
            ctx.fillRect(mirroredX, labelY, textWidth, 25);
            
            // Text rendering
            ctx.font = '16px Outfit, sans-serif';
            ctx.fillStyle = '#111';
            ctx.fontWeight = 'bold';
            ctx.fillText(text, mirroredX + 5, labelY + 17);
        });
    }

    if (isDetecting) {
        detectedListEl.innerText = validPredictions.length > 0 
            ? validPredictions.map(p => p.class).join(', ')
            : 'None';
    }

    // State Smoothing Logic for Actions
    Object.keys(INTEREST_OBJECTS).forEach(objKey => {
        if (!visualMemory[objKey]) {
            visualMemory[objKey] = { framesPresent: 0, framesAbsent: 0, active: false };
        }
        
        const mem = visualMemory[objKey];

        if (currentFrameClasses.has(objKey)) {
            mem.framesPresent++;
            mem.framesAbsent = 0;
        } else {
            mem.framesAbsent++;
        }

        // Fast decay if nothing is detected
        if (currentFrameClasses.size === 0) mem.framesAbsent += 2;

        if (mem.framesPresent >= FRAME_REQUIRED_FOR_TRIGGER && !mem.active) {
            mem.active = true;
            addCard(objKey);
            addToHistory(objKey);
            mem.framesPresent = 0; 
        } else if (mem.framesAbsent >= FRAME_REQUIRED_FOR_LIFETIME && mem.active) {
            mem.active = false;
            removeCard(objKey);
            mem.framesAbsent = 0; 
        }
    });
}

function addCard(objKey) {
    const config = INTEREST_OBJECTS[objKey];
    if (!config) return;

    // Avoid duplicates securely
    if (document.getElementById(`card-${objKey.replace(' ', '-')}`)) return;

    const card = document.createElement('div');
    card.className = `action-card ${config.class}`;
    card.id = `card-${objKey.replace(' ', '-')}`;
    card.innerHTML = `
        <h4>${config.title}</h4>
        <p>${config.desc}</p>
    `;
    actionsContainer.prepend(card);
}

function removeCard(objKey) {
    const id = `card-${objKey.replace(' ', '-')}`;
    const card = document.getElementById(id);
    if (card) {
        card.style.transform = 'translateX(150px) scale(0.9)';
        card.style.opacity = '0';
        setTimeout(() => {
            if (card.parentNode) card.remove();
        }, 300);
    }
}

function addToHistory(objKey) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const li = document.createElement('li');
    li.innerHTML = `<span style="color:var(--neon-blue)">${time}</span> - ${objKey} detected`;
    historyList.prepend(li);
    if (historyList.children.length > 25) {
        historyList.lastElementChild.remove();
    }
}

// Particle Background Animation
function setupParticles() {
    const container = document.getElementById('particle-container');
    const particleCount = 40;
    for(let i=0; i<particleCount; i++) {
        let p = document.createElement('div');
        p.style.position = 'absolute';
        p.style.width = Math.random() * 3 + 1 + 'px';
        p.style.height = p.style.width;
        p.style.background = 'rgba(0, 221, 255, 0.4)';
        p.style.borderRadius = '50%';
        p.style.left = Math.random() * 100 + 'vw';
        p.style.top = Math.random() * 100 + 'vh';
        p.style.animation = `float ${Math.random() * 15 + 10}s linear infinite`;
        p.style.boxShadow = '0 0 10px rgba(0, 221, 255, 0.6)';
        container.appendChild(p);
    }

    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes float {
            0% { transform: translateY(0) rotate(0deg); opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translateY(-100vh) rotate(360deg); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
}

setupParticles();
init();
