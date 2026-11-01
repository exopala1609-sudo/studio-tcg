// Arène : salon temps réel, actions, tapis de jeu

// =====================================================================
//  TABLE DE JEU : état local + salon Supabase Realtime (presence + broadcast)
// =====================================================================
const ARENA_FRONT_SLOTS = 5;
const ARENA_START_HAND = 5;
const ARENA_START_HP = 100;
const ARENA_MAX_MANA = 20;

let game = null;            // ma partie (sauvegardée dans localStorage pour pouvoir la reprendre)
let gameChannel = null;
let arenaPresence = [];     // joueurs connectés au salon, triés par ordre d'arrivée
let opponents = {};         // dernier état reçu de chaque autre joueur
let arenaSelection = null;  // { owner, uid, zone: 'hand' | 'field' }
let attackMode = null;      // { sourceUid, spell, dmg }
let lastDrawnUid = null;

const myId = () => currentUser?.id;
const shuffle = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

function readSavedGame() {
    try { return JSON.parse(localStorage.getItem('tcg_game') || 'null'); } catch (e) { return null; }
}

function saveGameLocal() {
    if (!game) return;
    try { localStorage.setItem('tcg_game', JSON.stringify(game)); } catch (e) {}
}

function refreshLobby() {
    const notice = document.getElementById('lobbyNotice');
    notice.textContent = isCloudActive() ? '' : 'Connectez-vous (compte Supabase) pour jouer en ligne avec vos amis.';
    document.getElementById('myCardsCount').textContent = collection.filter(isOwnCard).length;
    document.getElementById('randomDeckSize').max = Math.max(5, collection.length);
    loadDecks();
    const saved = readSavedGame();
    const resume = document.getElementById('resumeBtn');
    resume.hidden = !(saved && saved.userId === myId());
    if (!resume.hidden) resume.innerHTML = icon('undo-2') + `Reprendre la partie en cours (salon ${saved.room})`;
    const inGame = !!gameChannel;
    document.getElementById('arenaLobby').hidden = inGame;
    document.getElementById('arenaGame').hidden = !inGame;
}

// Une carte posée sur la table = une "instance" (copie figée de la carte + son état en jeu)
function makeInstance(card) {
    const maxHp = parseInt(card.hp, 10);
    const snap = normalizeCard(card);
    return {
        uid: crypto.randomUUID().slice(0, 8),
        card: snap,
        maxHp: Number.isFinite(maxHp) ? maxHp : null,
        curHp: Number.isFinite(maxHp) ? maxHp : null,
        tapped: false
    };
}

function buildDeckCards(spec) {
    if (spec.mode === 'mine') return collection.filter(isOwnCard);
    if (spec.mode === 'random') return shuffle(collection).slice(0, spec.size);
    const deck = myDecks.find(d => d.id === spec.deckId);
    if (!deck) return [];
    return deck.cardIds.map(id => collection.find(c => c.id === id)).filter(Boolean);
}

function newGameState(room, spec, joinedAt) {
    const cards = buildDeckCards(spec);
    const deck = shuffle(cards.map(makeInstance));
    const hand = deck.splice(0, Math.min(ARENA_START_HAND, deck.length));
    return {
        room, spec, joinedAt,
        userId: myId(),
        name: displayName(currentUser),
        hp: ARENA_START_HP,
        mana: 0,
        deck, hand,
        field: Array(ARENA_FRONT_SLOTS).fill(null),
        land: null,
        graveyard: [],
        turn: null,
        log: []
    };
}

function readDeckSpec() {
    const mode = document.querySelector('input[name=deckMode]:checked').value;
    return {
        mode,
        size: Math.max(1, parseInt(document.getElementById('randomDeckSize').value, 10) || 20),
        deckId: document.getElementById('deckSelect').value
    };
}

async function joinTable(resume) {
    if (!isCloudActive()) return alert('Connectez-vous pour rejoindre une table en ligne.');
    if (resume) {
        game = readSavedGame();
        if (!game) return;
    } else {
        const room = document.getElementById('roomCodeInput').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        if (!room) return alert('Indiquez un code de salon.');
        const spec = readDeckSpec();
        if (spec.mode === 'custom' && !myDecks.some(d => d.id === spec.deckId)) return alert('Choisissez ou créez un deck personnalisé.');
        const saved = readSavedGame();
        if (saved && saved.userId === myId() && !confirm(`Une partie est en cours dans le salon ${saved.room}. La remplacer par une nouvelle partie ?`)) return;
        game = newGameState(room, spec, Date.now());
        if (!game.deck.length && !game.hand.length) {
            game = null;
            return alert('Ce deck est vide : choisissez une autre option.');
        }
    }
    opponents = {};
    arenaPresence = [];
    arenaSelection = null;
    attackMode = null;
    saveGameLocal();
    connectRoom();
    pushLayer('game', doLeaveTable);
    refreshLobby();
    renderBoard();
}

