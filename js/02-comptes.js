// Comptes, constantes du jeu et démarrage de la page

// ---------- Comptes (connexion / inscription) ----------
let currentUser = null;
let offlineMode = false;
let authMode = 'login';

const AUTH_ERRORS = {
    invalid_credentials: 'E-mail ou mot de passe incorrect.',
    user_already_exists: 'Un compte existe déjà avec cet e-mail : utilisez « Se connecter ».',
    email_exists: 'Un compte existe déjà avec cet e-mail : utilisez « Se connecter ».',
    weak_password: 'Mot de passe trop faible (6 caractères minimum).',
    email_address_invalid: 'Adresse e-mail invalide.',
    over_request_rate_limit: 'Trop de tentatives, réessayez dans quelques minutes.',
    email_not_confirmed: "E-mail non confirmé : désactivez « Confirm email » dans Supabase."
};

function displayName(user) {
    return user?.user_metadata?.display_name || user?.email?.split('@')[0] || '';
}

async function initAuth(connected) {
    if (!connected) {
        // Supabase injoignable : on propose seulement le mode hors ligne
        showAuthMessage("Le cloud est injoignable pour l'instant. Vous pouvez continuer hors ligne.", true);
        document.getElementById('authOverlay').hidden = false;
        return;
    }
    const { data } = await sb.auth.getSession();
    applySession(data.session);
    sb.auth.onAuthStateChange((_event, session) => applySession(session));
}

function applySession(session) {
    currentUser = session?.user || null;
    const loggedIn = !!currentUser;
    if (loggedIn) offlineMode = false;
    document.getElementById('authOverlay').hidden = loggedIn || offlineMode;
    document.getElementById('userBadge').hidden = !loggedIn;
    document.getElementById('menuLogout').hidden = !loggedIn;
    document.getElementById('userName').textContent = displayName(currentUser);
    if (!loggedIn && !offlineMode) setAuthMode(authMode);
    // Rechargement seulement si l'utilisateur change (pas à chaque rafraîchissement de jeton),
    // hors du callback d'auth (Supabase déconseille d'y attendre d'autres requêtes)
    const ownerKey = loggedIn ? currentUser.id : (offlineMode ? 'local' : null);
    if (ownerKey === collectionOwnerKey) return;
    collectionOwnerKey = ownerKey;
    if (loggedIn) {
        // On écoute d'abord, puis on charge : aucun changement ne peut passer entre les deux
        setTimeout(() => { startRealtime(); loadSharedBack(); reloadCollection(); maybeShowWhatsNew(); }, 0);
    } else {
        stopRealtime();
        if (typeof gameChannel !== 'undefined' && gameChannel) leaveTable();
        if (!offlineMode) clearLoadedCollection();
    }
}

function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    document.getElementById('tabLogin').classList.toggle('active', !signup);
    document.getElementById('tabSignup').classList.toggle('active', signup);
    document.getElementById('pseudoGroup').hidden = !signup;
    document.getElementById('authPseudo').required = signup;
    document.getElementById('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    document.getElementById('authSubmit').textContent = signup ? 'Créer mon compte' : 'Se connecter';
    showAuthMessage('');
}

function showAuthMessage(text, info = false) {
    const el = document.getElementById('authMessage');
    el.textContent = text;
    el.classList.toggle('info', info);
}

async function submitAuth(event) {
    event.preventDefault();
    if (!sb) return;
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const pseudo = document.getElementById('authPseudo').value.trim();
    const btn = document.getElementById('authSubmit');
    btn.disabled = true;
    showAuthMessage('Un instant…', true);

    const { error } = authMode === 'signup'
        ? await sb.auth.signUp({ email, password, options: { data: { display_name: pseudo } } })
        : await sb.auth.signInWithPassword({ email, password });

    btn.disabled = false;
    if (error) {
        console.error('Auth :', error);
        showAuthMessage(AUTH_ERRORS[error.code] || `Erreur : ${error.message}`);
        return;
    }
    document.getElementById('authPassword').value = '';
    showAuthMessage('');
}

async function signOut() {
    if (sb) await sb.auth.signOut();
}

function continueOffline() {
    offlineMode = true;
    collectionOwnerKey = 'local';
    document.getElementById('authOverlay').hidden = true;
    setCloudStatus('Hors ligne', 'offline');
    reloadCollection();
    maybeShowWhatsNew();
}

const ART_HEIGHT_AUTO = 120;
const ZOOM_MIN = 25, ZOOM_MAX = 300;
const TYPES = { hero: 'Héros', spell: 'Sort', artifact: 'Artefact', land: 'Terrain' };
const RARITIES = { common: 'Commune', uncommon: 'Peu commune', rare: 'Rare', epic: 'Épique', legendary: 'Légendaire' };
// Compatibilité avec les anciennes cartes / decks exportés
const LEGACY_TYPES = { 'Créature': 'hero', 'Héros': 'hero', 'Sort': 'spell', 'Enchantement': 'spell', 'Artefact': 'artifact', 'Terrain': 'land' };

const MANA_PALETTES = {
    fire:    { hi: '#fecaca', l: '#f87171', b: '#dc2626', d: '#7f1d1d' },
    water:   { hi: '#bfdbfe', l: '#60a5fa', b: '#2563eb', d: '#1e3a8a' },
    nature:  { hi: '#bbf7d0', l: '#4ade80', b: '#16a34a', d: '#14532d' },
    light:   { hi: '#fef3c7', l: '#fbbf24', b: '#d97706', d: '#78350f' },
    dark:    { hi: '#e9d5ff', l: '#c084fc', b: '#7e22ce', d: '#3b0764' },
    neutral: { hi: '#e2e8f0', l: '#94a3b8', b: '#475569', d: '#1e293b' }
};

const DEFAULT_ART = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='375' height='523'%3E%3Crect width='100%25' height='100%25' fill='%231e293b'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-family='sans-serif' font-size='16'%3EGlissez ou importez une image%3C/text%3E%3C/svg%3E";

let collection = [];
let currentImageSrc = "";
let currentCardId = null;

// Initialisation
window.addEventListener('DOMContentLoaded', () => {
    renderCollection();
    try { backImageSrc = localStorage.getItem('tcg_back') || ''; } catch (e) { backImageSrc = ''; }
    applyBack();
    initArtInteractions();
    init3dTilt();
    document.getElementById('demoTextCheck').checked = demoTextEnabled;
    if (window.lucide) lucide.createIcons();
    updateCardZoom();
    initPwa();
    updateCard();
    checkSupabaseConnection().then(initAuth);
});
