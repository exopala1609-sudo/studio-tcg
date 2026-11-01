// Boosters : création à partir de la collection, taux de rareté, ouverture animée et inventaire

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_SHORT = { common: 'C', uncommon: 'PC', rare: 'R', epic: 'É', legendary: 'L' };

// Couleurs du sachet : [clair, foncé]
const BOOSTER_COLORS = {
    cuivre: { label: 'Cuivre', a: '#d0793a', b: '#4a1f08' },
    ambre: { label: 'Ambre', a: '#f2b14a', b: '#6b3a0c' },
    houblon: { label: 'Houblon', a: '#8fb44a', b: '#1f2f0a' },
    nuit: { label: 'Nuit', a: '#5b7fa6', b: '#111a2c' },
    rubis: { label: 'Rubis', a: '#c8503a', b: '#360c08' },
    ecume: { label: 'Écume', a: '#efe2c8', b: '#6e5a3e' }
};

// Modèle : 3 communes, 1 peu commune, 1 « rare ou mieux »
const DEFAULT_SLOTS = [
    { count: 3, weights: { common: 100, uncommon: 0, rare: 0, epic: 0, legendary: 0 } },
    { count: 1, weights: { common: 0, uncommon: 100, rare: 0, epic: 0, legendary: 0 } },
    { count: 1, weights: { common: 0, uncommon: 0, rare: 75, epic: 20, legendary: 5 } }
];
const MAX_PACK_CARDS = 15;

let boosters = [];
let boostersTableMissing = false;
let boostersChannel = null;
let myOpenings = [];   // [{ id, boosterId, boosterName, cardIds, createdAt }], plus récentes d'abord
let boosterEditorState = null;   // { id, color, cardIds: Set, slots, dirty }
let packState = null;            // ouverture en cours

const cloneSlots = slots => slots.map(s => ({ count: s.count, weights: { ...s.weights } }));
const rarityOf = card => RARITY_ORDER.includes(card?.rarity) ? card.rarity : 'common';

// ---------- Données ----------
function rowToBooster(row) {
    return {
        id: row.id,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        name: row.name,
        cardIds: row.data?.cardIds || [],
        slots: row.data?.slots?.length ? row.data.slots : cloneSlots(DEFAULT_SLOTS),
        dailyLimit: Number.isFinite(row.data?.dailyLimit) ? row.data.dailyLimit : 3,
        color: BOOSTER_COLORS[row.data?.color] ? row.data.color : 'cuivre'
    };
}

function boosterToRow(b) {
    return { name: b.name, data: { cardIds: b.cardIds, slots: b.slots, dailyLimit: b.dailyLimit, color: b.color } };
}

function rowToOpening(row) {
    return { id: row.id, boosterId: row.booster_id, boosterName: row.booster_name, cardIds: row.card_ids || [], createdAt: row.created_at };
}

function readLocalJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
}

function writeLocalJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function isOwnBooster(b) {
    return !isCloudActive() || b.ownerId === currentUser.id;
}

async function reloadBoosters() {
    if (isCloudActive()) {
        const { data, error } = await sb.from('boosters').select('*').order('created_at');
        if (error) {
            boosters = [];
            myOpenings = [];
            boostersTableMissing = error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message);
            if (!boostersTableMissing) cloudError('Impossible de charger les boosters', error);
        } else {
            boostersTableMissing = false;
            boosters = data.map(rowToBooster);
            const res = await sb.from('booster_openings').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });
            if (res.error) cloudError('Impossible de charger votre inventaire', res.error);
            else myOpenings = res.data.map(rowToOpening);
            startBoostersRealtime();
        }
    } else {
        boosters = readLocalJson('tcg_boosters');
        myOpenings = readLocalJson('tcg_openings');
    }
    refreshBoosterUI();
}

function startBoostersRealtime() {
    if (boostersChannel || !isCloudActive()) return;
    boostersChannel = sb.channel('studio-boosters')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'boosters' }, payload => {
            if (payload.eventType === 'DELETE') boosters = boosters.filter(b => b.id !== payload.old.id);
            else {
                const b = rowToBooster(payload.new);
                const idx = boosters.findIndex(x => x.id === b.id);
                if (idx === -1) boosters.push(b); else boosters[idx] = b;
            }
            refreshBoosterUI();
        })
        .subscribe();
}

function stopBoostersRealtime() {
    if (boostersChannel) sb.removeChannel(boostersChannel);
    boostersChannel = null;
}

function refreshBoosterUI() {
    if (document.body.dataset.view === 'boosters' && !boosterEditorState) renderBoostersView();
    if (isBinderOpen()) renderCollection();
}

// ---------- Inventaire ----------
function ownedCounts() {
    const counts = new Map();
    myOpenings.forEach(o => o.cardIds.forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
    return counts;
}

function openingsToday(boosterId) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return myOpenings.filter(o => o.boosterId === boosterId && new Date(o.createdAt) >= midnight).length;
}

function remainingToday(b) {
    return b.dailyLimit > 0 ? Math.max(0, b.dailyLimit - openingsToday(b.id)) : Infinity;
}

