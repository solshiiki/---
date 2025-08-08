// Utility: date helpers
function toISODate(date) {
  return date.toISOString().slice(0, 10);
}
function fromISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function clampDateToToday(iso) {
  const today = new Date();
  const isoToday = toISODate(today);
  return iso > isoToday ? isoToday : iso;
}

// Questions pool
const DAILY_QUESTIONS = [
  'Что я понял(а) о жизни сегодня?',
  'Какой момент дня был по-настоящему живым?',
  'Где сегодня я проявил(а) человечность?',
  'Что сегодня вызвало благодарность?',
  'Что я готов(а) отпустить?',
  'Какой страх я заметил(а) и признал(а)?',
  'Чему я учусь прямо сейчас?',
  'Что я сделал(а) хорошо, даже если это мало заметно?',
  'Какая мысль повторялась чаще всего?',
  'Как я поддержал(а) себя или других?'
];

// Storage & Encryption
const STORAGE_KEYS = {
  plain: 'journal.entries',
  encrypted: 'journal.encrypted',
  cipher: 'journal.ciphertext',
  iv: 'journal.iv',
  salt: 'journal.salt',
  questionIndex: 'journal.questionIndex'
};

let inMemoryEntries = []; // decrypted entries
let isEncrypted = false;
let isUnlocked = true; // if encrypted, requires unlock

// Crypto helpers
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: 120_000
    },
    passKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptEntries(password, entries) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(entries));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { salt, iv, ciphertext: new Uint8Array(ciphertext) };
}

async function decryptEntries(password, salt, iv, ciphertext) {
  const key = await deriveKey(password, salt);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(new Uint8Array(plaintext)));
}