function connectRoom() {
    disconnectRoom();
    document.getElementById('roomLabel').textContent = game.room;
    gameChannel = sb.channel('game-room-' + game.room, {
        config: { broadcast: { self: false }, presence: { key: myId() } }
    });

    gameChannel
        .on('presence', { event: 'sync' }, onPresenceSync)
        .on('broadcast', { event: 'game_state' }, ({ payload }) => onRemoteState(payload))
        .on('broadcast', { event: 'game_log' }, ({ payload }) => pushLog(payload))
        .on('broadcast', { event: 'card_action' }, ({ payload }) => onCardAction(payload))
        .on('broadcast', { event: 'request_state' }, () => sendState())
        .subscribe(async status => {
            if (status !== 'SUBSCRIBED') return;
            await gameChannel.track({ userId: myId(), name: game.name, joinedAt: game.joinedAt });
            gameChannel.send({ type: 'broadcast', event: 'request_state', payload: {} });
            sendState();
            logAction(`${game.name} s'installe à la table.`, 'beer');
        });
}

function disconnectRoom() {
    if (gameChannel) {
        gameChannel.untrack();
        sb.removeChannel(gameChannel);
    }
    gameChannel = null;
}

// Retour au lobby (bouton, ou geste Retour d'Android) : la partie reste sauvegardée
function leaveTable() {
    if (!closeLayer('game')) doLeaveTable();
}

function doLeaveTable() {
    if (gameChannel) logAction(`${game.name} quitte la table (partie sauvegardée).`, 'door-open');
    disconnectRoom();
    closeActionSheet();
    refreshLobby();
}

async function resetGame() {
    if (!game || !confirm('Recommencer une nouvelle partie avec le même deck ?')) return;
    const fresh = newGameState(game.room, game.spec, game.joinedAt);
    fresh.turn = game.turn;
    fresh.log = game.log;
    game = fresh;
    closeActionSheet();
    logAction(`${game.name} recommence avec un nouveau deck mélangé.`, 'rotate-ccw');
    sendState();
}

// ---------- Rôles : les deux premiers arrivés jouent, les autres regardent ----------
function onPresenceSync() {
    const state = gameChannel.presenceState();
    arenaPresence = Object.values(state)
        .map(metas => metas[0])
        .filter(Boolean)
        .sort((a, b) => a.joinedAt - b.joinedAt);
    // Le premier joueur lance la partie quand l'adversaire arrive
    const [p1, p2] = arenaPresence;
    if (p1 && p2 && p1.userId === myId() && !game.turn) {
        game.turn = { userId: p1.userId, number: 1, started: false, at: Date.now() };
        logAction(`La partie commence ! ${p1.name} joue en premier.`, 'flag');
    }
    sendState();
    renderBoard();
}

function arenaRoles() {
    const players = arenaPresence.slice(0, 2);
    const amPlayer = players.some(p => p.userId === myId()) || arenaPresence.length === 0;
    const opponent = players.find(p => p.userId !== myId());
    return { players, amPlayer, opponentId: opponent?.userId || Object.keys(opponents)[0] || null };
}

// ---------- Diffusion de mon état ----------
const stripImage = inst => inst && ({
    ...inst,
    card: { ...inst.card, imageSrc: inst.card.imageSrc?.startsWith('data:') ? '' : inst.card.imageSrc }
});

function publicState() {
    return {
        userId: game.userId,
        name: game.name,
        joinedAt: game.joinedAt,
        hp: game.hp,
        mana: game.mana,
        deckCount: game.deck.length,
        handCount: game.hand.length,
        field: game.field.map(stripImage),
        land: stripImage(game.land),
        graveyard: game.graveyard.map(stripImage),
        turn: game.turn,
        at: Date.now()
    };
}

function sendState() {
    saveGameLocal();
    renderBoard();
    if (!gameChannel || !arenaRoles().amPlayer) return;
    gameChannel.send({ type: 'broadcast', event: 'game_state', payload: publicState() });
}

function onRemoteState(payload) {
    if (!payload?.userId || payload.userId === myId()) return;
    opponents[payload.userId] = payload;
    if (payload.turn && (!game.turn || payload.turn.at > game.turn.at)) {
        game.turn = payload.turn;
        saveGameLocal();
    }
    renderBoard();
}

// ---------- Journal ----------
function pushLog(entry) {
    if (!game) return;
    game.log.push(entry);
    if (game.log.length > 150) game.log.shift();
    saveGameLocal();
    renderLog();
}

function logAction(text, kind = 'info') {
    const entry = { text, kind, at: Date.now() };
    pushLog(entry);
    if (gameChannel) gameChannel.send({ type: 'broadcast', event: 'game_log', payload: entry });
}

