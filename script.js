// Nostr Blog with direct relay connections (NIP-01) + REST fallback for GitHub Pages.
// No external JS imports (works on Pages). Includes local npub (NIP-19) decoding via bech32.
// Relays: Damus, Nos, Nostr.band, Primal, Snort, Purplepages, etc.

const NPUB = "npub1826v365he5ty69lk3xgvzqrwy8587vdfrxnsz0k09khzustf8r7s6j7t95";
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://purplepag.es",
  "wss://relay.nostrgraph.net",
  "wss://offchain.pub",
  "wss://nostr.wine",
  "wss://nostr.fmt.wiz.biz"
];

const postsEl = document.getElementById("posts");
const relayStatusEl = document.getElementById("relay-status");
const siteNameEl = document.getElementById("site-name");
const pageTitleEl = document.getElementById("page-title");
const footerTextEl = document.getElementById("footer-text");
const targetNpubEl = document.getElementById("target-npub");
targetNpubEl.textContent = NPUB;

// ---- Minimal bech32 / npub decoder (BIP-0173 + NIP-19) ----
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
  let chk = 1;
  for (let p=0; p<values.length; p++) {
    let top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[p];
    for (let i=0; i<5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32HrPExpand(hrp) {
  const ret = [];
  for (let i=0; i<hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i=0; i<hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}
function bech32Decode(str) {
  str = str.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1) throw new Error("invalid bech32: no separator");
  const hrp = str.slice(0, pos);
  const data = [];
  for (let i=pos+1; i<str.length; i++) {
    const v = BECH32_CHARSET.indexOf(str[i]);
    if (v === -1) throw new Error("invalid bech32 char");
    data.push(v);
  }
  if (bech32Polymod(bech32HrPExpand(hrp).concat(data)) !== 1) {
    throw new Error("invalid bech32 checksum");
  }
  return { hrp, data: data.slice(0, -6) };
}
function convertBits(data, from, to) {
  let acc = 0, bits = 0, ret = [];
  const maxv = (1 << to) - 1;
  for (let i=0; i<data.length; i++) {
    const value = data[i];
    if (value < 0 || (value >> from)) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (bits > 0) ret.push((acc << (to - bits)) & maxv);
  return ret;
}
function npubToHex(npub) {
  const { hrp, data } = bech32Decode(npub);
  if (hrp !== "npub") throw new Error("not an npub");
  const bytes = convertBits(data, 5, 8);
  // nip19 prefixes payload with type byte (0x00) for 'npub' followed by 32 bytes key
  // Some encoders omit prefix; handle both.
  if (bytes.length === 33 && bytes[0] === 0) return bytes.slice(1);
  if (bytes.length === 32) return bytes;
  // also handle TLV style (nip19 v2); try last 32 bytes
  return bytes.slice(-32);
}
function bytesToHex(arr) {
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

// ---- Render helpers ----
function setStatus(msg) {
  relayStatusEl.textContent = msg;
}
function linkifyAndAttach(content, containerAttachments, containerLinks) {
  const urls = content.match(/https?:\/\/[^\s]+/g) || [];
  urls.forEach(url => {
    if (/\.(png|jpe?g|webp|gif)$/i.test(url)) {
      const img = new Image();
      img.src = url; img.loading = "lazy"; img.alt = "Attachment";
      containerAttachments.appendChild(img);
    } else {
      const div = document.createElement("div");
      div.className = "link-card";
      div.innerHTML = `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      containerLinks.appendChild(div);
    }
  });
}

// ---- Nostr over WebSocket (NIP-01) ----
async function loadViaRelays(pubkeyHex, onProfile, onNotesDone) {
  let connected = 0;
  let responded = 0;
  let profileSet = false;
  const notes = [];
  const subId = "bcats-" + Math.random().toString(36).slice(2, 8);
  const subIdMeta = "bcats-meta-" + Math.random().toString(36).slice(2, 8);

  const wsList = RELAYS.map(url => {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        connected++;
        setStatus(`Connected ${connected}/${RELAYS.length} relays…`);
        // Request metadata (kind:0)
        ws.send(JSON.stringify(["REQ", subIdMeta, {authors:[pubkeyHex], kinds:[0], limit:1}]));
        // Request notes (kind:1)
        ws.send(JSON.stringify(["REQ", subId, {authors:[pubkeyHex], kinds:[1], limit:50}]));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg[0] === "EVENT") {
          responded++;
          const event = msg[2];
          if (event.kind === 0 && !profileSet) {
            try {
              const prof = JSON.parse(event.content);
              profileSet = true;
              onProfile?.(prof);
            } catch {}
          } else if (event.kind === 1) {
            notes.push(event);
          }
        } else if (msg[0] === "EOSE") {
          // End of stored events
          ws.close();
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {};
      return ws;
    } catch (e) { return null; }
  });

  // Wait up to 5 seconds for responses
  await new Promise(r => setTimeout(r, 5000));
  setStatus(`Relays responded. Rendering notes…`);
  // Deduplicate and sort
  const byId = new Map();
  notes.forEach(n => byId.set(n.id, n));
  const unique = Array.from(byId.values()).sort((a,b) => b.created_at - a.created_at);
  onNotesDone?.(unique);
}

// ---- Fallback via nostr.band REST (HTTPS) ----
async function loadViaApi(pubkeyHex, onProfile, onNotesDone) {
  try {
    // metadata
    const r0 = await fetch(`https://api.nostr.band/v0/events?authors=${pubkeyHex}&kinds=0&limit=1`);
    const j0 = await r0.json();
    if (j0.events?.length) {
      try { onProfile(JSON.parse(j0.events[0].content)); } catch {}
    }
  } catch (e) { console.warn("REST metadata failed", e); }
  try {
    const r1 = await fetch(`https://api.nostr.band/v0/events?authors=${pubkeyHex}&kinds=1&limit=50`);
    const j1 = await r1.json();
    onNotesDone(j1.events || []);
  } catch (e) {
    console.warn("REST posts failed", e);
    setStatus("Could not load posts (API error).");
  }
}

// ---- DOM rendering ----
function renderProfile(profile) {
  const name = profile?.display_name || profile?.name || "Nostr User";
  siteNameEl.textContent = name;
  pageTitleEl.textContent = `${name} — Nostr Timeline`;
  footerTextEl.textContent = `Built on Nostr by ${name}`;
}
function renderNotes(events, profile) {
  if (!events?.length) {
    setStatus("No posts found.");
    return;
  }
  setStatus(`Loaded ${events.length} posts.`);
  const tpl = document.getElementById("post-template");

  events.forEach(ev => {
    const node = tpl.content.cloneNode(true);
    const pic = profile?.picture || profile?.image || "https://placekitten.com/200/200";
    node.querySelector(".profile-pic").src = pic;
    node.querySelector(".display-name").textContent = profile?.display_name || profile?.name || "Nostr User";
    node.querySelector(".handle").textContent = "@" + (profile?.nip05 || ev.pubkey.slice(0,8));
    node.querySelector(".time").textContent = new Date(ev.created_at * 1000).toLocaleString();
    node.querySelector(".post-content").textContent = ev.content || "";

    linkifyAndAttach(ev.content || "", node.querySelector(".attachments"), node.querySelector(".links"));
    postsEl.appendChild(node);
  });
}

// ---- Main ----
async function main() {
  document.getElementById("refresh-btn").addEventListener("click", () => {
    postsEl.innerHTML = "";
    setStatus("Refreshing…");
    main();
  }, { once: true });

  const pubkeyHex = bytesToHex(npubToHex(NPUB));
  setStatus("Starting relay fetch…");
  let profile = null;

  const onProfile = (p) => {
    if (!profile) { profile = p; renderProfile(profile); }
  };
  const onNotesDone = (events) => {
    renderNotes(events, profile);
  };

  // Try real Nostr relays first; after timeout, if no posts rendered, hit fallback.
  let rendered = false;
  const originalAppend = postsEl.appendChild.bind(postsEl);
  postsEl.appendChild = (el) => { rendered = true; return originalAppend(el); };

  // Fire relay loader but don't await fully; allow timeout
  loadViaRelays(pubkeyHex, onProfile, onNotesDone);

  // After 6 seconds, if nothing rendered yet, fallback to API
  setTimeout(async () => {
    if (!rendered) {
      setStatus("Relays slow — using API fallback…");
      await loadViaApi(pubkeyHex, (p)=>{ if(!profile){ profile=p; renderProfile(profile);} }, (evs)=>{ renderNotes(evs, profile); });
    }
  }, 6000);
}

window.addEventListener("DOMContentLoaded", main);