function b64encode(uint8) {
  return btoa(String.fromCharCode(...uint8));
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Persistence
function loadState() {
  isEncrypted = localStorage.getItem(STORAGE_KEYS.encrypted) === 'true';
  if (!isEncrypted) {
    const raw = localStorage.getItem(STORAGE_KEYS.plain);
    inMemoryEntries = raw ? JSON.parse(raw) : [];
    isUnlocked = true;
  } else {
    inMemoryEntries = [];
    isUnlocked = false;
  }
}

async function persistPlain() {
  localStorage.setItem(STORAGE_KEYS.plain, JSON.stringify(inMemoryEntries));
}

async function persistEncrypted(password) {
  const { salt, iv, ciphertext } = await encryptEntries(password, inMemoryEntries);
  localStorage.setItem(STORAGE_KEYS.encrypted, 'true');
  localStorage.setItem(STORAGE_KEYS.salt, b64encode(salt));
  localStorage.setItem(STORAGE_KEYS.iv, b64encode(iv));
  localStorage.setItem(STORAGE_KEYS.cipher, b64encode(ciphertext));
  // Remove plain
  localStorage.removeItem(STORAGE_KEYS.plain);
}

function getEntryByDate(iso) {
  return inMemoryEntries.find(e => e.date === iso);
}

function upsertEntry({ date, text, tags }) {
  const existing = getEntryByDate(date);
  if (existing) {
    existing.text = text;
    existing.tags = tags;
    existing.updatedAt = new Date().toISOString();
  } else {
    inMemoryEntries.push({ date, text, tags, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
}

// UI Elements
const datePicker = document.getElementById('datePicker');
const prevDayBtn = document.getElementById('prevDayBtn');
const nextDayBtn = document.getElementById('nextDayBtn');
const todayBtn = document.getElementById('todayBtn');
const questionText = document.getElementById('questionText');
const shuffleQuestionBtn = document.getElementById('shuffleQuestionBtn');
const entryText = document.getElementById('entryText');
const tagsInput = document.getElementById('tagsInput');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const memoryRibbon = document.getElementById('memoryRibbon');
const ribbonRange = document.getElementById('ribbonRange');
const meaningTreeSvg = document.getElementById('meaningTree');
const treeThresholdRange = document.getElementById('treeThreshold');

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const enableEncryptionChk = document.getElementById('enableEncryptionChk');
const encryptionFields = document.getElementById('encryptionFields');
const encryptionManage = document.getElementById('encryptionManage');
const encryptionPass = document.getElementById('encryptionPass');
const encryptionPass2 = document.getElementById('encryptionPass2');
const applyEncryptionBtn = document.getElementById('applyEncryptionBtn');
const lockNowBtn = document.getElementById('lockNowBtn');
const disableEncryptionBtn = document.getElementById('disableEncryptionBtn');

const unlockModal = document.getElementById('unlockModal');
const unlockPass = document.getElementById('unlockPass');
const unlockBtn = document.getElementById('unlockBtn');
const unlockError = document.getElementById('unlockError');
const unlockForm = document.getElementById('unlockForm');

// Question rotation
function loadQuestion() {
  const idxRaw = localStorage.getItem(STORAGE_KEYS.questionIndex);
  const idx = idxRaw ? Number(idxRaw) : 0;
  questionText.textContent = DAILY_QUESTIONS[idx % DAILY_QUESTIONS.length];
}
function shuffleQuestion() {
  const idx = Math.floor(Math.random() * DAILY_QUESTIONS.length);
  localStorage.setItem(STORAGE_KEYS.questionIndex, String(idx));
  loadQuestion();
}

// Navigation
function setDate(iso) {
  const clamped = clampDateToToday(iso);
  datePicker.value = clamped;
  loadEntryIntoEditor(clamped);
}

function deltaDay(iso, delta) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + delta);
  return clampDateToToday(toISODate(d));
}

function loadEntryIntoEditor(iso) {
  const e = getEntryByDate(iso);
  entryText.value = e?.text ?? '';
  tagsInput.value = e?.tags?.join(', ') ?? '';
  renderRibbon();
}

// Saving
function parseTags(input, text) {
  const explicit = input
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.toLowerCase());
  if (explicit.length) return [...new Set(explicit)];
  // Fallback rudimentary keyword extraction from text
  const stop = new Set(['и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты','к','у','же','вы','за','бы','по','ее','мне','есть','если','они','тут','где','когда','ни','ему','сам','чтоб','без','будто','чего','раз','тоже','себя','ничего','ей','может','они','быть']);
  const words = (text || '').toLowerCase().replace(/[—–\-.,!?"()\n\r]/g, ' ').split(/\s+/).filter(Boolean);
  const freq = new Map();
  for (const w of words) {
    if (w.length < 4 || stop.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...[...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([w])=>w)];
}

async function saveCurrent() {
  const iso = datePicker.value;
  const text = entryText.value.trim();
  const tags = parseTags(tagsInput.value, text);
  upsertEntry({ date: iso, text, tags });
  if (!isEncrypted) {
    await persistPlain();
    saveStatus.textContent = 'Сохранено локально';
  } else {
    // If encrypted but not unlocked, cannot save; enforce unlock first
    if (!isUnlocked) {
      saveStatus.textContent = 'Разблокируйте, чтобы сохранить';
      return;
    }
    const currentPassword = sessionPasswordCache.get();
    if (!currentPassword) {
      saveStatus.textContent = 'Нет пароля сессии';
      return;
    }
    await persistEncrypted(currentPassword);
    saveStatus.textContent = 'Сохранено (зашифровано)';
  }
  renderRibbon();
  renderMeaningTree();
}

// Ribbon
function renderRibbon() {
  const days = Number(ribbonRange.value);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));

  memoryRibbon.innerHTML = '';
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = toISODate(d);
    const e = getEntryByDate(iso);
    const div = document.createElement('div');
    div.className = 'ribbon-item' + (e ? ' answered' : '') + (iso === toISODate(new Date()) ? ' today' : '');
    div.title = iso;
    div.addEventListener('click', () => setDate(iso));

    const tip = document.createElement('div');
    tip.className = 'tooltip';
    let preview = e?.text?.slice(0, 60) || 'Нет записи';
    if (e?.text && e.text.length > 60) preview += '…';
    tip.textContent = `${iso} · ${preview}`;
    div.appendChild(tip);

    memoryRibbon.appendChild(div);
  }
}

// Meaning Tree (simple radial co-occurrence graph)
function computeTagGraph() {
  const tagsByEntry = inMemoryEntries.map(e => new Set(e.tags || []));
  const tagFreq = new Map();
  for (const set of tagsByEntry) {
    for (const t of set) tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
  }
  const tags = [...tagFreq.keys()];
  const edges = new Map(); // key "a|b" => weight
  for (const set of tagsByEntry) {
    const arr = [...set];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]; const b = arr[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
  }
  return { tagFreq, edges };
}

function renderMeaningTree() {
  const threshold = Number(treeThresholdRange.value);
  const { tagFreq, edges } = computeTagGraph();
  const svg = meaningTreeSvg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const width = svg.viewBox.baseVal?.width || 800;
  const height = svg.viewBox.baseVal?.height || 500;
  const cx = width / 2; const cy = height / 2; const radius = Math.min(width, height) * 0.4;

  const tags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).map(([t, f]) => ({ tag: t, freq: f }));
  if (tags.length === 0) return;

  const angleStep = (Math.PI * 2) / tags.length;
  const positions = new Map();
  tags.forEach((item, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    positions.set(item.tag, { x, y, freq: item.freq });
  });

  // Draw edges over threshold
  for (const [key, w] of edges.entries()) {
    if (w < threshold) continue;
    const [a, b] = key.split('|');
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (!pa || !pb) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', pa.x);
    line.setAttribute('y1', pa.y);
    line.setAttribute('x2', pb.x);
    line.setAttribute('y2', pb.y);
    line.setAttribute('stroke-width', String(1 + Math.min(4, w)));
    line.setAttribute('class', 'link');
    svg.appendChild(line);
  }

  // Draw nodes and labels
  const maxFreq = Math.max(...tags.map(t => t.freq));
  for (const { tag, freq } of tags) {
    const p = positions.get(tag);
    const r = 6 + Math.round((freq / maxFreq) * 12);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', String(r));
    circle.setAttribute('class', 'node' + (freq === maxFreq ? ' tag-major' : ''));
    circle.addEventListener('click', () => focusTag(tag));
    circle.setAttribute('tabindex', '0');
    circle.setAttribute('role', 'button');
    circle.setAttribute('aria-label', `Тег ${tag}, встречается ${freq}`);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', p.x);
    text.setAttribute('y', p.y - (r + 10));
    text.setAttribute('class', 'node-label');
    text.textContent = tag;

    svg.appendChild(circle);
    svg.appendChild(text);
  }
}