function renderLog() {
    const list = document.getElementById('gameLog');
    list.innerHTML = '';
    [...game.log].reverse().forEach(e => {
        const li = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = new Date(e.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        li.insertAdjacentHTML('beforeend', icon(e.kind || 'info', 14));
        li.append(time, document.createTextNode(e.text));
        list.appendChild(li);
    });
}

// ---------- Actions sur les cartes d'un autre joueur : envoyées à leur propriétaire ----------
function sendCardAction(owner, action) {
    if (!gameChannel) return;
    gameChannel.send({ type: 'broadcast', event: 'card_action', payload: { owner, ...action } });
}

function onCardAction(p) {
    if (p.owner !== myId()) return;
    if (p.kind === 'player_hp') {
        game.hp = Math.max(0, game.hp + p.delta);
        flashHit(document.getElementById('barMe'));
    } else {
        const inst = findMyInstance(p.uid);
        if (!inst || inst.maxHp == null) return;
        inst.curHp = Math.max(0, inst.curHp + p.delta);
        if (p.delta < 0) setTimeout(() => flashHit(document.querySelector(`#rowMe [data-uid="${p.uid}"]`)), 30);
    }
    sendState();
}

function findMyInstance(uid) {
    return [...game.field, game.land].find(i => i && i.uid === uid);
}

// =====================================================================
//  ACTIONS DU JOUEUR
// =====================================================================
function isMyTurn() {
    return game?.turn?.userId === myId();
}

function drawCard() {
    if (!arenaRoles().amPlayer) return;
    if (!game.deck.length) return alert('Votre pioche est vide.');
    const inst = game.deck.shift();
    game.hand.push(inst);
    lastDrawnUid = inst.uid;
    logAction(`${game.name} pioche une carte (${game.deck.length} restante${game.deck.length > 1 ? 's' : ''}).`, 'layers');
    sendState();
}

function shuffleMyDeck() {
    if (!game.deck.length) return;
    game.deck = shuffle(game.deck);
    logAction(`${game.name} mélange sa pioche.`, 'shuffle');
    sendState();
}

function rollDice(faces) {
    const value = 1 + Math.floor(Math.random() * faces);
    logAction(`${game.name} lance 1d${faces} : ${value}${value === faces ? ' (maximum !)' : ''}`, 'dices');
}

function startMyTurn() {
    if (!isMyTurn()) return;
    [...game.field, game.land].forEach(i => { if (i) i.tapped = false; });
    game.turn = { ...game.turn, started: true, at: Date.now() };
    logAction(`${game.name} débute son tour ${game.turn.number} (cartes redressées).`, 'play');
    sendState();
}

function endTurn() {
    if (!isMyTurn()) return;
    const next = arenaRoles().opponentId;
    if (!next) return alert("Aucun adversaire à la table pour l'instant.");
    const nextName = opponents[next]?.name || arenaPresence.find(p => p.userId === next)?.name || 'adversaire';
    game.turn = { userId: next, number: game.turn.number + 1, started: false, at: Date.now() };
    closeActionSheet();
    logAction(`${game.name} termine son tour. À ${nextName} de jouer !`, 'skip-forward');
    sendState();
}

function changeMyStat(stat, delta) {
    if (stat === 'hp') game.hp = Math.max(0, game.hp + delta);
    else game.mana = Math.min(ARENA_MAX_MANA, Math.max(0, game.mana + delta));
    sendState();
}

// Poser une carte de la main : Terrain -> emplacement Terrain actif, sinon 1er emplacement libre
function playFromHand(uid) {
    const idx = game.hand.findIndex(i => i.uid === uid);
    if (idx === -1) return;
    const inst = game.hand[idx];
    if (inst.card.type === 'land') {
        if (game.land) {
            game.graveyard.push({ ...game.land, tapped: false });
            logAction(`${game.land.card.name} est remplacé et part au cimetière.`, 'mountain');
        }
        game.land = inst;
    } else {
        const slot = game.field.findIndex(s => !s);
        if (slot === -1) return alert('Votre ligne de front est pleine (5 cartes) : libérez un emplacement.');
        game.field[slot] = inst;
    }
    game.hand.splice(idx, 1);
    closeActionSheet();
    logAction(`${game.name} pose ${inst.card.name || 'une carte'} (coût ${inst.card.mana}).`, 'play');
    sendState();
}

function discardFromHand(uid) {
    const idx = game.hand.findIndex(i => i.uid === uid);
    if (idx === -1) return;
    const [inst] = game.hand.splice(idx, 1);
    game.graveyard.push(inst);
    closeActionSheet();
    logAction(`${game.name} défausse ${inst.card.name}.`, 'skull');
    sendState();
}

// Retire une carte de mon terrain (front ou Terrain actif)
function takeFromField(uid) {
    if (game.land?.uid === uid) {
        const inst = game.land;
        game.land = null;
        return inst;
    }
    const slot = game.field.findIndex(i => i?.uid === uid);
    if (slot === -1) return null;
    const inst = game.field[slot];
    game.field[slot] = null;
    return inst;
}

function sendToGraveyard(uid) {
    const inst = takeFromField(uid);
    if (!inst) return;
    game.graveyard.push({ ...inst, tapped: false });
    closeActionSheet();
    logAction(`${inst.card.name} est envoyé au cimetière.`, 'skull');
    sendState();
}

function returnToHand(uid) {
    const inst = takeFromField(uid);
    if (!inst) return;
    game.hand.push({ ...inst, tapped: false, curHp: inst.maxHp });
    closeActionSheet();
    logAction(`${inst.card.name} retourne dans la main de ${game.name}.`, 'hand');
    sendState();
}

function toggleTap(uid) {
    const inst = findMyInstance(uid);
    if (!inst) return;
    inst.tapped = !inst.tapped;
    logAction(inst.tapped ? `${inst.card.name} est engagé.` : `${inst.card.name} est redressé.`, inst.tapped ? 'rotate-cw' : 'undo-2');
    selectArenaCard(myId(), uid, 'field');
    sendState();
}

// Modifie les PV d'une carte en jeu (la mienne directement, celle d'un ami via son propriétaire)
function adjustCardHp(owner, uid, delta) {
    if (owner === myId()) {
        const inst = findMyInstance(uid);
        if (!inst || inst.maxHp == null) return;
        inst.curHp = Math.max(0, inst.curHp + delta);
        logAction(`${inst.card.name} : ${delta > 0 ? '+' : ''}${delta} PV (${inst.curHp}/${inst.maxHp}).`, 'heart');
        sendState();
    } else {
        const inst = findOpponentInstance(owner, uid);
        if (!inst || inst.maxHp == null) return;
        inst.curHp = Math.max(0, inst.curHp + delta);   // affichage immédiat, confirmé par le propriétaire
        sendCardAction(owner, { uid, kind: 'card_hp', delta });
        logAction(`${inst.card.name} (${opponents[owner]?.name}) : ${delta > 0 ? '+' : ''}${delta} PV.`, 'heart');
        renderBoard();
    }
    selectArenaCard(owner, uid, 'field');
}

function findOpponentInstance(owner, uid) {
    const s = opponents[owner];
    if (!s) return null;
    return [...s.field, s.land].find(i => i && i.uid === uid);
}

function recoverFromGraveyard(uid) {
    const idx = game.graveyard.findIndex(i => i.uid === uid);
    if (idx === -1) return;
    const [inst] = game.graveyard.splice(idx, 1);
    game.hand.push({ ...inst, tapped: false, curHp: inst.maxHp });
    logAction(`${game.name} récupère ${inst.card.name} du cimetière.`, 'undo-2');
    sendState();
    openGraveyard(myId());
}

// ---------- Attaque rapide : sort -> cible adverse ----------
function startAttack(sourceUid, spellIndex) {
    const inst = findMyInstance(sourceUid);
    const spell = inst?.card.spells[spellIndex];
    if (!spell) return;
    const dmg = parseInt(spell.dmg, 10);
    if (!Number.isFinite(dmg) || dmg <= 0) {
        logAction(`${inst.card.name} utilise ${spell.name}${spell.text ? ' : ' + spell.text : ''}`, 'sparkles');
        return closeActionSheet();
    }
    attackMode = { sourceUid, spell: spell.name, dmg, cardName: inst.card.name };
    renderBoard();
    renderActionSheet();
}

function resolveAttack(owner, targetUid) {
    const a = attackMode;
    attackMode = null;
    const targetName = targetUid ? findOpponentInstance(owner, targetUid)?.card.name : opponents[owner]?.name;
    if (targetUid) {
        const inst = findOpponentInstance(owner, targetUid);
        if (inst && inst.maxHp != null) inst.curHp = Math.max(0, inst.curHp - a.dmg);
        sendCardAction(owner, { uid: targetUid, kind: 'card_hp', delta: -a.dmg });
    } else {
        if (opponents[owner]) opponents[owner].hp = Math.max(0, opponents[owner].hp - a.dmg);
        sendCardAction(owner, { kind: 'player_hp', delta: -a.dmg });
    }
    closeActionSheet();
    renderBoard();
    flashHit(targetUid ? document.querySelector(`#rowOpp [data-uid="${targetUid}"]`) : document.getElementById('barOpp'));
    logAction(`${a.cardName} utilise ${a.spell} sur ${targetName || 'la cible'} (-${a.dmg} PV) !`, 'swords');
}

function flashHit(el) {
    if (!el) return;
    el.classList.remove('hit');
    void el.offsetWidth;   // relance l'animation
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 700);
}