// Classeur : filtre Possédées / Manquantes
function matchesOwnedFilter(card, counts) {
    const filter = document.getElementById('collectionOwnedFilter').value;
    if (!filter) return true;
    return filter === 'owned' ? counts.has(card.id) : !counts.has(card.id);
}

// ---------- Tirage ----------
function boosterPool(b) {
    return b.cardIds.map(id => collection.find(c => c.id === id)).filter(Boolean);
}

function groupByRarity(cards) {
    const groups = Object.fromEntries(RARITY_ORDER.map(r => [r, []]));
    cards.forEach(c => groups[rarityOf(c)].push(c));
    return groups;
}

// Une rareté absente de la sélection reporte son taux sur la rareté présente la plus proche
function nearestAvailable(index, groups) {
    for (let d = 0; d < RARITY_ORDER.length; d++) {
        for (const j of [index - d, index + d]) {
            const r = RARITY_ORDER[j];
            if (r && groups[r].length) return r;
        }
    }
    return null;
}

function effectiveWeights(slot, groups) {
    const w = Object.fromEntries(RARITY_ORDER.map(r => [r, 0]));
    RARITY_ORDER.forEach((r, i) => {
        const v = Number(slot.weights[r]) || 0;
        if (v <= 0) return;
        const target = nearestAvailable(i, groups);
        if (target) w[target] += v;
    });
    return w;
}

