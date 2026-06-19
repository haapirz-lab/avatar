/**
 * Akademia AI Avatar — main.js (the conductor)
 *
 * Loads local VRM files from /assets/avatars/.
 * Wires AI behavior JSON to ExpressionEngine / GestureEngine / LipSync.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { AvatarManager }    from './src/avatar/AvatarManager.js';
import { ExpressionEngine } from './src/avatar/ExpressionEngine.js';
import { GestureEngine }    from './src/avatar/GestureEngine.js';
import { LipSync }          from './src/avatar/LipSync.js';

import { CharacterBrain }    from './src/ai/CharacterBrain.js';
import { PersonaSystem }     from './src/systems/PersonaSystem.js';
import { BackgroundSystem }  from './src/systems/BackgroundSystem.js';
import { Controls }          from './src/ui/Controls.js';

const BACKEND = '';   // Vite proxy (see vite.config.js)

// ── Three.js scene ──────────────────────────────────────────────────────────
const scene    = new THREE.Scene();
const canvas3d = document.getElementById('avatar-canvas');
const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 1.8);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.target.set(0, 1.3, 0);
orbitControls.enableDamping  = true;
orbitControls.enablePan      = false;
orbitControls.enableZoom     = false;
orbitControls.minPolarAngle  = Math.PI / 2.4;
orbitControls.maxPolarAngle  = Math.PI / 2.05;
orbitControls.update();

scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const keyLight = new THREE.DirectionalLight(0xfff5ee, 2.0);
keyLight.position.set(1.2, 3.5, 2.5);
scene.add(keyLight);

// ── Systems ──────────────────────────────────────────────────────────────────
const avatarManager   = new AvatarManager(scene);
const brain           = new CharacterBrain(BACKEND);
const personaSystem   = new PersonaSystem('Tutor');
const backgroundSystem = new BackgroundSystem('scene-bg');

// Per-avatar engines (rebuilt whenever a new avatar loads).
let expression = null;
let gesture    = null;
let lipSync    = null;
let currentVrm = null;

// ── Avatar registry ───────────────────────────────────────────────────────────
// All files live in  ai-avatar-web/public/assets/avatars/
// VRM files you place there are served at /assets/avatars/<filename>.vrm
//
// DOWNLOAD THESE FREE CC0 VRM FILES AND SAVE THEM TO public/assets/avatars/:
//   sample_a.vrm  →  https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604
//   sample_b.vrm  →  https://hub.vroid.com/en/characters/7939147878897061040/models/2292219474373673889
//
// Until you download them, avatars show "Ready (no model)" — all other systems work.
let avatarList = [
    {
        id: 'uganda-female',
        name: 'Amara',
        handle: '@amara_ug',
        bio: 'Friendly bilingual tutor for English and Japanese.',
        file: '/assets/avatars/sample_a.vrm',
        // Picture shown in the "Discover" list. Drop your own image here
        // (any /assets/... path or full URL); falls back to a color if missing.
        image: '/assets/thumbs/avatar-uganda-female.svg',
        culture: 'en',
    },
    {
        id: 'uganda-male',
        name: 'Kwame',
        handle: '@kwame_ug',
        bio: 'Advanced native instruction specialist.',
        file: '/assets/avatars/sample_b.vrm',
        image: '/assets/thumbs/avatar-uganda-male.svg',
        culture: 'en',
    },
    {
        id: 'japan-female',
        name: 'Yuki',
        handle: '@yuki_jp',
        bio: 'Warm Japanese companion for everyday conversation.',
        file: '/assets/avatars/sample_a.vrm',
        image: '/assets/thumbs/avatar-japan-female.svg',
        culture: 'ja',
    },
    {
        id: 'japan-male',
        name: 'Kenji',
        handle: '@kenji_jp',
        bio: 'Linguistic acquisition mentor.',
        file: '/assets/avatars/sample_b.vrm',
        image: '/assets/thumbs/avatar-japan-male.svg',
        culture: 'ja',
    },
];

let currentAvatarId = 'uganda-female';

// ── UI controls ───────────────────────────────────────────────────────────────
const ui = new Controls({
    onAsk:           handleAsk,
    onSelectAvatar:  selectAvatar,
    onSelectScenario: selectScenario,
    onCreateAvatar:  createAvatar,
    onDeleteAvatar:  deleteAvatar,
    onReset:         () => brain.reset(),
    getAvatars:      () => avatarList,
    currentAvatarId: () => currentAvatarId,
});

// ── Avatar loading ────────────────────────────────────────────────────────────
async function selectAvatar(avatarId) {
    const a = avatarList.find((x) => x.id === avatarId);
    if (!a) return;
    currentAvatarId = avatarId;

    ui.setProfile({ name: a.name, handle: a.handle, bio: a.bio });
    ui.setVoiceLang(a.culture);
    ui.setStatus(`Loading ${a.name}…`);
    ui.setDot('yellow');

    try {
        currentVrm = await avatarManager.loadAvatar(a.file);
        attachEngines(currentVrm);
        ui.setStatus('Ready');
        ui.setDot('green');
    } catch (err) {
        console.warn('Avatar load failed — engines idle until model loads:', err.message);
        currentVrm = null;
        expression = gesture = lipSync = null;
        ui.setStatus('Ready (no model)');
        ui.setDot('green');
    }
}

function attachEngines(vrm) {
    expression = new ExpressionEngine(vrm);
    gesture    = new GestureEngine(vrm);
    lipSync    = new LipSync(vrm);
}

function selectScenario(personaKey) {
    const p = personaSystem.set(personaKey);
    backgroundSystem.load(p.background);
    ui.setVoiceLang(p.culture);
}

// ── The brain → body pipeline ─────────────────────────────────────────────────
async function handleAsk(text) {
    ui.setBusy(true);
    ui.setStatus('Thinking…');
    ui.setDot('yellow');

    let data;
    try {
        data = await brain.ask(text, personaSystem.current);
    } catch (err) {
        console.warn('Backend unavailable, using offline behavior:', err.message);
        data = brain.offlineBehavior(text, personaSystem.current);
    }

    applyBehavior(data);
    ui.setStatus('Ready');
    ui.setDot('green');
    ui.setBusy(false);
    ui.refreshSuggestions();
}

function applyBehavior(data) {
    const en = data.reply || data.text_en || '';
    const ja = data.translated_reply || data.text_ja || '';
    ui.showSpeechBubble('AVATAR', en, ja);

    // Face
    expression?.setExpression(data.expression || data.emotion || 'neutral');
    // Body
    gesture?.play(data.gesture || 'explain');
    // World
    if (data.background) backgroundSystem.load(data.background);

    // Audio + lip sync — play the persona's primary language track.
    const primary  = data.primary || 'en';
    const audioUrl = primary === 'ja'
        ? (data.audio_url_ja || data.audio_url)
        : (data.audio_url_en || data.audio_url);
    const visemes  = primary === 'ja'
        ? (data.visemes_ja  || data.visemes)
        : (data.visemes_en  || data.visemes);

    if (lipSync && audioUrl) {
        lipSync.play(BACKEND + audioUrl, visemes || []);
    }
}

// ── Avatar creator (preset-based, no external iframe) ─────────────────────────
function createAvatar({ name, style, culture, bio, image }) {
    const id = 'custom-' + Date.now();

    // Map style + culture to one of the local VRM files.
    // 'style' is either 'anime-female' | 'anime-male' | 'realistic-female' | 'realistic-male'
    const fileMap = {
        'anime-female':     '/assets/avatars/sample_a.vrm',
        'realistic-female': '/assets/avatars/sample_a.vrm',
        'anime-male':       '/assets/avatars/sample_b.vrm',
        'realistic-male':   '/assets/avatars/sample_b.vrm',
    };
    const file = fileMap[style] || '/assets/avatars/sample_a.vrm';

    // Picture: use the one the user picked, else a default per chosen style.
    // This is what "automatically adds a picture when the avatar is made".
    const thumb = image || `/assets/thumbs/style-${style}.svg`;

    const avatar = {
        id,
        name,
        handle: '@' + name.toLowerCase().replace(/\s+/g, '_'),
        bio,
        file,
        image: thumb,
        culture,
    };
    avatarList.push(avatar);
    selectAvatar(id);
    ui.showSpeechBubble('STUDIO', `Avatar "${name}" created and loaded.`, '');
}

function deleteAvatar(avatarId) {
    if (!avatarId.startsWith('custom-')) {
        ui.showSpeechBubble('SYSTEM', 'Cannot delete default avatars.', '');
        return;
    }
    const index = avatarList.findIndex((a) => a.id === avatarId);
    if (index === -1) return;

    const avatar = avatarList[index];
    avatarList.splice(index, 1);

    if (currentAvatarId === avatarId) {
        const next = avatarList[0];
        if (next) {
            selectAvatar(next.id);
        } else {
            currentAvatarId = null;
            currentVrm = null;
            expression = gesture = lipSync = null;
            ui.setStatus('No avatars available');
        }
    }
    ui.showSpeechBubble('SYSTEM', `Avatar "${avatar.name}" deleted.`, '');
}

// ── Render loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Timer();
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    gesture?.update(delta);
    expression?.update(delta);
    lipSync?.update(delta);
    if (currentVrm && typeof currentVrm.update === 'function') currentVrm.update(delta);

    orbitControls.update();
    renderer.render(scene, camera);
}

function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
    resize();
    ui.init();
    backgroundSystem.load(personaSystem.persona.background);
    await selectAvatar(currentAvatarId);
    animate();
}

document.addEventListener('DOMContentLoaded', init);
