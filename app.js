/* ── Constants ───────────────────────────────────────────── */
const CUISINES = [
  'Italian','Thai','Mexican','Japanese','Indian','Mediterranean',
  'American','Chinese','French','Greek','Korean','Vietnamese',
  'Middle Eastern','Spanish','Ethiopian','Moroccan','Custom',
];

const SYSTEM_RECIPE = `You are a recipe suggestion assistant with deep knowledge of global cooking.
Always respond with valid JSON only — no markdown fences, no extra text, no explanation.`;

const SYSTEM_UTILITY = `You are a helpful cooking assistant.
Always respond with valid JSON only — no markdown fences, no extra text.`;

/* ── Global lookups (avoids inline data escaping in onclick) */
let g_recipes  = [];   // last set of suggested recipes
let g_favsList = [];   // favorites currently rendered

/* ── State ───────────────────────────────────────────────── */
const state = {
  selectedCuisines: new Set(),
  uploadedPhotos: [],   // { dataUrl, mediaType }
};

/* ── Storage ─────────────────────────────────────────────── */
const Storage = {
  getProfile() {
    try { return JSON.parse(localStorage.getItem('rf_profile') || '{}'); }
    catch { return {}; }
  },
  saveProfile(p) { localStorage.setItem('rf_profile', JSON.stringify(p)); },
  getFavorites() {
    try { return JSON.parse(localStorage.getItem('rf_favorites') || '[]'); }
    catch { return []; }
  },
  saveFavorites(list) { localStorage.setItem('rf_favorites', JSON.stringify(list)); },
  addFavorite(fav) {
    const list = this.getFavorites();
    list.unshift({ ...fav, id: Date.now() });
    this.saveFavorites(list);
    return list;
  },
  removeFavorite(id) {
    const list = this.getFavorites().filter(f => f.id !== id);
    this.saveFavorites(list);
    return list;
  },
};