function randomUnit() {
    return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function pickWeighted(weights) {
    const total = RARITY_ORDER.reduce((s, r) => s + weights[r], 0);
    let x = randomUnit() * total;
    for (const r of RARITY_ORDER) {
        if (weights[r] <= 0) continue;
        if (x < weights[r]) return r;
        x -= weights[r];
    }
    return RARITY_ORDER.filter(r => weights[r] > 0).pop();
}

// Cartes tirées, de la plus commune à la plus rare (la meilleure se révèle en dernier)
function drawBooster(b) {
    const groups = groupByRarity(boosterPool(b));
    const pulled = [];
    b.slots.forEach(slot => {
        const weights = effectiveWeights(slot, groups);
        for (let k = 0; k < slot.count; k++) {
            const candidates = groups[pickWeighted(weights)];
            const fresh = candidates.filter(c => !pulled.includes(c));
            const list = fresh.length ? fresh : candidates;
            pulled.push(list[Math.floor(randomUnit() * list.length)]);
        }
    });
    return pulled.sort((x, y) => RARITY_ORDER.indexOf(rarityOf(x)) - RARITY_ORDER.indexOf(rarityOf(y)));
}

// Chances par booster : au moins une carte de chaque rareté, et nombre moyen
function boosterOdds(b) {
    const groups = groupByRarity(boosterPool(b));
    const none = Object.fromEntries(RARITY_ORDER.map(r => [r, 1]));
    const expected = Object.fromEntries(RARITY_ORDER.map(r => [r, 0]));
    b.slots.forEach(slot => {
        const w = effectiveWeights(slot, groups);
        const total = RARITY_ORDER.reduce((s, r) => s + w[r], 0);
        if (!total) return;
        RARITY_ORDER.forEach(r => {
            const p = w[r] / total;
            expected[r] += slot.count * p;
            none[r] *= Math.pow(1 - p, slot.count);
        });
    });
    return { atLeastOne: Object.fromEntries(RARITY_ORDER.map(r => [r, 1 - none[r]])), expected, groups };
}

function formatPercent(p) {
    const v = p * 100;
    if (v > 0 && v < 1) return '< 1 %';
    return `${v >= 10 || Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : v.toFixed(1).replace('.', ',')} %`;
}

const packSize = b => b.slots.reduce((s, slot) => s + (Number(slot.count) || 0), 0);

// ---------- Visuel du sachet ----------
function boosterCover(b) {
    const pool = boosterPool(b);
    for (const r of [...RARITY_ORDER].reverse()) {
        const card = pool.find(c => rarityOf(c) === r && c.imageSrc);
        if (card) return card.imageSrc;
    }
    return '';
}

function makePackVisual(b, width) {
    const color = BOOSTER_COLORS[b.color] || BOOSTER_COLORS.cuivre;
    const pack = document.createElement('div');
    pack.className = 'booster-pack';
    pack.style.setProperty('--pw', `${width}px`);
    pack.style.setProperty('--pack-a', color.a);
    pack.style.setProperty('--pack-b', color.b);
    const cover = boosterCover(b);
    pack.innerHTML = `
        <span class="pack-crimp top"></span>
        <span class="pack-brand">TCGBP</span>
        <span class="pack-window"${cover ? ` style="background-image:url('${cover.replace(/'/g, '%27')}')"` : ''}>${cover ? '' : icon('package', 28)}</span>
        <span class="pack-name"></span>
        <span class="pack-count">${packSize(b)} cartes</span>
        <span class="pack-sheen"></span>
        <span class="pack-crimp bottom"></span>`;
    pack.querySelector('.pack-name').textContent = b.name || 'Booster';
    return pack;
}

// ---------- Vue Boosters ----------
function renderBoostersView() {
    const note = document.getElementById('boostersNote');
    note.textContent = boostersTableMissing
        ? 'Les boosters ne sont pas encore activés : lancez le script SQL des boosters dans Supabase.'
        : isCloudActive()
            ? 'Partagés avec le groupe. Les cartes obtenues forment votre inventaire.'
            : 'Hors ligne : boosters et inventaire enregistrés sur cet appareil uniquement.';
    document.getElementById('boosterCreateBtn').disabled = boostersTableMissing;

    const counts = ownedCounts();
    const owned = collection.filter(c => counts.has(c.id)).length;
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    document.getElementById('inventorySummary').innerHTML = `
        <span>${icon('backpack', 16)}<strong>${total}</strong> carte${total > 1 ? 's' : ''} obtenue${total > 1 ? 's' : ''}</span>
        <span><strong>${owned}</strong> / ${collection.length} cartes différentes</span>
        <button type="button" class="link-btn" onclick="showInventoryInBinder()">Voir dans le classeur</button>`;

    const grid = document.getElementById('boosterGrid');
    grid.innerHTML = '';
    if (!boosters.length) {
        grid.innerHTML = `<div class="empty-state">${boostersTableMissing ? 'Boosters indisponibles pour le moment.' : 'Aucun booster pour l\'instant. Créez-en un à partir des cartes de la collection.'}</div>`;
    }
    boosters.forEach(b => grid.appendChild(makeBoosterTile(b, counts)));
    renderOpeningHistory();
}

function makeBoosterTile(b, counts) {
    const tile = document.createElement('article');
    tile.className = 'booster-tile';
    const pool = boosterPool(b);
    const remaining = remainingToday(b);
    const packWrap = document.createElement('button');
    packWrap.type = 'button';
    packWrap.className = 'booster-tile-pack';
    packWrap.setAttribute('aria-label', `Ouvrir ${b.name}`);
    packWrap.appendChild(makePackVisual(b, isMobileLayout() ? 104 : 120));
    packWrap.onclick = () => openBooster(b.id);

    const info = document.createElement('div');
    info.className = 'booster-info';
    const title = document.createElement('h3');
    title.textContent = b.name;
    const owner = document.createElement('span');
    owner.className = 'booster-owner';
    owner.textContent = isCloudActive() ? (isOwnBooster(b) ? 'Créé par vous' : `Créé par ${b.ownerName || 'un ami'}`) : '';

    const got = pool.filter(c => counts.has(c.id)).length;
    const progress = document.createElement('div');
    progress.className = 'booster-progress';
    progress.innerHTML = `<span>Obtenues : <strong>${got}</strong> / ${pool.length}</span><div class="set-progress"><div style="width:${pool.length ? Math.round(got / pool.length * 100) : 0}%"></div></div>`;

    const odds = boosterOdds(b).atLeastOne;
    const rates = document.createElement('div');
    rates.className = 'booster-rates';
    ['rare', 'epic', 'legendary'].forEach(r => {
        if (odds[r] <= 0) return;
        const chip = document.createElement('span');
        chip.className = `rate-chip r-${r}`;
        chip.textContent = `${RARITIES[r]} ${formatPercent(odds[r])}`;
        chip.title = `Chance d'obtenir au moins une carte ${RARITIES[r].toLowerCase()} par booster`;
        rates.appendChild(chip);
    });

    const left = document.createElement('span');
    left.className = 'booster-left' + (remaining === 0 ? ' empty' : '');
    left.textContent = b.dailyLimit > 0
        ? (remaining ? `${remaining} ouverture${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''} aujourd'hui` : 'Revenez demain pour en ouvrir un autre')
        : 'Ouvertures illimitées';

    const actions = document.createElement('div');
    actions.className = 'deck-actions';
    const openBtn = sheetButton('Ouvrir', () => openBooster(b.id), '', 'package-open');
    openBtn.disabled = !remaining || !pool.length;
    actions.appendChild(openBtn);
    if (isOwnBooster(b)) actions.appendChild(sheetButton('Modifier', () => openBoosterEditor(b.id), 'btn-secondary', 'pencil'));

    info.append(title, owner, progress, rates, left, actions);
    tile.append(packWrap, info);
    return tile;
}

function formatOpeningDate(iso) {
    const d = new Date(iso);
    const today = new Date();
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `Aujourd'hui ${time}`;
    return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${time}`;
}

function renderOpeningHistory() {
    const list = document.getElementById('openingHistory');
    list.innerHTML = '';
    const recent = myOpenings.slice(0, 8);
    document.getElementById('openingHistoryTitle').hidden = !recent.length;
    recent.forEach(o => {
        const cards = o.cardIds.map(id => collection.find(c => c.id === id)).filter(Boolean);
        const best = [...cards].sort((x, y) => RARITY_ORDER.indexOf(rarityOf(y)) - RARITY_ORDER.indexOf(rarityOf(x)))[0];
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'history-row';
        row.innerHTML = `<span class="history-date"></span><span class="history-name"></span><span class="history-dots"></span><span class="history-best"></span>`;
        row.querySelector('.history-date').textContent = formatOpeningDate(o.createdAt);
        row.querySelector('.history-name').textContent = o.boosterName;
        row.querySelector('.history-dots').innerHTML = cards.map(c => `<i class="rarity-dot r-${rarityOf(c)}"></i>`).join('');
        row.querySelector('.history-best').textContent = best ? best.name || 'Sans nom' : 'Cartes supprimées';
        row.onclick = () => showOpeningRecap(cards, o.boosterName);
        list.appendChild(row);
    });
}

function showInventoryInBinder() {
    setMainView('collection');
    document.getElementById('collectionOwnedFilter').value = 'owned';
    renderCollection();
}

// ---------- Éditeur de booster ----------
function openBoosterEditor(id) {
    if (boostersTableMissing) return;
    const b = boosters.find(x => x.id === id);
    if (b && !isOwnBooster(b)) return;
    boosterEditorState = {
        id: b?.id || null,
        color: b?.color || 'cuivre',
        cardIds: new Set(b?.cardIds || []),
        slots: cloneSlots(b?.slots || DEFAULT_SLOTS),
        dirty: false
    };
    document.getElementById('boosterNameInput').value = b?.name || '';
    document.getElementById('boosterLimitInput').value = b ? b.dailyLimit : 3;
    document.getElementById('boosterSearchInput').value = '';
    document.getElementById('boosterRarityFilter').value = '';
    document.getElementById('boosterDeleteBtn').hidden = !b;
    const setFilter = document.getElementById('boosterSetFilter');
    setFilter.innerHTML = '<option value="">Tous les sets</option>' + sets.map(s => `<option value="${s.id}">${escapeHtml(s.code)} — ${escapeHtml(s.name)}</option>`).join('');
    document.getElementById('boostersListView').hidden = true;
    document.getElementById('boosterEditor').hidden = false;
    pushLayer('boosterEditor', hideBoosterEditor);
    renderBoosterColors();
    renderBoosterSlots();
    renderBoosterPool();
    refreshBoosterSummary();
}

async function closeBoosterEditor() {
    if (boosterEditorState?.dirty && !(await tcgConfirm('Les modifications de ce booster ne sont pas enregistrées.', { title: "Quitter l'éditeur ?", confirmLabel: 'Quitter sans enregistrer', danger: true }))) return;
    if (!closeLayer('boosterEditor')) hideBoosterEditor();
}

function hideBoosterEditor() {
    boosterEditorState = null;
    document.getElementById('boosterEditor').hidden = true;
    document.getElementById('boostersListView').hidden = false;
    renderBoostersView();
}

function markBoosterDirty() {
    if (boosterEditorState) boosterEditorState.dirty = true;
}

function editorBooster() {
    const st = boosterEditorState;
    return {
        name: document.getElementById('boosterNameInput').value.trim() || 'Nouveau booster',
        color: st.color,
        cardIds: [...st.cardIds],
        slots: st.slots,
        dailyLimit: Math.max(0, parseInt(document.getElementById('boosterLimitInput').value, 10) || 0)
    };
}

function renderBoosterColors() {
    const box = document.getElementById('boosterColorChips');
    box.innerHTML = '';
    Object.entries(BOOSTER_COLORS).forEach(([key, c]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'color-chip' + (key === boosterEditorState.color ? ' selected' : '');
        b.style.background = `linear-gradient(135deg, ${c.a}, ${c.b})`;
        b.title = c.label;
        b.setAttribute('aria-label', c.label);
        b.onclick = () => { boosterEditorState.color = key; markBoosterDirty(); renderBoosterColors(); refreshBoosterPreview(); };
        box.appendChild(b);
    });
}

function refreshBoosterPreview() {
    document.getElementById('boosterPreview').replaceChildren(makePackVisual(editorBooster(), 110));
}

function boosterPoolMatches(card) {
    const search = document.getElementById('boosterSearchInput').value.trim().toLowerCase();
    const setId = document.getElementById('boosterSetFilter').value;
    const rarity = document.getElementById('boosterRarityFilter').value;
    return (!rarity || rarityOf(card) === rarity) &&
        (!setId || findSetForCard(card)?.id === setId) &&
        (!search || `${card.name} ${card.subtype} ${card.ownerName || ''}`.toLowerCase().includes(search));
}

function renderBoosterPool() {
    const pool = document.getElementById('boosterPool');
    pool.innerHTML = '';
    const cards = collection.filter(boosterPoolMatches);
    if (!cards.length) {
        pool.innerHTML = '<div class="empty-state">Aucune carte ne correspond.</div>';
        return;
    }
    cards.forEach(card => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'pool-tile' + (boosterEditorState.cardIds.has(card.id) ? ' in-deck' : '');
        tile.appendChild(makeMiniCard(card, isMobileLayout() ? 0.24 : 0.28));
        const tick = document.createElement('span');
        tick.className = 'pool-count';
        tile.appendChild(tick);
        const sync = () => {
            const on = boosterEditorState.cardIds.has(card.id);
            tile.classList.toggle('in-deck', on);
            tick.innerHTML = on ? icon('check', 13) : '';
            tile.title = on ? 'Retirer du booster' : 'Inclure dans le booster';
        };
        tile.onclick = () => {
            const ids = boosterEditorState.cardIds;
            if (ids.has(card.id)) ids.delete(card.id); else ids.add(card.id);
            markBoosterDirty();
            sync();
            refreshBoosterSummary();
        };
        sync();
        pool.appendChild(tile);
    });
}

function selectFilteredBoosterCards(include) {
    collection.filter(boosterPoolMatches).forEach(c => include ? boosterEditorState.cardIds.add(c.id) : boosterEditorState.cardIds.delete(c.id));
    markBoosterDirty();
    renderBoosterPool();
    refreshBoosterSummary();
}

function renderBoosterSlots() {
    const box = document.getElementById('boosterSlots');
    box.innerHTML = '';
    boosterEditorState.slots.forEach((slot, i) => {
        const row = document.createElement('div');
        row.className = 'slot-row';
        row.innerHTML = `
            <div class="slot-head">
                <strong>Emplacement ${i + 1}</strong>
                <label class="slot-count"><input type="number" min="1" max="10" value="${slot.count}"> carte${slot.count > 1 ? 's' : ''}</label>
                <span class="slot-sum"></span>
            </div>
            <div class="slot-weights">${RARITY_ORDER.map(r => `
                <label class="slot-weight" title="${RARITIES[r]}"><i class="rarity-dot r-${r}"></i><span>${RARITY_SHORT[r]}</span><input type="number" min="0" max="100" step="1" data-rarity="${r}" value="${slot.weights[r] || 0}"><small>%</small></label>`).join('')}
            </div>`;
        const countInput = row.querySelector('.slot-count input');
        countInput.oninput = () => {
            slot.count = Math.min(10, Math.max(1, parseInt(countInput.value, 10) || 1));
            countInput.nextSibling.textContent = ` carte${slot.count > 1 ? 's' : ''}`;
            markBoosterDirty();
            refreshBoosterSummary();
        };
        row.querySelectorAll('.slot-weight input').forEach(input => {
            input.oninput = () => {
                slot.weights[input.dataset.rarity] = Math.min(100, Math.max(0, parseFloat(input.value) || 0));
                markBoosterDirty();
                refreshSlotSums();
                refreshBoosterSummary();
            };
        });
        if (boosterEditorState.slots.length > 1) {
            const del = sheetButton('', () => { boosterEditorState.slots.splice(i, 1); markBoosterDirty(); renderBoosterSlots(); refreshBoosterSummary(); }, 'btn-ghost', 'x');
            del.title = "Retirer l'emplacement";
            del.classList.add('slot-remove');
            row.querySelector('.slot-head').appendChild(del);
        }
        box.appendChild(row);
    });
    refreshSlotSums();
}

const slotSum = slot => RARITY_ORDER.reduce((s, r) => s + (Number(slot.weights[r]) || 0), 0);

function refreshSlotSums() {
    document.querySelectorAll('#boosterSlots .slot-row').forEach((row, i) => {
        const sum = slotSum(boosterEditorState.slots[i]);
        const el = row.querySelector('.slot-sum');
        el.textContent = `Total ${Math.round(sum * 10) / 10} %`;
        el.classList.toggle('bad', Math.abs(sum - 100) > 0.01);
    });
}

function addBoosterSlot() {
    boosterEditorState.slots.push({ count: 1, weights: { common: 0, uncommon: 0, rare: 75, epic: 20, legendary: 5 } });
    markBoosterDirty();
    renderBoosterSlots();
    refreshBoosterSummary();
}

async function resetBoosterSlots() {
    boosterEditorState.slots = cloneSlots(DEFAULT_SLOTS);
    markBoosterDirty();
    renderBoosterSlots();
    refreshBoosterSummary();
}

function refreshBoosterSummary() {
    if (!boosterEditorState) return;
    const b = editorBooster();
    const { atLeastOne, expected, groups } = boosterOdds(b);
    const size = packSize(b);
    const lines = RARITY_ORDER.map(r => `
        <tr>
            <th><i class="rarity-dot r-${r}"></i>${RARITIES[r]}</th>
            <td>${groups[r].length}</td>
            <td>${expected[r] ? (Math.round(expected[r] * 100) / 100).toString().replace('.', ',') : '—'}</td>
            <td>${atLeastOne[r] ? formatPercent(atLeastOne[r]) : '—'}</td>
        </tr>`).join('');
    const warnings = [];
    const wanted = new Set();
    b.slots.forEach(s => RARITY_ORDER.forEach(r => { if (s.weights[r] > 0) wanted.add(r); }));
    RARITY_ORDER.forEach(r => {
        if (wanted.has(r) && !groups[r].length && b.cardIds.length) warnings.push(`Aucune carte ${RARITIES[r].toLowerCase()} sélectionnée : son taux est reporté sur la rareté la plus proche.`);
    });
    if (b.slots.some(s => Math.abs(slotSum(s) - 100) > 0.01)) warnings.push('Chaque emplacement doit totaliser 100 %.');
    if (size > MAX_PACK_CARDS) warnings.push(`${MAX_PACK_CARDS} cartes maximum par booster.`);
    if (!b.cardIds.length) warnings.push('Sélectionnez les cartes que ce booster peut contenir.');
    document.getElementById('boosterSummary').innerHTML = `
        <p class="summary-head"><strong>${b.cardIds.length}</strong> carte${b.cardIds.length > 1 ? 's' : ''} possible${b.cardIds.length > 1 ? 's' : ''} · <strong>${size}</strong> par booster</p>
        <table class="odds-table">
            <thead><tr><th>Rareté</th><th>Dans la sélection</th><th>En moyenne</th><th>Au moins 1</th></tr></thead>
            <tbody>${lines}</tbody>
        </table>
        ${warnings.map(w => `<p class="warn-line">${icon('triangle-alert', 14)}${w}</p>`).join('')}`;
    refreshBoosterPreview();
}

async function saveBoosterFromEditor() {
    const name = document.getElementById('boosterNameInput').value.trim();
    if (!name) return toast('Donnez un nom au booster.', { tone: 'warning' });
    const b = { ...editorBooster(), name };
    if (!b.cardIds.length) return toast('Sélectionnez au moins une carte.', { tone: 'warning' });
    if (b.slots.some(s => Math.abs(slotSum(s) - 100) > 0.01)) return toast('Chaque emplacement doit totaliser 100 %.', { tone: 'warning' });
    if (packSize(b) > MAX_PACK_CARDS) return toast(`${MAX_PACK_CARDS} cartes maximum par booster.`, { tone: 'warning' });

    let savedId = boosterEditorState.id;
    if (isCloudActive()) {
        const query = savedId
            ? sb.from('boosters').update(boosterToRow(b)).eq('id', savedId)
            : sb.from('boosters').insert({ ...boosterToRow(b), owner_name: displayName(currentUser) });
        const { data, error } = await query.select().single();
        if (error) return cloudError("Le booster n'a pas pu être enregistré", error);
        const saved = rowToBooster(data);
        const idx = boosters.findIndex(x => x.id === saved.id);
        if (idx === -1) boosters.push(saved); else boosters[idx] = saved;
    } else {
        if (!savedId) savedId = 'booster_' + Date.now();
        const local = { id: savedId, ownerId: null, ownerName: '', ...b };
        const idx = boosters.findIndex(x => x.id === savedId);
        if (idx === -1) boosters.push(local); else boosters[idx] = local;
        writeLocalJson('tcg_boosters', boosters);
    }
    boosterEditorState.dirty = false;
    toast(`Booster « ${name} » enregistré.`, { tone: 'success' });
    if (!closeLayer('boosterEditor')) hideBoosterEditor();
}

async function deleteBoosterFromEditor() {
    const b = boosters.find(x => x.id === boosterEditorState?.id);
    if (!b) return;
    const ok = await tcgConfirm('Les cartes déjà obtenues restent dans les inventaires.', { title: `Supprimer le booster « ${b.name} » ?`, confirmLabel: 'Supprimer', danger: true });
    if (!ok) return;
    if (isCloudActive()) {
        const { error } = await sb.from('boosters').delete().eq('id', b.id);
        if (error) return cloudError("Le booster n'a pas pu être supprimé", error);
    }
    boosters = boosters.filter(x => x.id !== b.id);
    if (!isCloudActive()) writeLocalJson('tcg_boosters', boosters);
    boosterEditorState.dirty = false;
    if (!closeLayer('boosterEditor')) hideBoosterEditor();
}

// =====================================================================
//  OUVERTURE ANIMÉE
// =====================================================================
async function openBooster(id) {
    const b = boosters.find(x => x.id === id);
    if (!b || packState) return;
    if (!boosterPool(b).length) return toast('Ce booster ne contient plus aucune carte de la collection.', { tone: 'warning' });
    if (!remainingToday(b)) return toast('Plus d\'ouverture disponible aujourd\'hui pour ce booster. Revenez demain !', { tone: 'warning' });

    const before = ownedCounts();
    const cards = drawBooster(b);
    // Le tirage est enregistré avant l'animation : fermer l'app ne permet pas de retenter sa chance
    const opening = { boosterId: b.id, boosterName: b.name, cardIds: cards.map(c => c.id), createdAt: new Date().toISOString() };
    if (isCloudActive()) {
        const { data, error } = await sb.from('booster_openings')
            .insert({ booster_id: b.id, booster_name: b.name, card_ids: opening.cardIds }).select().single();
        if (error) {
            if (error.code === 'P0001') return toast('Limite du jour atteinte pour ce booster. Revenez demain !', { tone: 'warning' });
            return cloudError("Le booster n'a pas pu être ouvert", error);
        }
        myOpenings.unshift(rowToOpening(data));
    } else {
        myOpenings.unshift({ id: 'op_' + Date.now(), ...opening });
        writeLocalJson('tcg_openings', myOpenings);
    }

    packState = { booster: b, cards, isNew: cards.map(c => !before.has(c.id)), index: 0, stage: 'pack' };
    // Les seconds tirages d'une même carte dans ce booster ne sont pas « nouveaux »
    cards.forEach((c, i) => { if (cards.indexOf(c) !== i) packState.isNew[i] = false; });
    packState.ready = preparePackImages(cards);
    if (document.getElementById('packOpening').hidden) showPackOverlay();
    renderPackStage();
}

function preparePackImages(cards) {
    const jobs = cards.map(async c => {
        await getImageRatio(c.imageSrc || DEFAULT_ART);
        await prepareCardImage(c);
    });
    // Au pire 2,5 s d'attente : une image lente s'affichera ensuite d'elle-même
    return Promise.race([Promise.allSettled(jobs), new Promise(r => setTimeout(r, 2500))]);
}

function showPackOverlay() {
    const overlay = document.getElementById('packOpening');
    overlay.hidden = false;
    overlay.className = 'pack-opening';
    pushLayer('packOpening', hidePackOverlay);
}

function closePackOpening() {
    if (!closeLayer('packOpening')) hidePackOverlay();
}

function hidePackOverlay() {
    document.getElementById('packOpening').hidden = true;
    document.getElementById('poStage').innerHTML = '';
    packState = null;
    if (document.body.dataset.view === 'boosters' && !boosterEditorState) renderBoostersView();
    if (isBinderOpen()) renderCollection();
}

function packCardScale() {
    const w = document.documentElement.clientWidth, h = window.innerHeight;
    return Math.min(0.78, (w * 0.78) / 375, (h * 0.56) / 523);
}

function setPackHint(text) {
    document.getElementById('poHint').textContent = text;
}

function setPackActions(buttons) {
    document.getElementById('poActions').replaceChildren(...buttons);
}

// Étape 1 : le sachet, à déchirer
function renderPackStage() {
    const stage = document.getElementById('poStage');
    const width = Math.min(240, document.documentElement.clientWidth * 0.6, window.innerHeight * 0.5 * 0.62);
    stage.innerHTML = '';
    const pack = document.createElement('div');
    pack.className = 'po-pack';
    const body = makePackVisual(packState.booster, width);
    body.classList.add('po-pack-body');
    const top = makePackVisual(packState.booster, width);
    top.classList.add('po-pack-top');
    const line = document.createElement('span');
    line.className = 'po-tear-line';
    pack.append(body, top, line);
    stage.appendChild(pack);
    setPackHint(isMobileLayout() ? 'Glissez le doigt sur le haut du sachet pour le déchirer' : 'Glissez sur le haut du sachet pour le déchirer, ou cliquez dessus');
    setPackActions([]);

    let startX = null, moved = 0;
    pack.onpointerdown = e => {
        startX = e.clientX;
        moved = 0;
        pack.setPointerCapture(e.pointerId);
    };
    pack.onpointermove = e => {
        if (startX === null) return;
        moved = Math.abs(e.clientX - startX);
        pack.style.setProperty('--tear', Math.min(1, moved / width).toFixed(3));
    };
    pack.onpointerup = pack.onpointercancel = () => {
        if (startX === null) return;
        startX = null;
        if (moved < 8 || moved / width > 0.45) tearPack(pack);
        else pack.style.setProperty('--tear', 0);
    };
}

async function tearPack(pack) {
    if (packState.stage !== 'pack') return;
    packState.stage = 'tearing';
    pack.onpointerdown = pack.onpointermove = pack.onpointerup = null;
    pack.style.setProperty('--tear', 1);
    pack.classList.add('torn');
    setPackHint('');
    if (navigator.vibrate) navigator.vibrate(30);
    await Promise.all([packState.ready, new Promise(r => setTimeout(r, 900))]);
    if (!packState) return;
    renderRevealStage();
}

// Étape 2 : la pile de cartes, à révéler une par une
function renderRevealStage() {
    packState.stage = 'reveal';
    const stage = document.getElementById('poStage');
    stage.innerHTML = '';
    const scale = packCardScale();
    const stack = document.createElement('div');
    stack.className = 'po-stack';
    stack.style.width = `${375 * scale}px`;
    stack.style.height = `${523 * scale}px`;
    packState.els = packState.cards.map((card, i) => {
        const el = document.createElement('div');
        el.className = 'po-card';
        el.dataset.rarity = rarityOf(card);
        el.style.zIndex = packState.cards.length - i;
        el.style.setProperty('--depth', i);
        const inner = document.createElement('div');
        inner.className = 'po-inner';
        const back = document.createElement('div');
        back.className = 'po-face po-back';
        back.appendChild(makeBackMini(scale));
        const front = document.createElement('div');
        front.className = 'po-face po-front';
        front.appendChild(makeMiniCard(card, scale));
        if (packState.isNew[i]) front.insertAdjacentHTML('beforeend', '<span class="po-new">Nouvelle</span>');
        const burst = document.createElement('div');
        burst.className = 'po-burst';
        inner.append(back, front);
        el.append(burst, inner);
        el.onclick = () => onPackCardTap(i);
        stack.appendChild(el);
        return el;
    });
    const tray = document.createElement('div');
    tray.className = 'po-tray';
    tray.id = 'poTray';
    stage.append(stack, tray);
    // Les cartes sortent du sachet
    stack.classList.add('rising');
    setTimeout(() => stack.classList.remove('rising'), 50);
    focusTopCard();
    setPackActions([sheetButton('Tout révéler', () => renderRecapStage(), 'btn-secondary', 'eye')]);
}

function focusTopCard() {
    const i = packState.index;
    const el = packState.els[i];
    if (!el) return;
    el.classList.add('top');
    const left = packState.cards.length - i;
    setPackHint(`Touchez la carte pour la retourner · ${left} restante${left > 1 ? 's' : ''}`);
}

function onPackCardTap(i) {
    if (!packState || packState.stage !== 'reveal' || i !== packState.index || packState.busy) return;
    const el = packState.els[i];
    if (!el.classList.contains('flipped')) return flipPackCard(el);
    dealPackCard(el, i);
}

function flipPackCard(el) {
    const rarity = el.dataset.rarity;
    const big = rarity === 'epic' || rarity === 'legendary';
    packState.busy = true;
    // Épique et légendaire : la carte vibre et s'illumine avant de se retourner
    if (big) el.classList.add('charging');
    if (big && navigator.vibrate) navigator.vibrate(rarity === 'legendary' ? [40, 60, 90] : 40);
    setTimeout(() => {
        el.classList.remove('charging');
        el.classList.add('flipped');
        if (big || rarity === 'rare') el.classList.add('burst');
        if (rarity === 'legendary') document.getElementById('packOpening').classList.add('flash');
        setTimeout(() => document.getElementById('packOpening').classList.remove('flash'), 700);
        const left = packState.cards.length - packState.index - 1;
        setPackHint(left ? 'Touchez encore pour passer à la suivante' : 'Touchez pour voir votre tirage');
        packState.busy = false;
    }, big ? (rarity === 'legendary' ? 1100 : 650) : 0);
}

function dealPackCard(el, i) {
    el.classList.remove('top');
    el.classList.add('dealt');
    const thumb = makeMiniCard(packState.cards[i], 0.12);
    thumb.classList.add('po-thumb');
    document.getElementById('poTray').appendChild(thumb);
    packState.index++;
    if (packState.index >= packState.cards.length) setTimeout(() => packState && renderRecapStage(), 350);
    else focusTopCard();
}

// Étape 3 : récapitulatif du tirage
function renderRecapStage() {
    if (!packState) return;
    packState.stage = 'recap';
    const b = packState.booster;
    fillRecap(packState.cards, packState.isNew);
    const remaining = remainingToday(b);
    const buttons = [];
    if (remaining) buttons.push(sheetButton(Number.isFinite(remaining) ? `Ouvrir un autre (${remaining})` : 'Ouvrir un autre', () => openBoosterAgain(b.id), '', 'package-open'));
    buttons.push(sheetButton('Voir mon inventaire', () => { closePackOpening(); showInventoryInBinder(); }, 'btn-secondary', 'backpack'));
    buttons.push(sheetButton('Fermer', closePackOpening, 'btn-secondary', 'x'));
    setPackActions(buttons);
}

// Le calque reste ouvert : on enchaîne directement sur le sachet suivant
async function openBoosterAgain(id) {
    packState = null;
    await openBooster(id);
}

function fillRecap(cards, isNew) {
    const stage = document.getElementById('poStage');
    stage.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'po-recap';
    const n = cards.length;
    const w = document.documentElement.clientWidth;
    const scale = isMobileLayout() ? Math.min(0.42, (w - 48) / 2 / 375) : Math.min(0.42, (w * 0.9) / Math.min(n, 5) / 395);
    cards.forEach((card, i) => {
        const item = document.createElement('div');
        item.className = `po-recap-item r-${rarityOf(card)}`;
        item.style.animationDelay = `${i * 60}ms`;
        item.appendChild(makeMiniCard(card, scale));
        if (isNew?.[i]) item.insertAdjacentHTML('beforeend', '<span class="po-new">Nouvelle</span>');
        const label = document.createElement('span');
        label.className = 'po-recap-label';
        label.innerHTML = `<i class="rarity-dot r-${rarityOf(card)}"></i>`;
        label.appendChild(document.createTextNode(RARITIES[rarityOf(card)]));
        item.appendChild(label);
        grid.appendChild(item);
    });
    stage.appendChild(grid);
    const fresh = isNew ? isNew.filter(Boolean).length : 0;
    setPackHint(isNew ? (fresh ? `${fresh} nouvelle${fresh > 1 ? 's' : ''} carte${fresh > 1 ? 's' : ''} dans votre inventaire !` : 'Que des doublons cette fois…') : '');
}

// Historique : revoir un ancien tirage, sans animation
function showOpeningRecap(cards, boosterName) {
    if (!cards.length) return toast('Les cartes de ce tirage ont été supprimées de la collection.', { tone: 'warning' });
    showPackOverlay();
    packState = { stage: 'history' };
    fillRecap(cards, null);
    setPackHint(boosterName);
    setPackActions([sheetButton('Fermer', closePackOpening, 'btn-secondary', 'x')]);
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('packOpening').hidden) closePackOpening();
    if (packState?.stage === 'reveal' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        onPackCardTap(packState.index);
    }
});
