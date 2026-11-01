// Configuration : version de l'app, connexion Supabase, pastille d'état

// Version affichée dans « Quoi de neuf » : l'augmenter relance l'animation chez chaque joueur
const APP_VERSION = '3.0';

// ---------- Supabase ----------
// Clé "publishable" : faite pour être visible dans la page. Les données sont protégées
// par les règles de sécurité (RLS) créées dans Supabase. Ne JAMAIS mettre la clé "secret" ici.
const SUPABASE_URL = 'https://ojpfmhipwdxcnhanolbd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kJ2KniYBEn7XhcQIe6BaMQ_uh80m8R5';
const CARD_IMAGES_BUCKET = 'card-images';

const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function setCloudStatus(text, state) {
    const el = document.getElementById('cloudStatus');
    el.querySelector('.status-text').textContent = text;
    el.className = 'cloud-status' + (state ? ' ' + state : ' busy');
}

// Vérifie que l'URL et la clé sont valides (sans connexion utilisateur, la table
// apparaît vide à cause des règles de sécurité : c'est normal)
async function checkSupabaseConnection() {
    if (!sb) {
        setCloudStatus('Hors ligne', 'error');
        return false;
    }
    const { error } = await sb.from('cards').select('id', { count: 'exact', head: true });
    if (error) {
        console.error('Supabase :', error);
        setCloudStatus('Hors ligne', 'error');
        return false;
    }
    setCloudStatus('En ligne', 'ok');
    return true;
}