// =====================================================================
//  AFFICHAGE DU TAPIS (souris et doigt : tout passe par des clics/taps)
// =====================================================================
function computeArenaScale() {
    const board = document.getElementById('board');
    const width = board.clientWidth - 32;
    const cols = width < 620 ? 3 : 6;
    const slotScale = Math.max(0.13, Math.min(0.3, (width - (cols - 1) * 8) / cols / 375));
    // Main un peu plus grande que le terrain : plus facile à lire et à toucher
    const handScale = Math.max(0.27, Math.min(0.33, slotScale * 1.15));
    const root = document.documentElement.style;
    root.setProperty('--slot-w', `${Math.round(375 * slotScale)}px`);
    root.setProperty('--slot-h', `${Math.round(523 * slotScale)}px`);
    root.setProperty('--hand-h', `${Math.round(523 * handScale)}px`);
    document.querySelectorAll('.front-row').forEach(r => r.style.gridTemplateColumns = `repeat(${cols}, var(--slot-w))`);
    return { slotScale, handScale, backScale: Math.max(0.1, slotScale * 0.55) };
}

let arenaResizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(arenaResizeTimer);
    arenaResizeTimer = setTimeout(() => { if (game && gameChannel) renderBoard(); }, 150);
});

function makeBackMini(scale) {
    const wrap = document.createElement('div');
    wrap.className = 'mini-card';
    wrap.style.width = `${375 * scale}px`;
    wrap.style.height = `${523 * scale}px`;
    const back = makeBackClone();
    back.style.position = 'absolute';
    back.style.transformOrigin = 'top left';
    back.style.transform = `scale(${scale})`;
    back.style.boxShadow = 'none';
    wrap.appendChild(back);
    return wrap;
}

