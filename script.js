import { SimplePool, nip19 } from 'https://esm.sh/nostr-tools@2';

const NPUB = 'npub1826v365he5ty69lk3xgvzqrwy8587vdfrxnsz0k09khzustf8r7s6j7t95';
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.wine',
  'wss://relay.nostrgraph.net'
];

const postsEl = document.getElementById('posts');
const relayStatusEl = document.getElementById('relay-status');
const siteNameEl = document.getElementById('site-name');
const pageTitleEl = document.getElementById('page-title');
const footerTextEl = document.getElementById('footer-text');
const targetNpubEl = document.getElementById('target-npub');
targetNpubEl.textContent = NPUB;

async function loadTimeline() {
  const pool = new SimplePool();
  const { data: pubkey } = nip19.decode(NPUB);

  let profile = null;
  try {
    const metas = await pool.list(RELAYS, [{ authors: [pubkey], kinds: [0], limit: 1 }]);
    if (metas.length) {
      profile = JSON.parse(metas[0].content);
      const displayName = profile.display_name || profile.name || 'Nostr User';
      siteNameEl.textContent = displayName;
      pageTitleEl.textContent = displayName + ' — Nostr Timeline';
      footerTextEl.textContent = 'Built on Nostr by ' + displayName + ' 🐾';
    }
  } catch (e) {
    console.error('Failed to load profile metadata:', e);
  }

  relayStatusEl.textContent = 'Connecting to multiple relays...';

  let events = [];
  try {
    events = await pool.list(RELAYS, [{ authors: [pubkey], kinds: [1], limit: 50 }]);
  } catch (e) {
    console.error('Failed to load posts:', e);
  }

  if (!events.length) {
    relayStatusEl.textContent = 'No posts found or relays are slow. Try refreshing.';
  } else {
    relayStatusEl.textContent = 'Loaded ' + events.length + ' posts from Nostr relays.';
  }

  events.sort((a, b) => b.created_at - a.created_at);
  const seen = new Set();
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    renderPost(ev, profile);
  }

  pool.close(RELAYS);
}

function renderPost(ev, profile) {
  const tpl = document.getElementById('post-template');
  const node = tpl.content.cloneNode(true);

  const pic = profile?.picture || profile?.image || 'https://placekitten.com/200/200';
  node.querySelector('.profile-pic').src = pic;
  node.querySelector('.display-name').textContent = profile?.display_name || 'Nostr User';
  node.querySelector('.handle').textContent = '@' + (profile?.nip05 || ev.pubkey.slice(0, 8));

  const t = new Date(ev.created_at * 1000).toLocaleString();
  node.querySelector('.time').textContent = t;
  node.querySelector('.post-content').textContent = ev.content;

  const urls = ev.content.match(/https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g) || [];
  const attachments = node.querySelector('.attachments');
  const links = node.querySelector('.links');

  urls.forEach(url => {
    if (url.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
      const img = new Image();
      img.src = url;
      attachments.appendChild(img);
    } else {
      const div = document.createElement('div');
      div.className = 'link-card';
      div.innerHTML = `<a href="${url}" target="_blank">${url}</a>`;
      links.appendChild(div);
    }
  });

  postsEl.appendChild(node);
}

window.addEventListener('DOMContentLoaded', loadTimeline);