/* ── API ─────────────────────────────────────────────────── */
const API = {
  async call(messages, system) {
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API request failed');
    return data.content;
  },

  parseJSON(text) {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  },

  async suggestRecipes(filters, profile) {
    const nytRule = profile.allowNYT
      ? ''
      : 'NEVER include cooking.nytimes.com (NYT Cooking) links — they are paywalled.';

    const prompt = `Suggest exactly 5 recipes with these preferences:

CUISINE: ${filters.cuisines.length ? (filters.cuisines.includes('custom') ? `Custom — ${filters.customCuisine}` : filters.cuisines.join(', ')) : 'any'}
COOK TIME: ${filters.cookTime !== 'any' ? filters.cookTime : 'no restriction'}
SKILL LEVEL (ceiling — recipes at or below this level are acceptable): ${filters.skillLevel !== 'any' ? filters.skillLevel : 'any'}
PORTIONS: ${filters.portions} servings
${filters.dessert ? 'DESSERT ONLY — suggest dessert recipes specifically.' : ''}
${filters.healthier ? 'Prefer nutritious, health-conscious options.' : ''}
${filters.ingredients ? `MUST incorporate these ingredients: ${filters.ingredients}` : ''}
${filters.occasion ? `OCCASION: ${filters.occasion}` : ''}
${filters.notes ? `NOTES: ${filters.notes}` : ''}

HARD RULES (strictly enforced):
${profile.allergies ? `• ALLERGIES — NEVER include: ${profile.allergies}. Set allergyWarning if anything is borderline.` : '• No allergy restrictions.'}
${profile.dislikes ? `• DISLIKES — never surface recipes containing: ${profile.dislikes}` : ''}
${profile.spice ? `• SPICE ceiling is "${profile.spice}". Recipes up to that heat level are fine; do not suggest spicier.` : ''}
${profile.equipment && profile.equipment.length ? `• User has: ${profile.equipment.join(', ')}. Prefer recipes that use this equipment.` : ''}
${nytRule}

VARIETY: include 3-4 familiar comfort dishes and 1-2 adventurous/lesser-known picks (set isAdventurous:true for those).

Return ONLY valid JSON — no markdown, no extra keys:
{
  "recipes": [
    {
      "name": "string",
      "cuisine": "string",
      "estimatedTime": "string (e.g. '35 minutes')",
      "difficulty": "beginner|intermediate|advanced",
      "description": "One sentence.",
      "isAdventurous": false,
      "allergyWarning": null
    }
  ]
}`;

    const raw = await this.call([{ role: 'user', content: prompt }], SYSTEM_RECIPE);
    return this.parseJSON(raw);
  },

  async getShoppingList(recipeName, extraDetails) {
    const prompt = `Generate a complete shopping list for: ${recipeName}
${extraDetails ? `\nRecipe context: ${extraDetails}` : ''}

Return ONLY this JSON:
{
  "recipeName": "string",
  "servings": 4,
  "ingredients": [
    { "category": "Produce",       "items": ["2 cloves garlic"] },
    { "category": "Meat & Seafood","items": [] },
    { "category": "Dairy & Eggs",  "items": [] },
    { "category": "Pantry",        "items": [] },
    { "category": "Other",         "items": [] }
  ]
}
Omit categories with no items. Be specific with quantities.`;

    const raw = await this.call([{ role: 'user', content: prompt }], SYSTEM_UTILITY);
    return this.parseJSON(raw);
  },

  async getVariants(recipeName, description) {
    const prompt = `Suggest 4 recipe variants that are similar to but meaningfully different from: "${recipeName}"
${description ? `Description: ${description}` : ''}

Each variant should share DNA (cuisine, technique, or flavour profile) but offer something distinct.

Return ONLY this JSON:
{
  "variants": [
    {
      "name": "string",
      "cuisine": "string",
      "estimatedTime": "string",
      "difficulty": "beginner|intermediate|advanced",
      "description": "One sentence.",
      "difference": "Brief note on how it differs."
    }
  ]
}`;

    const raw = await this.call([{ role: 'user', content: prompt }], SYSTEM_UTILITY);
    return this.parseJSON(raw);
  },

  async extractFromPhotos(photos) {
    const content = [
      ...photos.map(p => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.mediaType,
          data: p.dataUrl.split(',')[1],
        },
      })),
      {
        type: 'text',
        text: `Extract the recipe from these images. Multiple images may show different parts of the same recipe.

Return ONLY this JSON:
{
  "recipeName": "string",
  "description": "Brief description.",
  "estimatedTime": "string or null",
  "difficulty": "beginner|intermediate|advanced|null",
  "servings": "string or null",
  "ingredients": ["ingredient 1", "ingredient 2"],
  "notes": "Any tips or notes, or null"
}`,
      },
    ];

    const raw = await this.call([{ role: 'user', content }], SYSTEM_UTILITY);
    return this.parseJSON(raw);
  },
};

/* ── UI utilities ────────────────────────────────────────── */
function showToast(msg, type = 'default') {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : '');
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

function setBusy(btn, textEl, spinnerEl, busy, idleLabel) {
  btn.disabled = busy;
  textEl.textContent = busy ? '' : idleLabel;
  spinnerEl.classList.toggle('hidden', !busy);
}

function loadingHTML(msg) {
  return `<div class="loading-state">
    <div>${esc(msg)}</div>
    <div class="loading-dots"><span></span><span></span><span></span></div>
  </div>`;
}


const LINK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
</svg>`;

/* ── Helpers ─────────────────────────────────────────────── */
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function isValidUrl(s) { try { new URL(s); return true; } catch { return false; } }

function recipeSearchLinks(name) {
  const encoded = encodeURIComponent(name).replace(/%20/g, '+');
  return {
    google:      `https://www.google.com/search?q=${encoded}+recipe`,
    allrecipes:  `https://www.allrecipes.com/search?q=${encoded}`,
  };
}

function searchLinksHTML(name) {
  const { google, allrecipes } = recipeSearchLinks(name);
  return `<a href="${esc(google)}" target="_blank" rel="noopener noreferrer" class="link-primary">
    Google ${LINK_ICON}</a>
  <a href="${esc(allrecipes)}" target="_blank" rel="noopener noreferrer" class="link-alt">
    AllRecipes ${LINK_ICON}</a>`;
}

/* ── Settings ────────────────────────────────────────────── */
function loadSettingsIntoForm() {
  const p = Storage.getProfile();
  document.querySelectorAll('input[name="equipment"]').forEach(cb => {
    cb.checked = Array.isArray(p.equipment) && p.equipment.includes(cb.value);
  });
  document.getElementById('dislikes-input').value  = p.dislikes  || '';
  document.getElementById('allergies-input').value = p.allergies || '';
  const spice = document.querySelector(`input[name="spice"][value="${p.spice || 'medium'}"]`);
  if (spice) spice.checked = true;
  document.getElementById('allow-nyt-check').checked = !!p.allowNYT;
}