function focusTag(tag) {
  // When clicking on a tag node, jump to most recent date with that tag
  const filtered = inMemoryEntries
    .filter(e => (e.tags || []).includes(tag))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (filtered.length) {
    setDate(filtered[0].date);
  }
}

// Settings & Encryption UI
function refreshSettingsUI() {
  if (!isEncrypted) {
    enableEncryptionChk.checked = false;
    encryptionFields.classList.toggle('hidden', !enableEncryptionChk.checked);
    encryptionManage.classList.add('hidden');
  } else {
    enableEncryptionChk.checked = true;
    encryptionFields.classList.add('hidden');
    encryptionManage.classList.remove('hidden');
  }
}

const sessionPasswordCache = (function(){
  let value = null;
  return {
    set(pass){ value = pass; },
    get(){ return value; },
    clear(){ value = null; }
  };
})();

async function handleApplyEncryption() {
  const pass = encryptionPass.value;
  const pass2 = encryptionPass2.value;
  if (!pass || pass.length < 6) { alert('Минимальная длина пароля — 6 символов.'); return; }
  if (pass !== pass2) { alert('Пароли не совпадают.'); return; }
  await persistEncrypted(pass);
  isEncrypted = true;
  isUnlocked = true; // entries are encrypted in storage, but current session has the pass
  sessionPasswordCache.set(pass);
  refreshSettingsUI();
  saveStatus.textContent = 'Шифрование включено';
}

function handleLockNow() {
  sessionPasswordCache.clear();
  isUnlocked = false;
  entryText.value = '';
  tagsInput.value = '';
  openUnlockModal();
}

async function handleDisableEncryption() {
  if (!confirm('Отключить шифрование? Данные будут сохранены в открытом виде на этом устройстве.')) return;
  // Need password to decrypt current storage
  if (!isUnlocked) {
    openUnlockModal(() => handleDisableEncryption());
    return;
  }
  // Save plain
  await persistPlain();
  localStorage.removeItem(STORAGE_KEYS.encrypted);
  localStorage.removeItem(STORAGE_KEYS.cipher);
  localStorage.removeItem(STORAGE_KEYS.iv);
  localStorage.removeItem(STORAGE_KEYS.salt);
  isEncrypted = false;
  refreshSettingsUI();
  saveStatus.textContent = 'Шифрование отключено';
}

