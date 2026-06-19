/**
 * Controls — all DOM/UI wiring.
 *
 * Handles: chat input, mic, speech bubble, avatar/scenario modal,
 * in-page preset avatar creator (no iframes), suggestions, profile card.
 */
const SUGGESTIONS = [
  'How do I say thank you in Japanese?',
  'Teach me a simple greeting.',
  'Translate: nice to meet you.',
  'Tell me about Tokyo.',
  'How are you today?',
  'What is the weather like in Japan?',
  'Explain Japanese counting numbers.',
  'How do I introduce myself in Japanese?',
];

export class Controls {
  constructor(handlers) {
    this.h = handlers;
    // { onAsk, onSelectAvatar, onSelectScenario, onCreateAvatar,
    //   onDeleteAvatar, onReset, getAvatars, currentAvatarId }
    this.recognizer = null;
    this.recording  = false;
    this.lang       = 'en-US';
    this._studioImage = null;   // data URL of a picture chosen in the creator
  }

  init() {
    this._initVoice();
    this._bindInput();
    this._bindDropdown();
    this._bindModal();
    this._bindStudio();
    this._initTabs();
    this._initScenarioCards();
    this.refreshSuggestions();
  }

  // ── Input ──────────────────────────────────────────────────────────────
  _bindInput() {
    const input = document.getElementById('user-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._submit(); }
      });
      // Auto-grow textarea
      input.addEventListener('input', () => {
        input.style.height = '34px';
        input.style.height = Math.min(input.scrollHeight, 100) + 'px';
      });
    }
    document.getElementById('send-btn')?.addEventListener('click', () => this._submit());
    document.getElementById('mic-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); this.toggleVoice();
    });
  }

  _submit() {
    const input = document.getElementById('user-input');
    const text  = (input?.value || '').trim();
    if (!text) return;
    if (input) { input.value = ''; input.style.height = '34px'; }
    this.h.onAsk?.(text);
  }

  // ── Dropdown ───────────────────────────────────────────────────────────
  _bindDropdown() {
    const dropdown = document.getElementById('options-dropdown');
    document.getElementById('top-options-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); dropdown?.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown?.classList.remove('open'));
    document.getElementById('menu-restart-chat')?.addEventListener('click', () => {
      this.h.onReset?.();
      this.showSpeechBubble('SYSTEM', 'Conversation memory cleared.', '');
    });
  }

  // ── Modal ──────────────────────────────────────────────────────────────
  _bindModal() {
    const modal = document.getElementById('avatar-modal');
    document.getElementById('avatar-swap-btn')?.addEventListener('click', () =>
      this.openSelectionWindow('scenarios'));
    document.getElementById('avatar-modal-close')?.addEventListener('click', () =>
      modal?.classList.remove('open'));
    // Close on overlay click (outside .modal)
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('open');
    });
  }

  // ── Studio ─────────────────────────────────────────────────────────────
  _bindStudio() {
    document.getElementById('launch-studio-btn')?.addEventListener('click', () => this.openStudio());
    document.getElementById('close-studio-btn')?.addEventListener('click',  () => this.closeStudio());
    document.getElementById('save-studio-avatar-btn')?.addEventListener('click', () => this.saveStudioAvatar());
    // Optional picture upload — reads the chosen file into a preview + data URL.
    document.getElementById('studio-avatar-image')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      const preview = document.getElementById('studio-image-preview');
      if (!file) { this._studioImage = null; if (preview) preview.style.backgroundImage = ''; return; }
      const reader = new FileReader();
      reader.onload = () => {
        this._studioImage = reader.result;
        if (preview) preview.style.backgroundImage = `url("${reader.result}")`;
      };
      reader.readAsDataURL(file);
    });
    // The second cancel button and tile logic are in index.html inline script
    // (needed before the module loads). Nothing extra needed here.
  }

  openStudio() {
    document.getElementById('avatar-modal')?.classList.remove('open');
    // Reset form fields
    ['studio-avatar-name', 'studio-avatar-bio', 'studio-avatar-image'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this._studioImage = null;
    const preview = document.getElementById('studio-image-preview');
    if (preview) preview.style.backgroundImage = '';
    // Reset style tiles to first option
    const tiles  = document.querySelectorAll('.style-tile');
    const hidden = document.getElementById('studio-avatar-style');
    tiles.forEach((t, i) => {
      t.classList.toggle('chosen', i === 0);
      const radio = t.querySelector('input[type="radio"]');
      if (radio) radio.checked = i === 0;
    });
    if (hidden) hidden.value = 'anime-female';
    document.getElementById('studio-overlay')?.classList.add('open');
  }

  closeStudio() {
    document.getElementById('studio-overlay')?.classList.remove('open');
  }

  saveStudioAvatar() {
    const val     = (id) => (document.getElementById(id)?.value || '').trim();
    const name    = val('studio-avatar-name') || 'Custom Avatar';
    const style   = document.getElementById('studio-avatar-style')?.value || 'anime-female';
    const culture = document.getElementById('studio-avatar-lang')?.value  || 'en';
    const bio     = val('studio-avatar-bio') || 'Custom avatar.';

    if (!val('studio-avatar-name')) {
      document.getElementById('studio-avatar-name')?.focus();
      return;
    }
    this.h.onCreateAvatar?.({ name, style, culture, bio, image: this._studioImage });
    this.closeStudio();
  }

  // ── Voice input ────────────────────────────────────────────────────────
  _initVoice() {
    const Engine = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Engine) { console.warn('Speech recognition not supported.'); return; }
    this.recognizer = new Engine();
    this.recognizer.continuous      = false;
    this.recognizer.interimResults  = false;
    this.recognizer.maxAlternatives = 3;

    this.recognizer.onstart = () => {
      this.recording = true;
      const btn = document.getElementById('mic-btn');
      if (btn) { btn.classList.add('recording'); btn.textContent = '⏹'; }
      this.setStatus('Listening…');
    };
    this.recognizer.onresult = (e) => {
      const text = e.results[0][0].transcript;
      if (text) this.h.onAsk?.(text);
    };
    this.recognizer.onerror = (e) => {
      if (e.error === 'not-allowed') {
        this.showSpeechBubble('SYSTEM', 'Microphone access denied. Allow it in browser settings.', '');
      } else if (e.error === 'no-speech') {
        this.setStatus('No speech detected');
      } else if (e.error === 'audio-capture') {
        this.showSpeechBubble('SYSTEM', 'No microphone found. Please connect one.', '');
      } else {
        this.showSpeechBubble('SYSTEM', `Mic error: ${e.error}`, '');
      }
      this._stopVoiceUI();
    };
    this.recognizer.onend = () => this._stopVoiceUI();
  }

  setVoiceLang(culture) { this.lang = culture === 'ja' ? 'ja-JP' : 'en-US'; }

  toggleVoice() {
    if (!this.recognizer) { alert('Voice input needs Chrome or Edge on localhost.'); return; }
    if (this.recording) { this.recognizer.stop(); return; }
    this.recognizer.lang = this.lang;
    try { this.recognizer.start(); } catch (err) { console.error(err); }
  }

  _stopVoiceUI() {
    this.recording = false;
    const btn = document.getElementById('mic-btn');
    if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤'; }
    this.setStatus('Ready');
  }

  // ── Status / bubble / suggestions ──────────────────────────────────────
  setStatus(msg) { const el = document.getElementById('status-text'); if (el) el.textContent = msg; }
  setDot(c)      { const el = document.getElementById('status-dot');  if (el) el.className = `dot ${c}`; }
  setBusy(b)     { const btn = document.getElementById('send-btn');   if (btn) btn.disabled = b; }

  showSpeechBubble(lang, en, ja) {
    const bubble = document.getElementById('speech-bubble');
    if (!bubble) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('speech-lang', lang);
    set('speech-en',   en);
    const jaEl = document.getElementById('speech-ja');
    if (jaEl) {
      if (ja) { jaEl.textContent = ja; jaEl.style.display = 'block'; }
      else      { jaEl.style.display = 'none'; }
    }
    bubble.classList.add('visible');
  }

  refreshSuggestions() {
    const container = document.getElementById('suggestions');
    if (!container) return;
    container.innerHTML = '';
    [...SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 2).forEach((p) => {
      const btn = document.createElement('button');
      btn.className   = 'suggest-btn';
      btn.textContent = p;
      btn.addEventListener('click', () => this.h.onAsk?.(p));
      container.appendChild(btn);
    });
  }

  // ── Profile card ───────────────────────────────────────────────────────
  setProfile({ name, handle, bio }) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('avatar-name',   name);
    set('avatar-handle', handle);
    set('avatar-bio',    bio);
  }

  // ── Selection modal ────────────────────────────────────────────────────
  openSelectionWindow(tab) {
    this.buildAvatarStack();
    document.getElementById('avatar-modal')?.classList.add('open');
    this._switchTab(tab);
  }

  // Builds a thumbnail that shows a picture when one is available and
  // gracefully falls back to a colored gradient if the image is missing.
  _thumbHtml(imageUrl, gradient) {
    const img = imageUrl
      ? `<img class="pick-thumb-img" src="${imageUrl}" alt="" loading="lazy"
             onload="this.classList.add('loaded')" onerror="this.remove()" />`
      : '';
    return `<div class="pick-thumb" style="background:${gradient}">${img}</div>`;
  }

  buildAvatarStack() {
    const grid = document.getElementById('avatar-picker-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const avatars   = this.h.getAvatars?.() || [];
    const currentId = this.h.currentAvatarId?.();
    const palette   = ['#5a3d7a', '#3d5a7a', '#7a5a3d', '#3d7a5a', '#7a3d5a', '#3d7a7a'];

    avatars.forEach((a, i) => {
      const card     = document.createElement('div');
      card.className = `pick-card${a.id === currentId ? ' active' : ''}`;
      const tint     = palette[i % palette.length];
      const isCustom = a.id.startsWith('custom-');
      const gradient = `radial-gradient(circle at 30% 30%,${tint},#0b0b14)`;

      card.innerHTML = `
        ${this._thumbHtml(a.image, gradient)}
        <div class="pick-card-body">
          <div class="pick-card-title">${a.name}${isCustom ? ' <span style="font-size:0.58em;opacity:0.55">(Custom)</span>' : ''}</div>
          <div class="pick-card-desc">${a.bio}</div>
          <div style="display:flex;gap:7px;margin-top:8px;flex-wrap:wrap">
            <button class="enter-scene-btn">Enter Scene</button>
            ${isCustom ? `<button class="delete-btn" style="padding:6px 12px;border-radius:999px;border:none;background:#ef4444;color:#fff;font-size:0.7rem;font-weight:700;cursor:pointer">Delete</button>` : ''}
          </div>
        </div>`;

      const choose = () => {
        grid.querySelectorAll('.pick-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        this.h.onSelectAvatar?.(a.id);
        document.getElementById('avatar-modal')?.classList.remove('open');
      };

      card.addEventListener('click', choose);
      card.querySelector('.enter-scene-btn')?.addEventListener('click', (e) => {
        e.stopPropagation(); choose();
      });

      if (isCustom) {
        card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Delete avatar "${a.name}"?`)) {
            this.h.onDeleteAvatar?.(a.id);
            this.buildAvatarStack();
          }
        });
      }
      grid.appendChild(card);
    });
  }

  _initTabs() {
    document.getElementById('tab-trigger-scenarios')?.addEventListener('click', () => this._switchTab('scenarios'));
    document.getElementById('tab-trigger-characters')?.addEventListener('click', () => this._switchTab('characters'));
  }

  _switchTab(tab) {
    const scen = tab === 'scenarios';
    document.getElementById('tab-trigger-scenarios')?.classList.toggle('active',  scen);
    document.getElementById('tab-trigger-characters')?.classList.toggle('active', !scen);
    document.getElementById('tab-content-scenarios')?.classList.toggle('active',  scen);
    document.getElementById('tab-content-characters')?.classList.toggle('active', !scen);
    const title = document.getElementById('modal-title');
    if (title) title.textContent = scen ? 'Discover New Scenarios' : 'Discover New Characters';
    // "Create Avatar" belongs to Characters only — hide it on the Scenario tab.
    const studioBtn = document.getElementById('launch-studio-btn');
    if (studioBtn) studioBtn.style.display = scen ? 'none' : '';
    if (!scen) this.buildAvatarStack();   // refresh whenever Characters tab opens
  }

  _initScenarioCards() {
    document.querySelectorAll('#scenario-picker-grid .pick-card').forEach((card) => {
      const choose = () => {
        document.querySelectorAll('#scenario-picker-grid .pick-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        this.h.onSelectScenario?.(card.getAttribute('data-scenario'));
        document.getElementById('avatar-modal')?.classList.remove('open');
      };
      card.addEventListener('click', choose);
      card.querySelector('.enter-scene-btn')?.addEventListener('click', (e) => {
        e.stopPropagation(); choose();
      });
    });
  }
}