function saveSettingsFromForm() {
  const equipment = [...document.querySelectorAll('input[name="equipment"]:checked')].map(cb => cb.value);
  const spiceEl   = document.querySelector('input[name="spice"]:checked');
  Storage.saveProfile({
    equipment,
    dislikes:  document.getElementById('dislikes-input').value.trim(),
    allergies: document.getElementById('allergies-input').value.trim(),
    spice:     spiceEl ? spiceEl.value : 'medium',
    allowNYT:  document.getElementById('allow-nyt-check').checked,
  });
  showToast('Settings saved', 'success');
  closeModal('settings-modal');
}

/* ── Cuisine pills ───────────────────────────────────────── */
function buildCuisinePills() {
  const container = document.getElementById('cuisine-pills');
  CUISINES.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'cuisine-pill';
    btn.textContent = name;
    btn.dataset.cuisine = name.toLowerCase();
    btn.addEventListener('click', () => {
      const key = name.toLowerCase();
      if (state.selectedCuisines.has(key)) {
        state.selectedCuisines.delete(key);
        btn.classList.remove('active');
      } else {
        state.selectedCuisines.add(key);
        btn.classList.add('active');
      }
      document.getElementById('custom-cuisine-wrap')
        .classList.toggle('hidden', !state.selectedCuisines.has('custom'));
    });
    container.appendChild(btn);
  });
}

/* ── Recipe search ───────────────────────────────────────── */
async function handleFindRecipes() {
  const btn     = document.getElementById('find-btn');
  const btnText = document.getElementById('find-btn-text');
  const spinner = document.getElementById('find-btn-spinner');
  setBusy(btn, btnText, spinner, true, 'Find Recipes');
  btnText.textContent = 'Finding…';
  spinner.classList.remove('hidden');

  const resultsSection = document.getElementById('results-section');
  const resultsGrid    = document.getElementById('results-grid');
  resultsSection.classList.remove('hidden');
  resultsGrid.innerHTML = loadingHTML('Asking Claude for ideas…');

  try {
    const filters = {
      cuisines:      [...state.selectedCuisines],
      customCuisine: document.getElementById('custom-cuisine-input').value.trim(),
      cookTime:      document.getElementById('cook-time').value,
      skillLevel:    document.getElementById('skill-level').value,
      portions:      document.getElementById('portions').value,
      dessert:       document.getElementById('dessert-check').checked,
      healthier:     document.getElementById('healthier-check').checked,
      ingredients:   document.getElementById('ingredients-input').value.trim(),
      occasion:      document.getElementById('occasion-input').value.trim(),
      notes:         document.getElementById('notes-input').value.trim(),
    };
    const data = await API.suggestRecipes(filters, Storage.getProfile());
    g_recipes = data.recipes || [];
    renderRecipes(g_recipes);
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    g_recipes = [];
    resultsGrid.innerHTML = `<div class="empty-state" style="color:var(--error)">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Find Recipes';
    spinner.classList.add('hidden');
  }
}

function renderRecipes(recipes) {
  const grid = document.getElementById('results-grid');
  if (!recipes.length) {
    grid.innerHTML = '<p class="empty-state">No results — try adjusting your filters.</p>';
    return;
  }
  grid.innerHTML = recipes.map((r, i) => `<div class="recipe-card">
    <div class="recipe-card-header">
      <div class="recipe-name">${esc(r.name)}</div>
      <div class="recipe-badges">
        <span class="badge badge-cuisine">${esc(r.cuisine)}</span>
        ${r.isAdventurous ? '<span class="badge badge-adventurous">✦ Adventurous</span>' : ''}
        ${r.allergyWarning ? `<span class="badge badge-warning">⚠ ${esc(r.allergyWarning)}</span>` : ''}
      </div>
    </div>
    <div class="recipe-meta">
      <span class="meta-item"><span class="meta-icon">⏱</span> ${esc(r.estimatedTime)}</span>
      <span class="meta-item"><span class="meta-icon">📊</span> ${cap(r.difficulty)}</span>
    </div>
    <p class="recipe-description">${esc(r.description)}</p>
    <div class="recipe-links">
      <div class="recipe-links-label">Find this recipe</div>
      <div class="links-row">${searchLinksHTML(r.name)}</div>
    </div>
    <div class="recipe-actions">
      <button class="btn-ghost" data-action="shopping" data-idx="${i}">🛒 Shopping List</button>
      <button class="btn-ghost" data-action="save"     data-idx="${i}">♡ Save</button>
    </div>
  </div>`).join('');
}

/* ── Delegated click handler (recipe cards + favorite cards) */
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const idx    = parseInt(btn.dataset.idx, 10);

  // ── Recipe result actions ──
  if (action === 'shopping') {
    const r = g_recipes[idx];
    if (r) handleShoppingList(r.name, r.description);
    return;
  }
  if (action === 'save') {
    if (btn.dataset.saved) return;
    const r = g_recipes[idx];
    if (!r) return;
    Storage.addFavorite({
      name: r.name, source: 'suggestion',
      description: r.description,
      cuisine: r.cuisine, estimatedTime: r.estimatedTime, difficulty: r.difficulty,
    });
    btn.textContent  = '♥ Saved';
    btn.dataset.saved = '1';
    btn.disabled     = true;
    showToast(`"${r.name}" saved to favorites`, 'success');
    updateFavCount();
    return;
  }

  // ── Favorite card actions ──
  const fav = g_favsList[idx];
  if (!fav) return;

  if (action === 'variants-fav') {
    handleVariants(fav.name, fav.description || '');
    return;
  }
  if (action === 'shopping-fav') {
    const extra = [fav.description, fav.ingredients ? fav.ingredients.slice(0,6).join(', ') : '']
      .filter(Boolean).join(' | ');
    handleShoppingList(fav.name, extra);
    return;
  }
  if (action === 'remove-fav') {
    Storage.removeFavorite(fav.id);
    updateFavCount();
    renderFavorites();
    showToast('Removed from favorites');
  }
});

/* ── Shopping list ───────────────────────────────────────── */
async function handleShoppingList(recipeName, extraDetails) {
  document.getElementById('shopping-title').textContent = `Shopping List — ${recipeName}`;
  const body = document.getElementById('shopping-body');
  body.innerHTML = loadingHTML('Building your list…');
  openModal('shopping-modal');

  try {
    const data = await API.getShoppingList(recipeName, extraDetails);
    renderShoppingList(data);
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="color:var(--error)">${esc(err.message)}</div>`;
  }
}