function renderBoard() {
    if (!game || !gameChannel || document.body.dataset.view !== 'arena') return;
    const scales = computeArenaScale();
    const roles = arenaRoles();
    // Spectateur : J1 en bas (lecture seule), J2 en haut
    const bottom = roles.amPlayer ? { ...publicState(), mine: true } : opponents[roles.players[0]?.userId];
    const topId = roles.amPlayer ? roles.opponentId : roles.players[1]?.userId;
    const top = topId ? opponents[topId] : null;

    renderFrontRow('rowOpp', top, scales, false);
    renderPlayerBar('barOpp', top, scales, false);
    renderFrontRow('rowMe', bottom, scales, roles.amPlayer);
    renderPlayerBar('barMe', bottom, scales, roles.amPlayer);
    renderHand(scales, roles.amPlayer);
    renderTurn(roles);
    renderPresence(roles);
    renderLog();
    document.getElementById('rowOpp').classList.toggle('targetable', !!attackMode);
    document.getElementById('barOpp').classList.toggle('targetable', !!attackMode);
    document.getElementById('shuffleBtn').disabled = !roles.amPlayer;
    document.getElementById('resetGameBtn').hidden = !roles.amPlayer;
}

function renderFrontRow(rowId, state, scales, interactive) {
    const row = document.getElementById(rowId);
    row.innerHTML = '';
    const owner = state?.userId;
    const slots = state ? [...state.field, state.land] : Array(ARENA_FRONT_SLOTS + 1).fill(null);
    slots.forEach((inst, i) => {
        const slot = document.createElement('div');
        const isLand = i === ARENA_FRONT_SLOTS;
        slot.className = 'slot' + (isLand ? ' land-slot' : '');
        if (!inst) {
            slot.innerHTML = isLand ? icon('mountain', 18) + '<span>Terrain actif</span>' : `<span>Emplacement ${i + 1}</span>`;
        } else {
            slot.appendChild(renderTableCard(inst, owner, scales.slotScale, 'field'));
        }
        row.appendChild(slot);
    });
}

function renderTableCard(inst, owner, scale, zone) {
    const el = document.createElement('div');
    el.className = 'slot-card' + (inst.tapped ? ' tapped' : '') + (inst.maxHp != null && inst.curHp <= 0 ? ' ko' : '');
    if (arenaSelection?.uid === inst.uid) el.classList.add('selected');
    el.dataset.uid = inst.uid;
    el.appendChild(makeMiniCard(inst.card, scale));
    if (inst.maxHp != null) {
        const hp = document.createElement('span');
        hp.className = 'hp-badge';
        hp.innerHTML = icon('heart', 12) + `${inst.curHp} / ${inst.maxHp}`;
        el.appendChild(hp);
    }
    if (inst.tapped) {
        const t = document.createElement('span');
        t.className = 'tap-badge';
        t.textContent = 'Engagée';
        el.appendChild(t);
    }
    el.onclick = e => {
        e.stopPropagation();
        if (attackMode && owner !== myId()) return resolveAttack(owner, inst.uid);
        selectArenaCard(owner, inst.uid, zone);
    };
    return el;
}

