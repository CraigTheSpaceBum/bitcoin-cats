const { relayInit } = require('nostr-tools');

const relayUrl = 'wss://relay.damus.io'; // You can choose any public Nostr relay
const npub = 'npub1826v365he5ty69lk3xgvzqrwy8587vdfrxnsz0k09khzustf8r7s6j7t95';

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
            kinds: [1], // Kind 1 for text posts
            authors: [npub]
        }
    ]);

    sub.on('event', (event) => {
        console.log('New event:', event);
        // You can process and store the events as needed
    });

    sub.on('eose', () => {
        console.log('End of stored events');
        relay.close();
    });
}

fetchPosts().catch(console.error);