function renderShoppingList(data) {
  const body = document.getElementById('shopping-body');
  const cats = (data.ingredients || []).filter(c => c.items && c.items.length);
  if (!cats.length) { body.innerHTML = '<p class="empty-state">No ingredients found.</p>'; return; }
  body.innerHTML = cats.map(cat => `
    <div class="shopping-category">
      <div class="shopping-category-name">${esc(cat.category)}</div>
      ${cat.items.map(item => `<div class="shopping-item">${esc(item)}</div>`).join('')}
    </div>`).join('');
}

function copyShoppingList() {
  const lines = [];
  document.getElementById('shopping-body').querySelectorAll('.shopping-category').forEach(cat => {
    lines.push(cat.querySelector('.shopping-category-name').textContent.toUpperCase());
    cat.querySelectorAll('.shopping-item').forEach(el =>
      lines.push('• ' + el.textContent.trim().replace(/^[·•]\s*/, '')));
    lines.push('');
  });
  navigator.clipboard.writeText(lines.join('\n').trim())
    .then(() => showToast('Copied!', 'success'))
    .catch(() => showToast('Copy failed — select and copy manually', 'error'));
}

/* ── Variants ────────────────────────────────────────────── */
async function handleVariants(recipeName, description) {
  document.getElementById('variants-title').textContent = `Similar to: ${recipeName}`;
  const body = document.getElementById('variants-body');
  body.innerHTML = loadingHTML('Finding similar recipes…');
  openModal('variants-modal');

  try {
    const data = await API.getVariants(recipeName, description);
    renderVariants(data.variants || []);
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="color:var(--error)">${esc(err.message)}</div>`;
  }
}

function renderVariants(variants) {
  const body = document.getElementById('variants-body');
  if (!variants.length) { body.innerHTML = '<p class="empty-state">No variants found.</p>'; return; }
  body.innerHTML = `<div class="variants-grid">` + variants.map(v => `<div class="variant-card">
    <div class="variant-name">${esc(v.name)}
      <span style="font-weight:400;font-size:.82rem;color:var(--text-muted)">
        ${esc(v.cuisine)} · ${esc(v.estimatedTime)} · ${cap(v.difficulty)}
      </span>
    </div>
    <div class="variant-difference">${esc(v.difference)}</div>
    <p class="variant-desc">${esc(v.description)}</p>
    <div class="variant-links">${searchLinksHTML(v.name)}</div>
  </div>`).join('') + `</div>`;
}

/* ── Favorites ───────────────────────────────────────────── */
function renderFavorites() {
  g_favsList = Storage.getFavorites();
  const container = document.getElementById('favorites-cards');
  const empty     = document.getElementById('no-favorites-msg');

  if (!g_favsList.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = `<div class="favorites-cards-list">` +
    g_favsList.map((fav, i) => {
      const sourceIcon = fav.source === 'photo' ? '📷' : fav.source === 'suggestion' ? '✨' : '🔗';
      const nameHTML   = fav.url
        ? `<a href="${esc(fav.url)}" target="_blank" rel="noopener noreferrer">${esc(fav.name)}</a>`
        : esc(fav.name);
      const meta = [fav.cuisine, fav.estimatedTime, fav.difficulty ? cap(fav.difficulty) : null,
                    fav.servings ? `${fav.servings} servings` : null].filter(Boolean).join(' · ');
      const ingredientSnip = fav.ingredients && fav.ingredients.length
        ? fav.ingredients.slice(0, 5).join(', ') + (fav.ingredients.length > 5 ? '…' : '')
        : null;

      return `<div class="favorite-card">
        <div class="fav-source-icon" title="${esc(fav.source)}">${sourceIcon}</div>
        <div class="fav-body">
          <div class="fav-name">${nameHTML}</div>
          ${meta ? `<div class="fav-meta">${esc(meta)}</div>` : ''}
          ${fav.note        ? `<div class="fav-note">${esc(fav.note)}</div>` : ''}
          ${ingredientSnip  ? `<div class="fav-meta" style="font-style:italic">${esc(ingredientSnip)}</div>` : ''}
          <div class="fav-actions">
            <button class="btn-ghost"  data-action="variants-fav"  data-idx="${i}">🔀 Find Variants</button>
            <button class="btn-ghost"  data-action="shopping-fav"  data-idx="${i}">🛒 Shopping List</button>
            <button class="btn-danger" data-action="remove-fav"    data-idx="${i}">Remove</button>
          </div>
        </div>
      </div>`;
    }).join('') + `</div>`;
}

function updateFavCount() {
  const n = Storage.getFavorites().length;
  const badge = document.getElementById('fav-count');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

/* ── Photo upload & extraction ───────────────────────────── */
function setupPhotoUpload() {
  const zone      = document.getElementById('upload-zone');
  const fileInput = document.getElementById('photo-file-input');
  const extractBtn = document.getElementById('extract-btn');

  zone.addEventListener('click', e => { if (e.target !== fileInput) fileInput.click(); });
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    addFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  extractBtn.addEventListener('click', handleExtractRecipe);
}

function addFiles(files) {
  const images = files.filter(f => f.type.startsWith('image/'));
  if (!images.length) { showToast('Please select image files', 'error'); return; }
  images.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      state.uploadedPhotos.push({ dataUrl: e.target.result, mediaType: file.type });
      renderPhotoPreviews();
    };
    reader.readAsDataURL(file);
  });
}

function renderPhotoPreviews() {
  const grid       = document.getElementById('photo-previews-grid');
  const extractBtn = document.getElementById('extract-btn');
  if (!state.uploadedPhotos.length) {
    grid.classList.add('hidden');
    extractBtn.disabled = true;
    return;
  }
  grid.classList.remove('hidden');
  extractBtn.disabled = false;
  grid.innerHTML = state.uploadedPhotos.map((p, i) =>
    `<div class="photo-preview-item">
      <img src="${p.dataUrl}" alt="Photo ${i + 1}">
      <button class="photo-remove-btn" data-remove="${i}" aria-label="Remove">✕</button>
    </div>`).join('');
}

// Delegated handler for photo remove buttons
document.addEventListener('click', e => {
  const removeBtn = e.target.closest('[data-remove]');
  if (!removeBtn) return;
  const idx = parseInt(removeBtn.dataset.remove, 10);
  state.uploadedPhotos.splice(idx, 1);
  renderPhotoPreviews();
});

async function handleExtractRecipe() {
  if (!state.uploadedPhotos.length) return;
  const btn     = document.getElementById('extract-btn');
  const btnText = document.getElementById('extract-btn-text');
  const spinner = document.getElementById('extract-btn-spinner');

  btn.disabled = true;
  btnText.textContent = 'Extracting…';
  spinner.classList.remove('hidden');

  try {
    const data = await API.extractFromPhotos(state.uploadedPhotos);
    const fav  = {
      name:          data.recipeName || 'Unnamed Recipe',
      source:        'photo',
      description:   data.description  || '',
      estimatedTime: data.estimatedTime || '',
      difficulty:    data.difficulty    || '',
      servings:      data.servings      || '',
      ingredients:   data.ingredients   || [],
      notes:         data.notes         || '',
    };
    Storage.addFavorite(fav);
    updateFavCount();
    // Clear upload state
    state.uploadedPhotos = [];
    renderPhotoPreviews();
    renderFavorites();
    showToast(`"${fav.name}" extracted and saved!`, 'success');
    document.getElementById('favorites-list-section').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast(`Extraction failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Extract Recipe from Photos';
    spinner.classList.add('hidden');
  }
}