function statChip(iconName, value, buttons, title) {
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    if (title) chip.title = title;
    const text = document.createElement('span');
    text.className = 'stat-value';
    text.innerHTML = icon(iconName, 14) + value;
    (buttons || []).forEach(([txt, fn], i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = txt;
        b.onclick = fn;
        if (i === Math.floor(buttons.length / 2)) chip.appendChild(text);
        chip.appendChild(b);
    });
    if (!buttons) chip.appendChild(text);
    return chip;
}

function renderPlayerBar(barId, state, scales, interactive) {
    const bar = document.getElementById(barId);
    bar.innerHTML = '';
    if (!state) {
        bar.innerHTML = `<span class="player-name offline">${icon('hourglass', 15)}En attente d'un adversaire… (salon ${escapeHtml(game.room)})</span>`;
        return;
    }
    const online = arenaPresence.some(p => p.userId === state.userId) || state.mine;
    const name = document.createElement('span');
    name.className = 'player-name' + (online ? '' : ' offline');
    name.innerHTML = icon(state.mine ? 'user-round' : 'swords', 15);
    name.appendChild(document.createTextNode(state.name + (online ? '' : ' (déconnecté)')));
    bar.appendChild(name);
    if (!state.mine) {
        name.onclick = () => { if (attackMode) resolveAttack(state.userId, null); };
    }

    if (interactive) {
        bar.appendChild(statChip('heart', state.hp, [
            ['-10', () => changeMyStat('hp', -10)], ['-1', () => changeMyStat('hp', -1)],
            ['+1', () => changeMyStat('hp', 1)], ['+10', () => changeMyStat('hp', 10)]
        ]));
        bar.appendChild(statChip('droplet', `${state.mana}/${ARENA_MAX_MANA}`, [
            ['-', () => changeMyStat('mana', -1)], ['+', () => changeMyStat('mana', 1)]
        ]));
    } else {
        bar.appendChild(statChip('heart', state.hp, null, 'Points de vie'));
        bar.appendChild(statChip('droplet', `${state.mana}/${ARENA_MAX_MANA}`, null, 'Mana'));
    }

    // Pioche (verso TCGBP) : un clic pioche la carte du dessus
    const deck = document.createElement('div');
    deck.className = 'pile' + (state.deckCount ? '' : ' empty');
    deck.title = interactive ? 'Piocher une carte' : 'Pioche';
    deck.appendChild(makeBackMini(scales.backScale));
    const dc = document.createElement('span');
    dc.className = 'pile-count';
    dc.textContent = state.deckCount;
    deck.appendChild(dc);
    if (interactive) deck.onclick = drawCard;
    bar.appendChild(deck);

    // Cimetière : un clic ouvre la liste des cartes détruites
    const grave = document.createElement('div');
    grave.className = 'pile' + (state.graveyard.length ? '' : ' empty');
    grave.title = 'Cimetière';
    const top = state.graveyard[state.graveyard.length - 1];
    grave.appendChild(top ? makeMiniCard(top.card, scales.backScale) : makeBackMini(scales.backScale));
    const gc = document.createElement('span');
    gc.className = 'pile-count';
    gc.innerHTML = icon('skull', 13) + state.graveyard.length;
    grave.appendChild(gc);
    grave.onclick = () => openGraveyard(state.userId);
    bar.appendChild(grave);

    // Main de l'adversaire : seulement des versos
    if (!state.mine) {
        const hand = document.createElement('div');
        hand.className = 'opp-hand';
        const shown = Math.min(state.handCount, 8);
        for (let i = 0; i < shown; i++) hand.appendChild(makeBackMini(scales.backScale * 0.8));
        const more = document.createElement('span');
        more.className = 'more';
        more.innerHTML = icon('hand', 14) + state.handCount;
        hand.appendChild(more);
        bar.appendChild(hand);
    }
}

