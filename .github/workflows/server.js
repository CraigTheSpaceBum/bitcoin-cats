const express = require('express');
const path = require('path');
const { relayInit } = require('nostr-tools');

const app = express();
const port = 3000;

const relayUrl = 'wss://relay.damus.io';
const npub = 'npub1826v365he5ty69lk3xgvzqrwy8587vdfrxnsz0k09khzustf8r7s6j7t95';

let posts = [];

async function fetchPosts() {
    const relay = relayInit(relayUrl);
    await relay.connect();

    relay.on('connect', () => {
        console.log(`Connected to ${relay.url}`);
    });

    relay.on('error', () => {
        console.error(`Failed to connect to ${relay.url}`);
    });

    const sub = relay.sub([
        {
            kinds: [1],
            authors: [npub]
        }
    ]);

    sub.on('event', (event) => {
        console.log('New event:', event);
        posts.push(event);
    });

    sub.on('eose', () => {
        console.log('End of stored events');
        relay.close();
    });
}

fetchPosts().catch(console.error);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/posts', (req, res) => {
    res.json(posts);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'catstr.html'));
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