/* ── URL favorite ────────────────────────────────────────── */
function handleAddUrlFavorite() {
  const name = document.getElementById('fav-name-input').value.trim();
  const url  = document.getElementById('fav-url-input').value.trim();
  const note = document.getElementById('fav-note-input').value.trim();

  if (!name) { showToast('Please enter a recipe name', 'error'); return; }
  if (url && !isValidUrl(url)) { showToast('Please enter a valid URL', 'error'); return; }

  Storage.addFavorite({ name, source: 'url', url: url || null, note });
  document.getElementById('fav-name-input').value = '';
  document.getElementById('fav-url-input').value  = '';
  document.getElementById('fav-note-input').value = '';
  updateFavCount();
  renderFavorites();
  showToast(`"${name}" saved to favorites`, 'success');
  document.getElementById('favorites-list-section').scrollIntoView({ behavior: 'smooth' });
}

/* ── Tabs ────────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === target);
        b.setAttribute('aria-selected', String(b.dataset.tab === target));
      });
      document.querySelectorAll('.tab-pane').forEach(p => {
        const active = p.id === `${target}-tab`;
        p.classList.toggle('active', active);
        p.classList.toggle('hidden', !active);
      });
      if (target === 'favorites') renderFavorites();
    });
  });
}

/* ── Add-method tabs (URL vs Photo) ──────────────────────── */
function setupAddMethodTabs() {
  document.querySelectorAll('.add-method-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      document.querySelectorAll('.add-method-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.method === method));
      document.getElementById('add-url-form').classList.toggle('hidden',   method !== 'url');
      document.getElementById('add-photo-form').classList.toggle('hidden', method !== 'photo');
    });
  });
}

/* ── Modals ──────────────────────────────────────────────── */
function setupModals() {
  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  document.querySelectorAll('.modal-overlay').forEach(overlay =>
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => closeModal(m.id));
  });
}

/* ── Init ────────────────────────────────────────────────── */
function init() {
  buildCuisinePills();
  setupTabs();
  setupAddMethodTabs();
  setupModals();
  setupPhotoUpload();
  loadSettingsIntoForm();
  updateFavCount();

  document.getElementById('settings-btn').addEventListener('click', () => {
    loadSettingsIntoForm();
    openModal('settings-modal');
  });
  document.getElementById('save-settings-btn').addEventListener('click', saveSettingsFromForm);
  document.getElementById('find-btn').addEventListener('click', handleFindRecipes);
  document.getElementById('add-url-btn').addEventListener('click', handleAddUrlFavorite);
  document.getElementById('copy-list-btn').addEventListener('click', copyShoppingList);

  ['fav-name-input', 'fav-url-input', 'fav-note-input'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') handleAddUrlFavorite();
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