function renderHand(scales, interactive) {
    const handEl = document.getElementById('handMe');
    handEl.innerHTML = '';
    if (!interactive) {
        handEl.innerHTML = `<span class="hand-empty">${icon('eye', 15)}Vous regardez la partie en spectateur.</span>`;
        return;
    }
    if (!game.hand.length) {
        handEl.innerHTML = '<span class="hand-empty">Main vide : touchez votre pioche pour piocher.</span>';
        return;
    }
    game.hand.forEach(inst => {
        const selected = arenaSelection?.zone === 'hand' && arenaSelection.uid === inst.uid;
        const el = document.createElement('div');
        el.className = 'hand-card' + (selected ? ' selected' : '') + (inst.uid === lastDrawnUid ? ' just-drawn' : '');
        el.dataset.uid = inst.uid;
        el.appendChild(makeMiniCard(inst.card, scales.handScale));
        // 1er tap : la carte se soulève et propose Poser / Zoom, sans rien masquer
        if (selected) {
            const quick = document.createElement('div');
            quick.className = 'hand-quick';
            quick.append(
                sheetButton('Poser', () => playFromHand(inst.uid), 'btn-new-card', 'play'),
                sheetButton('Zoom', () => zoomCard(inst), 'btn-secondary', 'zoom-in')
            );
            el.appendChild(quick);
        }
        el.onclick = e => {
            e.stopPropagation();
            if (selected) return closeActionSheet();
            selectArenaCard(myId(), inst.uid, 'hand');
        };
        handEl.appendChild(el);
    });
    lastDrawnUid = null;
    const sel = handEl.querySelector('.hand-card.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTurn(roles) {
    const el = document.getElementById('turnIndicator');
    const t = game.turn;
    if (!t) {
        el.textContent = roles.players.length < 2 ? "En attente d'un 2e joueur" : 'Préparation…';
        el.classList.remove('mine');
    } else {
        const name = t.userId === myId() ? game.name : (opponents[t.userId]?.name || arenaPresence.find(p => p.userId === t.userId)?.name || '?');
        el.textContent = `Tour ${t.number} — ${name}`;
        el.classList.toggle('mine', t.userId === myId());
    }
    const mine = isMyTurn() && roles.amPlayer;
    document.getElementById('startTurnBtn').hidden = !(mine && !t.started);
    document.getElementById('endTurnBtn').disabled = !mine;
}

function renderPresence(roles) {
    const list = document.getElementById('presenceList');
    list.innerHTML = '';
    arenaPresence.forEach((p, i) => {
        const item = document.createElement('div');
        item.className = 'presence-item';
        const dot = document.createElement('span');
        dot.className = 'presence-dot';
        const name = document.createElement('span');
        name.textContent = p.name + (p.userId === myId() ? ' (vous)' : '');
        const role = document.createElement('span');
        role.className = 'presence-role';
        role.textContent = i < 2 ? `Joueur ${i + 1}` : 'Spectateur';
        item.append(dot, name, role);
        list.appendChild(item);
    });
}

function toggleArenaSidebar() {
    document.getElementById('arenaSidebar').classList.toggle('open');
}

// ---------- Feuille d'actions de la carte sélectionnée ----------
function selectArenaCard(owner, uid, zone) {
    arenaSelection = { owner, uid, zone };
    if (attackMode && owner === myId()) attackMode = null;
    // Le geste Retour d'Android ferme la sélection au lieu de quitter la table
    pushLayer('sheet', () => closeActionSheet(true));
    renderBoard();
    renderActionSheet();
}

function closeActionSheet(fromHistory = false) {
    if (!fromHistory && closeLayer('sheet')) return;
    arenaSelection = null;
    attackMode = null;
    document.getElementById('actionSheet').hidden = true;
    renderBoard();
}

function sheetButton(label, fn, extraClass = 'btn-secondary', iconName = null) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-small ${extraClass}`;
    if (iconName) b.insertAdjacentHTML('beforeend', icon(iconName, 15));
    if (label) b.appendChild(document.createTextNode(label));
    else if (iconName) b.setAttribute('aria-label', iconName);
    b.onclick = e => { e.stopPropagation(); fn(); };
    return b;
}

// Barre d'actions contextuelle : entre ma ligne de front et ma main, jamais par-dessus la main
function renderActionSheet() {
    const sheet = document.getElementById('actionSheet');
    sheet.innerHTML = '';
    const sel = arenaSelection;

    if (attackMode) {
        const title = document.createElement('div');
        title.className = 'sheet-title';
        title.innerHTML = icon('crosshair', 16);
        title.appendChild(document.createTextNode(
            `${attackMode.cardName} — ${attackMode.spell} (-${attackMode.dmg} PV) : touchez une carte adverse ou le nom de l'adversaire`));
        const row = document.createElement('div');
        row.className = 'sheet-row';
        row.appendChild(sheetButton('Annuler', () => { attackMode = null; renderBoard(); renderActionSheet(); }, 'btn-secondary', 'x'));
        sheet.append(title, row);
        sheet.hidden = false;
        return;
    }
    // Main : actions rapides directement sur la carte, pas de barre
    if (!sel || sel.zone === 'hand') { sheet.hidden = true; return; }

    const mine = sel.owner === myId();
    const inst = mine ? findMyInstance(sel.uid) : findOpponentInstance(sel.owner, sel.uid);
    if (!inst) { sheet.hidden = true; return; }

    const title = document.createElement('div');
    title.className = 'sheet-title';
    const label = document.createElement('span');
    label.textContent = `${inst.card.name || 'Sans nom'}${mine ? '' : ` (${opponents[sel.owner]?.name || 'adversaire'})`}`;
    const close = sheetButton('', () => closeActionSheet(), 'btn-ghost btn-icon', 'x');
    close.setAttribute('aria-label', 'Fermer');
    title.append(label, close);
    sheet.appendChild(title);

    const canAct = arenaRoles().amPlayer;
    if (inst.maxHp != null && canAct) {
        const hpRow = document.createElement('div');
        hpRow.className = 'sheet-row';
        const l = document.createElement('span');
        l.className = 'sheet-label';
        l.innerHTML = icon('heart', 14) + `${inst.curHp} / ${inst.maxHp}`;
        hpRow.appendChild(l);
        [-10, -5, 5, 10].forEach(d => hpRow.appendChild(sheetButton(`${d > 0 ? '+' : ''}${d}`, () => adjustCardHp(sel.owner, inst.uid, d))));
        sheet.appendChild(hpRow);
    }

    const row = document.createElement('div');
    row.className = 'sheet-row';
    if (mine && canAct) {
        inst.card.spells.forEach((s, i) => {
            if (!s.name) return;
            const dmg = parseInt(s.dmg, 10);
            const hasDmg = Number.isFinite(dmg) && dmg > 0;
            row.appendChild(sheetButton(hasDmg ? `${s.name} (${dmg})` : s.name,
                () => startAttack(inst.uid, i), hasDmg ? 'btn-spell' : 'btn-spell no-dmg', hasDmg ? 'swords' : 'sparkles'));
        });
        row.append(
            sheetButton(inst.tapped ? 'Redresser' : 'Tap', () => toggleTap(inst.uid), 'btn-secondary', inst.tapped ? 'undo-2' : 'rotate-cw'),
            sheetButton('Cimetière', () => sendToGraveyard(inst.uid), 'btn-secondary', 'skull'),
            sheetButton('Main', () => returnToHand(inst.uid), 'btn-secondary', 'hand')
        );
    }
    row.appendChild(sheetButton('Zoom', () => zoomCard(inst), 'btn-secondary', 'zoom-in'));
    sheet.appendChild(row);
    sheet.hidden = false;
}