function openUnlockModal(after = null) {
  unlockError.classList.add('hidden');
  unlockPass.value = '';
  unlockModal.showModal();
  const onSubmit = async (e) => {
    e?.preventDefault();
    const pass = unlockPass.value;
    try {
      const salt = b64decode(localStorage.getItem(STORAGE_KEYS.salt) || '');
      const iv = b64decode(localStorage.getItem(STORAGE_KEYS.iv) || '');
      const ciphertext = b64decode(localStorage.getItem(STORAGE_KEYS.cipher) || '');
      const entries = await decryptEntries(pass, salt, iv, ciphertext);
      inMemoryEntries = entries;
      isUnlocked = true;
      sessionPasswordCache.set(pass);
      unlockError.classList.add('hidden');
      unlockModal.close();
      renderRibbon();
      renderMeaningTree();
      if (after) after();
    } catch (err) {
      console.error(err);
      unlockError.classList.remove('hidden');
    }
  };
  unlockForm.onsubmit = onSubmit;
  unlockBtn.onclick = onSubmit;
}

// Export
function download(filename, content, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function exportJSON() {
  if (isEncrypted && !isUnlocked) { openUnlockModal(exportJSON); return; }
  const data = JSON.stringify(inMemoryEntries, null, 2);
  download(`journal-${toISODate(new Date())}.json`, data, 'application/json');
}

function exportMarkdown() {
  if (isEncrypted && !isUnlocked) { openUnlockModal(exportMarkdown); return; }
  const lines = ['# Дневник', ''];
  const sorted = [...inMemoryEntries].sort((a,b)=>a.date.localeCompare(b.date));
  for (const e of sorted) {
    const tags = (e.tags || []).map(t => `#${t}`).join(' ');
    lines.push(`## ${e.date}`);
    if (tags) lines.push(tags);
    if (e.text) lines.push('', e.text, '');
  }
  download(`journal-${toISODate(new Date())}.md`, lines.join('\n'), 'text/markdown');
}

// Init
function initDate() {
  const today = toISODate(new Date());
  datePicker.value = today;
}

function attachEvents() {
  prevDayBtn.addEventListener('click', () => setDate(deltaDay(datePicker.value, -1)));
  nextDayBtn.addEventListener('click', () => setDate(deltaDay(datePicker.value, +1)));
  todayBtn.addEventListener('click', () => setDate(toISODate(new Date())));
  datePicker.addEventListener('change', () => setDate(datePicker.value));

  shuffleQuestionBtn.addEventListener('click', shuffleQuestion);

  saveBtn.addEventListener('click', saveCurrent);
  document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);
  document.getElementById('exportMdBtn').addEventListener('click', exportMarkdown);
  entryText.addEventListener('input', () => { saveStatus.textContent = '…'; });
  tagsInput.addEventListener('input', () => { saveStatus.textContent = '…'; });

  ribbonRange.addEventListener('change', renderRibbon);
  treeThresholdRange.addEventListener('input', renderMeaningTree);

  settingsBtn.addEventListener('click', () => settingsModal.showModal());
  settingsModal.addEventListener('close', () => {
    encryptionPass.value = '';
    encryptionPass2.value = '';
  });

  enableEncryptionChk.addEventListener('change', () => {
    encryptionFields.classList.toggle('hidden', !enableEncryptionChk.checked);
  });
  applyEncryptionBtn.addEventListener('click', () => { handleApplyEncryption(); });
  lockNowBtn.addEventListener('click', () => { handleLockNow(); });
  disableEncryptionBtn.addEventListener('click', () => { handleDisableEncryption(); });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrent();
    }
  });
}

function initialRender() {
  renderRibbon();
  renderMeaningTree();
}

async function boot() {
  loadState();
  initDate();
  loadQuestion();
  attachEvents();
  refreshSettingsUI();
  initialRender();

  if (isEncrypted && !isUnlocked) {
    openUnlockModal();
  }
}

boot();