// Toucher le tapis à côté d'une carte ferme la feuille d'actions
document.addEventListener('click', e => {
    if (!game || document.body.dataset.view !== 'arena') return;
    if (e.target.closest('#actionSheet, .slot-card, .hand-card, .hand, .player-bar, .center-bar, .arena-topbar, .arena-sidebar, .modal-overlay, header, .bottom-tabs')) return;
    if (arenaSelection || attackMode) closeActionSheet();
});

// ---------- Zoom & cimetière ----------
function zoomCard(inst) {
    const box = document.getElementById('zoomBox');
    const scale = Math.min(1, (window.innerHeight - 190) / 523, (window.innerWidth - 40) / 375);
    box.replaceChildren(makeMiniCard(inst.card, scale));
    if (inst.maxHp != null) {
        const hp = document.createElement('div');
        hp.className = 'zoom-hp';
        hp.innerHTML = icon('heart', 16) + `PV en jeu : ${inst.curHp} / ${inst.maxHp}`;
        box.appendChild(hp);
    }
    // Carte de ma main : on peut la poser ou la défausser depuis le zoom
    if (game?.hand.some(i => i.uid === inst.uid) && arenaRoles().amPlayer) {
        const row = document.createElement('div');
        row.className = 'sheet-row';
        row.append(
            sheetButton('Poser sur le terrain', () => { closeModal('zoomModal'); playFromHand(inst.uid); }, 'btn-new-card', 'play'),
            sheetButton('Défausser', () => { closeModal('zoomModal'); discardFromHand(inst.uid); }, 'btn-secondary', 'skull')
        );
        box.appendChild(row);
    }
    openModal('zoomModal');
}

function openGraveyard(owner) {
    const mine = owner === myId();
    const state = mine ? game : opponents[owner];
    if (!state) return;
    document.getElementById('graveTitle').textContent = `Cimetière de ${mine ? 'vous' : state.name} (${state.graveyard.length})`;
    const grid = document.getElementById('graveGrid');
    grid.innerHTML = '';
    if (!state.graveyard.length) grid.innerHTML = '<div class="grave-empty">Aucune carte détruite pour l\'instant.</div>';
    [...state.graveyard].reverse().forEach(inst => {
        const item = document.createElement('div');
        item.className = 'grave-item';
        const card = makeMiniCard(inst.card, 0.32);
        card.style.cursor = 'zoom-in';
        card.onclick = () => zoomCard(inst);
        item.appendChild(card);
        if (mine && arenaRoles().amPlayer) item.appendChild(sheetButton('Récupérer en main', () => recoverFromGraveyard(inst.uid), 'btn-secondary', 'undo-2'));
        grid.appendChild(item);
    });
    openModal('graveModal');
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && game && (arenaSelection || attackMode)) closeActionSheet();
});
